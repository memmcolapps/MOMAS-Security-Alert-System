import axios from "axios";
import { Hono } from "hono";
import { isPlatformOperator, isPlatformStaff, requireAuth, requireOperator } from "../auth";
import { env } from "../config";
import { allowsDeviceType } from "../modules";
import * as db from "../db";
import { bus } from "../events";
import { readSosStatuses, startSosPush } from "../pocstars/sos-push";
import { count } from "../metrics";
import { alertListenerCount } from "./alerts";
import { provisionOnNetwork } from "../pocstars/live-gateway";
import { actionMessage, describeSyncFailure } from "../pocstars/messages";
import { ensureDeviceAccess, formUrlencoded, isPlatformAdmin, jsonError, orgScope, statusFromAxios } from "./pocstars-helpers";
import positionsRouter from "./pocstars-positions";
import recordingsRouter from "./pocstars-recordings";

type SseClient = {
  write: (chunk: string) => Promise<void>;
  close: () => Promise<void>;
  scope: { organizationId?: number; unitId?: number | null; modules?: string[] };
};

const router = new Hono();
const encoder = new TextEncoder();
const sseClients = new Set<SseClient>();

const LOC_BASE = env.POCSTARS_LOC_BASE;
const SOS_BASE = env.POCSTARS_SOS_BASE;
const MEDIA_BASE = env.POCSTARS_MEDIA_BASE;
const DEFAULT_TARGET_UID = env.POCSTARS_TARGET_UID;
const DISPATCHER_UID = env.POCSTARS_DISPATCHER_UID;

router.use("*", requireAuth);

let lastPocstarsOk: number | null = null;
let lastPocstarsErr: string | null = null;
let sosPollRunning = false;
let sosReconcileRunning = false;

function sseResponse(signal: AbortSignal, scope: any) {
  const stream = new TransformStream<Uint8Array>();
  const writer = stream.writable.getWriter();
  const client: SseClient = {
    write: (chunk) => writer.write(encoder.encode(chunk)),
    close: () => writer.close(),
    scope,
  };
  sseClients.add(client);
  void client.write(":ok\n\n");

  const heartbeat = setInterval(() => {
    void client.write(":heartbeat\n\n").catch(() => {});
  }, 25_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
    void client.close().catch(() => {});
  };
  signal.addEventListener("abort", cleanup, { once: true });

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function broadcastSse(event: string, data: unknown) {
  const alert = data as any;
  // Alarms follow the Radio/Vehicle module of the device that raised them.
  // Only look the device up when some listener actually has one switched off.
  const restricted = alert?.device_id !== undefined
    && [...sseClients].some((client) =>
      allowsDeviceType(client.scope.modules, "vehicle") !== allowsDeviceType(client.scope.modules, "handheld"));
  const deviceType = restricted ? db.deviceTypeOf(alert.device_id).catch(() => null) : Promise.resolve(null);
  void deviceType.then((type) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      if (
        alert?.organization_id !== undefined &&
        client.scope.organizationId &&
        (Number(alert.organization_id) !== Number(client.scope.organizationId) ||
          (client.scope.unitId &&
            Number(alert.unit_id) !== Number(client.scope.unitId)))
      ) {
        continue;
      }
      if (alert?.device_id !== undefined && !allowsDeviceType(client.scope.modules, type)) continue;
      void client.write(message).catch(() => {
        sseClients.delete(client);
      });
    }
  });
}

async function fetchPocstarsSos(
  targetUid: string,
  extra: Record<string, unknown> = {},
  { timeoutMs = 8000, attempts = 3 } = {},
) {
  const params = { targetUid, status: 0, pageNum: 1, pageSize: 50, ...extra };
  let lastError: any;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const { data } = await axios.get(`${SOS_BASE}/sos/mg/records`, {
        params,
        timeout: timeoutMs,
      });
      lastPocstarsOk = Date.now();
      lastPocstarsErr = null;
      return data;
    } catch (error: any) {
      lastError = error;
      lastPocstarsErr = error.message;
      if (attempt < attempts - 1)
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (attempt + 1)),
        );
    }
  }
  throw lastError;
}

async function persistAndBroadcast(rows: any[], via: "push" | "poll" = "poll") {
  for (const row of rows) {
    // The bridge also reports alarms from other companies on the same radio
    // install. Only radios MOMAS manages belong here; the rest are another
    // customer's business.
    if (row.sosMissedRecipient && !(await db.getDevice(String(row.sosFromId)).catch(() => true))) continue;
    let lat = null;
    let lon = null;
    let locationRaw = null;
    try {
      const loc =
        typeof row.sosLocationAt === "string"
          ? JSON.parse(row.sosLocationAt)
          : row.sosLocationAt;
      lat = loc?.wgs84?.lat ?? loc?.wgs84?.Lat ?? loc?.lat ?? loc?.Lat ?? null;
      lon =
        loc?.wgs84?.lon ??
        loc?.wgs84?.lng ??
        loc?.wgs84?.Lng ??
        loc?.lon ??
        loc?.lng ??
        loc?.Lng ??
        null;
      locationRaw = row.sosLocationAt;
    } catch {}

    const inserted = await db.insertSosAlert({
      sos_msg_id: row.sosMsgId,
      device_id: String(row.sosFromId),
      device_name: row.sosSendName || null,
      triggered_at: new Date(row.sosStamp),
      location_lat: lat,
      location_lon: lon,
      location_raw: locationRaw,
      pocstars_group_id:
        row.sosCgId ??
        row.cgId ??
        row.gid ??
        row.groupId ??
        row.sosGroupId ??
        null,
      pocstars_group_name:
        row.sosCgName ??
        row.cgName ??
        row.groupName ??
        row.sosGroupName ??
        null,
      upstream_status: Number.isFinite(Number(row.sosStatus ?? row.status))
        ? Number(row.sosStatus ?? row.status)
        : null,
      received_via: via,
    });
    if (inserted) {
      // Counted before sending, so the number is who was connected when the
      // alarm landed. It is written after, off the alarm's path.
      const consoles = alertListenerCount(inserted);
      broadcastSse("sos_new", inserted);
      bus.emit("pocstars-alert:new", inserted);
      void db.noteSosConsoles(inserted.id, consoles).catch(() => {});
    }
  }
}

function upstreamDate(value: unknown) {
  const stamp = Number(value);
  return Number.isFinite(stamp) && stamp > 0 ? new Date(stamp) : null;
}

async function reconcileAndBroadcast(rows: any[]) {
  // The archive pages hold every alarm the radio network has ever handled, and
  // nearly all of them already match. Reading MOMAS's statuses in one query
  // and opening a locked transaction only for the rows that moved replaces a
  // few hundred sequential round trips per pass.
  const candidates = rows.filter((row) =>
    [1, 2].includes(Number(row.sosStatus ?? row.status)),
  );
  if (!candidates.length) return;
  const known = await db.sosStatusesByMsgId(
    candidates.map((row) => Number(row.sosMsgId)),
  );
  for (const row of candidates) {
    const upstreamStatus = Number(row.sosStatus ?? row.status);
    const localStatus = known.get(Number(row.sosMsgId));
    if (localStatus === undefined || localStatus >= upstreamStatus) continue;
    const alert = await db.reconcileSosAlert({
      sos_msg_id: row.sosMsgId,
      upstream_status: upstreamStatus,
      processed_at: upstreamDate(row.sosPtamp),
      closed_at: upstreamDate(row.sosEtamp),
      processor_id: row.sosProcessorId ?? null,
      processor_name: row.sosProcessorName ?? null,
    });
    if (alert) {
      broadcastSse("sos_updated", alert);
      bus.emit("pocstars-alert:updated", alert);
    }
  }
}

type SosAction = "process" | "close" | "reopen";

// Reopening a closed alarm puts it back into the dispatcher's hands upstream,
// which is the same "begin handling" operation as starting a response.
const UPSTREAM_ENDPOINTS: Record<SosAction, string> = {
  process: "handle/begin",
  close: "handle/end",
  reopen: "handle/begin",
};

const AUDIT_ACTIONS: Record<SosAction, string> = {
  process: "sos.response_started",
  close: "sos.resolved",
  reopen: "sos.reopened",
};

const INVALID_STATUS_CODES: Record<SosAction, string> = {
  process: "alarm_already_started",
  close: "alarm_already_resolved",
  reopen: "alarm_not_resolved",
};

async function callPocstarsAction(action: SosAction, sosMsgId: number) {
  const { data } = await axios.put(
    `${SOS_BASE.replace(/\/$/, "")}/sos/mg/${UPSTREAM_ENDPOINTS[action]}`,
    null,
    {
      params: { uid: DISPATCHER_UID, sosMsgId },
      timeout: 12_000,
    },
  );
  if (Number(data?.code) !== 200 || data?.success === false) {
    const upstreamCode = Number(data?.code);
    const error: any = new Error("The radio network rejected the update.");
    error.status =
      upstreamCode === 501
        ? 403
        : [502, 503, 504].includes(upstreamCode)
          ? 409
          : 502;
    error.code = "alarm_radio_sync_failed";
    error.upstreamCode = Number.isFinite(upstreamCode) ? upstreamCode : null;
    // Raw vendor text is kept for the audit trail only — never rendered to operators.
    error.upstreamMessage = data?.message || null;
    throw error;
  }
  return data;
}

async function handleSosAction(c: any, action: SosAction) {
  const sosMsgId = parseInt(c.req.param("sosMsgId"), 10);
  if (!sosMsgId)
    return c.json(
      { error: "invalid_alarm_reference", message: "Invalid alarm reference." },
      400,
    );
  if (!DISPATCHER_UID) {
    return c.json(
      {
        error: "alarm_dispatch_not_configured",
        message: actionMessage("alarm_dispatch_not_configured"),
      },
      503,
    );
  }
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  // One note field per action: the outcome when resolving, the reason when
  // reopening, and who/what is responding when starting.
  const note =
    typeof body?.note === "string"
      ? body.note.trim()
      : typeof body?.resolution_note === "string"
        ? body.resolution_note.trim()
        : null;

  const start = await db.beginSosAction(
    sosMsgId,
    action,
    user?.id,
    orgScope(c),
  );
  if (start.state === "not_found") {
    return c.json(
      { error: "alarm_not_found", message: actionMessage("alarm_not_found") },
      404,
    );
  }
  if (start.state === "syncing") {
    return c.json(
      {
        error: "alarm_action_in_progress",
        message: actionMessage("alarm_action_in_progress"),
        alert: start.alert,
      },
      409,
    );
  }
  if (start.state === "invalid_status") {
    const code = INVALID_STATUS_CODES[action];
    return c.json(
      { error: code, message: actionMessage(code), alert: start.alert },
      409,
    );
  }

  try {
    const upstreamResponse = await callPocstarsAction(action, sosMsgId);
    const alert = await db.completeSosAction(sosMsgId, action, user?.id, {
      note,
      upstreamResponse,
      previousNote: start.alert?.resolution_note || null,
    });
    await db.createAuditLog({
      organization_id: alert?.organization_id || null,
      actor_user_id: user?.id || null,
      action: AUDIT_ACTIONS[action],
      target_type: "sos_alert",
      target_id: String(sosMsgId),
      metadata: { note, upstream: true },
    });
    broadcastSse("sos_updated", alert);
    bus.emit("pocstars-alert:updated", alert);
    return c.json({ alert });
  } catch (error: any) {
    const { message, detail } = describeSyncFailure(error);
    const alert = await db.failSosAction(
      sosMsgId,
      action,
      user?.id,
      message,
      detail,
    );
    broadcastSse("sos_updated", alert);
    bus.emit("pocstars-alert:updated", alert);
    return c.json(
      { error: error?.code || "alarm_radio_sync_failed", message, alert },
      error?.status || statusFromAxios(error),
    );
  }
}

// New alarms and status reconciliation run as two separate loops. They used to
// share one cycle and one lock, so a reconcile pass over the archive (two large
// vendor pages plus a database round trip per row) or a run of vendor timeouts
// held back the check for new alarms, and a pressed SOS button reached the
// console one to two and a half minutes late.
//
// The new-alarm check fails fast: one short attempt and no retry inside the
// cycle, because the next poll a few seconds later is the retry.
async function pollNewSos({ notifyHealth = true } = {}) {
  if (sosPollRunning) return;
  sosPollRunning = true;
  const started = Date.now();
  try {
    const newData = await fetchPocstarsSos(
      DEFAULT_TARGET_UID,
      { status: 0, pageSize: 50 },
      { timeoutMs: 4000, attempts: 1 },
    );
    const answeredInMs = Date.now() - started;
    await persistAndBroadcast(newData?.data?.rows || []);
    count("sos.poll.ok", 1, answeredInMs);
    if (notifyHealth)
      broadcastSse("pocstars_health", { ok: true, ts: lastPocstarsOk });
  } catch (error: any) {
    count("sos.poll.fail");
    if (notifyHealth)
      broadcastSse("pocstars_health", {
        ok: false,
        err: error.message,
        ts: Date.now(),
      });
  } finally {
    sosPollRunning = false;
  }
}

// Processing/resolved rows only reconcile records MOMAS already knows about, so
// this cannot backfill the vendor archive. Nothing here is time-critical: it
// moves alarms that were handled on the radio network itself.
async function reconcileSosStatuses() {
  if (sosReconcileRunning) return;
  sosReconcileRunning = true;
  try {
    // 583's pages only list alarms sent to 583. Alarms from other companies,
    // or from a radio in a private call, are answered and closed in consoles
    // MOMAS never hears from, so their state is read straight from the radio
    // network's database as well. Independent reads, so they run together.
    // The vendor pages cross the internet and time out on this link now and
    // then; that must not hold back the direct read, so each stands alone.
    const [processing, resolved, direct] = await Promise.allSettled([
      fetchPocstarsSos(DEFAULT_TARGET_UID, { status: 1, pageSize: 200 }),
      fetchPocstarsSos(DEFAULT_TARGET_UID, { status: 2, pageSize: 200 }),
      db.openSosMsgIds().then((ids) => readSosStatuses(ids)),
    ]);
    if (direct.status === "fulfilled" && direct.value) await reconcileAndBroadcast(direct.value);
    if (processing.status === "fulfilled") await reconcileAndBroadcast(processing.value?.data?.rows || []);
    if (resolved.status === "fulfilled") await reconcileAndBroadcast(resolved.value?.data?.rows || []);
    const failed = [processing, resolved].find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) throw failed.reason;
    count("sos.reconcile.ok");
  } catch (error: any) {
    count("sos.reconcile.fail");
    console.warn(
      "[SOS] Status reconciliation failed:",
      error?.message || error,
    );
  } finally {
    sosReconcileRunning = false;
  }
}

setInterval(() => {
  void pollNewSos();
}, env.POCSTARS_SOS_POLL_SEC * 1000);

setInterval(() => {
  void reconcileSosStatuses();
}, 30_000);

// The fast path: the bridge on the POCSTARS host pushes alarms as it sees them.
// The poll above keeps running regardless and is what covers the bridge or its
// tunnel being down.
startSosPush((rows) => persistAndBroadcast(rows, "push"));

/** When the radio network last answered the alarm poll, for the stats page. */
export function sosPollStatus() {
  return {
    lastOkAt: lastPocstarsOk ? new Date(lastPocstarsOk).toISOString() : null,
    lastError: lastPocstarsErr,
  };
}

router.get("/devices", async (c) => {
  try {
    const devices = await db.listDevices(orgScope(c));
    return c.json({ devices });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/radio/channels", async (c) => {
  try {
    const channels = await db.listMonitorableChannels(orgScope(c));
    return c.json({ channels });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

// The radio network owns a managed radio's name: the handset shows it and the
// inventory sync copies it back over this row every cycle. So a rename goes to
// the network first, and a rename that fails there fails here too - otherwise
// the new name would quietly revert within minutes.
async function renameOnNetwork(
  existing: any,
  name: unknown,
  companyId: number | null,
) {
  const next = typeof name === "string" ? name.trim() : "";
  if (!existing?.pocstars_managed || !next || next === existing.name)
    return null;
  const uid = Number(existing.device_id);
  if (!Number.isSafeInteger(uid) || uid <= 0) return null;
  try {
    await provisionOnNetwork("provision.radio.rename", {
      uid,
      companyId,
      name: next,
    });
    return null;
  } catch (error) {
    return error instanceof Error
      ? `The radio could not be renamed on the radio network: ${error.message}`
      : "The radio could not be renamed on the radio network.";
  }
}

router.post("/devices", requireOperator, async (c) => {
  const user = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  const { device_id, name, operator, device_type, notes, active } = body;
  if (!device_id?.trim())
    return c.json({ error: "device_id is required" }, 400);

  try {
    // A radio is a physical handset allocated by the platform, so only platform
    // admins may create one or move it between organizations. This branch
    // upserts organization_id, which previously let an organization admin claim
    // an existing device_id and pull another tenant's radio into their own org.
    if (isPlatformOperator(user)) {
      // Platform operators can rename any radio, pooled ones included, so the
      // network write is not scoped to a company.
      const renameError = await renameOnNetwork(
        await db.getDevice(device_id.trim()),
        name,
        null,
      );
      if (renameError) return c.json({ error: renameError }, 502);
      const device = await db.upsertDevice({
        device_id: device_id.trim(),
        name,
        company: null,
        operator,
        device_type,
        notes,
        organization_id: body.organization_id || null,
        unit_id: body.unit_id || null,
        active: active ?? true,
      });
      await db.createAuditLog({
        organization_id: body.organization_id || null,
        actor_user_id: user?.id,
        action: "device.upsert",
        target_type: "device",
        target_id: device_id.trim(),
        metadata: { unit_id: body.unit_id || null },
      });
      return c.json({ device });
    }

    // Support is platform staff with no organization of its own, so it would
    // otherwise fall into the tenant branch below and be judged against an
    // undefined org. Refuse it by name instead of by accident.
    if (isPlatformStaff(user)) {
      return c.json({ error: "The support role cannot make changes." }, 403);
    }

    // Non-admin: can only update operational fields on devices in their own org.
    // Cannot create new devices, cannot change organization assignment.
    const orgId = orgScope(c).organizationId;
    const existing = await db.getDevice(device_id.trim());
    if (!existing) return c.json({ error: "Device not found" }, 404);
    if (existing.organization_id !== orgId)
      return c.json({ error: "forbidden" }, 403);

    const organization = await db.getOrganization(Number(orgId));
    const companyId = Number(organization?.pocstars_company_id) || null;
    const renameError = await renameOnNetwork(existing, name, companyId);
    if (renameError) return c.json({ error: renameError }, 502);

    // Device type decides the Radio/Vehicle module a device belongs to, so it
    // is a platform setting: a tenant could otherwise retype handhelds as
    // vehicles to see radios their organization has not been given.
    if (device_type !== undefined && device_type !== existing.device_type) {
      return c.json({ error: "Only the platform team can change a device's type." }, 403);
    }
    const device = await db.updateDeviceFields(device_id.trim(), {
      name,
      operator,
      notes,
      active,
    });
    return c.json({ device });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

// Sets the type of many devices at once - mostly marking the vehicle radios,
// which the network sync brings in as handhelds. Platform operators only,
// because the type decides which module (Radio or Vehicle) a device is in.
router.post("/devices/type", requireOperator, async (c) => {
  const user = (c as any).get("user");
  if (!isPlatformOperator(user)) {
    return c.json({ error: "Only the platform team can change a device's type." }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const ids: string[] = [...new Set<string>((Array.isArray(body.device_ids) ? body.device_ids : []).map((id: unknown) => String(id).trim()).filter(Boolean))];
  const type = String(body.device_type || "");
  if (!ids.length) return c.json({ error: "Pick at least one device." }, 400);
  if (ids.length > 2000) return c.json({ error: "Too many devices in one go." }, 400);
  if (!["handheld", "vehicle", "fixed", "other"].includes(type)) {
    return c.json({ error: "Unknown device type." }, 400);
  }
  try {
    const updated = await db.setDeviceTypes(ids, type);
    await db.createAuditLog({
      organization_id: null,
      actor_user_id: user?.id,
      action: "device.type",
      target_type: "device",
      target_id: ids.length === 1 ? ids[0] : `${ids.length} devices`,
      metadata: { device_type: type, device_ids: ids },
    });
    return c.json({ updated });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.delete("/devices/:device_id", async (c) => {
  const user = (c as any).get("user");
  if (!isPlatformOperator(user)) return c.json({ error: "forbidden" }, 403);
  try {
    const deviceId = c.req.param("device_id");
    const existing = await db.getDevice(deviceId);
    if (!existing) return c.json({ error: "Device not found" }, 404);
    // Retire on the radio network first: the vendor row owns the IMEI, and a
    // MOMAS-only delete leaves an active handset that the next inventory sync
    // re-imports and that blocks the IMEI from being onboarded again.
    let network: any = null;
    if (existing.pocstars_managed) {
      const uid = Number(deviceId);
      if (!Number.isSafeInteger(uid) || uid <= 0) {
        return c.json(
          { error: "That radio has no network identity to retire." },
          400,
        );
      }
      const companyId = existing.organization_id
        ? Number(
            (await db.getOrganization(Number(existing.organization_id)))
              ?.pocstars_company_id,
          ) || null
        : Number(
            ((await provisionOnNetwork("provision.pool", {})) as any)
              ?.companyId,
          ) || null;
      network = await provisionOnNetwork("provision.radio.retire", {
        companyId,
        uid,
      });
    }
    const deleted = await db.deleteDevice(deviceId);
    if (!deleted) return c.json({ error: "Device not found" }, 404);
    await db.createAuditLog({
      organization_id: existing.organization_id
        ? Number(existing.organization_id)
        : null,
      actor_user_id: user?.id,
      action: "radio.retire",
      target_type: "device",
      target_id: deviceId,
      metadata: { name: existing.name, imei: existing.imei, network },
    });
    return c.json({ ok: true });
  } catch (error) {
    return c.json(jsonError(error), 409);
  }
});

router.get("/sos/events", (c) => sseResponse(c.req.raw.signal, orgScope(c)));

router.get("/sos/seen-ids", async (c) => {
  try {
    const ids = await db.allSosMsgIds(orgScope(c));
    return c.json({ ids: [...ids] });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/sos/log", async (c) => {
  try {
    await pollNewSos({ notifyHealth: false });
    const alerts = await db.listSosAlerts(orgScope(c), { status: "open" });
    return c.json({
      alerts,
      pocstarsLastOk: lastPocstarsOk,
      pocstarsLastErr: lastPocstarsErr,
    });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/sos/:sosMsgId/acknowledge", requireOperator, async (c) => {
  return handleSosAction(c, "process");
});

router.post("/sos/:sosMsgId/resolve", requireOperator, async (c) => {
  return handleSosAction(c, "close");
});

router.get("/alarms", async (c) => {
  try {
    await pollNewSos({ notifyHealth: false });
    const query = c.req.query();
    const alerts = await db.listSosAlerts(orgScope(c), {
      status: query.status || "all",
      search: query.search,
      from: query.from,
      to: query.to,
      limit: query.limit,
    });
    return c.json({
      alerts,
      pocstarsLastOk: lastPocstarsOk,
      pocstarsLastErr: lastPocstarsErr,
      actionsConfigured: Boolean(DISPATCHER_UID),
    });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/alarms/:sosMsgId", async (c) => {
  const sosMsgId = parseInt(c.req.param("sosMsgId"), 10);
  if (!sosMsgId) return c.json({ error: "invalid sosMsgId" }, 400);
  try {
    const result = await db.listSosEvents(sosMsgId, orgScope(c));
    if (!result) return c.json({ error: "alarm_not_found" }, 404);
    return c.json(result);
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/alarms/:sosMsgId/start-response", requireOperator, (c) =>
  handleSosAction(c, "process"),
);
router.post("/alarms/:sosMsgId/resolve", requireOperator, (c) => handleSosAction(c, "close"));
router.post("/alarms/:sosMsgId/reopen", requireOperator, (c) => handleSosAction(c, "reopen"));

router.post("/radio/messages", requireOperator, async (c) => {
  const user = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  const deviceId = String(body.device_id || "").trim();
  const message = String(body.message || "").trim();

  if (!deviceId) {
    return c.json(
      { error: "device_required", message: "Choose a radio before sending." },
      400,
    );
  }
  if (!message) {
    return c.json(
      { error: "message_required", message: "Enter a message to send." },
      400,
    );
  }
  if (Buffer.byteLength(message, "utf8") > 200) {
    return c.json(
      {
        error: "message_too_long",
        message: "Radio messages are limited to 200 bytes.",
      },
      400,
    );
  }
  if (!DISPATCHER_UID) {
    return c.json(
      {
        error: "radio_messaging_not_configured",
        message: "Radio messaging is not configured.",
      },
      503,
    );
  }

  try {
    const devices = await db.listDevices(orgScope(c));
    const device = devices.find(
      (row: any) => String(row.device_id) === deviceId,
    );
    if (!device) {
      return c.json(
        {
          error: "forbidden",
          message: "That radio is outside your operational scope.",
        },
        403,
      );
    }

    const { data } = await axios.post(
      `${MEDIA_BASE.replace(/\/$/, "")}/api/v1/media/send`,
      formUrlencoded({
        msg: message,
        msg_descriptor: message,
        from: DISPATCHER_UID,
        from_name: "EPAIL Command",
        to: deviceId,
        to_name: device.name || deviceId,
        msg_type: 1,
        token: "token",
        source_flag: 3,
        source: "",
        source_name: "",
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15_000,
      },
    );

    const upstreamCode = Number(data?.code ?? data?.response?.code ?? 200);
    if (data?.success === false || upstreamCode >= 400) {
      return c.json(
        {
          error: "pocstars_message_failed",
          message:
            data?.message ||
            data?.response?.message ||
            "The radio network rejected the message.",
        },
        502,
      );
    }

    const deliveryId =
      data?.data?.msgUUID ||
      data?.data?.uuid ||
      data?.response?.msgUUID ||
      data?.response?.uuid ||
      null;
    await db.createAuditLog({
      organization_id: device.organization_id || null,
      actor_user_id: user?.id,
      action: "radio.message.send",
      target_type: "device",
      target_id: deviceId,
      metadata: {
        delivery_id: deliveryId,
        message_bytes: Buffer.byteLength(message, "utf8"),
      },
    });

    return c.json({
      sent: true,
      deviceId,
      deliveryId,
      acceptedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    return c.json(
      {
        error: "pocstars_message_failed",
        message: "The radio message could not be sent.",
      },
      statusFromAxios(error),
    );
  }
});

router.get("/config", async (c) => {
  const devices = await db.listDevices(orgScope(c)).catch(() => []);
  const active = devices.filter((device: any) => device.active);
  return c.json({
    uids: active.map((device: any) => device.device_id),
    targetUid: DEFAULT_TARGET_UID,
  });
});

router.get("/history", async (c) => {
  const { uid, start, end } = c.req.query();
  if (!uid || !start || !end)
    return c.json({ error: "uid, start, end required" }, 400);
  if (!(await ensureDeviceAccess(c, [uid]))) {
    return c.json(
      { error: "That device is outside your operational scope." },
      403,
    );
  }
  const startStamp = new Date(start.replace(" ", "T") + "Z").getTime();
  const endStamp = new Date(end.replace(" ", "T") + "Z").getTime();
  try {
    const { data } = await axios.post(
      `${LOC_BASE}/shanli/gps/api/trace/gethistory`,
      formUrlencoded({
        Uid: uid,
        CorrdinateType: "Wgs84",
        startDateTime: start,
        endDateTime: end,
        startDateTamp: startStamp,
        endDateTamp: endStamp,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15000,
      },
    );
    return c.json(data);
  } catch (error: any) {
    return c.json(
      { error: "pocstars_history_failed", message: error.message },
      statusFromAxios(error),
    );
  }
});

router.get("/sos", async (c) => {
  if (!isPlatformAdmin(c)) {
    return c.json(
      { error: "The raw SOS feed is restricted to platform administrators." },
      403,
    );
  }
  const query = c.req.query();
  const targetUid = query.targetUid || DEFAULT_TARGET_UID;
  if (!targetUid) return c.json({ error: "targetUid required" }, 400);
  const extra: Record<string, unknown> = {};
  if (query.status !== undefined) extra.status = query.status;
  if (query.cgId) extra.cgId = query.cgId;
  if (query.pageNum) extra.pageNum = query.pageNum;
  if (query.pageSize) extra.pageSize = query.pageSize;

  try {
    const data = await fetchPocstarsSos(targetUid, extra);
    const rows = data?.data?.rows || [];
    await persistAndBroadcast(rows);
    return c.json(data);
  } catch (error: any) {
    return c.json(
      { error: "pocstars_sos_failed", message: error.message },
      statusFromAxios(error),
    );
  }
});

router.get("/sos/detail", async (c) => {
  const sosMsgId = c.req.query("sosMsgId");
  if (!sosMsgId) return c.json({ error: "sosMsgId required" }, 400);
  const visible = await db.getSosAlert(Number(sosMsgId), orgScope(c));
  if (!visible) return c.json({ error: "alarm_not_found" }, 404);
  try {
    const { data } = await axios.get(`${SOS_BASE}/sos/mg/detail`, {
      params: { sosMsgId },
      timeout: 8000,
    });
    return c.json(data);
  } catch (error: any) {
    return c.json(
      { error: "pocstars_sos_detail_failed", message: error.message },
      statusFromAxios(error),
    );
  }
});

// Positions and recordings live in their own files; requireAuth above covers them.
router.route("/", positionsRouter);
router.route("/", recordingsRouter);

export default router;
