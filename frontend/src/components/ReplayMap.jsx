import L from "leaflet";
import { useEffect, useRef, useState } from "react";
import { IMAGERY_LABEL_TILES, IMAGERY_ROAD_TILES, SATELLITE_TILES } from "../lib/basemaps";
import { escapeHtml } from "../lib/domain";
import { mainCluster, pathIndexAt, radioStateAt } from "../lib/fleet-replay";
import { replayPosition } from "../lib/radio-replay";

const NIGERIA_CENTER = [9.0, 8.5];
// Kept clear for the fleet panel on the left and the timeline along the bottom.
const FIT_PADDING = { paddingTopLeft: [380, 90], paddingBottomRight: [60, 170], maxZoom: 17 };
const TAIL_MS = 10 * 60_000;
const time = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// The route up to t, split wherever the radio jumped, ending where it is now.
function routeUpTo(path, t, here, sinceT = -Infinity) {
  const pieces = [];
  let piece = [];
  const last = pathIndexAt(path, t);
  for (let index = 0; index <= last; index += 1) {
    const point = path[index];
    if (point.t < sinceT) continue;
    if (point.jump && piece.length) {
      pieces.push(piece);
      piece = [];
    }
    piece.push([point.lat, point.lon]);
  }
  const next = path[last + 1];
  if (here && piece.length && next && !next.jump) piece.push([here.lat, here.lon]);
  if (piece.length) pieces.push(piece);
  return pieces;
}

function wholeRoute(path) {
  return routeUpTo(path, Infinity, null);
}

function headIcon(colour, label) {
  return L.divIcon({
    className: "",
    html: `<div class="rp-head" style="--c:${colour}"><div class="rp-arrow"></div></div><div class="rp-label" style="--c:${colour}">${escapeHtml(label)}</div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

/**
 * The fleet replay drawn on the map: each radio's route in its own colour, the
 * part already travelled bright, and a head where the radio was at the replay
 * time. With one radio focused, everything else steps back and its stops show.
 */
export function ReplayMap({ fleet, time: t, focusId, trailMode, hiddenIds, showStill, follow, names, onFocus, panTarget }) {
  const nodeRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef(null);
  const entriesRef = useRef(new Map());
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const followRef = useRef(0);
  // Radios left out of the opening view because they were far from the rest.
  const [elsewhere, setElsewhere] = useState([]);

  useEffect(() => {
    if (!nodeRef.current || mapRef.current) return undefined;
    // No maxBounds, unlike the live map: framing Lagos and Abuja together
    // clear of the side panel needs room past the border, and a clamp would
    // shove Lagos under the panel.
    const map = L.map(nodeRef.current, { zoomControl: false, maxZoom: 21 }).setView(NIGERIA_CENTER, 6);
    L.tileLayer(SATELLITE_TILES.url, SATELLITE_TILES.options).addTo(map);
    L.tileLayer(IMAGERY_ROAD_TILES.url, IMAGERY_ROAD_TILES.options).addTo(map);
    L.tileLayer(IMAGERY_LABEL_TILES.url, IMAGERY_LABEL_TILES.options).addTo(map);
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.scale({ position: "bottomright", imperial: false }).addTo(map);
    const renderer = L.canvas({ padding: 0.4, tolerance: 6 });
    layersRef.current = {
      renderer,
      routes: L.layerGroup().addTo(map),
      stops: L.layerGroup().addTo(map),
      still: L.layerGroup(),
      heads: L.layerGroup().addTo(map),
    };
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Build every radio's lines and head once per replay; the clock only moves them.
  useEffect(() => {
    const map = mapRef.current;
    const layers = layersRef.current;
    if (!map || !layers) return;
    layers.routes.clearLayers();
    layers.heads.clearLayers();
    layers.still.clearLayers();
    entriesRef.current = new Map();
    if (!fleet) return;
    for (const radio of fleet.movers) {
      const name = names(radio.uid);
      const click = () => onFocusRef.current(radio.uid);
      const future = L.polyline(wholeRoute(radio.path), {
        renderer: layers.renderer,
        color: radio.colour,
        weight: 3,
        opacity: 0.55,
        // Dashed for "still to come", solid for "has been": the difference
        // has to survive busy satellite imagery, where a faint line vanishes.
        dashArray: "5 7",
      })
        .on("click", click)
        .bindTooltip(name, { sticky: true, direction: "top" });
      const done = L.polyline([], { renderer: layers.renderer, color: radio.colour, weight: 4, opacity: 0.95, interactive: false });
      const head = L.marker([radio.path[0].lat, radio.path[0].lon], { icon: headIcon(radio.colour, name), zIndexOffset: 1000 })
        .on("click", click)
        .bindTooltip(name, { direction: "top", offset: [0, -10] });
      entriesRef.current.set(radio.uid, { radio, future, done, head, state: null });
    }
    for (const radio of fleet.still) {
      L.circleMarker([radio.lat, radio.lon], { radius: 4, color: "#0a0a0a", weight: 1, fillColor: "#a3a3a3", fillOpacity: 0.85 })
        .bindTooltip(`${escapeHtml(names(radio.uid))} · stayed put · ${time(radio.firstAt)}–${time(radio.lastAt)}`, { direction: "top" })
        .addTo(layers.still);
    }
    // Open on where most of the movement was. One radio on a trip to Abuja
    // should not shrink a day of patrols in Lagos to a speck.
    const { inside, outside } = mainCluster(fleet.movers);
    setElsewhere(outside);
    const framed = inside.flatMap((radio) => radio.path.map((point) => [point.lat, point.lon]));
    if (framed.length) map.fitBounds(L.latLngBounds(framed), FIT_PADDING);
    else if (fleet.still.length) map.fitBounds(L.latLngBounds(fleet.still.map((radio) => [radio.lat, radio.lon])), FIT_PADDING);
  }, [fleet, names]);

  const showAll = () => {
    const all = fleet.movers.flatMap((radio) => radio.path.map((point) => [point.lat, point.lon]));
    if (all.length) mapRef.current?.fitBounds(L.latLngBounds(all), FIT_PADDING);
    setElsewhere([]);
  };

  // Which lines are on the map, and how loud each one is.
  useEffect(() => {
    const layers = layersRef.current;
    if (!layers) return;
    for (const [uid, entry] of entriesRef.current) {
      const shown = !hiddenIds.has(uid);
      const quiet = focusId && focusId !== uid;
      const focused = focusId === uid;
      const showFuture = shown && trailMode === "full";
      if (showFuture) entry.future.addTo(layers.routes);
      else layers.routes.removeLayer(entry.future);
      if (shown) {
        entry.done.addTo(layers.routes);
        entry.head.addTo(layers.heads);
      } else {
        layers.routes.removeLayer(entry.done);
        layers.heads.removeLayer(entry.head);
      }
      entry.future.setStyle({ opacity: quiet ? 0.12 : focused ? 0.75 : 0.55, weight: focused ? 4 : 3 });
      entry.done.setStyle({ opacity: quiet ? 0.18 : 0.95, weight: focused ? 6 : 4 });
      entry.head.setZIndexOffset(focused ? 3000 : 1000);
      entry.head.getElement()?.classList.toggle("rp-quiet", Boolean(quiet));
      entry.head.getElement()?.classList.toggle("rp-focused", focused);
      if (focused) entry.done.bringToFront();
    }
  }, [fleet, focusId, trailMode, hiddenIds]);

  // Stops for the focused radio: a ring sized by how long it stayed.
  useEffect(() => {
    const layers = layersRef.current;
    const map = mapRef.current;
    if (!layers || !map) return;
    layers.stops.clearLayers();
    const entry = focusId ? entriesRef.current.get(focusId) : null;
    if (!entry) return;
    const { radio } = entry;
    radio.stops.forEach((stop, index) => {
      L.circleMarker([stop.lat, stop.lon], {
        radius: Math.min(18, 7 + stop.durationSec / 400),
        color: radio.colour,
        weight: 2,
        fillColor: radio.colour,
        fillOpacity: 0.18,
      })
        .bindTooltip(`Stop ${index + 1} · ${Math.round(stop.durationSec / 60)} min · ${time(stop.from)}–${time(stop.to)}`, { direction: "top" })
        .addTo(layers.stops);
    });
    map.fitBounds(L.latLngBounds(radio.path.map((point) => [point.lat, point.lon])), FIT_PADDING);
  }, [focusId, fleet]);

  useEffect(() => {
    const layers = layersRef.current;
    const map = mapRef.current;
    if (!layers || !map) return;
    if (showStill) layers.still.addTo(map);
    else map.removeLayer(layers.still);
  }, [showStill, fleet]);

  useEffect(() => {
    if (panTarget && mapRef.current) mapRef.current.setView([panTarget.lat, panTarget.lon], Math.max(mapRef.current.getZoom(), 16));
  }, [panTarget]);

  // The clock: every head to where its radio was, every trail up to it.
  useEffect(() => {
    if (t == null) return;
    for (const entry of entriesRef.current.values()) {
      const { radio, head, done } = entry;
      const state = radioStateAt(radio, t);
      const here = replayPosition(radio, t);
      if (here) head.setLatLng([here.lat, here.lon]);
      const element = head.getElement();
      if (element) {
        element.classList.toggle("rp-is-moving", state.kind === "moving");
        const pin = element.querySelector(".rp-head");
        pin?.classList.toggle("rp-moving", state.kind === "moving");
        pin?.classList.toggle("rp-silent", state.kind === "silent" || state.kind === "before");
        const arrow = element.querySelector(".rp-arrow");
        if (arrow) arrow.style.transform = here?.moving ? `rotate(${Math.round(here.bearing)}deg)` : "";
        arrow?.classList.toggle("rp-show", Boolean(here?.moving));
      }
      done.setLatLngs(routeUpTo(radio.path, t, here, trailMode === "tail" ? t - TAIL_MS : -Infinity));
    }
    // Follow the focused radio, panning only when it nears the edge.
    const map = mapRef.current;
    const focused = focusId ? entriesRef.current.get(focusId) : null;
    if (follow && focused && map && window.performance.now() - followRef.current > 400) {
      const here = replayPosition(focused.radio, t);
      if (here && !map.getBounds().pad(-0.3).contains([here.lat, here.lon])) {
        followRef.current = window.performance.now();
        map.panTo([here.lat, here.lon], { animate: true, duration: 0.4 });
      }
    }
  }, [t, trailMode, fleet, follow, focusId]);

  return (
    <>
      <div ref={nodeRef} className="ops-map" />
      {elsewhere.length && !focusId ? (
        <button
          onClick={showAll}
          className="glass-panel absolute left-[calc(50%+11rem)] top-[calc(var(--ops-chrome)+0.75rem)] z-[1000] -translate-x-1/2 rounded-full px-3 py-1 text-[11px] text-neutral-200 hover:text-white"
        >
          {elsewhere.length === 1 ? `${names(elsewhere[0].uid)} is elsewhere` : `${elsewhere.length} radios are elsewhere`} ·{" "}
          <span className="font-bold text-ops-red">Show all</span>
        </button>
      ) : null}
    </>
  );
}
