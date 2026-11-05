/**
 * Real place borders from OpenStreetMap, so a zone can follow "Barnawa" or
 * "Kaduna Airport" without anyone drawing it.
 *
 * Two services, because Nominatim (which has the borders) forbids
 * search-as-you-type. Photon is built for type-ahead and answers the
 * suggestions; Nominatim is asked once, for the one place that was picked.
 * Both are free, keyless and shared, so answers are cached and Nominatim is
 * held to its one-request-a-second rule.
 */

const PHOTON = "https://photon.komoot.io/api/";
const NOMINATIM = "https://nominatim.openstreetmap.org/lookup";
const USER_AGENT = "MOMAS geofencing";
// Nigeria with a little margin: west, south, east, north.
const NIGERIA_BBOX = "2.6,4.2,14.7,13.9";
const MAX_BORDER_POINTS = 120;

type Point = [number, number];

const suggestCache = new Map<string, { at: number; value: any[] }>();
const borderCache = new Map<string, { at: number; value: Point[] | null }>();
const SUGGEST_TTL_MS = 60 * 60_000;
const BORDER_TTL_MS = 24 * 60 * 60_000;

function remember<T>(cache: Map<string, { at: number; value: T }>, key: string, value: T) {
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
}

// Roads are a strip, not an area; they get their own picker later.
const SKIP_KEYS = new Set(["highway", "railway", "waterway", "route"]);

const KIND_WORDS: Record<string, string> = {
  city: "City",
  town: "Town",
  village: "Village",
  hamlet: "Village",
  suburb: "Area",
  neighbourhood: "Area",
  quarter: "Area",
  administrative: "Local government",
  aerodrome: "Airport",
  military: "Military",
  barracks: "Barracks",
  school: "School",
  university: "University",
  hospital: "Hospital",
  marketplace: "Market",
  stadium: "Stadium",
  police: "Police",
  prison: "Prison",
};

function kindOf(props: any) {
  if (props.osm_key === "building") return "Building";
  return KIND_WORDS[props.osm_value] || KIND_WORDS[props.type] || "Place";
}

/** Type-ahead suggestions; `osm` is set when the place has an outline to fetch. */
export async function suggestPlaces(query: string) {
  const needle = String(query || "").trim().toLowerCase();
  if (needle.length < 3) return [];
  const cached = suggestCache.get(needle);
  if (cached && Date.now() - cached.at < SUGGEST_TTL_MS) return cached.value;

  const url = `${PHOTON}?${new URLSearchParams({ q: needle, limit: "10", lang: "en", bbox: NIGERIA_BBOX })}`;
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Place search failed (${response.status})`);
  const data: any = await response.json();

  const seen = new Set<string>();
  const places = [];
  for (const feature of data.features || []) {
    const props = feature.properties || {};
    if (SKIP_KEYS.has(props.osm_key) || props.countrycode && props.countrycode !== "NG") continue;
    const [lon, lat] = feature.geometry?.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const area = props.osm_type === "R" || props.osm_type === "W";
    const detail = [props.district || props.city || props.county, props.state].filter((part) => part && part !== props.name).join(", ");
    const key = `${props.name}|${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    places.push({
      name: props.name,
      detail,
      kind: kindOf(props),
      lat,
      lon,
      osm: area ? `${props.osm_type}${props.osm_id}` : null,
    });
    if (places.length >= 6) break;
  }
  remember(suggestCache, needle, places);
  return places;
}

let nominatimQueue: Promise<unknown> = Promise.resolve();
let lastNominatimAt = 0;

/** Runs Nominatim requests one at a time, at least a second apart. */
function throttled<T>(task: () => Promise<T>): Promise<T> {
  const run = nominatimQueue.then(async () => {
    const wait = lastNominatimAt + 1100 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastNominatimAt = Date.now();
    return task();
  });
  nominatimQueue = run.catch(() => undefined);
  return run;
}

/** The outline of one OSM place as [lon, lat] corners, or null when it has none. */
export async function placeBorder(osm: string): Promise<Point[] | null> {
  if (!/^[RW]\d{1,12}$/.test(osm)) throw new Error("Unknown place");
  const cached = borderCache.get(osm);
  if (cached && Date.now() - cached.at < BORDER_TTL_MS) return cached.value;

  const url = `${NOMINATIM}?${new URLSearchParams({ osm_ids: osm, format: "jsonv2", polygon_geojson: "1", polygon_threshold: "0.00005" })}`;
  const data: any = await throttled(async () => {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Border lookup failed (${response.status})`);
    return response.json();
  });

  const border = outerRing(data?.[0]?.geojson);
  const value = border ? simplify(border, MAX_BORDER_POINTS) : null;
  remember(borderCache, osm, value);
  return value;
}

/** A zone is one ring: the largest part of the place, without its holes. */
function outerRing(geojson: any): Point[] | null {
  if (!geojson) return null;
  const rings: Point[][] =
    geojson.type === "Polygon" ? [geojson.coordinates[0]]
    : geojson.type === "MultiPolygon" ? geojson.coordinates.map((part: Point[][]) => part[0])
    : [];
  let best: Point[] | null = null;
  let bestArea = 0;
  for (const ring of rings) {
    const area = Math.abs(shoelace(ring));
    if (area > bestArea) {
      best = ring;
      bestArea = area;
    }
  }
  if (!best || best.length < 4) return null;
  const open = sameCorner(best[0], best[best.length - 1]) ? best.slice(0, -1) : best;
  return open.length >= 3 ? open.map(([lon, lat]) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))] as Point) : null;
}

function shoelace(ring: Point[]) {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function sameCorner(a: Point, b: Point) {
  return a && b && a[0] === b[0] && a[1] === b[1];
}

/**
 * Fewer corners, same outline: each corner is a drag handle in the editor, and
 * a district border can carry thousands. The tolerance grows until the ring fits.
 */
export function simplify(ring: Point[], maxPoints: number): Point[] {
  if (ring.length <= maxPoints) return ring;
  const lat0 = (ring.reduce((sum, [, lat]) => sum + lat, 0) / ring.length) * (Math.PI / 180);
  const scale = Math.cos(lat0);
  let tolerance = 0.00002;
  let result = ring;
  while (result.length > maxPoints) {
    // Closed ring: run it as a line from the first corner back round to itself.
    const line = [...ring, ring[0]];
    const kept = douglasPeucker(line, tolerance, scale);
    result = kept.slice(0, -1);
    tolerance *= 1.6;
  }
  return result.length >= 3 ? result : ring.slice(0, maxPoints);
}

function douglasPeucker(points: Point[], tolerance: number, scale: number): Point[] {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let worst = 0;
    let at = -1;
    for (let i = start + 1; i < end; i += 1) {
      const distance = offLine(points[i], points[start], points[end], scale);
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
  return points.filter((_, i) => keep[i]);
}

function offLine(p: Point, a: Point, b: Point, scale: number) {
  const ax = a[0] * scale, ay = a[1];
  const bx = b[0] * scale, by = b[1];
  const px = p[0] * scale, py = p[1];
  const dx = bx - ax, dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
