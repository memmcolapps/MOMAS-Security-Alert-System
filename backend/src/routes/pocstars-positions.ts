import { Hono } from "hono";
import * as db from "../db";
import { bus } from "../events";
import { fetchLastLocations } from "../pocstars/locations";
import { recordedLocations } from "../pocstars/position-recorder";
import { ensureDeviceAccess, isPlatformAdmin, orgScope, statusFromAxios } from "./pocstars-helpers";

// Radio positions: the latest fix per radio, the live point stream, trails,
// replay and coverage. Mounted inside routes/pocstars.ts, which applies
// sign-in to everything here.
const router = new Hono();

// Every open map polls this. Normally the shared position recorder answers it
// without touching the vendor; when it cannot, tabs asking for the same radios
// within a few seconds share one upstream call. Only this route is cached: the
// geofence engine calls fetchLastLocations directly and needs every fix as
// soon as it lands. Kept under the map's fastest poll (5 s, used when the live
// stream is down) so a moving radio still moves on every refresh.
const LOCATIONS_CACHE_MS = 4_000;
const locationsCache = new Map<string, { at: number; value: Promise<any> }>();

function cachedLastLocations(uids: string[]) {
  const key = [...new Set(uids)].sort().join(",");
  const now = Date.now();
  for (const [cachedKey, entry] of locationsCache) {
    if (now - entry.at >= LOCATIONS_CACHE_MS) locationsCache.delete(cachedKey);
  }
  const hit = locationsCache.get(key);
  if (hit) return hit.value;
  const value = fetchLastLocations(uids);
  const entry = { at: now, value };
  locationsCache.set(key, entry);
  value.catch(() => {
    if (locationsCache.get(key) === entry) locationsCache.delete(key);
  });
  return value;
}

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
  const requestedIds = uids
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!(await ensureDeviceAccess(c, requestedIds))) {
    return c.json(
      { error: "One or more devices are outside your operational scope." },
      403,
    );
  }
  try {
    return c.json(
      recordedLocations(requestedIds) ??
        (await cachedLastLocations(requestedIds)),
    );
  } catch (error: any) {
    return c.json(
      { error: "pocstars_locations_failed", message: error.message },
      statusFromAxios(error),
    );
  }
});

// The radios a request may see, or null for the whole estate. Same rule as
// ensureDeviceAccess, computed once so a stream can filter every batch.
async function visibleDeviceIds(c: any): Promise<Set<string> | null> {
  if (isPlatformAdmin(c)) return null;
  return new Set(
    (await db.listDevices(orgScope(c))).map((device: any) =>
      String(device.device_id),
    ),
  );
}

// Recent points for every radio the caller can see, so an opening map has a
// few batches to play before the live stream delivers its first.
router.get("/positions/recent", async (c) => {
  const seconds = Math.min(
    Math.max(Number(c.req.query("seconds")) || 90, 10),
    600,
  );
  try {
    const visible = await visibleDeviceIds(c);
    const rows = await db.listRecentRadioPoints(
      visible ? [...visible] : null,
      new Date(Date.now() - seconds * 1000),
    );
    return c.json({
      points: rows.map((row: any) => ({
        uid: String(row.device_id),
        lat: Number(row.lat),
        lon: Number(row.lon),
        t: new Date(row.observed_at).getTime(),
      })),
    });
  } catch (error: any) {
    return c.json(
      { error: "radio_points_failed", message: error.message },
      500,
    );
  }
});

// Each batch of points as it arrives from the bridge, filtered to the radios
// this viewer can see. The registry is re-read every minute so a radio moved
// between organizations stops (or starts) streaming without a reconnect.
router.get("/positions/stream", async (c) => {
  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array>();
  const writer = stream.writable.getWriter();
  let visible = await visibleDeviceIds(c).catch(() => new Set<string>());
  const write = (chunk: string) =>
    writer.write(encoder.encode(chunk)).catch(() => cleanup());
  const onPoints = (points: any[]) => {
    const mine = visible
      ? points.filter((point) => visible!.has(String(point.uid)))
      : points;
    if (mine.length)
      void write(`event: points\ndata: ${JSON.stringify(mine)}\n\n`);
  };
  const refresh = setInterval(() => {
    void visibleDeviceIds(c)
      .then((next) => (visible = next))
      .catch(() => {});
  }, 60_000);
  const heartbeat = setInterval(() => void write(":heartbeat\n\n"), 25_000);
  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(refresh);
    clearInterval(heartbeat);
    bus.off("radio-points", onPoints);
    void writer.close().catch(() => {});
  }
  bus.on("radio-points", onPoints);
  void write(":ok\n\n");
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

// Replay: one radio's points between two moments, at most a day at a time.
const REPLAY_MAX_MS = 24 * 3600_000;

router.get("/locations/:uid/replay", async (c) => {
  const uid = c.req.param("uid");
  if (!(await ensureDeviceAccess(c, [uid]))) {
    return c.json(
      { error: "That device is outside your operational scope." },
      403,
    );
  }
  const to = new Date(c.req.query("to") || Date.now());
  const from = new Date(c.req.query("from") || to.getTime() - 3600_000);
  if (
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from >= to
  ) {
    return c.json({ error: "from and to must be times, from before to." }, 400);
  }
  if (to.getTime() - from.getTime() > REPLAY_MAX_MS) {
    return c.json({ error: "Replay covers at most 24 hours at a time." }, 400);
  }
  try {
    const rows = await db.listRadioTrackBetween(uid, from, to);
    return c.json({
      uid,
      from: from.toISOString(),
      to: to.toISOString(),
      points: rows.map((row: any) => ({
        lat: Number(row.lat),
        lon: Number(row.lon),
        t: new Date(row.observed_at).getTime(),
      })),
    });
  } catch (error: any) {
    return c.json(
      { error: "radio_replay_failed", message: error.message },
      500,
    );
  }
});

// Fleet replay: every radio this viewer can see that reported between two
// moments. Radios whose fixes stayed within a few tens of metres (a handset on
// a desk, drifting) come back as a summary only; the rest carry their route,
// thinned so a whole day stays a few hundred kilobytes. Points are
// [seconds after from, lat, lon] to keep the payload small.
const FLEET_REPLAY_SPREAD_M = 60;
router.get("/positions/replay", async (c) => {
  const to = new Date(c.req.query("to") || Date.now());
  const from = new Date(c.req.query("from") || to.getTime() - 3600_000);
  if (
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from >= to
  ) {
    return c.json({ error: "from and to must be times, from before to." }, 400);
  }
  if (to.getTime() - from.getTime() > REPLAY_MAX_MS) {
    return c.json({ error: "Replay covers at most 24 hours at a time." }, 400);
  }
  const spanSec = (to.getTime() - from.getTime()) / 1000;
  const bucketSec = Math.min(30, Math.max(5, Math.round(spanSec / 3000)));
  try {
    const visible = await visibleDeviceIds(c);
    const summary = await db.radioReplaySummary(
      visible ? [...visible] : null,
      from,
      to,
    );
    const travelling = summary
      .filter((row: any) => Number(row.extent_m) >= FLEET_REPLAY_SPREAD_M)
      .map((row: any) => String(row.device_id));
    const tracks = new Map<string, number[][]>();
    if (travelling.length) {
      for (const row of await db.radioReplayTracks(
        travelling,
        from,
        to,
        bucketSec,
      )) {
        const uid = String(row.device_id);
        if (!tracks.has(uid)) tracks.set(uid, []);
        tracks
          .get(uid)!
          .push([
            Math.round(
              (new Date(row.observed_at).getTime() - from.getTime()) / 1000,
            ),
            Number(Number(row.lat).toFixed(6)),
            Number(Number(row.lon).toFixed(6)),
          ]);
      }
    }
    return c.json({
      from: from.toISOString(),
      to: to.toISOString(),
      bucketSec,
      radios: summary.map((row: any) => {
        const uid = String(row.device_id);
        return {
          uid,
          fixes: row.fixes,
          firstAt: new Date(row.first_at).getTime(),
          lastAt: new Date(row.last_at).getTime(),
          lat: Number(row.lat),
          lon: Number(row.lon),
          spreadM: Math.round(Number(row.extent_m)),
          points: tracks.get(uid) || null,
        };
      }),
    });
  } catch (error: any) {
    return c.json(
      { error: "fleet_replay_failed", message: error.message },
      500,
    );
  }
});

// Patrol coverage: where the radios this viewer can see have been in the last
// few hours, as grid squares carrying when each was last visited.
const COVERAGE_CELL_DEG = 0.0005; // about 55 m
router.get("/positions/coverage", async (c) => {
  const hours = Math.min(Math.max(Number(c.req.query("hours")) || 4, 1), 72);
  try {
    const visible = await visibleDeviceIds(c);
    const rows = await db.radioCoverage(
      visible ? [...visible] : null,
      new Date(Date.now() - hours * 3600_000),
      COVERAGE_CELL_DEG,
    );
    return c.json({
      hours,
      cellDeg: COVERAGE_CELL_DEG,
      cells: rows.map((row: any) => ({
        lat: Number(row.gy) * COVERAGE_CELL_DEG,
        lon: Number(row.gx) * COVERAGE_CELL_DEG,
        fixes: row.fixes,
        radios: row.radios,
        lastAt: new Date(row.last_at).getTime(),
      })),
    });
  } catch (error: any) {
    return c.json(
      { error: "radio_coverage_failed", message: error.message },
      500,
    );
  }
});

const TRACK_MAX_MINUTES = 240;

// The trail behind a tracked radio, from the fixes the position recorder kept.
router.get("/locations/:uid/track", async (c) => {
  const uid = c.req.param("uid");
  if (!(await ensureDeviceAccess(c, [uid]))) {
    return c.json(
      { error: "That device is outside your operational scope." },
      403,
    );
  }
  const minutes = Math.min(
    Math.max(Number(c.req.query("minutes")) || 30, 1),
    TRACK_MAX_MINUTES,
  );
  try {
    const since = new Date(Date.now() - minutes * 60_000);
    const rows = await db.listRadioTrack(uid, since);
    return c.json({
      uid,
      minutes,
      points: rows.map((row: any) => ({
        lat: Number(row.lat),
        lon: Number(row.lon),
        observed_at: new Date(row.observed_at).toISOString(),
        received_at: new Date(row.received_at).toISOString(),
      })),
    });
  } catch (error: any) {
    return c.json({ error: "radio_track_failed", message: error.message }, 500);
  }
});

// The trails behind several tracked radios at once, so a split screen of
// tracked radios costs one request rather than one per tile.
const TRACKS_MAX_RADIOS = 200;
router.get("/locations/tracks", async (c) => {
  const uids = [
    ...new Set(
      String(c.req.query("uids") || "")
        .split(",")
        .map((uid) => uid.trim())
        .filter(Boolean),
    ),
  ].slice(0, TRACKS_MAX_RADIOS);
  if (!uids.length) return c.json({ minutes: 0, tracks: {} });
  if (!(await ensureDeviceAccess(c, uids))) {
    return c.json(
      { error: "That device is outside your operational scope." },
      403,
    );
  }
  const minutes = Math.min(
    Math.max(Number(c.req.query("minutes")) || 30, 1),
    TRACK_MAX_MINUTES,
  );
  try {
    const since = new Date(Date.now() - minutes * 60_000);
    const rows = await db.listRadioTracks(uids, since);
    const tracks: Record<string, any[]> = Object.fromEntries(
      uids.map((uid) => [uid, []]),
    );
    for (const row of rows) {
      tracks[String(row.device_id)]?.push({
        lat: Number(row.lat),
        lon: Number(row.lon),
        observed_at: new Date(row.observed_at).toISOString(),
        received_at: new Date(row.received_at).toISOString(),
      });
    }
    return c.json({ minutes, tracks });
  } catch (error: any) {
    return c.json(
      { error: "radio_tracks_failed", message: error.message },
      500,
    );
  }
});

export default router;
