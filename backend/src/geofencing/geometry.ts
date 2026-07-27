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

