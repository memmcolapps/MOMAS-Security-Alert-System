/**
 * One poll of every active radio's last position, shared by everyone.
 *
 * Each open map used to ask the vendor GPS service itself. This asks once every
 * few seconds, keeps the answer for the /locations route to serve, and stores
 * each fix it has not seen before so a tracked radio can draw its trail.
 *
 * It also stamps every row with FixSeenAt: when this server first saw that
 * fix. "How stale is this position" is judged by that, on our own clock,
 * rather than by the handset's GpsTime, whose timezone we do not control.
 */
import { env } from "../config";
import * as db from "../db";
import { fetchLastLocations } from "./locations";

type Snapshot = { at: number; rows: Map<string, any> };

const DEVICE_LIST_TTL_MS = 60_000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

let snapshot: Snapshot | null = null;
let started = false;
let polling = false;
let deviceIds = new Set<string>();
let deviceIdsAt = 0;
let lastPruneAt = 0;
// The last fix seen per radio, and when it was first seen.
const lastFix = new Map<string, { key: string; seenAt: number }>();

function fixKey(observedMs: number | null, lat: number, lon: number) {
  return `${observedMs ?? "none"}|${lat.toFixed(6)}|${lon.toFixed(6)}`;
}

// A row with no usable GPS time is keyed on position alone, so it is not
// recorded again on every poll.
function observedMs(row: any) {
  const raw = row.GpsTime || row.gpsTime || row.UpdateTime;
  const stamp = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(stamp) ? stamp : null;
}

async function activeDeviceIds() {
  if (Date.now() - deviceIdsAt < DEVICE_LIST_TTL_MS) return deviceIds;
  const devices = await db.listDevices({});
  deviceIds = new Set(devices.filter((device: any) => device.active).map((device: any) => String(device.device_id)));
  deviceIdsAt = Date.now();
  return deviceIds;
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const uids = await activeDeviceIds();
    if (!uids.size) {
      snapshot = { at: Date.now(), rows: new Map() };
      return;
    }
    const response = await fetchLastLocations([...uids]);
    const rows = Array.isArray(response?.data) ? response.data : [];
    const now = Date.now();
    const next = new Map<string, any>();
    const fresh: any[] = [];

    for (const row of rows) {
      const uid = String(row.Uid ?? row.uid ?? "");
      if (!uid) continue;
      const lat = Number(row.Lat ?? row.lat);
      const lon = Number(row.Lng ?? row.lng ?? row.Lon ?? row.lon);
      const usable = Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
      if (!usable) {
        next.set(uid, row);
        continue;
      }
      const observed = observedMs(row);
      const key = fixKey(observed, lat, lon);
      const previous = lastFix.get(uid);
      if (previous?.key !== key) {
        lastFix.set(uid, { key, seenAt: now });
        fresh.push({ device_id: uid, lat, lon, observed_at: new Date(observed ?? now), received_at: new Date(now) });
      }
      next.set(uid, { ...row, FixSeenAt: new Date(lastFix.get(uid)!.seenAt).toISOString() });
    }

    snapshot = { at: now, rows: next };
    if (fresh.length) await db.insertRadioPositions(fresh);
    if (now - lastPruneAt > PRUNE_EVERY_MS) {
      lastPruneAt = now;
      const cutoff = new Date(now - env.RADIO_TRACK_RETENTION_DAYS * 86_400_000);
      await db.pruneRadioPositions(cutoff);
    }
  } catch (error: any) {
    console.warn("[RadioTrack] position poll failed:", error?.message || error);
  } finally {
    polling = false;
  }
}

/**
 * The latest positions for these radios, or null when the shared poll cannot
 * answer for all of them freshly - the caller then asks the vendor itself.
 */
export function recordedLocations(uids: string[]) {
  if (!snapshot) return null;
  const maxAgeMs = env.RADIO_TRACK_POLL_SEC * 2000 + 2000;
  if (Date.now() - snapshot.at > maxAgeMs) return null;
  const data: any[] = [];
  for (const uid of uids) {
    // A radio that joined since the device list was cached is not in the
    // snapshot yet; it must not silently vanish from the map.
    if (!deviceIds.has(uid)) return null;
    const row = snapshot.rows.get(uid);
    if (row) data.push(row);
  }
  return { code: 200, data, success: true };
}

export async function startRadioPositionRecorder() {
  if (started || !env.RADIO_TRACK_ENABLE) return;
  started = true;
  try {
    for (const row of await db.latestRadioPositions()) {
      lastFix.set(String(row.device_id), {
        key: fixKey(new Date(row.observed_at).getTime(), Number(row.lat), Number(row.lon)),
        seenAt: new Date(row.received_at).getTime(),
      });
    }
  } catch (error: any) {
    console.warn("[RadioTrack] could not load last fixes:", error?.message || error);
  }
  void poll();
  setInterval(() => void poll(), env.RADIO_TRACK_POLL_SEC * 1000);
  console.log(`[RadioTrack] recording radio positions every ${env.RADIO_TRACK_POLL_SEC}s`);
}
