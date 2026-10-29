// Smooth playback of a radio's GPS points.
//
// Handsets take a point every 5s but upload them in batches every 15-30s. Drawn
// as they arrive, a pin would sit still and then dart through a batch. So each
// radio is played back a little behind real time - about one batch gap - which
// means there is always a next point to move toward, and the pin moves through
// the real points at the pace they were taken. Uber does the same.
//
// The delay is also what lets noise be filtered properly: a point that drifts
// away from a still radio is only treated as movement once the point after it
// agrees, and by the time the pin gets there, that next point has arrived.

import { MOTION, bearingBetween, distanceMetres } from "./radio-motion.js";

export const PLAYBACK = {
  // Used until a radio's own batch rhythm has been measured.
  defaultDelayMs: 30_000,
  minDelayMs: 6_000,
  maxDelayMs: 45_000,
  // Head-room on top of the measured batch lag, so the pin rarely catches up
  // with the newest point and has to stop.
  marginMs: 2_000,
  // A shrinking delay pulls the pin forward; at most this much per batch.
  shrinkPerBatchMs: 2_000,
  lagSamples: 20,
  keepMs: 15 * 60_000,
};

// Points averaged into a still radio's resting position: about a minute at 5s.
const STILL_WINDOW = 12;

export function createTrack() {
  return { raw: [], path: [], lags: [], delayMs: PLAYBACK.defaultDelayMs, lastArrivalMs: null };
}

function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function speedBetween(a, b) {
  const sec = (b.t - a.t) / 1000;
  return sec > 0 ? distanceMetres(a, b) / sec : Infinity;
}

/**
 * The points worth moving through, from every raw point. Drift around a still
 * radio is dropped, a lone spike is dropped, a long gap or an impossible speed
 * becomes a jump, and a radio that sets off after standing still gets a
 * departure point so the move is not smeared across the time it stood there.
 */
export function buildPath(raw) {
  const path = [];
  let anchor = null;
  let prev = null;
  let lastStillT = null;
  // While a radio stands still its pin sits at the centre of its drift, not on
  // whichever point came first: measured from an edge of the cloud, ordinary
  // drift reaches twice as far and starts to look like a step.
  let still = [];
  const settle = (point) => {
    still = [point];
  };
  for (let index = 0; index < raw.length; index += 1) {
    const point = raw[index];
    if (!anchor) {
      anchor = point;
      prev = point;
      lastStillT = point.t;
      settle(point);
      path.push({ ...point, jump: false });
      continue;
    }
    const next = raw[index + 1];
    const gapSec = (point.t - prev.t) / 1000;
    if (speedBetween(prev, point) > MOTION.maxSpeedMs) {
      // Far from the point before and the point after: one bad fix.
      if (next && speedBetween(point, next) > MOTION.maxSpeedMs && speedBetween(prev, next) <= MOTION.maxSpeedMs) continue;
    }
    if (gapSec > MOTION.maxGlideGapSec || speedBetween(prev, point) > MOTION.maxSpeedMs) {
      path.push({ ...point, jump: true });
      anchor = point;
      prev = point;
      lastStillT = point.t;
      settle(point);
      continue;
    }
    prev = point;
    const distance = distanceMetres(anchor, point);
    const last = path[path.length - 1];
    const before = path[path.length - 2];
    const moving =
      before &&
      !last.jump &&
      distanceMetres(before, last) >= MOTION.minStepM &&
      point.t - last.t <= MOTION.stopAfterSec * 1000;
    if (distance < (moving ? MOTION.minStepM : MOTION.jitterM)) {
      if (!moving && distance < MOTION.jitterM * 0.6) {
        // The centre is the average of roughly the last minute of nearby
        // points, so it settles in the middle of the drift. Points further out
        // are left out: they may be a radio setting off, and must not drag its
        // resting place along behind it.
        lastStillT = point.t;
        still.push(point);
        if (still.length > STILL_WINDOW) still.shift();
        const centre = {
          lat: still.reduce((sum, p) => sum + p.lat, 0) / still.length,
          lon: still.reduce((sum, p) => sum + p.lon, 0) / still.length,
        };
        anchor = { ...anchor, ...centre };
        Object.assign(last, centre);
      }
      continue;
    }
    if (!moving) {
      // Starting to move has to be confirmed by the next point. With no next
      // point yet, wait: the playback delay means it is usually on its way.
      if (!next) break;
      // A real step carries on: the next point is further out, the same way.
      // Drift lands anywhere around the centre, often no further than before.
      const agrees =
        distanceMetres(anchor, next) > distance &&
        Math.abs(((bearingBetween(anchor, point) - bearingBetween(anchor, next) + 540) % 360) - 180) <= 45;
      if (!agrees) continue;
      if (lastStillT != null && lastStillT > anchor.t) path.push({ ...anchor, t: lastStillT, jump: false });
    }
    path.push({ ...point, jump: false });
    anchor = point;
    settle(point);
  }
  return path;
}

/**
 * Adds points to a radio's track. `live` points came off the stream as they
 * landed, so their arrival time says how far behind real time this radio's
 * batches run; backfilled points say nothing about that.
 */
export function addPoints(track, points, arrivalMs, { live = true } = {}) {
  const known = new Set(track.raw.map((point) => point.t));
  let added = 0;
  for (const point of points) {
    const t = Number(point.t);
    const lat = Number(point.lat);
    const lon = Number(point.lon);
    if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon) || known.has(t)) continue;
    known.add(t);
    track.raw.push({ lat, lon, t });
    added += 1;
    if (live) {
      track.lags.push(arrivalMs - t);
      if (track.lags.length > PLAYBACK.lagSamples) track.lags.shift();
    }
  }
  if (!added) return false;
  track.raw.sort((a, b) => a.t - b.t);
  const newest = track.raw[track.raw.length - 1].t;
  track.raw = track.raw.filter((point) => point.t >= newest - PLAYBACK.keepMs);
  track.path = buildPath(track.raw);
  if (live) {
    track.lastArrivalMs = arrivalMs;
    if (track.lags.length) {
      const target = Math.min(
        PLAYBACK.maxDelayMs,
        Math.max(PLAYBACK.minDelayMs, percentile(track.lags, 0.9) + PLAYBACK.marginMs),
      );
      track.delayMs = target >= track.delayMs ? target : Math.max(target, track.delayMs - PLAYBACK.shrinkPerBatchMs);
    }
  }
  return true;
}

/** Where the radio was at renderT, and how it was moving. */
export function sampleTrack(track, renderT) {
  const path = track.path;
  if (!path.length) return null;
  if (renderT <= path[0].t) return { lat: path[0].lat, lon: path[0].lon, moving: false, bearing: null, speedMs: 0 };
  for (let index = 0; index < path.length - 1; index += 1) {
    const a = path[index];
    const b = path[index + 1];
    if (renderT >= b.t) continue;
    // A jump is not a path: hold where the radio was last seen, then appear.
    if (b.jump) return { lat: a.lat, lon: a.lon, moving: false, bearing: null, speedMs: 0 };
    const f = (renderT - a.t) / (b.t - a.t);
    const step = distanceMetres(a, b);
    const moving = step >= MOTION.minStepM;
    return {
      lat: a.lat + (b.lat - a.lat) * f,
      lon: a.lon + (b.lon - a.lon) * f,
      moving,
      bearing: moving ? bearingBetween(a, b) : null,
      speedMs: moving ? step / ((b.t - a.t) / 1000) : 0,
    };
  }
  const last = path[path.length - 1];
  return { lat: last.lat, lon: last.lon, moving: false, bearing: null, speedMs: 0 };
}

/** The newest point received, whatever playback is showing. */
export function newestPoint(track) {
  return track.raw.length ? track.raw[track.raw.length - 1] : null;
}
