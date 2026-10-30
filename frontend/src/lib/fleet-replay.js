// Replaying the whole fleet: which radios went somewhere, when each was on the
// move, and how busy the fleet was across the window. Each radio's route is
// cleaned by the same rules as a single-radio replay (radio-replay.js), so the
// Replay tab and the map never disagree about whether a radio moved.

import { MOTION, distanceMetres } from "./radio-motion.js";
import { buildReplay } from "./radio-replay.js";

// A radio "moved" when its cleaned route covers at least this much ground.
// Drift around a desk is already removed by buildPath; this keeps a radio
// that shuffled across a compound out of the movers list.
export const MOVED_MIN_M = 150;

// Moving spells closer together than this are one trip: a pause at a junction
// is not an arrival.
const SPELL_GAP_MS = 60_000;

// Distinct on satellite imagery and on the dark basemap, and none of them the
// red of an alarm. Assigned in order of distance travelled, so the busiest
// radios get the strongest colours.
export const TRAIL_COLOURS = [
  "#22d3ee",
  "#facc15",
  "#f472b6",
  "#4ade80",
  "#a78bfa",
  "#fb923c",
  "#60a5fa",
  "#e879f9",
  "#a3e635",
  "#2dd4bf",
  "#fda4af",
  "#fde68a",
];

/** The [seconds, lat, lon] rows the server sends, as points in epoch ms. */
export function decodePoints(rows, fromMs) {
  return (rows || []).map(([sec, lat, lon]) => ({ t: fromMs + sec * 1000, lat, lon }));
}

/**
 * When the radio was actually on the move: spans between consecutive path
 * points that are a real step (not a jump, not drift), merged into spells.
 */
export function movingSpells(path) {
  const spells = [];
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1];
    const b = path[index];
    if (b.jump || distanceMetres(a, b) < MOTION.minStepM) continue;
    const last = spells[spells.length - 1];
    if (last && a.t - last.to <= SPELL_GAP_MS) last.to = b.t;
    else spells.push({ from: a.t, to: b.t });
  }
  return spells;
}

function topSpeed(path) {
  let best = 0;
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1];
    const b = path[index];
    const sec = (b.t - a.t) / 1000;
    if (b.jump || sec <= 0) continue;
    best = Math.max(best, distanceMetres(a, b) / sec);
  }
  return best;
}

/**
 * One radio, ready to play: the single-radio replay plus when it was moving,
 * how long that added up to, and its top speed.
 */
export function buildFleetRadio(radio, fromMs) {
  const replay = buildReplay(decodePoints(radio.points, fromMs));
  const spells = movingSpells(replay.path);
  return {
    ...replay,
    uid: String(radio.uid),
    fixes: radio.fixes,
    spells,
    movingSec: spells.reduce((sum, spell) => sum + (spell.to - spell.from) / 1000, 0),
    topSpeedMs: topSpeed(replay.path),
    moved: replay.distanceM >= MOVED_MIN_M,
  };
}

/**
 * The whole response, split into the radios that went somewhere (longest
 * route first, each with its colour) and the ones that reported but stayed
 * put, with where they stayed.
 */
export function buildFleetReplay(response) {
  const fromMs = Date.parse(response.from);
  const toMs = Date.parse(response.to);
  const movers = [];
  const still = [];
  for (const radio of response.radios || []) {
    const built = radio.points ? buildFleetRadio(radio, fromMs) : null;
    if (built?.moved) movers.push(built);
    else
      still.push({
        uid: String(radio.uid),
        fixes: radio.fixes,
        lat: radio.lat,
        lon: radio.lon,
        firstAt: radio.firstAt,
        lastAt: radio.lastAt,
      });
  }
  movers.sort((a, b) => b.distanceM - a.distanceM);
  movers.forEach((radio, index) => {
    radio.colour = TRAIL_COLOURS[index % TRAIL_COLOURS.length];
  });
  return {
    from: fromMs,
    to: toMs,
    movers,
    still,
    distanceM: movers.reduce((sum, radio) => sum + radio.distanceM, 0),
    bins: activityBins(movers, fromMs, toMs),
  };
}

// Radios whose routes centre further than this from the busiest area are left
// out of the opening view.
const CLUSTER_RADIUS_M = 60_000;

/**
 * The radios around where most of the movement was, and the ones far away
 * from it. The centre is the radio with the most others near it.
 */
export function mainCluster(radios) {
  const centres = radios.map((radio) => {
    const n = radio.path.length || 1;
    return {
      lat: radio.path.reduce((sum, point) => sum + point.lat, 0) / n,
      lon: radio.path.reduce((sum, point) => sum + point.lon, 0) / n,
    };
  });
  let best = -1;
  let bestCount = -1;
  centres.forEach((centre, index) => {
    const count = centres.filter((other) => distanceMetres(centre, other) <= CLUSTER_RADIUS_M).length;
    if (count > bestCount) {
      best = index;
      bestCount = count;
    }
  });
  if (best < 0) return { inside: [], outside: [] };
  const near = (index) => distanceMetres(centres[best], centres[index]) <= CLUSTER_RADIUS_M;
  return {
    inside: radios.filter((_, index) => near(index)),
    outside: radios.filter((_, index) => !near(index)),
  };
}

/** How many radios were moving in each slice of the window. */
export function activityBins(radios, from, to, count = 144) {
  const width = (to - from) / count;
  const bins = Array.from({ length: count }, (_, index) => ({ from: from + index * width, to: from + (index + 1) * width, moving: 0 }));
  for (const radio of radios) {
    const hit = new Set();
    for (const spell of radio.spells) {
      const first = Math.max(0, Math.floor((spell.from - from) / width));
      const last = Math.min(count - 1, Math.floor((spell.to - from) / width));
      for (let index = first; index <= last; index += 1) hit.add(index);
    }
    for (const index of hit) bins[index].moving += 1;
  }
  return bins;
}

/**
 * Where playback should go next when quiet stretches are skipped: t itself if
 * any radio is moving then, otherwise the start of the next busy slice (or
 * null when nothing moves again before the end).
 */
export function nextBusyTime(bins, t) {
  const index = bins.findIndex((bin) => t < bin.to);
  if (index < 0) return null;
  if (bins[index].moving) return t;
  const next = bins.slice(index + 1).find((bin) => bin.moving);
  return next ? next.from : null;
}

/** Index of the last path point at or before t (-1 before the first). */
export function pathIndexAt(path, t) {
  let lo = 0;
  let hi = path.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (path[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * What a radio was doing at t, in words a supervisor reads at a glance:
 * not yet reporting, moving, stopped (and since when), or gone quiet.
 */
export function radioStateAt(radio, t) {
  if (!radio.raw.length || t < radio.raw[0].t) return { kind: "before" };
  const spell = radio.spells.find((s) => t >= s.from && t <= s.to);
  if (spell) return { kind: "moving", since: spell.from };
  const lastFix = radio.raw[pathIndexAtRaw(radio.raw, t)];
  if (t - lastFix.t > MOTION.maxGlideGapSec * 1000) return { kind: "silent", since: lastFix.t };
  const previous = [...radio.spells].reverse().find((s) => s.to <= t);
  return { kind: "stopped", since: previous ? previous.to : radio.raw[0].t };
}

function pathIndexAtRaw(raw, t) {
  return Math.max(0, pathIndexAt(raw, t));
}

/** A playback speed that plays the whole window in about two minutes. */
export function naturalSpeed(spanMs, speeds) {
  const ideal = spanMs / 120_000;
  return speeds.reduce((best, speed) => (Math.abs(Math.log(speed / ideal)) < Math.abs(Math.log(best / ideal)) ? speed : best), speeds[0]);
}

// A silence this long between fixes is worth telling the reader about: the
// radio was indoors, out of coverage or switched off.
const SILENCE_MS = 5 * 60_000;

// A "trip" shorter than this is someone shuffling around where they stood.
const TRIP_MIN_M = 40;

/**
 * A radio's window as a story, oldest first: each trip (when, how far), each
 * stop (when, how long, where) and each stretch it went silent. Stops come
 * from findStops, so a pause at a junction is part of the trip around it.
 * Anything inside a stop belongs to the stop: a radio that went quiet in a
 * building and came back in the same place stopped there, and the story says
 * so once rather than as a stop, a silence and a 10 m "trip".
 */
export function itinerary(radio) {
  const stops = radio.stops.map((stop) => ({ kind: "stop", from: stop.from, to: stop.to, lat: stop.lat, lon: stop.lon }));
  const insideStop = (entry) => stops.some((stop) => entry.from >= stop.from && entry.to <= stop.to);
  const entries = [...stops];
  for (const spell of radio.spells) {
    let distanceM = 0;
    for (let index = 1; index < radio.path.length; index += 1) {
      const a = radio.path[index - 1];
      const b = radio.path[index];
      if (!b.jump && a.t >= spell.from && b.t <= spell.to) distanceM += distanceMetres(a, b);
    }
    const trip = { kind: "trip", from: spell.from, to: spell.to, distanceM };
    if (distanceM >= TRIP_MIN_M && !insideStop(trip)) entries.push(trip);
  }
  for (let index = 1; index < radio.raw.length; index += 1) {
    const silence = { kind: "silent", from: radio.raw[index - 1].t, to: radio.raw[index].t };
    if (silence.to - silence.from >= SILENCE_MS && !insideStop(silence)) entries.push(silence);
  }
  return entries.sort((a, b) => a.from - b.from || a.to - b.to);
}
