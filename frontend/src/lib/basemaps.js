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

const ESRI_CLARITY = "https://clarity.maptiles.arcgis.com/arcgis/rest/services";
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
 */
export const SATELLITE_TILES = {
  url: `${ESRI_CLARITY}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
  options: { maxZoom: 21, maxNativeZoom: 19, attribution: "Tiles &copy; Esri Clarity" },
};

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

/** Basemaps that draw no place names of their own and need the overlay. */
export const LABELLED_BASEMAPS = new Set(["satellite"]);
