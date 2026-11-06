// Each zone gets its own colour, so two zones side by side are told apart at
// a glance and a zone in the list matches its shape on the map. Red, pink, amber,
// yellow and green are left out: they mean alarm levels and radio status.

import L from "leaflet";

export const ZONE_COLOURS = ["#38bdf8", "#a78bfa", "#2dd4bf", "#e879f9", "#cbd5e1", "#818cf8"];

/** The same zone is always the same colour, on every map and in the list. */
export function zoneColour(zone) {
  const id = Number(zone?.id);
  if (Number.isFinite(id)) return ZONE_COLOURS[Math.abs(id) % ZONE_COLOURS.length];
  let hash = 0;
  for (const char of String(zone?.name || "")) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return ZONE_COLOURS[Math.abs(hash) % ZONE_COLOURS.length];
}

/** The zone's name on the map, in its colour, at its middle. */
export function addZoneName(layer, zone, colour) {
  let at = null;
  if (zone.shape_type === "circle") {
    const lat = Number(zone.center_lat);
    const lon = Number(zone.center_lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) at = [lat, lon];
  } else {
    const ring = zone.geometry?.coordinates?.[0];
    if (Array.isArray(ring) && ring.length >= 3) at = L.latLngBounds(ring.map(([lon, lat]) => [lat, lon])).getCenter();
  }
  if (!at || !zone.name) return;
  const name = document.createElement("span");
  name.className = "zone-name";
  name.style.color = colour;
  name.textContent = zone.name;
  L.marker(at, { interactive: false, keyboard: false, icon: L.divIcon({ className: "", iconSize: [0, 0], html: name.outerHTML }) }).addTo(layer);
}

/** Names hide when zoomed out far, where they would only pile on each other. */
export function hideZoneNamesWhenFar(map, minZoom = 11) {
  const sync = () => map.getContainer().classList.toggle("zone-names-hidden", map.getZoom() < minZoom);
  map.on("zoomend", sync);
  sync();
}
