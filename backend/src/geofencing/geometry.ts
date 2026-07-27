export type GeofenceShape = {
  shape_type: "circle" | "polygon";
  geometry?: any;
  center_lat?: number | null;
  center_lon?: number | null;
  radius_m?: number | null;
  buffer_m?: number | null;
};

const EARTH_RADIUS_M = 6_371_008.8;

export function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function pointInPolygon(lat: number, lon: number, geometry: any) {
  const rings = geometry?.type === "Polygon" ? geometry.coordinates : null;
  if (!Array.isArray(rings) || !rings.length) return false;

  const inRing = (ring: any[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i] || [];
      const [xj, yj] = ring[j] || [];
      if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
      const crosses = yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi;
      if (crosses) inside = !inside;
    }
    return inside;
  };

  if (!inRing(rings[0])) return false;
  return !rings.slice(1).some(inRing);
}

function localXY(lat: number, lon: number, originLat: number, originLon: number) {
  const rad = Math.PI / 180;
  return {
    x: (lon - originLon) * rad * EARTH_RADIUS_M * Math.cos(originLat * rad),
    y: (lat - originLat) * rad * EARTH_RADIUS_M,
  };
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distanceToPolygonMetres(lat: number, lon: number, geometry: any) {
  const rings = geometry?.type === "Polygon" ? geometry.coordinates : null;
  if (!Array.isArray(rings)) return Number.POSITIVE_INFINITY;
  let closest = Number.POSITIVE_INFINITY;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      const p = localXY(lat, lon, lat, lon);
      const aa = localXY(a[1], a[0], lat, lon);
      const bb = localXY(b[1], b[0], lat, lon);
      closest = Math.min(closest, distanceToSegment(p.x, p.y, aa.x, aa.y, bb.x, bb.y));
    }
  }
  return closest;
}

export function evaluateFence(fence: GeofenceShape, lat: number, lon: number) {
  const buffer = Math.max(0, Number(fence.buffer_m) || 0);
  if (fence.shape_type === "circle") {
    const distance = haversineMetres(lat, lon, Number(fence.center_lat), Number(fence.center_lon));
    const radius = Number(fence.radius_m) || 0;
    return {
      outside: distance > radius + buffer,
      distanceOutsideM: Math.max(0, distance - radius),
    };
  }

  const inside = pointInPolygon(lat, lon, fence.geometry);
  const boundaryDistance = distanceToPolygonMetres(lat, lon, fence.geometry);
  return {
    outside: !inside && boundaryDistance > buffer,
    distanceOutsideM: inside ? 0 : boundaryDistance,
  };
}

function outerRing(geometry: any): number[][] {
  const rings = geometry?.type === "Polygon" ? geometry.coordinates : null;
  const ring = Array.isArray(rings) ? rings[0] : null;
  return Array.isArray(ring) ? ring.filter((point: any) => Array.isArray(point) && point.length >= 2) : [];
}

/** Null and "" both coerce to 0, which is a real coordinate — reject them first. */
function coordinate(value: any) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Centre of a fence: the circle's centre, or the polygon's bounding-box centre. */
export function fenceCentre(fence: GeofenceShape) {
  if (fence.shape_type === "circle") {
    const lat = coordinate(fence.center_lat);
    const lon = coordinate(fence.center_lon);
    return lat !== null && lon !== null ? { lat, lon } : null;
  }
  const ring = outerRing(fence.geometry);
  if (!ring.length) return null;
  const lats = ring.map((point) => Number(point[1]));
  const lons = ring.map((point) => Number(point[0]));
  return {
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    lon: (Math.min(...lons) + Math.max(...lons)) / 2,
  };
}

/**
 * Size of a fence in metres and square metres. Surfaced so someone placing a
 * fence can sanity-check it in units they think in — "1.2 km across" catches a
 * fence drawn around a whole city far faster than looking at the shape does.
 */
export function fenceMetrics(fence: GeofenceShape) {
  const centre = fenceCentre(fence);
  if (!centre) return null;

  if (fence.shape_type === "circle") {
    const radius = Math.max(0, Number(fence.radius_m) || 0);
    return { centre, width_m: radius * 2, height_m: radius * 2, area_sq_m: Math.PI * radius * radius };
  }

  const ring = outerRing(fence.geometry);
  if (ring.length < 3) return null;
  const projected = ring.map((point) => localXY(Number(point[1]), Number(point[0]), centre.lat, centre.lon));
  const xs = projected.map((point) => point.x);
  const ys = projected.map((point) => point.y);
  // Shoelace over the locally projected ring; accurate at fence scale.
  let twiceArea = 0;
  for (let i = 0, j = projected.length - 1; i < projected.length; j = i++) {
    twiceArea += projected[j].x * projected[i].y - projected[i].x * projected[j].y;
  }
  return {
    centre,
    width_m: Math.max(...xs) - Math.min(...xs),
    height_m: Math.max(...ys) - Math.min(...ys),
    area_sq_m: Math.abs(twiceArea) / 2,
  };
}

export function validatePolygonGeometry(geometry: any) {
  if (geometry?.type !== "Polygon" || !Array.isArray(geometry.coordinates) || !geometry.coordinates.length) {
    return false;
  }
  const outer = geometry.coordinates[0];
  return Array.isArray(outer) && outer.length >= 4 && outer.every(
    (point: any) =>
      Array.isArray(point) &&
      point.length >= 2 &&
      Number.isFinite(Number(point[0])) &&
      Number.isFinite(Number(point[1])),
  );
}

