import axios from "axios";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Hono } from "hono";
import { canManageOrganization, primaryOrganization, requireAuth } from "../auth";
import { env } from "../config";
import * as db from "../db";
import { bus } from "../events";
import { fetchLastLocations } from "../pocstars/locations";
import { actionMessage, describeSyncFailure } from "../pocstars/messages";

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
const MEDIA_BASE = env.POCSTARS_MEDIA_BASE;
const RECORDINGS_BASE = env.POCSTARS_RECORDINGS_BASE;
const RECORDINGS_USERNAME = env.POCSTARS_RECORDINGS_USERNAME;
const RECORDINGS_PASSWORD = env.POCSTARS_RECORDINGS_PASSWORD;
const DEFAULT_TARGET_UID = env.POCSTARS_TARGET_UID;
const DISPATCHER_UID = env.POCSTARS_DISPATCHER_UID;
const RECORDING_TICKET_TTL_MS = 10 * 60 * 1000;
const RECORDING_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RECORDING_BYTES = 20 * 1024 * 1024;

type RecordingTicket = {
  path: string;
  speakerUserId: string;
  expiresAt: number;
};

const recordingTickets = new Map<string, RecordingTicket>();
const ticketByRecording = new Map<string, string>();
const transcodedRecordingCache = new Map<string, { data: Buffer; expiresAt: number }>();

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
let lastPocstarsReconcileAt: number | null = null;
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

function cleanRecordingCaches() {
  const now = Date.now();
  for (const [token, ticket] of recordingTickets) {
    if (ticket.expiresAt > now) continue;
    recordingTickets.delete(token);
    ticketByRecording.delete(`${ticket.speakerUserId}:${ticket.path}`);
  }
  for (const [path, entry] of transcodedRecordingCache) {
    if (entry.expiresAt <= now) transcodedRecordingCache.delete(path);
  }
}

function recordingTicket(path: string, speakerUserId: string) {
  cleanRecordingCaches();
  const key = `${speakerUserId}:${path}`;
  const currentToken = ticketByRecording.get(key);
  const current = currentToken ? recordingTickets.get(currentToken) : null;
  if (current && current.expiresAt > Date.now()) return currentToken as string;

  const token = crypto.randomBytes(24).toString("base64url");
  recordingTickets.set(token, {
    path,
    speakerUserId,
    expiresAt: Date.now() + RECORDING_TICKET_TTL_MS,
  });
  ticketByRecording.set(key, token);
  return token;
}

function basicRecordingAuthorization() {
  if (!RECORDINGS_USERNAME || !RECORDINGS_PASSWORD) return null;
  return `Basic ${Buffer.from(`${RECORDINGS_USERNAME}:${RECORDINGS_PASSWORD}`).toString("base64")}`;
}

function recordingFileUrl(path: string) {
  const base = RECORDINGS_BASE.endsWith("/") ? RECORDINGS_BASE : `${RECORDINGS_BASE}/`;
  return new URL(String(path).replace(/^\/+/, ""), base).toString();
}

async function transcodeAmrToMp3(rawAudio: Buffer) {
  const input = rawAudio.subarray(0, 6).toString("ascii") === "#!AMR\n"
    ? rawAudio
    : Buffer.concat([Buffer.from("#!AMR\n"), rawAudio]);

  return new Promise<Buffer>((resolve, reject) => {
    const process = spawn(
      ffmpeg.path,
      [
        "-hide_banner",
        "-loglevel",
        "fatal",
        "-f",
        "amr",
        "-i",
        "pipe:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "32k",
        "-f",
        "mp3",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;

    process.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_RECORDING_BYTES) {
        process.kill();
        reject(new Error("Transcoded radio clip exceeded the size limit."));
        return;
      }
      output.push(chunk);
    });
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      const result = Buffer.concat(output);
      const hasMp3Header =
        result.subarray(0, 3).toString("ascii") === "ID3" ||
        (result[0] === 0xff && (result[1] & 0xe0) === 0xe0);
      if (!result.length || (code !== 0 && !hasMp3Header)) {
        const detail = Buffer.concat(errors).toString("utf8").trim().slice(0, 500);
        reject(new Error(detail || "POCSTARS radio audio could not be decoded."));
        return;
      }
      resolve(result);
    });
    process.stdin.end(input);
  });
}

async function fetchAndTranscodeRecording(path: string) {
  cleanRecordingCaches();
  const cached = transcodedRecordingCache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const authorization = basicRecordingAuthorization();
  if (!authorization) {
    const error: any = new Error("Radio recording access is not configured.");
    error.status = 503;
    throw error;
  }

  const response = await fetch(recordingFileUrl(path), {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const error: any = new Error(`POCSTARS recording server returned ${response.status}.`);
    error.status = 502;
    throw error;
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_RECORDING_BYTES) {
    const error: any = new Error("Radio clip is too large to play.");
    error.status = 413;
    throw error;
  }
  const raw = Buffer.from(await response.arrayBuffer());
  if (!raw.length) {
    const error: any = new Error("POCSTARS returned an empty radio clip.");
    error.status = 502;
    throw error;
  }
  if (raw.length > MAX_RECORDING_BYTES) {
    const error: any = new Error("Radio clip is too large to play.");
    error.status = 413;
    throw error;
  }

  const data = await transcodeAmrToMp3(raw);
  if (transcodedRecordingCache.size >= 100) {
    const oldest = transcodedRecordingCache.keys().next().value;
    if (oldest) transcodedRecordingCache.delete(oldest);
  }
  transcodedRecordingCache.set(path, {
    data,
    expiresAt: Date.now() + RECORDING_CACHE_TTL_MS,
  });
  return data;
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

function upstreamDate(value: unknown) {
  const stamp = Number(value);
  return Number.isFinite(stamp) && stamp > 0 ? new Date(stamp) : null;
}

async function reconcileAndBroadcast(rows: any[]) {
  for (const row of rows) {
    const upstreamStatus = Number(row.sosStatus ?? row.status);
    if (![1, 2].includes(upstreamStatus)) continue;
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
    error.status = upstreamCode === 501 ? 403 : [502, 503, 504].includes(upstreamCode) ? 409 : 502;
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
  if (!sosMsgId) return c.json({ error: "invalid_alarm_reference", message: "Invalid alarm reference." }, 400);
  if (!DISPATCHER_UID) {
    return c.json(
      { error: "alarm_dispatch_not_configured", message: actionMessage("alarm_dispatch_not_configured") },
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

  const start = await db.beginSosAction(sosMsgId, action, user?.id, orgScope(c));
  if (start.state === "not_found") {
    return c.json({ error: "alarm_not_found", message: actionMessage("alarm_not_found") }, 404);
  }
  if (start.state === "syncing") {
    return c.json(
      { error: "alarm_action_in_progress", message: actionMessage("alarm_action_in_progress"), alert: start.alert },
      409,
    );
  }
  if (start.state === "invalid_status") {
    const code = INVALID_STATUS_CODES[action];
    return c.json({ error: code, message: actionMessage(code), alert: start.alert }, 409);
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
    const alert = await db.failSosAction(sosMsgId, action, user?.id, message, detail);
    broadcastSse("sos_updated", alert);
    bus.emit("pocstars-alert:updated", alert);
    return c.json(
      { error: error?.code || "alarm_radio_sync_failed", message, alert },
      error?.status || statusFromAxios(error),
    );
  }
}

async function syncPocstarsSos({ notifyHealth = true } = {}) {
  if (sosSyncRunning) return;
  sosSyncRunning = true;
  try {
    // New alarms are imported. Processing/resolved rows only reconcile records
    // MOMAS already knows about, so polling cannot backfill the vendor archive.
    const newData = await fetchPocstarsSos(DEFAULT_TARGET_UID, { status: 0, pageSize: 50 });
    await persistAndBroadcast(newData?.data?.rows || []);

    // Alarm-list requests can also trigger a sync, so keep the heavier archive
    // reads on their own cadence instead of tripling vendor traffic per request.
    const reconcileDue = !lastPocstarsReconcileAt || Date.now() - lastPocstarsReconcileAt >= 30_000;
    if (reconcileDue) {
      const [processingData, resolvedData] = await Promise.all([
        fetchPocstarsSos(DEFAULT_TARGET_UID, { status: 1, pageSize: 200 }),
        fetchPocstarsSos(DEFAULT_TARGET_UID, { status: 2, pageSize: 200 }),
      ]);
      await reconcileAndBroadcast(processingData?.data?.rows || []);
      await reconcileAndBroadcast(resolvedData?.data?.rows || []);
      lastPocstarsReconcileAt = Date.now();
    }
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
router.post("/alarms/:sosMsgId/reopen", (c) => handleSosAction(c, "reopen"));

router.get("/radio/recordings", async (c) => {
  const query = c.req.query();
  const pageIndex = Math.max(1, Number.parseInt(query.pageIndex || "1", 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(query.pageSize || "20", 10) || 20));
  const speakerUserId = String(query.speakerUserId || "").trim();
  const groupName = String(query.groupName || "").trim().slice(0, 200);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || "") ? query.from : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || "") ? query.to : "";

  if (!DISPATCHER_UID) {
    return c.json({ error: "radio_recordings_not_configured", message: "Radio recordings are not configured." }, 503);
  }
  if (speakerUserId && !(await ensureDeviceAccess(c, [speakerUserId]))) {
    return c.json({ error: "forbidden", message: "That radio is outside your operational scope." }, 403);
  }

  try {
    const devices = await db.listDevices(orgScope(c));
    const allowedSpeakers = new Set(devices.map((device: any) => String(device.device_id)));
    const form: Record<string, unknown> = {
      pageIndex,
      pageSize,
      uid: DISPATCHER_UID,
    };
    if (groupName) form.groupName = groupName;
    if (from || to) form.callIdDate = `${from || to} ~ ${to || from}`;

    const { data } = await axios.post(
      `${LOC_BASE.replace(/\/$/, "")}/speakRecord/queryList`,
      formUrlencoded(form),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15_000,
      },
    );
    if (data?.success === false || Number(data?.code) !== 200) {
      return c.json({
        error: "pocstars_recordings_failed",
        message: data?.message || "POCSTARS did not return radio recordings.",
      }, 502);
    }

    const rows = Array.isArray(data?.data?.speakRecordList) ? data.data.speakRecordList : [];
    const recordings = rows
      .filter((row: any) => {
        const rowSpeaker = String(row.Rc_SpeakerUserID ?? "");
        if (!row.Rc_SavePath || !rowSpeaker) return false;
        if (speakerUserId && rowSpeaker !== speakerUserId) return false;
        return isPlatformAdmin(c) || allowedSpeakers.has(rowSpeaker);
      })
      .map((row: any) => {
        const rowSpeaker = String(row.Rc_SpeakerUserID);
        return {
          id: String(row.Rc_ID),
          groupId: row.Rc_ChatGroupID == null ? null : String(row.Rc_ChatGroupID),
          groupName: row.Rc_ChatGroupName || null,
          groupType: row.Rc_GroupType ?? null,
          speakerUserId: rowSpeaker,
          speakerName: row.Rc_SpeakerUserName || null,
          startedAt: row.Rc_SpeakStartTime || row.SpeakStartTime || null,
          durationMs: Number(row.Rc_SpeakTimeOfMilliSecond || 0),
          codec: String(row.Rc_CodeFormat || ""),
          playbackToken: recordingTicket(String(row.Rc_SavePath), rowSpeaker),
        };
      });

    return c.json({
      recordings,
      pageIndex: Number(data?.data?.pageIndex || pageIndex),
      pageSize: Number(data?.data?.pageSize || pageSize),
      pageCount: Number(data?.data?.pageCount || 0),
      refreshAfterMs: 3_000,
    });
  } catch (error: any) {
    return c.json({
      error: "pocstars_recordings_failed",
      message: "Radio traffic is temporarily unavailable.",
    }, statusFromAxios(error));
  }
});

router.get("/radio/recordings/:token/audio", async (c) => {
  cleanRecordingCaches();
  const token = c.req.param("token");
  const ticket = recordingTickets.get(token);
  if (!ticket || ticket.expiresAt <= Date.now()) {
    return c.json({ error: "recording_link_expired", message: "Refresh the radio traffic list and try again." }, 410);
  }
  if (!(await ensureDeviceAccess(c, [ticket.speakerUserId]))) {
    return c.json({ error: "forbidden", message: "That radio is outside your operational scope." }, 403);
  }

  try {
    const audio = await fetchAndTranscodeRecording(ticket.path);
    return new Response(audio, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audio.length),
        "Cache-Control": "private, max-age=300",
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error: any) {
    return c.json({
      error: "pocstars_recording_playback_failed",
      message: error?.message || "This radio clip could not be played.",
    }, error?.status || 502);
  }
});

router.post("/radio/messages", async (c) => {
  const user = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  const deviceId = String(body.device_id || "").trim();
  const message = String(body.message || "").trim();

  if (!deviceId) {
    return c.json({ error: "device_required", message: "Choose a radio before sending." }, 400);
  }
  if (!message) {
    return c.json({ error: "message_required", message: "Enter a message to send." }, 400);
  }
  if (Buffer.byteLength(message, "utf8") > 200) {
    return c.json({
      error: "message_too_long",
      message: "POCSTARS radio messages are limited to 200 bytes.",
    }, 400);
  }
  if (!DISPATCHER_UID) {
    return c.json({
      error: "radio_messaging_not_configured",
      message: "Radio messaging is not configured.",
    }, 503);
  }

  try {
    const devices = await db.listDevices(orgScope(c));
    const device = devices.find((row: any) => String(row.device_id) === deviceId);
    if (!device) {
      return c.json({
        error: "forbidden",
        message: "That radio is outside your operational scope.",
      }, 403);
    }

    const { data } = await axios.post(
      `${MEDIA_BASE.replace(/\/$/, "")}/api/v1/media/send`,
      formUrlencoded({
        msg: message,
        msg_descriptor: message,
        from: DISPATCHER_UID,
        from_name: "MOMAS Command",
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
      return c.json({
        error: "pocstars_message_failed",
        message: data?.message || data?.response?.message || "POCSTARS rejected the message.",
      }, 502);
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
    return c.json({
      error: "pocstars_message_failed",
      message: "The radio message could not be sent.",
    }, statusFromAxios(error));
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
