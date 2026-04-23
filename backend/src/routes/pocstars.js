"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../db");

const router = express.Router();

const LOC_BASE = process.env.POCSTARS_LOC_BASE || "http://102.221.238.124:9275";
const SOS_BASE = process.env.POCSTARS_SOS_BASE || "http://102.221.238.124:6891";
const DEFAULT_TARGET_UID = process.env.POCSTARS_TARGET_UID || "583";

const formUrlencoded = (obj) =>
  Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

// ── SSE + health tracking ─────────────────────────────────────────────────────

const sseClients = new Set();
let lastPocstarsOk = null;
let lastPocstarsErr = null;

function broadcastSse(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch {}
  }
}

// Helper: fetch SOS records from POCSTARS with up to 3 retries
async function fetchPocstarsSos(targetUid, extra = {}) {
  const params = { targetUid, status: 0, pageNum: 1, pageSize: 50, ...extra };
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await axios.get(`${SOS_BASE}/sos/mg/records`, { params, timeout: 8000 });
      lastPocstarsOk = Date.now();
      lastPocstarsErr = null;
      return data;
    } catch (err) {
      lastErr = err;
      lastPocstarsErr = err.message;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Helper: persist and broadcast a batch of POCSTARS SOS rows
async function persistAndBroadcast(rows) {
  for (const s of rows) {
    let lat = null, lon = null, locationRaw = null;
    try {
      const loc = typeof s.sosLocationAt === "string" ? JSON.parse(s.sosLocationAt) : s.sosLocationAt;
      lat = loc?.wgs84?.lat ?? null;
      lon = loc?.wgs84?.lon ?? null;
      locationRaw = s.sosLocationAt;
    } catch {}
    const inserted = await db.insertSosAlert({
      sos_msg_id:   s.sosMsgId,
      device_id:    String(s.sosFromId),
      device_name:  s.sosSendName || null,
      triggered_at: new Date(s.sosStamp),
      location_lat: lat,
      location_lon: lon,
      location_raw: locationRaw,
    });
    if (inserted) broadcastSse("sos_new", inserted);
  }
}

// Server-side poll: drives SSE for all connected clients independently
async function serverPollSos() {
  if (!sseClients.size) return;
  try {
    const data = await fetchPocstarsSos(DEFAULT_TARGET_UID);
    const rows = data?.data?.rows || [];
    await persistAndBroadcast(rows);
    // Broadcast health update
    broadcastSse("pocstars_health", { ok: true, ts: lastPocstarsOk });
  } catch (err) {
    broadcastSse("pocstars_health", { ok: false, err: err.message, ts: Date.now() });
  }
}

setInterval(serverPollSos, 12_000);

// ── Device registry CRUD ──────────────────────────────────────────────────────

router.get("/devices", async (_req, res) => {
  try {
    const devices = await db.listDevices();
    res.json({ devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/devices", async (req, res) => {
  const { device_id, name, company, operator, device_type, notes, active } = req.body;
  if (!device_id?.trim()) {
    return res.status(400).json({ error: "device_id is required" });
  }
  try {
    const device = await db.upsertDevice({
      device_id: device_id.trim(),
      name, company, operator, device_type, notes,
      active: active ?? true,
    });
    res.json({ device });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/devices/:device_id", async (req, res) => {
  try {
    const deleted = await db.deleteDevice(req.params.device_id);
    if (!deleted) return res.status(404).json({ error: "Device not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SOS SSE stream ────────────────────────────────────────────────────────────

router.get("/sos/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(":ok\n\n");

  sseClients.add(res);
  const hb = setInterval(() => {
    try { res.write(":heartbeat\n\n"); } catch {}
  }, 25_000);

  req.on("close", () => {
    clearInterval(hb);
    sseClients.delete(res);
  });
});

// ── SOS log ───────────────────────────────────────────────────────────────────

router.get("/sos/seen-ids", async (_req, res) => {
  try {
    const ids = await db.allSosMsgIds();
    res.json({ ids: [...ids] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/sos/log", async (_req, res) => {
  try {
    const alerts = await db.listSosAlerts();
    res.json({ alerts, pocstarsLastOk: lastPocstarsOk, pocstarsLastErr: lastPocstarsErr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/sos/:sosMsgId/acknowledge", async (req, res) => {
  const sosMsgId = parseInt(req.params.sosMsgId, 10);
  if (!sosMsgId) return res.status(400).json({ error: "invalid sosMsgId" });
  try {
    const alert = await db.acknowledgeSosAlert(sosMsgId);
    if (!alert) return res.status(404).json({ error: "alert not found or already acknowledged" });
    broadcastSse("sos_updated", alert);
    res.json({ alert });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/sos/:sosMsgId/resolve", async (req, res) => {
  const sosMsgId = parseInt(req.params.sosMsgId, 10);
  if (!sosMsgId) return res.status(400).json({ error: "invalid sosMsgId" });
  try {
    const alert = await db.resolveSosAlert(sosMsgId);
    if (!alert) return res.status(404).json({ error: "alert not found or already resolved" });
    broadcastSse("sos_updated", alert);
    res.json({ alert });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GPS proxy ─────────────────────────────────────────────────────────────────

router.get("/config", async (_req, res) => {
  const devices = await db.listDevices().catch(() => []);
  const active = devices.filter((d) => d.active);
  res.json({
    uids: active.map((d) => d.device_id),
    targetUid: DEFAULT_TARGET_UID,
  });
});

router.get("/locations", async (req, res) => {
  let uids = req.query.uids;
  if (!uids) {
    const devices = await db.listDevices().catch(() => []);
    uids = devices.filter((d) => d.active).map((d) => d.device_id).join(",");
  }
  if (!uids) return res.json({ code: 200, data: [], success: true });
  try {
    const { data } = await axios.post(
      `${LOC_BASE}/shanli/gps/api/locations/LastLocation`,
      formUrlencoded({ Uids: uids, CorrdinateType: "Wgs84" }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 8000 },
    );
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 502).json({
      error: "pocstars_locations_failed",
      message: err.message,
    });
  }
});

router.get("/history", async (req, res) => {
  const { uid, start, end } = req.query;
  if (!uid || !start || !end) {
    return res.status(400).json({ error: "uid, start, end required" });
  }
  const startStamp = new Date(start.replace(" ", "T") + "Z").getTime();
  const endStamp   = new Date(end.replace(" ", "T") + "Z").getTime();
  try {
    const { data } = await axios.post(
      `${LOC_BASE}/shanli/gps/api/trace/gethistory`,
      formUrlencoded({
        Uid: uid, CorrdinateType: "Wgs84",
        startDateTime: start, endDateTime: end,
        startDateTamp: startStamp, endDateTamp: endStamp,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 },
    );
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 502).json({
      error: "pocstars_history_failed",
      message: err.message,
    });
  }
});

router.get("/sos", async (req, res) => {
  const targetUid = req.query.targetUid || DEFAULT_TARGET_UID;
  if (!targetUid) return res.status(400).json({ error: "targetUid required" });
  const extra = {};
  if (req.query.status !== undefined) extra.status = req.query.status;
  if (req.query.cgId) extra.cgId = req.query.cgId;
  if (req.query.pageNum) extra.pageNum = req.query.pageNum;
  if (req.query.pageSize) extra.pageSize = req.query.pageSize;

  try {
    const data = await fetchPocstarsSos(targetUid, extra);
    const rows = data?.data?.rows || [];
    await persistAndBroadcast(rows);
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 502).json({
      error: "pocstars_sos_failed",
      message: err.message,
    });
  }
});

router.get("/sos/detail", async (req, res) => {
  const { sosMsgId } = req.query;
  if (!sosMsgId) return res.status(400).json({ error: "sosMsgId required" });
  try {
    const { data } = await axios.get(`${SOS_BASE}/sos/mg/detail`, {
      params: { sosMsgId }, timeout: 8000,
    });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 502).json({
      error: "pocstars_sos_detail_failed",
      message: err.message,
    });
  }
});

module.exports = router;
