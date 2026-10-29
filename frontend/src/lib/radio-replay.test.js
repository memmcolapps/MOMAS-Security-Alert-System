import assert from "node:assert/strict";
import test from "node:test";
import { buildReplay, findStops, replayPosition } from "./radio-replay.js";

const M = 1 / 111_320;
const BASE = { lat: 6.784, lon: 3.422 };
const T0 = Date.parse("2026-10-29T09:00:00Z");
const pt = (northM, eastM, sec) => ({
  lat: BASE.lat + northM * M,
  lon: BASE.lon + (eastM * M) / Math.cos((BASE.lat * Math.PI) / 180),
  t: T0 + sec * 1000,
});

// 10 minutes at the office with drift, a 5-minute walk north, 4 minutes at the gate.
function shift() {
  const points = [];
  for (let sec = 0; sec <= 600; sec += 5) points.push(pt(Math.sin(sec / 7) * 12, Math.cos(sec / 11) * 12, sec));
  for (let sec = 605; sec <= 900; sec += 5) points.push(pt((sec - 600) * 1.4, 0, sec));
  for (let sec = 905; sec <= 1140; sec += 5) points.push(pt(420 + Math.sin(sec) * 5, 0, sec));
  return points;
}

test("finds where the radio stayed and for how long", () => {
  const stops = findStops(shift());
  assert.equal(stops.length, 2);
  assert.ok(Math.abs(stops[0].durationSec - 600) <= 30, `office ${stops[0].durationSec}s`);
  assert.ok(stops[1].durationSec >= 200 && stops[1].durationSec <= 260, `gate ${stops[1].durationSec}s`);
});

test("a brief pause is not a stop", () => {
  const points = [];
  for (let sec = 0; sec <= 100; sec += 5) points.push(pt(0, 0, sec));
  for (let sec = 105; sec <= 300; sec += 5) points.push(pt((sec - 100) * 1.4, 0, sec));
  assert.equal(findStops(points).length, 0);
});

test("distance counts the walk, not the drift", () => {
  const replay = buildReplay(shift());
  assert.ok(replay.distanceM > 350 && replay.distanceM < 480, `distance ${replay.distanceM}`);
});

test("the replay position follows the walk", () => {
  const replay = buildReplay(shift());
  const halfway = replayPosition(replay, T0 + 750_000);
  const north = (halfway.lat - BASE.lat) / M;
  assert.ok(north > 150 && north < 260, `halfway ${north} m north`);
  assert.equal(halfway.moving, true);
});

test("an empty window replays nothing", () => {
  const replay = buildReplay([]);
  assert.equal(replay.path.length, 0);
  assert.equal(replayPosition(replay, T0), null);
});
