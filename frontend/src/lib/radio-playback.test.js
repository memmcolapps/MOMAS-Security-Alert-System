import assert from "node:assert/strict";
import test from "node:test";
import { PLAYBACK, addPoints, buildPath, createTrack, newestPoint, sampleTrack } from "./radio-playback.js";

const M = 1 / 111_320;
const BASE = { lat: 6.784, lon: 3.422 };
const T0 = Date.parse("2026-10-29T09:00:00Z");

const pt = (northM, eastM, sec) => ({
  lat: BASE.lat + northM * M,
  lon: BASE.lon + (eastM * M) / Math.cos((BASE.lat * Math.PI) / 180),
  t: T0 + sec * 1000,
});

// A walk north at 1.4 m/s, one point every 5s.
const walk = (fromSec, toSec, startNorth = 0) => {
  const points = [];
  for (let sec = fromSec; sec <= toSec; sec += 5) points.push(pt(startNorth + (sec - fromSec) * 1.4, 0, sec));
  return points;
};

test("a still radio's drift never becomes movement", () => {
  const raw = [];
  for (let sec = 0; sec <= 300; sec += 5) raw.push(pt(Math.sin(sec) * 15, Math.cos(sec) * 15, sec));
  const path = buildPath(raw);
  assert.equal(path.length, 1);
  const track = createTrack();
  addPoints(track, raw, T0 + 330_000);
  for (let sec = 0; sec <= 300; sec += 7) assert.equal(sampleTrack(track, T0 + sec * 1000).moving, false);
});

test("a lone excursion past the jitter threshold is not followed", () => {
  const raw = [pt(0, 0, 0), pt(3, 0, 5), pt(40, 0, 10), pt(2, 0, 15), pt(1, 0, 20)];
  assert.equal(buildPath(raw).length, 1);
});

test("walking plays back smoothly through the points, at walking pace", () => {
  const raw = [pt(0, 0, 0), pt(1, 0, 30), pt(0, 0, 60), ...walk(65, 185)];
  const track = createTrack();
  addPoints(track, raw, T0 + 200_000);
  const samples = [];
  // Up to the last point taken, where playback correctly comes to rest.
  for (let sec = 90; sec < 180; sec += 1) samples.push(sampleTrack(track, T0 + sec * 1000));
  assert.ok(samples.every((sample) => sample.moving), "moving the whole way");
  for (const sample of samples) assert.ok(Math.abs(sample.bearing) < 2 || Math.abs(sample.bearing - 360) < 2);
  const speeds = samples.map((sample) => sample.speedMs);
  assert.ok(Math.min(...speeds) > 0.8 && Math.max(...speeds) < 2.5, `pace ${Math.min(...speeds)}..${Math.max(...speeds)}`);
  // Never jumps backwards, never leaps forward.
  for (let i = 1; i < samples.length; i += 1) {
    const step = (samples[i].lat - samples[i - 1].lat) / M;
    assert.ok(step >= -0.01 && step < 4, `step ${step} m at ${i}`);
  }
});

test("setting off after standing still does not smear the move over the wait", () => {
  const still = [];
  for (let sec = 0; sec <= 120; sec += 5) still.push(pt(0, 0, sec));
  const track = createTrack();
  addPoints(track, [...still, ...walk(125, 200, 7)], T0 + 220_000);
  const waiting = sampleTrack(track, T0 + 100_000);
  assert.equal(waiting.moving, false);
  // Within a few metres: the first steps nudge the resting point a little.
  assert.ok(Math.abs(waiting.lat - BASE.lat) < 5 * M, "still at the start until it leaves");
});

test("a long silence is a jump: the pin waits, then appears", () => {
  const track = createTrack();
  addPoints(track, [pt(0, 0, 0), pt(0, 0, 5), pt(400, 0, 400), pt(401, 0, 405)], T0 + 420_000);
  const during = sampleTrack(track, T0 + 200_000);
  assert.ok(Math.abs(during.lat - BASE.lat) < 1e-7);
  assert.equal(during.moving, false);
  assert.ok(Math.abs(sampleTrack(track, T0 + 402_000).lat - (BASE.lat + 400 * M)) < 2 * M);
});

test("one bad fix in the middle of a walk is dropped", () => {
  const raw = walk(0, 60);
  raw.splice(6, 0, { ...pt(3000, 0, 32) });
  const path = buildPath(raw);
  assert.ok(path.every((point) => point.lat < BASE.lat + 200 * M));
});

test("the delay follows how far behind this radio's batches arrive", () => {
  const track = createTrack();
  assert.equal(track.delayMs, PLAYBACK.defaultDelayMs);
  // Batches of 4 points every 20s: the oldest point in each is ~20s old on arrival.
  for (let batch = 0; batch < 6; batch += 1) {
    const end = batch * 20;
    addPoints(track, [pt(0, 0, end - 15), pt(0, 0, end - 10), pt(0, 0, end - 5), pt(0, 0, end)], T0 + (end + 2) * 1000);
  }
  assert.ok(track.delayMs >= 17_000 && track.delayMs <= 24_000, `delay ${track.delayMs}`);
});

test("backfilled points do not set the delay", () => {
  const track = createTrack();
  addPoints(track, walk(0, 60), T0 + 600_000, { live: false });
  assert.equal(track.delayMs, PLAYBACK.defaultDelayMs);
  assert.equal(newestPoint(track).t, T0 + 60_000);
});

test("duplicate points are ignored", () => {
  const track = createTrack();
  assert.equal(addPoints(track, walk(0, 20), T0 + 30_000), true);
  assert.equal(addPoints(track, walk(0, 20), T0 + 31_000), false);
  assert.equal(track.raw.length, 5);
});
