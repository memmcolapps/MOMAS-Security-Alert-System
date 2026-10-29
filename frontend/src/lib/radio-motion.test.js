import assert from "node:assert/strict";
import test from "node:test";
import { MOTION, fixFromLocation, isStale, trailSegments } from "./radio-motion.js";

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
