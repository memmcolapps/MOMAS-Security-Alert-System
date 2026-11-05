/**
 * Building a fence from the assets it protects.
 *
 * Placing a fence normally means finding the place on a map first, which
 * assumes you can read one. These helpers invert that: the operator picks who
 * they are protecting, and the shape is derived from where those assets
 * actually are right now.
 *
 * All maths is planar over a local metre approximation — at fence scale
 * (metres to a few kilometres) the error is far below GPS noise.
 */

// The same earth model the geofencing engine uses (backend/src/geofencing/
// geometry.ts). These helpers exist to depict what that engine will decide, so
// a different constant here would put every drawn line a tenth of a percent off
// the line the alarm actually fires on.
import polygonClipping from "polygon-clipping";

const EARTH_RADIUS_M = 6_371_008.8;
const METRES_PER_DEGREE_LAT = (EARTH_RADIUS_M * Math.PI) / 180;

function metresPerDegreeLon(lat) {
  return Math.max(1, METRES_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
}

export function metresBetween(a, b) {
  const dLat = (b.lat - a.lat) * METRES_PER_DEGREE_LAT;
  const dLon = (b.lon - a.lon) * metresPerDegreeLon((a.lat + b.lat) / 2);
  return Math.hypot(dLat, dLon);
}

export function centroidOf(points) {
  if (!points.length) return null;
  return {
    lat: points.reduce((total, point) => total + point.lat, 0) / points.length,
    lon: points.reduce((total, point) => total + point.lon, 0) / points.length,
  };
}

/** Andrew's monotone chain, in lon/lat. Returns the hull in counter-clockwise order. */
export function convexHull(points) {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => a.lon - b.lon || a.lat - b.lat);
  const cross = (o, a, b) => (a.lon - o.lon) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lon - o.lon);

  const build = (sequence) => {
    const chain = [];
    for (const point of sequence) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) {
        chain.pop();
      }
      chain.push(point);
    }
    chain.pop();
    return chain;
  };

  return [...build(sorted), ...build([...sorted].reverse())];
}

/**
 * Local metre frame around an origin. Everything below works in plain x/y
 * metres, which is what makes a constant-distance offset expressible at all.
 */
function toLocal(points, origin) {
  const scaleLon = metresPerDegreeLon(origin.lat);
  return points.map((point) => ({
    x: (point.lon - origin.lon) * scaleLon,
    y: (point.lat - origin.lat) * METRES_PER_DEGREE_LAT,
  }));
}

function fromLocal(points, origin) {
  const scaleLon = metresPerDegreeLon(origin.lat);
  return points.map((point) => [
    origin.lon + point.x / scaleLon,
    origin.lat + point.y / METRES_PER_DEGREE_LAT,
  ]);
}

/** Positive for a counter-clockwise ring. */
function signedArea(points) {
  let twice = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    twice += points[j].x * points[i].y - points[i].x * points[j].y;
  }
  return twice / 2;
}

/** Repeated vertices give a zero-length edge, whose normal is undefined. */
function dropRepeats(points) {
  const kept = [];
  for (const point of points) {
    const last = kept[kept.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 1e-6) kept.push(point);
  }
  while (kept.length > 1 && Math.hypot(kept[0].x - kept[kept.length - 1].x, kept[0].y - kept[kept.length - 1].y) <= 1e-6) {
    kept.pop();
  }
  return kept;
}

// A corner is rounded to roughly this angular resolution. Fine enough that the
// arc reads as a curve, coarse enough that a fence stays a handful of points.
const ARC_STEP_RAD = Math.PI / 16;

// Past this multiple of the offset distance a mitred corner becomes a spike,
// so it is rounded instead.
const MITER_LIMIT = 4;

/**
 * Arc sampled so the polygon *edges* land on the true circle, not just the
 * vertices. Sampling at the plain radius puts every chord inside the circle,
 * which quietly shrinks a fence by the chord sagitta — about 2 m on a 100 m
 * corner. Sampling at the circumradius instead makes the chord midpoints exact
 * and leaves the vertices a few centimetres proud, so a clearance is never
 * less than the one that was asked for.
 */
function arcBetween(centre, radius, fromAngle, toAngle) {
  let sweep = toAngle - fromAngle;
  while (sweep < 0) sweep += Math.PI * 2;
  const steps = Math.max(1, Math.ceil(sweep / ARC_STEP_RAD));
  const circumradius = radius / Math.cos(sweep / (2 * steps));
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const angle = fromAngle + (sweep * i) / steps;
    points.push({
      x: centre.x + circumradius * Math.cos(angle),
      y: centre.y + circumradius * Math.sin(angle),
    });
  }
  return points;
}

/**
 * The set of points exactly `distance` metres outside a ring — its Minkowski
 * sum with a disc of that radius.
 *
 * This is the shape the geofence engine actually tests against: it asks how far
 * a position is from the nearest point on the boundary, so a convex corner's
 * firing line is an arc centred on that vertex, not a mitred spike. Scaling
 * every vertex away from the centroid instead — which is what this used to do —
 * offsets each edge by a different amount, and on an elongated fence the long
 * sides barely move at all.
 *
 * Input and output are counter-clockwise rings of `{x, y}` metres.
 *
 * `join` decides what happens at a convex corner. "round" is the exact offset
 * and is what the buffer ring needs, since that is the line the engine fires
 * on. "miter" cuts the corner to a single point instead: it only ever adds
 * clearance, and it keeps a fitted fence down to a handful of vertices someone
 * can still drag around by hand.
 */
function offsetRing(ring, distance, join = "round") {
  const count = ring.length;
  if (count < 2 || !(distance > 0)) return ring;

  // Outward unit normal of the edge leaving each vertex, for CCW winding.
  const normals = ring.map((point, index) => {
    const next = ring[(index + 1) % count];
    const dx = next.x - point.x;
    const dy = next.y - point.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: dy / length, y: -dx / length };
  });

  const offset = [];
  for (let index = 0; index < count; index++) {
    const vertex = ring[index];
    const arriving = normals[(index - 1 + count) % count];
    const leaving = normals[index];
    const cross = arriving.x * leaving.y - arriving.y * leaving.x;
    const dot = Math.max(-1, Math.min(1, arriving.x * leaving.x + arriving.y * leaving.y));

    const straight = Math.abs(cross) <= 1e-9;
    // Rounding is the only join that holds the offset distance exactly, so it
    // is what every awkward corner falls back to. Cutting the corner off flat
    // instead would pass closer to the vertex than the distance asked for —
    // on a sharp spike, far closer.
    const roundCorner = () =>
      offset.push(
        ...arcBetween(vertex, distance, Math.atan2(arriving.y, arriving.x), Math.atan2(leaving.y, leaving.x)),
      );

    if (straight && dot < 0) {
      // The 180° turn at the end of a degenerate segment. No miter exists here,
      // so a cap is always rounded — this is what makes a two-asset fit a
      // capsule rather than nothing at all.
      roundCorner();
      continue;
    }

    if (straight) {
      // Collinear: one point on the shared normal.
      offset.push({ x: vertex.x + leaving.x * distance, y: vertex.y + leaving.y * distance });
      continue;
    }

    if (cross > 0 && join === "round") {
      // Convex corner: the offset edges leave a gap that the exact offset fills
      // with an arc centred on the vertex.
      roundCorner();
      continue;
    }

    // A reflex corner's offset edges genuinely cross, so they always meet at
    // the miter point; a convex one does so only when asked to.
    const bisector = { x: arriving.x + leaving.x, y: arriving.y + leaving.y };
    const length = Math.hypot(bisector.x, bisector.y);
    if (length < 1e-9) {
      roundCorner();
      continue;
    }
    const unit = { x: bisector.x / length, y: bisector.y / length };
    const projection = unit.x * arriving.x + unit.y * arriving.y;
    const miter = projection > 1e-6 ? distance / projection : Number.POSITIVE_INFINITY;
    if (miter > distance * MITER_LIMIT) {
      roundCorner();
      continue;
    }
    offset.push({ x: vertex.x + unit.x * miter, y: vertex.y + unit.y * miter });
  }

  return offset;
}

/** Ring in counter-clockwise order, so `offsetRing`'s normals point outward. */
function counterClockwise(ring) {
  return ring.length >= 3 && signedArea(ring) < 0 ? [...ring].reverse() : ring;
}

function circleRing(centre, radius) {
  return arcBetween(centre, radius, 0, Math.PI * 2).slice(0, -1);
}

/** Smallest circle centred on the group that holds every asset, plus a margin. */
export function circleAroundAssets(points, marginM = 200) {
  const centre = centroidOf(points);
  if (!centre) return null;
  const furthest = points.reduce((max, point) => Math.max(max, metresBetween(centre, point)), 0);
  return {
    center_lat: centre.lat,
    center_lon: centre.lon,
    radius_m: Math.max(50, Math.round(furthest + marginM)),
  };
}

/**
 * Hull around the assets, held `marginM` clear of every one of them. Returns
 * `[lon, lat]` pairs to match the editor's point list and GeoJSON ordering.
 *
 * Two assets, or any number of them strung out along a road, have a hull with
 * no area — the clearance is what gives the fence its width, so those become a
 * capsule around the line rather than a box around the midpoint. A box around
 * the midpoint is what this used to draw, and it left the assets outside their
 * own fence whenever they were further apart than the margin.
 */
export function polygonAroundAssets(points, marginM = 200) {
  const centre = centroidOf(points);
  if (!centre) return null;
  const hull = dropRepeats(toLocal(convexHull(points), centre));
  if (!hull.length) return null;

  // A point or a straight line has no width of its own, so it needs a margin
  // to become a shape at all.
  const requested = Math.max(0, Number(marginM) || 0);
  const clearance = hull.length >= 3 ? requested : Math.max(requested, 50);
  if (hull.length === 1) return fromLocal(circleRing(hull[0], clearance), centre);

  const ring = counterClockwise(hull);
  if (clearance === 0) return fromLocal(ring, centre);
  return fromLocal(offsetRing(ring, clearance, "miter"), centre);
}

/**
 * Ring showing where a breach actually fires: every point exactly `bufferM`
 * outside the fence, which is the line the engine compares positions against.
 */
export function bufferRing(ring, bufferM) {
  if (!Array.isArray(ring) || ring.length < 3 || !(Number(bufferM) > 0)) return null;
  const points = ring.map(([lon, lat]) => ({ lat, lon }));
  const centre = centroidOf(points);
  if (!centre) return null;
  const local = dropRepeats(toLocal(points, centre));
  if (local.length < 3) return null;
  return fromLocal(offsetRing(counterClockwise(local), Number(bufferM)), centre);
}

/**
 * Every point exactly `distanceM` from the zone's edge: outside it, or inside
 * it with `inward`. This is the line the engine fires on, for any shape.
 *
 * Shifting each edge out and joining the corners is only right for a shape
 * with no inward bends. At an inward corner the shifted edges cross, and once
 * the distance is large next to the bend they fold back over each other: an
 * L-shaped zone drew its 2 km line up to 500 m from where it really is. So for
 * those shapes the area is built the way the engine measures it - the shape,
 * plus a strip along every edge, plus a circle on every corner - and its
 * outline is the line.
 *
 * Returns outlines as `[lon, lat]` rings (open). An outer line can come with
 * holes, such as the gap between a U's arms that is further than the distance
 * from both. Null when there is no such line, e.g. a step deeper than the zone
 * is wide.
 */
export function offsetRings(ring, distanceM, inward = false) {
  const distance = Number(distanceM);
  if (!Array.isArray(ring) || ring.length < 3 || !(distance > 0)) return null;
  const points = ring.map(([lon, lat]) => ({ lat, lon }));
  const centre = centroidOf(points);
  const local = counterClockwise(dropRepeats(toLocal(points, centre)));
  if (local.length < 3) return null;

  // No inward bends: shifting the edges is already exact, and far cheaper.
  if (!inward && isConvex(local)) return [fromLocal(offsetRing(local, distance), centre)];

  // Detail far smaller than the distance cannot move the line by more than
  // its own size, so a border is smoothed by at most 0.5% of the distance
  // first. A 2 km line on a district border goes from most of a second to a
  // few tens of milliseconds, and stays within 10 m.
  const closed = [...local, local[0]];
  const kept = keepIndices(closed, Math.max(0.25, distance * 0.005)).slice(0, -1);
  const outline = kept.length >= 3 ? kept.map((i) => local[i]) : local;

  // The clipping maths trips over coordinates that differ in the last few
  // binary digits, so everything is snapped to a centimetre grid first.
  const asPair = (p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100];
  const shape = [[...outline, outline[0]].map(asPair)];
  const strips = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > 1e-6) {
      const nx = ((b.y - a.y) / length) * distance;
      const ny = (-(b.x - a.x) / length) * distance;
      const quad = [
        { x: a.x + nx, y: a.y + ny },
        { x: b.x + nx, y: b.y + ny },
        { x: b.x - nx, y: b.y - ny },
        { x: a.x - nx, y: a.y - ny },
      ];
      strips.push([[...quad, quad[0]].map(asPair)]);
    }
    const disc = fineCircle(a, distance);
    strips.push([[...disc, disc[0]].map(asPair)]);
  }

  let area;
  try {
    area = inward
      ? polygonClipping.difference(shape, polygonClipping.union(...strips))
      : polygonClipping.union(shape, ...strips);
  } catch {
    return null;
  }
  const rings = [];
  for (const polygon of area) {
    for (const outline of polygon) {
      const open = outline.slice(0, -1).map(([x, y]) => ({ x, y }));
      if (open.length >= 3) rings.push(fromLocal(open, centre));
    }
  }
  return rings.length ? rings : null;
}

/**
 * A place's border pushed out by a margin, as one outline to save as a zone.
 * Any hole is dropped: it only makes the zone a little bigger, never smaller.
 */
export function grownRing(ring, distanceM) {
  const rings = offsetRings(ring, distanceM);
  if (!rings) return null;
  return rings.reduce((best, item) => (Math.abs(ringArea(item)) > Math.abs(ringArea(best)) ? item : best), rings[0]);
}

function ringArea(ring) {
  return signedArea(ring.map(([x, y]) => ({ x, y })));
}

function isConvex(ring) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const c = ring[(i + 2) % ring.length];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) < -1e-9) return false;
  }
  return true;
}

// Corner circles for offsetRings. Their edges sit on the true circle and their
// points a little proud, as with arcBetween; at 64 sides that is about 0.1%,
// two metres on a 2 km step.
function fineCircle(centre, radius, sides = 64) {
  const circumradius = radius / Math.cos(Math.PI / sides);
  const points = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    points.push({ x: centre.x + circumradius * Math.cos(angle), y: centre.y + circumradius * Math.sin(angle) });
  }
  return points;
}

/**
 * The alarm line of a "must not enter" rule: every point `bufferM` inside the
 * zone. Drawn only; a zone thinner than twice the allowance has no honest
 * inner line, and the caller simply shows what comes back.
 */
export function insetRing(ring, bufferM) {
  if (!Array.isArray(ring) || ring.length < 3 || !(Number(bufferM) > 0)) return null;
  const points = ring.map(([lon, lat]) => ({ lat, lon }));
  const centre = centroidOf(points);
  if (!centre) return null;
  const local = dropRepeats(toLocal(points, centre));
  if (local.length < 3) return null;
  // Clockwise winding turns offsetRing's outward normals inward.
  return fromLocal(offsetRing([...counterClockwise(local)].reverse(), Number(bufferM), "miter"), centre);
}

export function formatDistance(metres) {
  if (!Number.isFinite(metres)) return "—";
  return metres >= 1000 ? `${(metres / 1000).toFixed(metres >= 10_000 ? 0 : 1)} km` : `${Math.round(metres)} m`;
}

export function formatArea(squareMetres) {
  if (!Number.isFinite(squareMetres)) return "—";
  if (squareMetres >= 1_000_000) return `${(squareMetres / 1_000_000).toFixed(1)} km²`;
  if (squareMetres >= 10_000) return `${(squareMetres / 10_000).toFixed(1)} ha`;
  return `${Math.round(squareMetres)} m²`;
}

/**
 * Whether a ring crosses itself — a bowtie, usually from clicking corners in
 * the wrong order.
 *
 * The engine fills a polygon by the even-odd rule, so one lobe of a bowtie
 * counts as *outside* the fence. Nothing about the drawn shape says so, which
 * makes a self-intersecting fence a silently wrong one. Ring is `[lon, lat]`
 * pairs, open or closed; the test is topological, so it needs no projection.
 */
export function polygonSelfIntersects(ring) {
  const points = Array.isArray(ring) ? ring.filter((point) => Array.isArray(point) && point.length >= 2) : [];
  const open =
    points.length > 1 && samePair(points[0], points[points.length - 1]) ? points.slice(0, -1) : points;
  const count = open.length;
  if (count < 4) return false;

  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      // Edges that share a vertex always touch; that is not a crossing.
      if (j === i || j === (i + 1) % count || i === (j + 1) % count) continue;
      if (segmentsCross(open[i], open[(i + 1) % count], open[j], open[(j + 1) % count])) return true;
    }
  }
  return false;
}

/** Null, undefined and "" all coerce to 0, which is a real coordinate. */
function coordinate(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function samePair(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12;
}

function orientation(a, b, c) {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(value) < 1e-15) return 0;
  return value > 0 ? 1 : -1;
}

function onSegment(a, b, point) {
  return (
    Math.min(a[0], b[0]) - 1e-15 <= point[0] &&
    point[0] <= Math.max(a[0], b[0]) + 1e-15 &&
    Math.min(a[1], b[1]) - 1e-15 <= point[1] &&
    point[1] <= Math.max(a[1], b[1]) + 1e-15
  );
}

function segmentsCross(p1, p2, p3, p4) {
  const d1 = orientation(p3, p4, p1);
  const d2 = orientation(p3, p4, p2);
  const d3 = orientation(p1, p2, p3);
  const d4 = orientation(p1, p2, p4);
  if (d1 !== d2 && d3 !== d4) return true;
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

// Enough sides that the ring still reads as the circle it came from, few enough
// that every vertex can carry a drag handle later.
const CIRCLE_SIDES = 12;

/**
 * The polygon a circle becomes when the operator switches shape type. Vertices
 * sit on the circumradius so the edges cut through the original circle rather
 * than sitting inside it — the shape keeps the area it had.
 */
export function circleToPolygon(centreLat, centreLon, radiusM, sides = CIRCLE_SIDES) {
  const radius = Number(radiusM);
  // Null and "" both coerce to 0, which is a real coordinate — reject them first.
  const centre = { lat: coordinate(centreLat), lon: coordinate(centreLon) };
  if (centre.lat === null || centre.lon === null || !(radius > 0)) return null;
  const circumradius = radius / Math.cos(Math.PI / sides);
  const local = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    local.push({ x: circumradius * Math.cos(angle), y: circumradius * Math.sin(angle) });
  }
  return fromLocal(local, centre);
}

/**
 * The circle a polygon becomes when the operator switches shape type: the
 * smallest one centred on the shape that still contains every corner, so
 * nothing that was inside the fence falls out of it.
 */
export function polygonToCircle(ring) {
  const points = (Array.isArray(ring) ? ring : [])
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map(([lon, lat]) => ({ lat: Number(lat), lon: Number(lon) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  if (!points.length) return null;
  return circleAroundAssets(points, 0);
}

/**
 * Fewer corners, same outline. A finger trace or a widened border can carry
 * hundreds of points, and every corner becomes a drag handle in the editor.
 * Douglas-Peucker in local metres, with the tolerance raised until it fits.
 * `ring` is [lon, lat] pairs, open (no repeated closing corner).
 */
export function simplifyRing(ring, maxPoints = 60, startToleranceM = 2) {
  if (!Array.isArray(ring) || ring.length <= 3) return ring;
  const points = ring.map(([lon, lat]) => ({ lat, lon }));
  const centre = centroidOf(points);
  const local = toLocal(points, centre);
  const closed = [...local, local[0]];
  let tolerance = startToleranceM;
  let kept = closed.map((_, i) => i);
  do {
    kept = keepIndices(closed, tolerance);
    tolerance *= 1.5;
  } while (kept.length - 1 > maxPoints);
  const result = kept.slice(0, -1).map((i) => ring[i]);
  return result.length >= 3 ? result : ring;
}

function keepIndices(points, tolerance) {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let worst = 0;
    let at = -1;
    for (let i = start + 1; i < end; i++) {
      const distance = distanceToSegment(points[i], points[start], points[end]);
      if (distance > worst) {
        worst = distance;
        at = i;
      }
    }
    if (at !== -1 && worst > tolerance) {
      keep[at] = 1;
      stack.push([start, at], [at, end]);
    }
  }
  const indices = [];
  keep.forEach((flag, i) => flag && indices.push(i));
  return indices;
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether a point is inside a zone as the editor holds it (circle or open ring). */
export function insideZone(point, zone) {
  if (zone.shape_type === "circle") {
    if (zone.center_lat == null) return false;
    return metresBetween(point, { lat: Number(zone.center_lat), lon: Number(zone.center_lon) }) <= Number(zone.radius_m);
  }
  const ring = zone.points || [];
  if (ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point.lat !== yj > point.lat && point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
