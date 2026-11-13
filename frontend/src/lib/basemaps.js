/**
 * Shared tile sources for the dark basemap and its label overlays.
 *
 * CARTO ended anonymous access to their basemaps: unauthenticated requests
 * still return a tile, but one with "API KEY REQUIRED" burned across it. Esri's
 * Canvas services are the keyless replacement, and living in one module means
 * the next provider change is a single edit rather than a hunt.
 *
 * The dark canvas stops at zoom 16 - past that Esri serves a pale "Map data not
 * yet available" placeholder, which on a dark operations map reads as a
 * rendering fault. Pinning maxNativeZoom to 16 makes Leaflet upscale the last
 * real tile instead of asking for one that does not exist.
 *
 * Esri's dark canvas is also a lighter grey than CARTO's was, bright enough to
 * read as a lit panel inside the dark operations chrome. The basemap-dark class
 * darkens it back down; it sits on this layer's own tile container, so the
 * satellite and streets basemaps are untouched and markers - which live in a
 * different pane - keep their full colour.
 */

const ESRI_IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
const ESRI_CANVAS = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
const ESRI_REFERENCE = "https://services.arcgisonline.com/arcgis/rest/services/Reference";
const ESRI_ATTRIBUTION = "Tiles &copy; Esri";

export const DARK_TILES = {
  url: `${ESRI_CANVAS}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
  options: {
    maxZoom: 21,
    maxNativeZoom: 16,
    attribution: ESRI_ATTRIBUTION,
    className: "basemap-dark",
  },
};

/**
 * Imagery is the default basemap: it is how someone who does not read maps
 * recognises a real place - they see their own buildings.
 *
 * Esri's main World Imagery service, which carries its newest photos (checked
 * Nov 2026: Kaduna Mar 2026, Kano Jan 2026, Abuja Dec 2025, about 30 cm). The
 * "Clarity" service used before now redirects every street-level zoom (15+)
 * to a frozen January 2020 snapshot.
 *
 * Cities have photos to zoom 19; much of the countryside stops at 18, where
 * Esri would answer with a grey "Map data not yet available" square.
 * blankTile=false turns that square into a plain miss, and a zoom-18 layer
 * underneath shows through, slightly enlarged, wherever the zoom-19 photo is
 * missing.
 */
const SATELLITE_URL = `${ESRI_IMAGERY}/tile/{z}/{y}/{x}?blankTile=false`;
const SATELLITE_ATTRIBUTION = "Tiles &copy; Esri";

export function satelliteLayer(L, extraOptions = {}) {
  const base = L.tileLayer(SATELLITE_URL, {
    maxZoom: 21,
    maxNativeZoom: 18,
    attribution: SATELLITE_ATTRIBUTION,
    ...extraOptions,
  });
  // Only exists from zoom 19, so lower zooms fetch each photo once.
  const detail = L.tileLayer(SATELLITE_URL, {
    minZoom: 19,
    maxZoom: 21,
    maxNativeZoom: 19,
    ...extraOptions,
  });
  const group = L.layerGroup([base, detail]);
  // Basemap switching sends the active basemap behind the labels. Each call
  // lands below the last, so the detail layer goes first to end up on top.
  group.bringToBack = () => {
    detail.bringToBack();
    base.bringToBack();
    return group;
  };
  return group;
}

/**
 * Imagery carries no place names of its own, and the operations map opens
 * country-wide - unlabelled, that view cannot tell Kaduna from Bauchi. Any
 * basemap listed in LABELLED_BASEMAPS gets this overlay stacked on top.
 *
 * Place labels for imagery rather than the dark canvas's own reference layer:
 * satellite stays sharp to zoom 19, and the canvas labels would have blurred
 * out three levels earlier.
 */
export const IMAGERY_LABEL_TILES = {
  url: `${ESRI_REFERENCE}/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
  options: { maxZoom: 21, maxNativeZoom: 19, opacity: 0.9, attribution: ESRI_ATTRIBUTION },
};

/**
 * Street names for imagery, stacked under the place names. Seen from above,
 * one road looks like the next; the name is what says where a radio is. Esri
 * serves real tiles to zoom 19, so names stay sharp as far in as the imagery.
 */
export const IMAGERY_ROAD_TILES = {
  url: `${ESRI_REFERENCE}/World_Transportation/MapServer/tile/{z}/{y}/{x}`,
  options: { maxZoom: 21, maxNativeZoom: 19, opacity: 0.9, attribution: ESRI_ATTRIBUTION },
};

/** Basemaps that draw no place names of their own and need the overlays. */
export const LABELLED_BASEMAPS = new Set(["satellite"]);

/**
 * Vector basemaps, drawn in the browser by MapLibre from OpenFreeMap's
 * OpenStreetMap tiles: free, keyless, and sharp at every zoom - including the
 * close-in zooms where the raster canvases above run out and blur. Building
 * outlines and street names stay crisp at street level, which is where radios
 * are worked.
 */
const OPENFREEMAP = "https://tiles.openfreemap.org/styles";
const OSM_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';

export const VECTOR_STYLES = {
  streets: `${OPENFREEMAP}/liberty`,
  // Light grey with every building outlined: the pins carry the colour. The
  // dark style was tried first and was too dark to make out buildings.
  grey: `${OPENFREEMAP}/positron`,
};

/**
 * The stock styles undersell street names, which are what tell an operator
 * where a radio is at street level. Motorways get only a route shield - "E1",
 * never "Lagos-Ibadan Expressway" - small-street names wait for zoom 15, and
 * every name is 12-13px grey with no halo colour, so it sinks into the road it
 * labels. Both styles use these layer ids; a missing one is skipped.
 */
const ROAD_NAME_SIZE = ["interpolate", ["linear"], ["zoom"], 13, 12, 16, 14, 18, 16];

function emphasiseRoadNames(glMap) {
  const has = (id) => Boolean(glMap.getLayer(id));
  if (has("highway-name-major")) {
    glMap.setFilter("highway-name-major", [
      "match",
      ["get", "class"],
      ["motorway", "trunk", "primary", "secondary", "tertiary"],
      true,
      false,
    ]);
  }
  // The shields sit above the names and are placed first; at their stock 200px
  // spacing they leave no stretch long enough for "Lagos-Ibadan Expressway".
  if (has("highway-shield-non-us")) glMap.setLayoutProperty("highway-shield-non-us", "symbol-spacing", 600);
  // Zoom 14 is the deepest the tiles go, so every name is already loaded there.
  if (has("highway-name-minor")) glMap.setLayerZoomRange("highway-name-minor", 14, 24);
  for (const id of ["highway-name-major", "highway-name-minor"]) {
    if (!has(id)) continue;
    glMap.setLayoutProperty(id, "text-size", ROAD_NAME_SIZE);
    glMap.setPaintProperty(id, "text-color", "#333");
    glMap.setPaintProperty(id, "text-halo-color", "#fff");
    glMap.setPaintProperty(id, "text-halo-width", 1.5);
  }
}

/**
 * A Leaflet layer that draws one of VECTOR_STYLES. MapLibre is large, so it is
 * fetched only the first time someone picks a vector basemap, not on every
 * load of the satellite map most people use.
 */
export async function vectorBasemapLayer(L, key) {
  const [{ maplibreGL }] = await Promise.all([
    import("@maplibre/maplibre-gl-leaflet"),
    import("maplibre-gl/dist/maplibre-gl.css"),
  ]);
  const layer = maplibreGL({
    style: VECTOR_STYLES[key],
    attribution: OSM_ATTRIBUTION,
    // Leaflet owns zoom and panning; MapLibre only paints underneath.
    interactive: false,
  });
  // The plugin builds a fresh MapLibre map every time the layer is added, so
  // the road names are re-emphasised each time this basemap is picked again.
  layer.on("add", () => {
    const glMap = layer.getMaplibreMap();
    glMap?.on("style.load", () => emphasiseRoadNames(glMap));
  });
  return layer;
}
