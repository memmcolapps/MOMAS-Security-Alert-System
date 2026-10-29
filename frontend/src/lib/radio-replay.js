// Replaying a radio's shift: the cleaned path, where it stopped and for how
// long, and how far it went. Built on the same noise rules as live playback,
// so a replay and the live map never disagree about whether a radio moved.

import { distanceMetres } from "./radio-motion.js";
import { buildPath, sampleTrack } from "./radio-playback.js";

export const STOPS = {
  // Everything within this of where the stop began counts as the same stop:
  // wider than GPS drift indoors, narrower than a walk to the next building.
  radiusM: 35,
  minSec: 180,
};

/** Points in time order, with anything unusable dropped. */
export function cleanPoints(points) {
  return (points || [])
    .map((point) => ({ lat: Number(point.lat), lon: Number(point.lon), t: Number(point.t) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon) && Number.isFinite(point.t))
    .sort((a, b) => a.t - b.t);
}

/**
 * Places the radio stayed for at least STOPS.minSec. A stop is measured from
 * its first point; it ends at the last point still inside the radius, so a
 * radio that drifts around a building is one stop, not several.
 */
export function findStops(points, { radiusM = STOPS.radiusM, minSec = STOPS.minSec } = {}) {
  const stops = [];
  let index = 0;
  while (index < points.length) {
    const start = points[index];
    let end = index;
    let sumLat = start.lat;
    let sumLon = start.lon;
    while (end + 1 < points.length && distanceMetres(start, points[end + 1]) <= radiusM) {
      end += 1;
      sumLat += points[end].lat;
      sumLon += points[end].lon;
    }
    const durationSec = (points[end].t - start.t) / 1000;
    if (durationSec >= minSec) {
      const n = end - index + 1;
      stops.push({ lat: sumLat / n, lon: sumLon / n, from: start.t, to: points[end].t, durationSec });
      index = end + 1;
    } else {
      index += 1;
    }
  }
  return stops;
}

/** Distance along the cleaned path, so GPS drift does not add up to kilometres. */
export function pathDistance(path) {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) {
    if (!path[index].jump) total += distanceMetres(path[index - 1], path[index]);
  }
  return total;
}

export function buildReplay(points) {
  const raw = cleanPoints(points);
  const path = buildPath(raw);
  return {
    raw,
    path,
    stops: findStops(raw),
    distanceM: pathDistance(path),
    from: raw.length ? raw[0].t : null,
    to: raw.length ? raw[raw.length - 1].t : null,
  };
}

/** Where the radio was at time t during the replay. */
export function replayPosition(replay, t) {
  return sampleTrack({ path: replay.path }, t);
}
