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

const METRES_PER_DEGREE_LAT = 111_320;

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

/** Pushes every vertex directly away from the centre by `marginM`. */
function expandFromCentre(points, centre, marginM) {
  if (marginM <= 0) return points;
  return points.map((point) => {
    const distance = metresBetween(centre, point);
    if (distance < 1) return point;
    const scale = (distance + marginM) / distance;
    return {
      lat: centre.lat + (point.lat - centre.lat) * scale,
      lon: centre.lon + (point.lon - centre.lon) * scale,
    };
  });
}

function boxAround(centre, halfWidthM) {
  const dLat = halfWidthM / METRES_PER_DEGREE_LAT;
  const dLon = halfWidthM / metresPerDegreeLon(centre.lat);
  return [
    { lat: centre.lat - dLat, lon: centre.lon - dLon },
    { lat: centre.lat - dLat, lon: centre.lon + dLon },
    { lat: centre.lat + dLat, lon: centre.lon + dLon },
    { lat: centre.lat + dLat, lon: centre.lon - dLon },
  ];
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
 * Hull around the assets, widened by a margin. Returns `[lon, lat]` pairs to
 * match the editor's point list and GeoJSON ordering. Fewer than three assets
 * cannot make a shape, so those fall back to a box.
 */
export function polygonAroundAssets(points, marginM = 200) {
  const centre = centroidOf(points);
  if (!centre) return null;
  const hull = convexHull(points);
  const shaped = hull.length >= 3 ? expandFromCentre(hull, centre, marginM) : boxAround(centre, Math.max(marginM, 50));
  return shaped.map((point) => [point.lon, point.lat]);
}

/** Ring showing where a breach actually fires: the fence widened by its buffer. */
export function bufferRing(ring, bufferM) {
  const points = ring.map(([lon, lat]) => ({ lat, lon }));
  const centre = centroidOf(points);
  if (!centre || bufferM <= 0) return null;
  return expandFromCentre(points, centre, bufferM).map((point) => [point.lon, point.lat]);
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
