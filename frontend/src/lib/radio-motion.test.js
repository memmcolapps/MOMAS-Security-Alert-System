import assert from "node:assert/strict";
import test from "node:test";
import { MOTION, advanceMotion, fixFromLocation, isStale, trailSegments } from "./radio-motion.js";

// Roughly metres to degrees of latitude near Abuja; plenty precise for
// thresholds measured in tens of metres.
const M = 1 / 111_320;
const BASE = { lat: 9.05, lon: 7.49 };
const T0 = Date.parse("2026-10-28T10:00:00Z");

function fix(northM, eastM, sec) {
  const at = new Date(T0 + sec * 1000).toISOString();
  return fixFromLocation({
    Lat: BASE.lat + northM * M,
    Lng: BASE.lon + (eastM * M) / Math.cos((BASE.lat * Math.PI) / 180),
    GpsTime: at,
    FixSeenAt: at,
  });
}

function run(fixes) {
  let state = null;
  const actions = [];
  for (const next of fixes) {
    const result = advanceMotion(state, next, next.seenMs);
    state = result.state;
    actions.push(result.action);
  }
  return { state, actions };
}

test("first sighting places the pin", () => {
  assert.deepEqual(run([fix(0, 0, 0)]).actions, ["place"]);
});

test("the same fix again changes nothing", () => {
  const first = fix(0, 0, 0);
  const { actions } = run([first, { ...first }]);
  assert.deepEqual(actions, ["place", "none"]);
});

test("indoor drift under the jitter threshold never moves the pin", () => {
  const { state, actions } = run([fix(0, 0, 0), fix(12, -8, 30), fix(-15, 10, 60), fix(9, 14, 90)]);
  assert.deepEqual(actions, ["place", "none", "none", "none"]);
  assert.equal(state.moving, false);
  assert.ok(Math.abs(state.lat - BASE.lat) < 1e-9);
});

test("drift that lands either side of the pin does not count as walking", () => {
  const { state, actions } = run([fix(0, 0, 0), fix(0, 40, 30), fix(0, -40, 60), fix(0, 40, 90)]);
  assert.deepEqual(actions, ["place", "none", "none", "none"]);
  assert.equal(state.moving, false);
});

test("a still radio needs two agreeing fixes before it moves, then glides each fix", () => {
  const { state, actions } = run([fix(0, 0, 0), fix(40, 0, 30), fix(80, 0, 60), fix(120, 0, 90)]);
  assert.deepEqual(actions, ["place", "none", "glide", "glide"]);
  assert.equal(state.moving, true);
  assert.ok(Math.abs(state.bearing - 0) < 1, `heading north, got ${state.bearing}`);
  assert.ok(Math.abs(state.speedMs - 40 / 30) < 0.05, `walking pace, got ${state.speedMs}`);
});

test("glides take the gap between fixes, capped", () => {
  let state = run([fix(0, 0, 0), fix(0, 40, 5), fix(0, 80, 10)]).state;
  const quick = advanceMotion(state, fix(0, 120, 15), T0 + 15_000);
  assert.equal(quick.action, "glide");
  assert.equal(quick.durationMs, 5000);
  state = quick.state;
  const slow = advanceMotion(state, fix(0, 400, 75), T0 + 75_000);
  assert.equal(slow.action, "glide");
  assert.equal(slow.durationMs, MOTION.glideMaxMs);
});

test("reappearing after a long silence jumps instead of drawing a path through the building", () => {
  const { state, actions } = run([fix(0, 0, 0), fix(300, 0, 600)]);
  assert.deepEqual(actions, ["place", "jump"]);
  assert.equal(state.moving, false);
});

test("an impossible speed is a bad fix, so it jumps", () => {
  const { actions } = run([fix(0, 0, 0), fix(0, 5000, 30)]);
  assert.deepEqual(actions, ["place", "jump"]);
});

test("a hop far away, judged over the gap and not since the pin was last placed", () => {
  // Still for an hour, then a 5 km jump between two fixes 30s apart.
  const fixes = [fix(0, 0, 0)];
  for (let sec = 30; sec <= 3600; sec += 30) fixes.push(fix(sec % 60 ? 5 : -5, 0, sec));
  fixes.push(fix(5000, 0, 3630));
  const { actions } = run(fixes);
  assert.equal(actions.at(-1), "jump");
});

test("a moving radio that stops loses its arrow", () => {
  const moving = run([fix(0, 0, 0), fix(40, 0, 30), fix(80, 0, 60)]).state;
  assert.equal(moving.moving, true);
  const stopped = advanceMotion(moving, fix(82, 0, 90), T0 + 90_000);
  assert.equal(stopped.action, "none");
  assert.equal(stopped.state.moving, false);
});

test("a moving radio that stops reporting loses its arrow after a while", () => {
  const moving = run([fix(0, 0, 0), fix(40, 0, 30), fix(80, 0, 60)]);
  const last = fix(80, 0, 60);
  const later = advanceMotion(moving.state, last, moving.state.lastMoveMs + (MOTION.stopAfterSec + 1) * 1000);
  assert.equal(later.state.moving, false);
});

test("staleness is judged by when the server saw the fix", () => {
  const position = fix(0, 0, 0);
  assert.equal(isStale(position, T0 + 60_000), false);
  assert.equal(isStale(position, T0 + (MOTION.staleSec + 1) * 1000), true);
});

test("unusable positions are not fixes", () => {
  assert.equal(fixFromLocation({ Lat: 0, Lng: 0 }), null);
  assert.equal(fixFromLocation({ Lat: "x", Lng: 7 }), null);
});

test("trail drops drift and breaks at gaps", () => {
  const point = (northM, sec) => ({
    lat: BASE.lat + northM * M,
    lon: BASE.lon,
    observed_at: new Date(T0 + sec * 1000).toISOString(),
  });
  const segments = trailSegments([
    point(0, 0),
    point(5, 30), // drift, dropped
    point(40, 60),
    point(80, 90),
    point(2000, 900), // long gap: a new piece
    point(2040, 930),
  ]);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].length, 3);
  assert.equal(segments[1].length, 2);
});
