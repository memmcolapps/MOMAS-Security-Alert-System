import axios from "axios";
import { Hono } from "hono";
import { canManageOrganization, primaryOrganization, requireAuth } from "../auth";
import { env } from "../config";
import * as db from "../db";
import { bus } from "../events";
import { fetchLastLocations } from "../pocstars/locations";

type SseClient = {
  write: (chunk: string) => Promise<void>;
  close: () => Promise<void>;
  scope: { organizationId?: number; unitId?: number | null };
};

const router = new Hono();
const encoder = new TextEncoder();
const sseClients = new Set<SseClient>();

const LOC_BASE = env.POCSTARS_LOC_BASE;
const SOS_BASE = env.POCSTARS_SOS_BASE;
const DEFAULT_TARGET_UID = env.POCSTARS_TARGET_UID;
const DISPATCHER_UID = env.POCSTARS_DISPATCHER_UID;

router.use("*", requireAuth);

function orgScope(c: any) {
  const user = c.get("user");
  if (!user || user.platform_role === "admin") return {};
  const org = primaryOrganization(user);
  return org ? { organizationId: org.organization_id, unitId: org.scope_level === "unit" ? org.unit_id : null } : { organizationId: -1 };
}

function isPlatformAdmin(c: any) {
  return c.get("user")?.platform_role === "admin";
}

async function ensureDeviceAccess(c: any, deviceIds: string[]) {
  if (isPlatformAdmin(c)) return true;
  const allowed = new Set(
    (await db.listDevices(orgScope(c))).map((device: any) => String(device.device_id)),
  );
  return deviceIds.every((deviceId) => allowed.has(String(deviceId)));
}

let lastPocstarsOk: number | null = null;
let lastPocstarsErr: string | null = null;
let sosSyncRunning = false;

const formUrlencoded = (obj: Record<string, unknown>) =>
  Object.entries(obj)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");

function jsonError(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error) };
}

function statusFromAxios(error: any) {
  return error?.response?.status || 502;
}

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
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    const alert = data as any;
    if (
      alert?.organization_id !== undefined &&
      client.scope.organizationId &&
      (Number(alert.organization_id) !== Number(client.scope.organizationId) ||
        (client.scope.unitId && Number(alert.unit_id) !== Number(client.scope.unitId)))
    ) {
      continue;
    }
    void client.write(message).catch(() => {
      sseClients.delete(client);
    });
  }
}

async function fetchPocstarsSos(targetUid: string, extra: Record<string, unknown> = {}) {
  const params = { targetUid, status: 0, pageNum: 1, pageSize: 50, ...extra };
  let lastError: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await axios.get(`${SOS_BASE}/sos/mg/records`, {
        params,
        timeout: 8000,
      });
      lastPocstarsOk = Date.now();
      lastPocstarsErr = null;
      return data;
    } catch (error: any) {
      lastError = error;
      lastPocstarsErr = error.message;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function persistAndBroadcast(rows: any[]) {
  for (const row of rows) {
    let lat = null;
    let lon = null;
    let locationRaw = null;
    try {
      const loc = typeof row.sosLocationAt === "string" ? JSON.parse(row.sosLocationAt) : row.sosLocationAt;
      lat = loc?.wgs84?.lat ?? loc?.wgs84?.Lat ?? loc?.lat ?? loc?.Lat ?? null;
      lon = loc?.wgs84?.lon ?? loc?.wgs84?.lng ?? loc?.wgs84?.Lng ?? loc?.lon ?? loc?.lng ?? loc?.Lng ?? null;
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
      pocstars_group_id: row.sosCgId ?? row.cgId ?? row.gid ?? row.groupId ?? row.sosGroupId ?? null,
      pocstars_group_name: row.sosCgName ?? row.cgName ?? row.groupName ?? row.sosGroupName ?? null,
      upstream_status: Number.isFinite(Number(row.sosStatus ?? row.status))
        ? Number(row.sosStatus ?? row.status)
        : null,
    });
    if (inserted) {
      broadcastSse("sos_new", inserted);
      bus.emit("pocstars-alert:new", inserted);
    }
  }
}

async function callPocstarsAction(action: "process" | "close", sosMsgId: number) {
  const endpoint = action === "process" ? "handle/begin" : "handle/end";
  const { data } = await axios.put(
    `${SOS_BASE.replace(/\/$/, "")}/sos/mg/${endpoint}`,
    null,
    {
      params: { uid: DISPATCHER_UID, sosMsgId },
      timeout: 12_000,
    },
  );
  if (Number(data?.code) !== 200 || data?.success === false) {
    const upstreamCode = Number(data?.code);
    const error: any = new Error(data?.message || `POCSTARS ${action} operation was rejected.`);
    error.status = upstreamCode === 501 ? 403 : [502, 503, 504].includes(upstreamCode) ? 409 : 502;
    error.code = "pocstars_action_rejected";
    error.upstreamCode = Number.isFinite(upstreamCode) ? upstreamCode : null;
    throw error;
  }
  return data;
}

function actionError(error: any) {
  return {
    error: error?.code || "pocstars_action_failed",
    message: error?.response?.data?.message || error?.message || String(error),
  };
}

async function handleSosAction(c: any, action: "process" | "close") {
  const sosMsgId = parseInt(c.req.param("sosMsgId"), 10);
  if (!sosMsgId) return c.json({ error: "invalid sosMsgId" }, 400);
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const note = typeof body?.resolution_note === "string" ? body.resolution_note.trim() : null;
  const start = await db.beginSosAction(sosMsgId, action, user?.id, orgScope(c));
  if (start.state === "not_found") return c.json({ error: "alarm_not_found" }, 404);
  if (start.state === "syncing") return c.json({ error: "alarm_action_in_progress", alert: start.alert }, 409);
  if (start.state === "invalid_status") {
    return c.json(
      {
        error: action === "process" ? "alarm_already_started" : "alarm_already_resolved",
        alert: start.alert,
      },
      409,
    );
  }

  try {
    const upstreamResponse = await callPocstarsAction(action, sosMsgId);
    const alert = await db.completeSosAction(sosMsgId, action, user?.id, {
      note,
      upstreamResponse,
    });
    await db.createAuditLog({
      organization_id: alert?.organization_id || null,
      actor_user_id: user?.id || null,
      action: action === "process" ? "sos.response_started" : "sos.resolved",
      target_type: "sos_alert",
      target_id: String(sosMsgId),
      metadata: { resolution_note: note, upstream: true },
    });
    broadcastSse("sos_updated", alert);
    bus.emit("pocstars-alert:updated", alert);
    return c.json({ alert });
  } catch (error: any) {
    const alert = await db.failSosAction(sosMsgId, action, user?.id, actionError(error).message);
    broadcastSse("sos_updated", alert);
    bus.emit("pocstars-alert:updated", alert);
    return c.json({ ...actionError(error), alert }, error?.status || statusFromAxios(error));
  }
}

async function syncPocstarsSos({ notifyHealth = true } = {}) {
  if (sosSyncRunning) return;
  sosSyncRunning = true;
  try {
    const data = await fetchPocstarsSos(DEFAULT_TARGET_UID);
    const rows = data?.data?.rows || [];
    await persistAndBroadcast(rows);
    if (notifyHealth) broadcastSse("pocstars_health", { ok: true, ts: lastPocstarsOk });
  } catch (error: any) {
    if (notifyHealth) broadcastSse("pocstars_health", { ok: false, err: error.message, ts: Date.now() });
  } finally {
    sosSyncRunning = false;
  }
}

setInterval(() => {
  void syncPocstarsSos();
}, 12_000);

router.get("/devices", async (c) => {
  try {
    const devices = await db.listDevices(orgScope(c));
    return c.json({ devices });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/devices", async (c) => {
  const user = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  const { device_id, name, operator, device_type, notes, active } = body;
  if (!device_id?.trim()) return c.json({ error: "device_id is required" }, 400);

  try {
    const membership = primaryOrganization(user);
    if (user?.platform_role === "admin" || canManageOrganization(membership)) {
      const device = await db.upsertDevice({
        device_id: device_id.trim(),
        name,
        company: null,
        operator,
        device_type,
        notes,
        organization_id: user?.platform_role === "admin" ? body.organization_id || null : membership.organization_id,
        unit_id: body.unit_id || (membership?.scope_level === "unit" ? membership.unit_id : null),
        active: active ?? true,
      });
      await db.createAuditLog({
        organization_id: user?.platform_role === "admin" ? body.organization_id || null : membership.organization_id,
        actor_user_id: user?.id,
        action: "device.upsert",
        target_type: "device",
        target_id: device_id.trim(),
        metadata: { unit_id: body.unit_id || null },
      });
      return c.json({ device });
    }

    // Non-admin: can only update operational fields on devices in their own org.
    // Cannot create new devices, cannot change organization assignment.
    const orgId = orgScope(c).organizationId;
    const existing = await db.getDevice(device_id.trim());
    if (!existing) return c.json({ error: "Device not found" }, 404);
    if (existing.organization_id !== orgId) return c.json({ error: "forbidden" }, 403);

    const device = await db.updateDeviceFields(device_id.trim(), {
      name,
      operator,
      device_type,
      notes,
      active,
    });
    return c.json({ device });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.delete("/devices/:device_id", async (c) => {
  const user = (c as any).get("user");
  if (user?.platform_role !== "admin") return c.json({ error: "forbidden" }, 403);
  try {
    const deleted = await db.deleteDevice(c.req.param("device_id"));
    if (!deleted) return c.json({ error: "Device not found" }, 404);
    return c.json({ ok: true });
  } catch (error) {
    return c.json(jsonError(error), 500);
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
    await syncPocstarsSos({ notifyHealth: false });
    const alerts = await db.listSosAlerts(orgScope(c), { status: "open" });
    return c.json({ alerts, pocstarsLastOk: lastPocstarsOk, pocstarsLastErr: lastPocstarsErr });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/sos/:sosMsgId/acknowledge", async (c) => {
  return handleSosAction(c, "process");
});

router.post("/sos/:sosMsgId/resolve", async (c) => {
  return handleSosAction(c, "close");
});

router.get("/alarms", async (c) => {
  try {
    await syncPocstarsSos({ notifyHealth: false });
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

router.post("/alarms/:sosMsgId/start-response", (c) => handleSosAction(c, "process"));
router.post("/alarms/:sosMsgId/resolve", (c) => handleSosAction(c, "close"));

router.get("/config", async (c) => {
  const devices = await db.listDevices(orgScope(c)).catch(() => []);
  const active = devices.filter((device: any) => device.active);
  return c.json({
    uids: active.map((device: any) => device.device_id),
    targetUid: DEFAULT_TARGET_UID,
  });
});

router.get("/locations", async (c) => {
  let uids = c.req.query("uids");
  if (!uids) {
    const devices = await db.listDevices(orgScope(c)).catch(() => []);
    uids = devices
      .filter((device: any) => device.active)
      .map((device: any) => device.device_id)
      .join(",");
  }
  if (!uids) return c.json({ code: 200, data: [], success: true });
  const requestedIds = uids.split(",").map((value) => value.trim()).filter(Boolean);
  if (!(await ensureDeviceAccess(c, requestedIds))) {
    return c.json({ error: "One or more devices are outside your operational scope." }, 403);
  }
  try {
    return c.json(await fetchLastLocations(requestedIds));
  } catch (error: any) {
    return c.json({ error: "pocstars_locations_failed", message: error.message }, statusFromAxios(error));
  }
});

router.get("/history", async (c) => {
  const { uid, start, end } = c.req.query();
  if (!uid || !start || !end) return c.json({ error: "uid, start, end required" }, 400);
  if (!(await ensureDeviceAccess(c, [uid]))) {
    return c.json({ error: "That device is outside your operational scope." }, 403);
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
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 },
    );
    return c.json(data);
  } catch (error: any) {
    return c.json({ error: "pocstars_history_failed", message: error.message }, statusFromAxios(error));
  }
});

router.get("/sos", async (c) => {
  if (!isPlatformAdmin(c)) {
    return c.json({ error: "The raw POCSTARS SOS feed is restricted to platform administrators." }, 403);
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
    return c.json({ error: "pocstars_sos_failed", message: error.message }, statusFromAxios(error));
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
    return c.json({ error: "pocstars_sos_detail_failed", message: error.message }, statusFromAxios(error));
  }
});

export default router;
