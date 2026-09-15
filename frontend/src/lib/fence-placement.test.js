import assert from "node:assert/strict";
import test from "node:test";
import {
  bufferRing,
  circleAroundAssets,
  circleToPolygon,
  polygonAroundAssets,
  polygonSelfIntersects,
  polygonToCircle,
} from "./fence-placement.js";

/*
 * These tests check the placement helpers against the geofencing engine's own
 * rule rather than against themselves. The engine (backend/src/geofencing/
 * geometry.ts) decides a polygon breach with:
 *
 *   outside = !pointInPolygon(lat, lon) && distanceToBoundary > buffer
 *
 * so the only meaningful question about a drawn buffer ring is whether it sits
 * at a constant `buffer` metres from the fence boundary, and the only
 * meaningful question about a fitted fence is whether the assets are actually
 * inside it with the requested clearance. Both are reimplemented below so a
 * change to the helpers cannot quietly move the goalposts.
 */

const LAT = 9.06;
const LON = 7.49;
const METRES_PER_DEGREE_LAT = 110_574;
const METRES_PER_DEGREE_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);

const at = (eastM, northM) => ({
  lat: LAT + northM / METRES_PER_DEGREE_LAT,
  lon: LON + eastM / METRES_PER_DEGREE_LON,
});

const EARTH_RADIUS_M = 6_371_008.8;

function localXY(lat, lon, originLat, originLon) {
  const rad = Math.PI / 180;
  return {
    x: (lon - originLon) * rad * EARTH_RADIUS_M * Math.cos(originLat * rad),
    y: (lat - originLat) * rad * EARTH_RADIUS_M,
  };
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The engine's `distanceToPolygonMetres`, over a `[lon, lat]` ring. */
function distanceToBoundary(lat, lon, ring) {
  let closest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const p = localXY(lat, lon, lat, lon);
    const aa = localXY(a[1], a[0], lat, lon);
    const bb = localXY(b[1], b[0], lat, lon);
    closest = Math.min(closest, distanceToSegment(p.x, p.y, aa.x, aa.y, bb.x, bb.y));
  }
  return closest;
}

/** The engine's `pointInPolygon`, over a `[lon, lat]` ring. */
function pointInPolygon(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function ringOf(...corners) {
  return corners.map((corner) => [corner.lon, corner.lat]);
}

/** Straight-line metres between two coordinates, in the engine's projection. */
function metresApart(fromLat, fromLon, toLat, toLon) {
  const point = localXY(toLat, toLon, fromLat, fromLon);
  return Math.hypot(point.x, point.y);
}

/** Clearance from an asset to the nearest fence edge, signed by containment. */
function clearance(asset, ring) {
  const distance = distanceToBoundary(asset.lat, asset.lon, ring);
  return pointInPolygon(asset.lat, asset.lon, ring) ? distance : -distance;
}

test("buffer ring sits at a constant distance from an elongated fence", () => {
  // A 1000 x 100 m compound: radial scaling used to move the long sides by 3 m
  // while the engine went on firing at 30.
  const fence = ringOf(at(-500, -50), at(500, -50), at(500, 50), at(-500, 50));
  const ring = bufferRing(fence, 30);

  for (const vertex of ring) {
    const distance = distanceToBoundary(vertex[1], vertex[0], fence);
    assert.ok(
      Math.abs(distance - 30) < 0.5,
      `ring vertex sits ${distance.toFixed(1)}m from the fence, expected 30m`,
    );
  }
});

test("buffer ring matches the engine's verdict just inside and just outside it", () => {
  const fence = ringOf(at(-500, -50), at(500, -50), at(500, 50), at(-500, 50));
  const ring = bufferRing(fence, 30);

  // Straight out from the middle of a long side.
  assert.equal(pointInPolygon(at(0, 79).lat, at(0, 79).lon, ring), true, "29m out should be within the alarm line");
  assert.equal(pointInPolygon(at(0, 81).lat, at(0, 81).lon, ring), false, "31m out should be beyond the alarm line");
  // And the engine agrees at those same two points.
  assert.equal(distanceToBoundary(at(0, 79).lat, at(0, 79).lon, fence) > 30, false);
  assert.equal(distanceToBoundary(at(0, 81).lat, at(0, 81).lon, fence) > 30, true);
});

test("buffer ring rounds convex corners rather than spiking", () => {
  const fence = ringOf(at(-200, -200), at(200, -200), at(200, 200), at(-200, 200));
  const ring = bufferRing(fence, 50);
  const furthest = Math.max(...ring.map((vertex) => metresApart(LAT, LON, vertex[1], vertex[0])));
  // A mitred corner would reach 200*sqrt(2) + 50*sqrt(2) = 353m from centre;
  // the true offset reaches the corner distance plus the buffer.
  assert.ok(furthest < Math.hypot(200, 200) + 50 + 1, `corner reached ${furthest.toFixed(0)}m`);
});

test("buffer ring is skipped for a zero or missing buffer", () => {
  const fence = ringOf(at(-100, -100), at(100, -100), at(100, 100), at(-100, 100));
  assert.equal(bufferRing(fence, 0), null);
  assert.equal(bufferRing(fence, -5), null);
  assert.equal(bufferRing([[LON, LAT]], 30), null);
});

test("fitted polygon encloses two assets far apart", () => {
  const assets = [at(-1000, 0), at(1000, 0)];
  const ring = polygonAroundAssets(assets, 200);
  for (const asset of assets) {
    const gap = clearance(asset, ring);
    assert.ok(gap >= 199.95 && gap <= 200.6, `clearance was ${gap.toFixed(1)}m, expected 200m`);
  }
});

test("fitted polygon encloses assets strung out in a line", () => {
  const assets = [at(-1000, 0), at(0, 0), at(1000, 0)];
  const ring = polygonAroundAssets(assets, 200);
  for (const asset of assets) {
    assert.ok(clearance(asset, ring) > 0, "asset fell outside its own fence");
  }
});

test("fitted polygon holds the requested clearance on an elongated hull", () => {
  // A convoy: the hull is a long thin quadrilateral, which radial scaling
  // widened to between 46m and 194m when asked for 200m.
  const assets = [at(-900, 0), at(0, 60), at(900, 0), at(0, -60)];
  const ring = polygonAroundAssets(assets, 200);
  for (const asset of assets) {
    const gap = clearance(asset, ring);
    assert.ok(gap >= 199.95 && gap <= 200.6, `clearance was ${gap.toFixed(1)}m, expected 200m`);
  }
});

test("fitted polygon handles a single asset", () => {
  const assets = [at(0, 0)];
  const ring = polygonAroundAssets(assets, 150);
  assert.ok(ring.length >= 8, "a lone asset should get a rounded fence");
  for (const vertex of ring) {
    const distance = metresApart(LAT, LON, vertex[1], vertex[0]);
    assert.ok(distance >= 149.95 && distance <= 150.9, `vertex sat ${distance.toFixed(1)}m out`);
  }
});

test("fitted polygon keeps the requested clearance around a compound", () => {
  const assets = [at(-300, -200), at(300, -200), at(300, 200), at(-300, 200)];
  const ring = polygonAroundAssets(assets, 100);
  for (const asset of assets) {
    const gap = clearance(asset, ring);
    assert.ok(gap >= 99.95 && gap <= 100.4, `clearance was ${gap.toFixed(1)}m, expected 100m`);
  }
});

test("a degenerate fit still produces a usable shape with no margin asked for", () => {
  const ring = polygonAroundAssets([at(0, 0), at(500, 0)], 0);
  assert.ok(ring.length >= 3, "expected a real polygon");
  assert.ok(clearance(at(0, 0), ring) > 0, "asset fell outside its own fence");
});

test("circle fit still encloses every asset", () => {
  const assets = [at(-1000, 0), at(0, 60), at(1000, 0)];
  const circle = circleAroundAssets(assets, 200);
  for (const asset of assets) {
    const distance = metresApart(circle.center_lat, circle.center_lon, asset.lat, asset.lon);
    assert.ok(distance + 200 <= circle.radius_m + 1, "asset was not clear of the circle edge");
  }
});

test("accepts a simple ring, open or closed", () => {
  const square = ringOf(at(-100, -100), at(100, -100), at(100, 100), at(-100, 100));
  assert.equal(polygonSelfIntersects(square), false);
  assert.equal(polygonSelfIntersects([...square, square[0]]), false);
  assert.equal(polygonSelfIntersects(ringOf(at(0, 0), at(100, 0), at(50, 80))), false);
});

test("catches a bowtie ring", () => {
  // Corners clicked in the wrong order: the two diagonals cross.
  const bowtie = ringOf(at(-100, -100), at(100, 100), at(100, -100), at(-100, 100));
  assert.equal(polygonSelfIntersects(bowtie), true);
});

test("catches a ring whose edge passes back through an earlier one", () => {
  const tangled = ringOf(at(0, 0), at(200, 0), at(200, 200), at(100, -100), at(0, 200));
  assert.equal(polygonSelfIntersects(tangled), true);
});

test("a ring too short to cross itself is not flagged", () => {
  assert.equal(polygonSelfIntersects(ringOf(at(0, 0), at(100, 0), at(50, 50))), false);
  assert.equal(polygonSelfIntersects([]), false);
});

test("the polygon a circle converts to keeps the circle's extent", () => {
  const ring = circleToPolygon(LAT, LON, 400);
  assert.equal(ring.length, 12);
  // Edge midpoints land on the original circle; vertices sit just outside it.
  for (const vertex of ring) {
    const distance = metresApart(LAT, LON, vertex[1], vertex[0]);
    assert.ok(distance >= 399.9 && distance <= 415, `vertex sat ${distance.toFixed(0)}m out`);
  }
  assert.equal(polygonSelfIntersects(ring), false);
});

test("a circle converted from a polygon contains every corner", () => {
  const ring = ringOf(at(-500, -50), at(500, -50), at(500, 50), at(-500, 50));
  const circle = polygonToCircle(ring);
  for (const [lon, lat] of ring) {
    const distance = metresApart(circle.center_lat, circle.center_lon, lat, lon);
    assert.ok(distance <= circle.radius_m + 1, `corner sat ${distance.toFixed(0)}m from a ${circle.radius_m}m circle`);
  }
});

test("shape conversion rejects incomplete input", () => {
  assert.equal(circleToPolygon(LAT, LON, 0), null);
  assert.equal(circleToPolygon(null, null, 400), null);
  assert.equal(polygonToCircle([]), null);
});
