import axios from "axios";
import { Hono } from "hono";
import { env } from "../config";
import * as db from "../db";

type SseClient = {
  write: (chunk: string) => Promise<void>;
  close: () => Promise<void>;
};

const router = new Hono();
const encoder = new TextEncoder();
const sseClients = new Set<SseClient>();

const LOC_BASE = env.POCSTARS_LOC_BASE;
const SOS_BASE = env.POCSTARS_SOS_BASE;
const DEFAULT_TARGET_UID = env.POCSTARS_TARGET_UID;

let lastPocstarsOk: number | null = null;
let lastPocstarsErr: string | null = null;

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

function sseResponse(signal: AbortSignal) {
  const stream = new TransformStream<Uint8Array>();
  const writer = stream.writable.getWriter();
  const client: SseClient = {
    write: (chunk) => writer.write(encoder.encode(chunk)),
    close: () => writer.close(),
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
      lat = loc?.wgs84?.lat ?? null;
      lon = loc?.wgs84?.lon ?? null;
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
    });
    if (inserted) broadcastSse("sos_new", inserted);
  }
}

async function serverPollSos() {
  if (!sseClients.size) return;
  try {
    const data = await fetchPocstarsSos(DEFAULT_TARGET_UID);
    const rows = data?.data?.rows || [];
    await persistAndBroadcast(rows);
    broadcastSse("pocstars_health", { ok: true, ts: lastPocstarsOk });
  } catch (error: any) {
    broadcastSse("pocstars_health", { ok: false, err: error.message, ts: Date.now() });
  }
}

setInterval(serverPollSos, 12_000);

router.get("/devices", async (c) => {
  try {
    const devices = await db.listDevices();
    return c.json({ devices });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/devices", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { device_id, name, company, operator, device_type, notes, active } = body;
  if (!device_id?.trim()) return c.json({ error: "device_id is required" }, 400);

  try {
    const device = await db.upsertDevice({
      device_id: device_id.trim(),
      name,
      company,
      operator,
      device_type,
      notes,
      active: active ?? true,
    });
    return c.json({ device });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.delete("/devices/:device_id", async (c) => {
  try {
    const deleted = await db.deleteDevice(c.req.param("device_id"));
    if (!deleted) return c.json({ error: "Device not found" }, 404);
    return c.json({ ok: true });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/sos/events", (c) => sseResponse(c.req.raw.signal));

router.get("/sos/seen-ids", async (c) => {
  try {
    const ids = await db.allSosMsgIds();
    return c.json({ ids: [...ids] });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/sos/log", async (c) => {
  try {
    const alerts = await db.listSosAlerts();
    return c.json({ alerts, pocstarsLastOk: lastPocstarsOk, pocstarsLastErr: lastPocstarsErr });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/sos/:sosMsgId/acknowledge", async (c) => {
  const sosMsgId = parseInt(c.req.param("sosMsgId"), 10);
  if (!sosMsgId) return c.json({ error: "invalid sosMsgId" }, 400);
  try {
    const alert = await db.acknowledgeSosAlert(sosMsgId);
    if (!alert) return c.json({ error: "alert not found or already acknowledged" }, 404);
    broadcastSse("sos_updated", alert);
    return c.json({ alert });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/sos/:sosMsgId/resolve", async (c) => {
  const sosMsgId = parseInt(c.req.param("sosMsgId"), 10);
  if (!sosMsgId) return c.json({ error: "invalid sosMsgId" }, 400);
  try {
    const alert = await db.resolveSosAlert(sosMsgId);
    if (!alert) return c.json({ error: "alert not found or already resolved" }, 404);
    broadcastSse("sos_updated", alert);
    return c.json({ alert });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/config", async (c) => {
  const devices = await db.listDevices().catch(() => []);
  const active = devices.filter((device: any) => device.active);
  return c.json({
    uids: active.map((device: any) => device.device_id),
    targetUid: DEFAULT_TARGET_UID,
  });
});

router.get("/locations", async (c) => {
  let uids = c.req.query("uids");
  if (!uids) {
    const devices = await db.listDevices().catch(() => []);
    uids = devices
      .filter((device: any) => device.active)
      .map((device: any) => device.device_id)
      .join(",");
  }
  if (!uids) return c.json({ code: 200, data: [], success: true });
  try {
    const { data } = await axios.post(
      `${LOC_BASE}/shanli/gps/api/locations/LastLocation`,
      formUrlencoded({ Uids: uids, CorrdinateType: "Wgs84" }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 8000 },
    );
    return c.json(data);
  } catch (error: any) {
    return c.json({ error: "pocstars_locations_failed", message: error.message }, statusFromAxios(error));
  }
});

router.get("/history", async (c) => {
  const { uid, start, end } = c.req.query();
  if (!uid || !start || !end) return c.json({ error: "uid, start, end required" }, 400);
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
