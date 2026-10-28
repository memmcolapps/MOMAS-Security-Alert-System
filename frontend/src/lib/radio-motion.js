// How a radio's pin moves between fixes. Kept out of the map component so the
// rules - which fixes count as movement, which are GPS noise, when to glide and
// when to jump - can be tested without Leaflet.
//
// The vendor gives us a position and a time, nothing about how good the fix
// is. Indoors that matters: a handset on a desk drifts tens of metres, and one
// that walks out of a building reappears somewhere else after minutes of
// silence. So movement has to be earned (MOTION.confirmFixes fixes that agree),
// small drift is ignored, and a gap or an impossible speed is a jump, never an
// animated path drawn through walls.

export const MOTION = {
  // Drift below this, from where the pin stands, is treated as GPS noise.
  jitterM: 25,
  // Once a radio is moving, a smaller step still counts as moving on.
  minStepM: 8,
  // Consecutive fixes, in roughly the same direction, before a still radio is
  // allowed to start moving.
  confirmFixes: 2,
  // A handheld or a vehicle on Nigerian roads; anything faster is a bad fix
  // or a long gap, and the pin jumps rather than slides.
  maxSpeedMs: 70,
  // A gap between fixes longer than this is a jump: whatever path the radio
  // took in between is unknown.
  maxGlideGapSec: 120,
  // Longest a single glide is drawn over. Fixes further apart than this are
  // shown late rather than slowly.
  glideMaxMs: 8000,
  glideMinMs: 800,
  // How long since the last movement before the direction arrow is dropped.
  stopAfterSec: 90,
  // A position the server has not seen change for this long is marked stale.
  staleSec: 180,
};

const EARTH_RADIUS_M = 6371000;
const toRad = (value) => (value * Math.PI) / 180;
const toDeg = (value) => (value * 180) / Math.PI;

export function distanceMetres(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function bearingBetween(a, b) {
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function angleBetween(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function stamp(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A /locations row reduced to what motion needs. observedMs is the handset's
 * GPS time, used only for intervals between its own fixes; seenMs is when our
 * server first saw the fix, used for "how old is this".
 */
export function fixFromLocation(location) {
  const lat = Number(location?.Lat);
  const lon = Number(location?.Lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  const observedMs = stamp(location.GpsTime);
  const seenMs = stamp(location.FixSeenAt) ?? observedMs;
  return { lat, lon, observedMs, seenMs, key: `${location.GpsTime ?? ""}|${lat}|${lon}` };
}

/** Seconds since the server last saw this radio's position change. */
export function fixAgeSec(fix, now = Date.now()) {
  if (!fix?.seenMs) return null;
  return Math.max(0, Math.round((now - fix.seenMs) / 1000));
}

export function isStale(fix, now = Date.now()) {
  const age = fixAgeSec(fix, now);
  return age != null && age > MOTION.staleSec;
}

function intervalSec(fromMs, toMs, fallbackFrom, fallbackTo) {
  if (fromMs != null && toMs != null && toMs > fromMs) return (toMs - fromMs) / 1000;
  if (fallbackFrom != null && fallbackTo != null && fallbackTo > fallbackFrom) return (fallbackTo - fallbackFrom) / 1000;
  return null;
}

function placed(fix) {
  return {
    lat: fix.lat,
    lon: fix.lon,
    key: fix.key,
    lastObservedMs: fix.observedMs,
    lastSeenMs: fix.seenMs,
    candidate: null,
    moving: false,
    bearing: null,
    speedMs: null,
    lastMoveMs: null,
  };
}

/**
 * Advance one radio's motion with its latest fix.
 *
 * Returns the next state and what the pin should do:
 *   place - first sighting, put it there
 *   none  - stay put (same fix, or noise)
 *   glide - slide from where it is to state.lat/lon over durationMs
 *   jump  - move there at once; the path in between is unknown
 */
export function advanceMotion(state, fix, now = Date.now()) {
  if (!fix) return { state, action: "none" };
  if (!state) return { state: placed(fix), action: "place" };

  if (fix.key === state.key) {
    // No new fix. The arrow only means something while fixes keep moving.
    if (state.moving && state.lastMoveMs != null && now - state.lastMoveMs > MOTION.stopAfterSec * 1000) {
      return { state: { ...state, moving: false }, action: "none" };
    }
    return { state, action: "none" };
  }

  const here = { lat: state.lat, lon: state.lon };
  const distance = distanceMetres(here, fix);
  const gapSec = intervalSec(state.lastObservedMs, fix.observedMs, state.lastSeenMs, fix.seenMs);
  const seen = { key: fix.key, lastObservedMs: fix.observedMs, lastSeenMs: fix.seenMs };

  if (distance < (state.moving ? MOTION.minStepM : MOTION.jitterM)) {
    return { state: { ...state, ...seen, candidate: null, moving: false }, action: "none" };
  }

  // The pin's spot was last confirmed by the fix before this move began: the
  // previous fix, or the one before the first unconfirmed step.
  const since = state.candidate || { sinceObservedMs: state.lastObservedMs, sinceSeenMs: state.lastSeenMs };
  const travelSec = intervalSec(since.sinceObservedMs, fix.observedMs, since.sinceSeenMs, fix.seenMs);
  const speedMs = travelSec ? distance / travelSec : Infinity;
  if ((gapSec != null && gapSec > MOTION.maxGlideGapSec) || speedMs > MOTION.maxSpeedMs) {
    return { state: placed(fix), action: "jump" };
  }

  const bearing = bearingBetween(here, fix);
  if (!state.moving) {
    // A still radio has to earn its first move: one far fix is as likely to
    // be a reflection off a wall as a step, and a desk-bound handset whose
    // drift lands either side of it must not pace the room.
    const agrees = state.candidate != null && angleBetween(state.candidate.bearing, bearing) <= 60;
    const count = agrees ? state.candidate.count + 1 : 1;
    if (count < MOTION.confirmFixes) {
      const start = agrees ? state.candidate : { sinceObservedMs: state.lastObservedMs, sinceSeenMs: state.lastSeenMs };
      return {
        state: {
          ...state,
          ...seen,
          candidate: { bearing, count, sinceObservedMs: start.sinceObservedMs, sinceSeenMs: start.sinceSeenMs },
        },
        action: "none",
      };
    }
  }

  const durationMs = Math.min(
    MOTION.glideMaxMs,
    Math.max(MOTION.glideMinMs, (gapSec ?? MOTION.glideMaxMs / 1000) * 1000),
  );
  return {
    state: {
      ...state,
      ...seen,
      lat: fix.lat,
      lon: fix.lon,
      candidate: null,
      moving: true,
      bearing,
      speedMs,
      lastMoveMs: now,
    },
    action: "glide",
    durationMs,
  };
}

/**
 * A trail split into the pieces worth drawing. Noise under MOTION.jitterM is
 * dropped, and a gap or an impossible speed starts a new piece rather than
 * drawing a straight line nobody travelled.
 */
export function trailSegments(points) {
  const segments = [];
  let current = [];
  let last = null;
  for (const raw of points || []) {
    const point = {
      lat: Number(raw.lat),
      lon: Number(raw.lon),
      ms: stamp(raw.observed_at) ?? stamp(raw.received_at),
    };
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || point.ms == null) continue;
    if (!last) {
      current.push(point);
      last = point;
      continue;
    }
    const distance = distanceMetres(last, point);
    const gapSec = (point.ms - last.ms) / 1000;
    const broken = gapSec > MOTION.maxGlideGapSec || (gapSec > 0 && distance / gapSec > MOTION.maxSpeedMs);
    if (broken) {
      if (current.length > 1) segments.push(current);
      current = [point];
      last = point;
      continue;
    }
    if (distance < MOTION.jitterM) continue;
    current.push(point);
    last = point;
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function compassFor(bearing) {
  return Number.isFinite(bearing) ? COMPASS[Math.round(bearing / 45) % 8] : null;
}

export function formatAge(seconds) {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}
