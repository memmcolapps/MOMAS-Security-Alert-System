/**
 * When the Esri satellite photo under the map was taken.
 *
 * Esri's World Imagery is a patchwork: Kano is from Jan 2026, Mowe (Ogun) from
 * April 2020. An operator looking at a new estate that "isn't there" needs to
 * know the photo predates it, so the map shows the date for its centre.
 *
 * Esri keeps one record per zoom range for each patch: layer 0 covers zooms
 * 12-17, layer 2 zoom 18, layer 3 zoom 19 - and in some places all three are
 * different photos. Below zoom 12 the map is a coarse 15 m world mosaic with
 * no single date, so nothing is shown there.
 */

const IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
export const PHOTO_DATE_MIN_ZOOM = 12;
const MAX_PHOTO_ZOOM = 19;
const DATE_FIELD = "DATE (YYYYMMDD)";

/** The YYYYMMDD date of the photo shown at this zoom, or null. */
export function pickPhotoDate(results, zoom) {
  const level = Math.min(Math.round(zoom), MAX_PHOTO_ZOOM);
  if (level < PHOTO_DATE_MIN_ZOOM) return null;
  const match = (results || [])
    .map((result) => result?.attributes || {})
    .find(
      (attributes) =>
        /^\d{8}$/.test(String(attributes[DATE_FIELD] || "")) &&
        Number(attributes.MinMapLevel) <= level &&
        level <= Number(attributes.MaxMapLevel),
    );
  return match ? String(match[DATE_FIELD]) : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "20200405" -> "5 Apr 2020". */
export function formatPhotoDate(yyyymmdd) {
  const value = String(yyyymmdd || "");
  const month = MONTHS[Number(value.slice(4, 6)) - 1];
  if (!/^\d{8}$/.test(value) || !month) return "";
  return `${Number(value.slice(6, 8))} ${month} ${value.slice(0, 4)}`;
}

// Panning back and forth over the same streets asks Esri once per ~100 m.
const cache = new Map();
const CACHE_LIMIT = 500;

export async function fetchPhotoDate(lat, lng, zoom) {
  const level = Math.min(Math.round(zoom), MAX_PHOTO_ZOOM);
  if (level < PHOTO_DATE_MIN_ZOOM) return null;
  const key = `${level}:${lat.toFixed(3)}:${lng.toFixed(3)}`;
  if (cache.has(key)) return cache.get(key);
  const span = 0.005;
  const query = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    sr: "4326",
    layers: "all:0,2,3",
    tolerance: "1",
    mapExtent: `${lng - span},${lat - span},${lng + span},${lat + span}`,
    imageDisplay: "800,800,96",
    returnGeometry: "false",
    f: "json",
  });
  const response = await fetch(`${IMAGERY}/identify?${query}`);
  if (!response.ok) throw new Error(`Esri imagery date: HTTP ${response.status}`);
  const body = await response.json();
  const date = pickPhotoDate(body?.results, level);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, date);
  return date;
}
