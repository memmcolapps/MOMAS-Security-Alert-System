import { Hono } from "hono";
import { isPlatformStaff, primaryOrganization, requireAuth } from "../auth";
import { env } from "../config";
import * as db from "../db";
import { bus } from "../events";
import * as store from "../geofencing/store";

type Client = {
  write: (chunk: string) => Promise<void>;
  close: () => Promise<void>;
  organizationId: number | null;
  unitId: number | null;
  admin: boolean;
};

const router = new Hono();
const clients = new Set<Client>();
const encoder = new TextEncoder();

const COUNT_KEYS = ["all", "open", "new", "in_progress", "resolved", "sync_failed"] as const;

function normalizeSos(alert: any) {
  return {
    ...alert,
    source: "pocstars",
    alert_key: `pocstars:${alert.sos_msg_id}`,
    alert_type: "sos",
    asset_type: "radio",
    asset_id: String(alert.device_id),
    asset_name: alert.dev_name || alert.device_name || null,
  };
}

function normalizeGeofence(alert: any) {
  return {
    ...alert,
    source: "geofence",
    alert_key: `geofence:${alert.id}`,
    alert_type: "geofence_breach",
    device_id: String(alert.asset_id),
    device_name: alert.asset_name,
    dev_name: alert.asset_name,
    sync_status: "synced",
  };
}

function broadcast(event: string, alert: any, source: "pocstars" | "geofence") {
  const normalized = source === "pocstars" ? normalizeSos(alert) : normalizeGeofence(alert);
  const message = `event: ${event}\ndata: ${JSON.stringify(normalized)}\n\n`;
  for (const client of clients) {
    const allowed =
      client.admin ||
      (Number(normalized.organization_id) === Number(client.organizationId) &&
        (!client.unitId || Number(normalized.unit_id) === Number(client.unitId)));
    if (!allowed) continue;
    void client.write(message).catch(() => clients.delete(client));
  }
}

bus.on("operational-alert:new", (alert) => broadcast("alert_new", alert, "geofence"));
bus.on("operational-alert:updated", (alert) => broadcast("alert_updated", alert, "geofence"));
bus.on("pocstars-alert:new", (alert) => broadcast("alert_new", alert, "pocstars"));
bus.on("pocstars-alert:updated", (alert) => broadcast("alert_updated", alert, "pocstars"));

router.use("*", requireAuth);

function requestScope(c: any) {
  const user = c.get("user");
  if (isPlatformStaff(user)) return {};
  const membership = primaryOrganization(user);
  return membership
    ? {
        organizationId: membership.organization_id,
        unitId: membership.scope_level === "unit" ? membership.unit_id : null,
      }
    : { organizationId: -1 };
}

router.get("/events", (c) => {
  const user: any = (c as any).get("user");
  const membership = primaryOrganization(user);
  const stream = new TransformStream<Uint8Array>();
  const writer = stream.writable.getWriter();
  const client: Client = {
    write: (chunk) => writer.write(encoder.encode(chunk)),
    close: () => writer.close(),
    organizationId: membership?.organization_id || null,
    unitId: membership?.scope_level === "unit" ? membership.unit_id : null,
    admin: isPlatformStaff(user),
  };
  clients.add(client);
  void client.write(":ok\n\n");
  const heartbeat = setInterval(() => void client.write(":heartbeat\n\n").catch(() => {}), 25_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(client);
    void client.close().catch(() => {});
  };
  c.req.raw.signal.addEventListener("abort", cleanup, { once: true });
  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

router.get("/", async (c) => {
  try {
    const query = c.req.query();
    const filters = {
      status: query.status || "all",
      search: query.search,
      from: query.from,
      to: query.to,
      limit: query.limit || 500,
    };
    const [sos, geofence, sosCounts, geofenceCounts] = await Promise.all([
      db.listSosAlerts(requestScope(c), filters),
      store.listOperationalAlerts(requestScope(c), filters),
      db.countSosAlerts(requestScope(c), filters),
      store.countOperationalAlerts(requestScope(c), filters),
    ]);
    const alerts = [
      ...sos.map(normalizeSos),
      ...geofence.map(normalizeGeofence),
    ].sort((a, b) => new Date(b.triggered_at).getTime() - new Date(a.triggered_at).getTime());
    // Counted in the database rather than over `alerts`, which is capped by
    // `limit` — a client-side tally silently undercounts once history grows.
    const counts = Object.fromEntries(
      COUNT_KEYS.map((key) => [key, Number(sosCounts?.[key] || 0) + Number(geofenceCounts?.[key] || 0)]),
    );
    return c.json({ alerts, counts, actionsConfigured: Boolean(env.POCSTARS_DISPATCHER_UID) });
  } catch (error: any) {
    return c.json({ error: error?.message || String(error) }, 500);
  }
});

router.get("/:source/:id", async (c) => {
  const source = c.req.param("source");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Invalid alert id." }, 400);
  try {
    const result =
      source === "geofence"
        ? await store.listOperationalAlertEvents(id, requestScope(c))
        : source === "pocstars"
          ? await db.listSosEvents(id, requestScope(c))
          : null;
    if (!result) return c.json({ error: "Alarm not found." }, 404);
    return c.json({
      alert: source === "geofence" ? normalizeGeofence(result.alert) : normalizeSos(result.alert),
      events: result.events,
    });
  } catch (error: any) {
    return c.json({ error: error?.message || String(error) }, 500);
  }
});

/** One note field per action: who is responding, the outcome, or the reason for reopening. */
function actionNote(body: any) {
  const raw = typeof body?.note === "string" ? body.note : body?.resolution_note;
  return String(raw || "").trim();
}

router.post("/geofence/:id/start-response", async (c) => {
  const user: any = (c as any).get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_alarm_reference", message: "Invalid alarm reference." }, 400);
  const note = actionNote(await c.req.json().catch(() => ({})));
  const visible = await store.getOperationalAlert(id, requestScope(c));
  if (!visible) return c.json({ error: "alarm_not_found", message: "This alarm is no longer available in your operational scope." }, 404);
  const alert = await store.updateOperationalAlert(id, user.id, "start", note || undefined);
  bus.emit("operational-alert:updated", alert);
  return c.json({ alert: normalizeGeofence(alert) });
});

router.post("/geofence/:id/resolve", async (c) => {
  const user: any = (c as any).get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_alarm_reference", message: "Invalid alarm reference." }, 400);
  const note = actionNote(await c.req.json().catch(() => ({})));
  if (!note) return c.json({ error: "resolution_note_required", message: "Record what was confirmed before closing the alarm." }, 400);
  const visible = await store.getOperationalAlert(id, requestScope(c));
  if (!visible) return c.json({ error: "alarm_not_found", message: "This alarm is no longer available in your operational scope." }, 404);
  const alert = await store.updateOperationalAlert(id, user.id, "resolve", note);
  bus.emit("operational-alert:updated", alert);
  return c.json({ alert: normalizeGeofence(alert) });
});

router.post("/geofence/:id/reopen", async (c) => {
  const user: any = (c as any).get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_alarm_reference", message: "Invalid alarm reference." }, 400);
  const note = actionNote(await c.req.json().catch(() => ({})));
  if (!note) return c.json({ error: "reopen_reason_required", message: "Record why this alarm is being reopened." }, 400);
  const visible = await store.getOperationalAlert(id, requestScope(c));
  if (!visible) return c.json({ error: "alarm_not_found", message: "This alarm is no longer available in your operational scope." }, 404);
  if (Number(visible.status) !== 2) {
    return c.json({ error: "alarm_not_resolved", message: "Only a resolved alarm can be reopened." }, 409);
  }
  try {
    const alert = await store.updateOperationalAlert(id, user.id, "reopen", note);
    bus.emit("operational-alert:updated", alert);
    return c.json({ alert: normalizeGeofence(alert) });
  } catch (error: any) {
    // Only one alarm may be active per fence/asset pair. If the asset breached
    // again after this one closed, the newer alarm owns that slot.
    if (error?.code === "23505") {
      return c.json(
        {
          error: "alarm_superseded",
          message: "A newer alarm is already open for this asset and fence. Work that alarm instead.",
        },
        409,
      );
    }
    return c.json({ error: "alarm_reopen_failed", message: "The alarm could not be reopened." }, 500);
  }
});

export default router;
