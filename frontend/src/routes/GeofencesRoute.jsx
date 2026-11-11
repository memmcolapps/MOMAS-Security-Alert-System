import L from "leaflet";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Ban,
  Check,
  ChevronDown,
  LoaderCircle,
  LocateFixed,
  LogOut,
  MapPin,
  MapPinned,
  Minus,
  MousePointerClick,
  Pencil,
  PenLine,
  Plus,
  Radio,
  Save,
  Search,
  Settings2,
  Spline,
  Trash2,
  Undo2,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LEVEL_MEANING, LEVEL_STYLES, LEVELS } from "../lib/alarm-levels";
import {
  deleteGeofence,
  getDronePositions,
  getGeofenceTargets,
  getLocations,
  getMe,
  getPlaceBorder,
  listGeofences,
  listOrganizations,
  previewGeofence,
  saveGeofence,
  searchPlaces,
  suggestPlaces,
} from "../lib/api";
import { IMAGERY_LABEL_TILES, IMAGERY_ROAD_TILES, LABELLED_BASEMAPS, SATELLITE_TILES, vectorBasemapLayer } from "../lib/basemaps";
import { escapeHtml } from "../lib/domain";
import {
  circleAroundAssets,
  formatDistance,
  grownRing,
  insideZone,
  metresBetween,
  polygonSelfIntersects,
  simplifyRing,
} from "../lib/fence-placement";
import { isPlatformOperator, isPlatformStaff } from "../lib/platform-roles";
import { addZoneName, hideZoneNamesWhenFar, zoneColour } from "../lib/zone-colours";
import { drawZoneSteps, zoneSteps } from "../lib/zone-steps";

// A zone is only a place. Each rule on it says who it watches, whether leaving
// or entering is the problem, and how loud the alarm is.
const EMPTY_ZONE = {
  id: null,
  organization_id: "",
  name: "",
  shape_type: "circle",
  points: [],
  center_lat: null,
  center_lon: null,
  radius_m: 300,
};

// In the editor a rule card holds any number of radios, plus units or
// channels as a shortcut, and one direction. Its alarm comes in steps that get
// louder further from the edge: Yellow at the edge, Amber 200 m out, Red 500 m
// out. On save it becomes one stored rule per radio and step, so each radio
// still alarms on its own and the server knows each step's line.
let ruleSeq = 0;
function newRule(patch = {}) {
  ruleSeq += 1;
  return {
    key: `new-${ruleSeq}`,
    targets: [],
    trigger: "exit",
    steps: [firstStep(patch.trigger || "exit")],
    confirmations_required: 1,
    active: true,
    saved: {},
    ...patch,
  };
}

const LEVEL_RANK = { yellow: 0, amber: 1, red: 2 };
const MAX_STEP_M = 20_000;

// Steps are listed from the edge outwards. Going out, a keep-in zone's steps
// get louder (a radio further away is more lost); a no-go zone's get quieter
// (a radio further away is less of a worry), so Red sits at its edge.
const outwardRank = (trigger, level) => (trigger === "enter" ? -LEVEL_RANK[level] : LEVEL_RANK[level]);
const OUTWARD_LEVELS = {
  exit: [...LEVELS].sort((a, b) => outwardRank("exit", a) - outwardRank("exit", b)),
  enter: [...LEVELS].sort((a, b) => outwardRank("enter", a) - outwardRank("enter", b)),
};
const levelsOutward = (trigger) => OUTWARD_LEVELS[trigger] || OUTWARD_LEVELS.exit;

/**
 * The step at the edge. A keep-in zone's is held 30 m out, off GPS drift; a
 * no-go zone's is the edge itself, since being inside is the alarm.
 */
function firstStep(trigger) {
  return trigger === "enter" ? { level: "red", distance_m: 0 } : { level: "amber", distance_m: 30 };
}

/** Keeps only steps in the right order going out; anything that no longer is, is dropped. */
function keepInOrder(steps, trigger) {
  const kept = [];
  for (const step of steps) {
    const previous = kept[kept.length - 1];
    if (!previous || outwardRank(trigger, step.level) > outwardRank(trigger, previous.level)) kept.push(step);
  }
  return kept;
}

/** The next step out and a sensible distance for it. */
function nextStep(steps, trigger) {
  const last = steps[steps.length - 1];
  const level = levelsOutward(trigger).find((item) => outwardRank(trigger, item) > outwardRank(trigger, last.level));
  if (!level) return null;
  // Measured from the zone's edge, so small steps: 100 m, then 250 m.
  const distance = Number(last.distance_m) < 100 ? 100 : Math.round((Number(last.distance_m) * 2.5) / 50) * 50;
  return { level, distance_m: Math.min(MAX_STEP_M, distance) };
}

/**
 * Switching a card between "must stay inside" and "must not enter" keeps its
 * distances and turns the levels round: Yellow, Amber, Red out from a keep-in
 * edge becomes Red, Amber, Yellow out from a no-go edge.
 */
function stepsForTrigger(steps, from, to) {
  if (from === to) return steps;
  return steps.map((step, index) => ({
    level: steps[steps.length - 1 - index].level,
    distance_m: index === 0 && Number(step.distance_m) === firstStep(from).distance_m ? firstStep(to).distance_m : step.distance_m,
  }));
}

const savedKey = (target, trigger, level) => `${target.target_type}:${target.target_id}:${trigger}:${level}`;

const TRIGGER_LABEL = { exit: "must stay inside", enter: "must not enter" };

// Leaving and entering look different everywhere a zone is listed or drawn:
// a blue keep-in zone, a rose no-go zone with a dashed edge.
const TRIGGER_LOOK = {
  exit: {
    zone: "Keep-in zone",
    Icon: LogOut,
    chip: "border-sky-400/40 bg-sky-400/10 text-sky-300",
    accent: "border-l-sky-400",
    icon: "text-sky-300",
    breach: "outside",
    stroke: "#38bdf8",
    dash: null,
  },
  enter: {
    zone: "No-go zone",
    Icon: Ban,
    chip: "border-rose-400/40 bg-rose-400/10 text-rose-300",
    accent: "border-l-rose-400",
    icon: "text-rose-300",
    breach: "inside",
    stroke: "#fb7185",
    dash: "6 5",
  },
};

/** "exit", "enter", or null for a zone with both kinds of rule (or none). */
function zoneKind(rules) {
  const triggers = new Set((rules || []).map((rule) => rule.trigger));
  return triggers.size === 1 ? [...triggers][0] : null;
}
const AROUND_MARGIN_M = 150;

// The same basemaps as the operations map, so a zone is drawn on exactly what
// operators will see it on.
const BASEMAPS = {
  satellite: { label: "Satellite" },
  streets: { label: "Streets" },
  grey: { label: "Grey" },
};

const MEMBER_COLOURS = { ok: "#22c55e", breach: "#ef4444", unknown: "#94a3b8", pending: "#38bdf8" };

function samePoint(a, b) {
  return a && b && Number(a[0]) === Number(b[0]) && Number(a[1]) === Number(b[1]);
}

function toForm(zone) {
  const ring = zone.geometry?.coordinates?.[0] || [];
  const points = ring.length > 1 && samePoint(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring;
  return {
    zone: {
      id: zone.id,
      organization_id: String(zone.organization_id || ""),
      name: zone.name || "",
      shape_type: zone.shape_type,
      points,
      center_lat: zone.center_lat == null ? null : Number(zone.center_lat),
      center_lon: zone.center_lon == null ? null : Number(zone.center_lon),
      radius_m: Number(zone.radius_m) || 300,
    },
    rules: cardsFromRules(zone.rules || []),
  };
}

/**
 * Stored rules back into cards: each radio's rules on one direction are its
 * steps, and radios with exactly the same steps share a card.
 */
function cardsFromRules(rules) {
  const perTarget = new Map();
  for (const rule of rules) {
    const target = { target_type: rule.target_type, target_id: String(rule.target_id) };
    const tuning = [Number(rule.confirmations_required), rule.active !== false];
    const key = [target.target_type, target.target_id, rule.trigger, ...tuning].join("|");
    if (!perTarget.has(key)) {
      perTarget.set(key, { target, trigger: rule.trigger, tuning, steps: [], saved: {} });
    }
    const entry = perTarget.get(key);
    entry.steps.push({ level: LEVELS.includes(rule.level) ? rule.level : "red", distance_m: Number(rule.buffer_m) || 0 });
    entry.saved[savedKey(target, rule.trigger, rule.level)] = rule.id;
  }
  const cards = new Map();
  for (const entry of perTarget.values()) {
    const steps = keepInOrder(
      [...entry.steps].sort((a, b) => a.distance_m - b.distance_m || outwardRank(entry.trigger, a.level) - outwardRank(entry.trigger, b.level)),
      entry.trigger,
    );
    const signature = [entry.trigger, ...entry.tuning, steps.map((step) => `${step.level}@${step.distance_m}`).join(",")].join("|");
    const card = cards.get(signature);
    if (card) {
      card.targets.push(entry.target);
      Object.assign(card.saved, entry.saved);
      continue;
    }
    cards.set(signature, {
      key: `rule-${Object.values(entry.saved)[0]}`,
      targets: [entry.target],
      trigger: entry.trigger,
      steps,
      confirmations_required: entry.tuning[0],
      active: entry.tuning[1],
      saved: { ...entry.saved },
    });
  }
  return [...cards.values()];
}

/**
 * One stored rule per radio and step. A step keeps its stored rule while its
 * radio, direction and level stay the same; anything else is a new rule, so the
 * server starts it fresh instead of carrying an old breach state over.
 */
function expandRule(card) {
  return card.targets.flatMap((target) =>
    card.steps.map((step, stepIndex) => {
      const id = card.saved?.[savedKey(target, card.trigger, step.level)] || null;
      return {
        cardKey: card.key,
        stepIndex,
        level: step.level,
        fresh: !id,
        payload: {
          id,
          target_type: target.target_type,
          target_id: target.target_id,
          trigger: card.trigger,
          level: step.level,
          buffer_m: Number(step.distance_m),
          confirmations_required: Number(card.confirmations_required),
          active: card.active,
        },
      };
    }),
  );
}

const hasTarget = (card, type, id) => card.targets.some((t) => t.target_type === type && String(t.target_id) === String(id));

function isPlaced(zone) {
  return zone.shape_type === "polygon" ? zone.points.length >= 3 : zone.center_lat != null && Number(zone.radius_m) > 0;
}

function toGeometry(zone) {
  if (zone.shape_type !== "polygon" || zone.points.length < 3) return null;
  return { type: "Polygon", coordinates: [[...zone.points, zone.points[0]]] };
}

function zonePayload(zone) {
  return {
    name: zone.name,
    shape_type: zone.shape_type,
    geometry: toGeometry(zone),
    center_lat: zone.center_lat,
    center_lon: zone.center_lon,
    radius_m: zone.shape_type === "circle" ? Number(zone.radius_m) : null,
  };
}

/** Holds a value back until it has stopped changing, so dragging a corner sends one preview. */
function useSettled(value, delayMs) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/** Name lookups and member lists for everything a rule can point at, across organizations. */
function useTargetIndex(allTargets) {
  return useMemo(() => {
    const names = new Map();
    const members = new Map();
    for (const targets of allTargets) {
    for (const unit of targets?.units || []) {
      names.set(`unit:${unit.id}`, unit.name);
      members.set(`unit:${unit.id}`, unit.members || []);
    }
    for (const channel of targets?.channels || []) {
      names.set(`channel:${channel.id}`, channel.name);
      members.set(`channel:${channel.id}`, channel.members || []);
    }
    for (const radio of targets?.radios || []) {
      const key = `radio:${radio.device_id}`;
      names.set(key, radio.name || `Radio ${radio.device_id}`);
      members.set(key, [key]);
    }
    for (const drone of targets?.drones || []) {
      const key = `drone:${drone.sysid}`;
      names.set(key, drone.name || `Drone ${drone.sysid}`);
      members.set(key, [key]);
    }
    }
    return { names, members };
  }, [allTargets]);
}

function targetLabel(index, target) {
  const key = `${target.target_type}:${target.target_id}`;
  const name = index.names.get(key) || `${target.target_type} ${target.target_id}`;
  return target.target_type === "unit" || target.target_type === "channel" ? `${name} (all)` : name;
}

/** "Bello, Musa +3" — enough to recognise a card without reading every chip. */
function targetsSummary(index, targets, max = 2) {
  if (!targets.length) return "Nobody yet";
  const names = targets.slice(0, max).map((target) => targetLabel(index, target)).join(", ");
  return targets.length > max ? `${names} +${targets.length - max}` : names;
}

function ZoneMap({
  basemap,
  onBasemapChange,
  zones,
  editing,
  zone,
  drawing,
  cards,
  radios,
  highlighted,
  members,
  fitToken,
  onShapeChange,
  onAddPoint,
  onFinishPolygon,
  onRadioAction,
  tracing,
  onTrace,
}) {
  const nodeRef = useRef(null);
  const mapRef = useRef(null);
  const layers = useRef({});
  const handlers = useRef({});
  handlers.current = { onShapeChange, onAddPoint, onFinishPolygon, onRadioAction, onTrace };
  const live = useRef({});
  live.current = { editing, zone, drawing, tracing };
  const gesture = useRef({ active: false, justDrew: false });
  const edit = useRef(null);

  useEffect(() => {
    if (!nodeRef.current || mapRef.current) return undefined;
    const map = L.map(nodeRef.current, { zoomControl: false, doubleClickZoom: false }).setView([9, 8.5], 6);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
    layers.current.zones = L.layerGroup().addTo(map);
    layers.current.radios = L.layerGroup().addTo(map);
    layers.current.edit = L.layerGroup().addTo(map);
    layers.current.alarm = L.layerGroup().addTo(map);
    layers.current.members = L.layerGroup().addTo(map);
    mapRef.current = map;
    hideZoneNamesWhenFar(map);

    // Circle: press where the centre goes and drag out the radius. A plain
    // click drops a circle sized to the view, for touch screens and trackpads.
    map.on("mousedown", (event) => {
      const { editing: isEditing, zone: current } = live.current;
      if (!isEditing || current.shape_type !== "circle" || current.center_lat != null) return;
      gesture.current = { active: true, justDrew: false, centre: event.latlng };
      map.dragging.disable();
      handlers.current.onShapeChange({ center_lat: event.latlng.lat, center_lon: event.latlng.lng, radius_m: 1 });
    });
    map.on("mousemove", (event) => {
      if (!gesture.current.active) return;
      const radius = gesture.current.centre.distanceTo(event.latlng);
      handlers.current.onShapeChange({ radius_m: Math.max(1, Math.round(radius)) });
    });
    const endGesture = (event) => {
      if (!gesture.current.active) return;
      const radius = event?.latlng ? gesture.current.centre.distanceTo(event.latlng) : 0;
      gesture.current = { active: false, justDrew: true };
      map.dragging.enable();
      if (radius < 15) handlers.current.onShapeChange({ radius_m: viewRadius(map) });
    };
    map.on("mouseup", endGesture);
    map.on("click", (event) => {
      if (gesture.current.justDrew) {
        gesture.current.justDrew = false;
        return;
      }
      const { editing: isEditing, zone: current, drawing: isDrawing, tracing: isTracing } = live.current;
      if (!isEditing || isTracing) return;
      if (current.shape_type === "circle" && current.center_lat == null) {
        handlers.current.onShapeChange({ center_lat: event.latlng.lat, center_lon: event.latlng.lng, radius_m: viewRadius(map) });
        return;
      }
      if (current.shape_type === "polygon" && isDrawing) handlers.current.onAddPoint([event.latlng.lng, event.latlng.lat]);
    });

    const observer = new window.ResizeObserver(() => map.invalidateSize());
    observer.observe(nodeRef.current);
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      layers.current = {};
    };
  }, []);

  // Tracing: press and draw round the area with a finger or the mouse. The map
  // holds still while this mode is on, so the stroke draws instead of panning;
  // zoom still works from the buttons and the wheel.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !tracing) return undefined;
    const node = map.getContainer();
    map.dragging.disable();
    let stroke = null;
    const down = (event) => {
      if (event.button > 0 || event.target.closest?.(".leaflet-control")) return;
      node.setPointerCapture?.(event.pointerId);
      const at = map.mouseEventToLatLng(event);
      stroke = {
        last: map.mouseEventToContainerPoint(event),
        points: [at],
        line: L.polyline([at], { color: "#fb7185", weight: 3, interactive: false }).addTo(map),
      };
    };
    const move = (event) => {
      if (!stroke) return;
      const point = map.mouseEventToContainerPoint(event);
      if (point.distanceTo(stroke.last) < 4) return;
      stroke.last = point;
      const at = map.mouseEventToLatLng(event);
      stroke.points.push(at);
      stroke.line.addLatLng(at);
    };
    const up = () => {
      if (!stroke) return;
      const { points, line } = stroke;
      stroke = null;
      line.remove();
      gesture.current.justDrew = true;
      if (points.length >= 6) handlers.current.onTrace(points.map((p) => [p.lng, p.lat]));
    };
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
    // With dragging off, Leaflet hands touch back to the page; keep it.
    node.style.touchAction = "none";
    return () => {
      node.style.touchAction = "";
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
      stroke?.line.remove();
      map.dragging.enable();
    };
  }, [tracing]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const cache = (layers.current.baseLayers ||= {
      satellite: L.tileLayer(SATELLITE_TILES.url, SATELLITE_TILES.options),
    });
    layers.current.labelLayer ||= L.layerGroup([
      L.tileLayer(IMAGERY_ROAD_TILES.url, IMAGERY_ROAD_TILES.options),
      L.tileLayer(IMAGERY_LABEL_TILES.url, IMAGERY_LABEL_TILES.options),
    ]);
    let cancelled = false;
    const key = basemap in BASEMAPS ? basemap : "satellite";
    const show = (next) => {
      if (cancelled || mapRef.current !== map) return;
      if (layers.current.base !== next) {
        if (layers.current.base) map.removeLayer(layers.current.base);
        next.addTo(map);
        layers.current.base = next;
        next.bringToBack?.();
      }
      const labels = layers.current.labelLayer;
      const wantsLabels = LABELLED_BASEMAPS.has(key);
      if (wantsLabels && !map.hasLayer(labels)) labels.addTo(map);
      else if (!wantsLabels && map.hasLayer(labels)) map.removeLayer(labels);
    };
    if (cache[key]) show(cache[key]);
    else {
      vectorBasemapLayer(L, key)
        .then((layer) => {
          cache[key] = layer;
          show(layer);
        })
        // No WebGL, or the tile service is unreachable: stay on imagery.
        .catch((error) => {
          console.warn("[Geofences] vector basemap unavailable:", error);
          show(cache.satellite);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [basemap]);

  // Every zone in its own colour and with its name, so neighbours are told
  // apart. A no-go zone keeps a dashed edge. While editing, the others go faint.
  useEffect(() => {
    const layer = layers.current.zones;
    if (!layer) return;
    layer.clearLayers();
    for (const other of zones) {
      if (editing && Number(other.id) === Number(zone.id)) continue;
      const look = TRIGGER_LOOK[zoneKind(other.rules)];
      const colour = zoneColour(other);
      const style = {
        color: colour,
        weight: 2,
        dashArray: look?.dash || null,
        fillColor: colour,
        fillOpacity: editing ? 0.04 : 0.1,
        opacity: editing ? 0.6 : 1,
        interactive: !editing,
      };
      const shape =
        other.shape_type === "circle"
          ? L.circle([Number(other.center_lat), Number(other.center_lon)], { ...style, radius: Number(other.radius_m) })
          : L.polygon((other.geometry?.coordinates?.[0] || []).map(([lon, lat]) => [lat, lon]), style);
      const safeName = escapeHtml(other.name);
      shape.bindTooltip(look ? `${safeName} · ${escapeHtml(look.zone)}` : safeName).addTo(layer);
      if (!editing) addZoneName(layer, other, colour);
      // Browsing: each zone's alarm lines too. While editing they would
      // crowd the one being drawn, so other zones show their edge only.
      if (!editing) drawZoneSteps(layer, other, zoneSteps(other.rules), { name: safeName });
    }
  }, [zones, editing, zone.id]);

  // Live radios. Clicking one is how a rule starts from a person, not a list.
  useEffect(() => {
    const layer = layers.current.radios;
    if (!layer) return;
    layer.clearLayers();
    const quiet = editing && drawing;
    for (const radio of radios) {
      const lit = highlighted.has(radio.key);
      if (lit && members.has(radio.key)) continue;
      const marker = L.circleMarker([radio.lat, radio.lon], {
        radius: lit ? 6 : 4,
        color: "#0b0b0b",
        weight: 1.5,
        fillColor: lit ? MEMBER_COLOURS.pending : "#e5e7eb",
        fillOpacity: lit ? 1 : 0.75,
        interactive: !quiet,
        bubblingMouseEvents: false,
      }).bindTooltip(escapeHtml(radio.name));
      if (!quiet) marker.bindPopup(() => radioPopup(mapRef.current, radio, editing, handlers), { closeButton: false, offset: [0, -2] });
      marker.addTo(layer);
    }
  }, [radios, highlighted, members, editing, drawing]);

  // The shape being edited and its handles. Built only when the shape's
  // structure changes, then moved in place, so a handle being dragged is never
  // torn down under the pointer.
  const structure = editing ? `${zone.shape_type}|${zone.shape_type === "polygon" ? zone.points.length : zone.center_lat != null}|${drawing}` : "off";
  useEffect(() => {
    const layer = layers.current.edit;
    if (!layer) return;
    layer.clearLayers();
    edit.current = null;
    if (!editing) return;
    const style = { color: "#fb7185", weight: 3, fillColor: "#ef4444", fillOpacity: 0.14, interactive: false };
    const handleIcon = (size, fill) =>
      L.divIcon({
        className: "",
        html: `<span style="display:block;width:${size}px;height:${size}px;border-radius:9999px;background:${fill};border:2px solid #fb7185;box-shadow:0 1px 4px rgba(0,0,0,.6)"></span>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });

    if (zone.shape_type === "circle") {
      if (zone.center_lat == null) return;
      const centre = L.latLng(zone.center_lat, zone.center_lon);
      const shape = L.circle(centre, { ...style, radius: Number(zone.radius_m) || 1 }).addTo(layer);
      const centreHandle = L.marker(centre, { draggable: true, icon: handleIcon(14, "#fff"), title: "Drag to move" }).addTo(layer);
      const radiusHandle = L.marker(eastOf(centre, Number(zone.radius_m) || 1), {
        draggable: true,
        icon: handleIcon(12, "#fb7185"),
        title: "Drag to resize",
      }).addTo(layer);
      centreHandle.on("drag", (event) => {
        const next = event.target.getLatLng();
        handlers.current.onShapeChange({ center_lat: next.lat, center_lon: next.lng });
      });
      radiusHandle.on("drag", (event) => {
        const { zone: current } = live.current;
        const radius = L.latLng(current.center_lat, current.center_lon).distanceTo(event.target.getLatLng());
        handlers.current.onShapeChange({ radius_m: Math.max(10, Math.round(radius)) });
      });
      edit.current = { kind: "circle", shape, centreHandle, radiusHandle };
      return;
    }

    const latlngs = zone.points.map(([lon, lat]) => [lat, lon]);
    const shape = (zone.points.length >= 3 && !drawing ? L.polygon(latlngs, style) : L.polyline(latlngs, { ...style, dashArray: "6 6" })).addTo(layer);
    const vertices = zone.points.map(([lon, lat], index) => {
      const marker = L.marker([lat, lon], {
        draggable: !drawing,
        icon: handleIcon(index === 0 && drawing ? 16 : 12, "#fff"),
        title: drawing ? (index === 0 ? "Click to close the shape" : "") : "Drag to move · double-click to remove",
      }).addTo(layer);
      marker.on("click", (event) => {
        L.DomEvent.stopPropagation(event);
        if (drawing && index === 0 && live.current.zone.points.length >= 3) handlers.current.onFinishPolygon();
      });
      marker.on("drag", (event) => {
        const next = event.target.getLatLng();
        const points = live.current.zone.points.map((point, i) => (i === index ? [next.lng, next.lat] : point));
        handlers.current.onShapeChange({ points });
      });
      marker.on("dblclick", (event) => {
        L.DomEvent.stopPropagation(event);
        const points = live.current.zone.points;
        if (points.length > 3) handlers.current.onShapeChange({ points: points.filter((_, i) => i !== index) });
      });
      return marker;
    });
    // A handle on each edge adds a corner where it is dropped. The outline
    // follows it during the drag without touching state, so the drag survives.
    const midpoints = drawing || zone.points.length < 3
      ? []
      : zone.points.map((point, index) => {
          const next = zone.points[(index + 1) % zone.points.length];
          const marker = L.marker(midpointOf(point, next), {
            draggable: true,
            icon: handleIcon(9, "rgba(251,113,133,.85)"),
            title: "Drag to add a corner",
            opacity: 0.85,
          }).addTo(layer);
          marker.on("drag", (event) => {
            const at = event.target.getLatLng();
            const points = [...live.current.zone.points];
            points.splice(index + 1, 0, [at.lng, at.lat]);
            shape.setLatLngs(points.map(([lon, lat]) => [lat, lon]));
          });
          marker.on("dragend", (event) => {
            const at = event.target.getLatLng();
            const points = [...live.current.zone.points];
            points.splice(index + 1, 0, [at.lng, at.lat]);
            handlers.current.onShapeChange({ points });
          });
          return marker;
        });
    edit.current = { kind: "polygon", shape, vertices, midpoints };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure]);

  // Moves the shape and handles to the current form without rebuilding them.
  useEffect(() => {
    const current = edit.current;
    if (!current) return;
    if (current.kind === "circle" && zone.center_lat != null) {
      const centre = L.latLng(zone.center_lat, zone.center_lon);
      current.shape.setLatLng(centre);
      current.shape.setRadius(Number(zone.radius_m) || 1);
      current.centreHandle.setLatLng(centre);
      current.radiusHandle.setLatLng(eastOf(centre, Number(zone.radius_m) || 1));
      return;
    }
    if (current.kind === "polygon") {
      current.shape.setLatLngs(zone.points.map(([lon, lat]) => [lat, lon]));
      current.vertices.forEach((marker, index) => {
        const point = zone.points[index];
        if (point) marker.setLatLng([point[1], point[0]]);
      });
      current.midpoints.forEach((marker, index) => {
        const point = zone.points[index];
        const next = zone.points[(index + 1) % zone.points.length];
        if (point && next) marker.setLatLng(midpointOf(point, next));
      });
      const crossed = zone.points.length >= 4 && polygonSelfIntersects(zone.points);
      current.shape.setStyle({ color: crossed ? "#f59e0b" : "#fb7185" });
    }
  }, [zone]);

  // Every alarm step of every card in the draft, one dashed line per level,
  // labelled with its level and distance. A circle's lines are drawn at once;
  // a shape's are worked out a moment after it stops changing, since a long
  // border can take a noticeable fraction of a second and dragging a corner
  // must stay smooth.
  useEffect(() => {
    const layer = layers.current.alarm;
    if (!layer) return undefined;
    if (!editing || !cards?.length || !isPlaced(zone) || drawing) {
      layer.clearLayers();
      return undefined;
    }
    const steps = zoneSteps(
      cards.flatMap((card) => card.steps.map((step) => ({ trigger: card.trigger, level: step.level, buffer_m: Number(step.distance_m) }))),
    );
    if (zone.shape_type === "circle") {
      layer.clearLayers();
      drawZoneSteps(layer, zone, steps, { labels: true });
      return undefined;
    }
    if (polygonSelfIntersects(zone.points)) {
      layer.clearLayers();
      return undefined;
    }
    const timer = window.setTimeout(() => {
      layer.clearLayers();
      drawZoneSteps(layer, zone, steps, { labels: true });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [editing, cards, zone, drawing]);

  // Who the rules watch, coloured by the server's verdict.
  useEffect(() => {
    const layer = layers.current.members;
    if (!layer) return;
    layer.clearLayers();
    for (const member of members.values()) {
      if (!Number.isFinite(member.lat) || !Number.isFinite(member.lon)) continue;
      L.circleMarker([member.lat, member.lon], {
        radius: 7,
        color: "#0b0b0b",
        weight: 2,
        // Past a step: that step's colour, so the map says how loud it is.
        fillColor: (member.state === "breach" && LEVEL_STYLES[member.level]?.dot) || MEMBER_COLOURS[member.state] || MEMBER_COLOURS.pending,
        fillOpacity: 1,
        interactive: !drawing,
        bubblingMouseEvents: false,
      })
        .bindTooltip(`${escapeHtml(member.name)} · ${escapeHtml(member.label)}`)
        .addTo(layer);
    }
  }, [members, drawing]);

  // Set on the element directly: a React className here would wipe the
  // classes Leaflet adds to its container, tiles included.
  const placing = editing && (drawing || (zone.shape_type === "circle" && zone.center_lat == null));
  useEffect(() => {
    const map = mapRef.current;
    if (map) map.getContainer().style.cursor = placing ? "crosshair" : "";
  }, [placing]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitToken) return;
    if (fitToken.bounds) map.fitBounds(fitToken.bounds, { padding: [48, 48], maxZoom: 17 });
    else if (fitToken.centre) map.setView([fitToken.centre.lat, fitToken.centre.lon], fitToken.zoom || 15);
  }, [fitToken]);

  return (
    <div className="absolute inset-0">
      <div className="h-full w-full" ref={nodeRef} />
      <div className="absolute right-3 top-3 z-[1000] flex overflow-hidden rounded-lg border border-white/15 bg-black/70 shadow-lg backdrop-blur">
        {Object.entries(BASEMAPS).map(([key, config]) => (
          <button
            className={`px-2.5 py-1.5 text-[10px] font-bold transition-colors ${basemap === key ? "bg-white/15 text-neutral-100" : "text-neutral-400 hover:text-neutral-100"}`}
            key={key}
            onClick={() => onBasemapChange(key)}
            type="button"
          >
            {config.label}
          </button>
        ))}
      </div>
    </div>
  );
}


function viewRadius(map) {
  const bounds = map.getBounds();
  const width = bounds.getSouthWest().distanceTo(bounds.getSouthEast());
  return Math.max(50, Math.round(width * 0.12));
}

function eastOf(centre, metres) {
  const dLon = metres / (111_320 * Math.cos((centre.lat * Math.PI) / 180));
  return L.latLng(centre.lat, centre.lng + dLon);
}

function midpointOf(a, b) {
  return [(a[1] + b[1]) / 2, (a[0] + b[0]) / 2];
}

/** Built as DOM so its buttons call straight into React without a global lookup. */
function radioPopup(map, radio, editing, handlers) {
  const root = document.createElement("div");
  root.style.minWidth = "170px";
  const title = document.createElement("div");
  title.textContent = radio.name;
  title.style.cssText = "font-size:12px;font-weight:700;margin-bottom:6px;color:#f5f5f5";
  root.appendChild(title);
  const actions = editing
    ? [["watch", "Add to / remove from this zone"]]
    : [
        ["exit", "Alarm if it leaves an area"],
        ["enter", "Alarm if it enters an area"],
      ];
  for (const [action, label] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText =
      "display:block;width:100%;margin-top:4px;padding:6px 8px;border-radius:6px;background:#f87171;color:#000;font-size:11px;font-weight:700;text-align:left";
    button.addEventListener("click", () => {
      map.closePopup();
      handlers.current.onRadioAction(radio, action);
    });
    root.appendChild(button);
  }
  return root;
}

/** Lives over the map, because all it does is move the view. */
function PlaceSearch({ onPick }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      searchPlaces(query.trim())
        .then((data) => setResults(data.places || []))
        .catch(() => setResults([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  return (
    <div className="absolute left-3 top-3 z-[1001] w-[min(260px,calc(100%-24px))]">
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
        <input
          aria-label="Search for a place"
          className="w-full rounded-lg border border-white/15 bg-black/70 py-2 pl-8 pr-3 text-[11px] text-neutral-200 shadow-lg outline-none backdrop-blur placeholder:text-neutral-500 focus:border-white/30"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a town or state"
          value={query}
        />
      </div>
      {results.length ? (
        <ul className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-white/15 bg-[#0b0b0b]/95 py-1 shadow-xl backdrop-blur">
          {results.map((place) => (
            <li key={`${place.name}-${place.state}`}>
              <button
                className="block w-full px-3 py-1.5 text-left text-[11px] text-neutral-300 hover:bg-white/5"
                onClick={() => {
                  setQuery("");
                  setResults([]);
                  onPick(place);
                }}
                type="button"
              >
                {place.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Sizes said the way people say them, by how wide the thing is from one side
// to the other. They used to be radii, so "Building" drew a circle 100 m
// across. A circle is one of these unless someone drags it to another size.
const SIZES = [
  { label: "Building", across: 30 },
  { label: "Compound", across: 100 },
  { label: "Street block", across: 250 },
  { label: "Neighbourhood", across: 1000 },
  { label: "Town", across: 5000 },
].map((size) => ({ ...size, radius: size.across / 2 }));
const MAX_RADIUS_M = 50_000;
const DEFAULT_RADIUS = SIZES[1].radius;

/** A place with no outline gets a circle about as wide as its kind suggests. */
function radiusForKind(kind) {
  if (["City", "Local government"].includes(kind)) return SIZES[4].radius;
  if (["Town", "Village", "Area", "Airport", "Military", "Barracks", "University"].includes(kind)) return SIZES[3].radius;
  return DEFAULT_RADIUS;
}

// How far "Bigger" pushes a place's own border out, a step at a time.
const MARGINS = [0, 50, 100, 250, 500, 1000];

const borderQuery = (osm) => ({
  queryKey: ["place-border", osm],
  queryFn: () => getPlaceBorder(osm),
  staleTime: Infinity,
});

/**
 * The one question for a new zone: where is it? Takes a place name, a radio's
 * name, or "my location", and works out the shape itself. Drawing by hand is
 * the other way in, right underneath.
 */
function WherePicker({ radios, aroundCount, onPlace, onDraw, onAround }) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [online, setOnline] = useState([]);
  const [local, setLocal] = useState([]);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const needle = query.trim();

  useEffect(() => {
    if (needle.length < 2) {
      setLocal([]);
      setOnline([]);
      return undefined;
    }
    let stale = false;
    // The town list answers at once; OpenStreetMap follows with the borders.
    const fast = window.setTimeout(() => {
      searchPlaces(needle)
        .then((data) => !stale && setLocal(data.places || []))
        .catch(() => !stale && setLocal([]));
    }, 150);
    const slow = window.setTimeout(() => {
      if (needle.length < 3) return;
      suggestPlaces(needle)
        .then((data) => !stale && setOnline(data.places || []))
        .catch(() => !stale && setOnline([]));
    }, 350);
    return () => {
      stale = true;
      window.clearTimeout(fast);
      window.clearTimeout(slow);
    };
  }, [needle]);

  const places = useMemo(() => {
    const names = new Set(online.map((place) => place.name.toLowerCase()));
    const towns = local
      .filter((place) => !names.has(place.name.toLowerCase()))
      .map((place) => ({ name: place.name, detail: place.state, kind: "Town", lat: place.lat, lon: place.lon, osm: null }));
    return [...online, ...towns].slice(0, 7);
  }, [online, local]);

  const radioMatches = needle
    ? radios.filter((radio) => radio.name.toLowerCase().includes(needle.toLowerCase())).slice(0, 5)
    : [];

  async function pickPlace(place) {
    setProblem(null);
    const label = place.name;
    if (place.osm) {
      setBusy(place.osm);
      try {
        const data = await queryClient.fetchQuery(borderQuery(place.osm));
        if (data?.points?.length >= 3) {
          onPlace({ kind: "border", label, points: data.points });
          return;
        }
      } catch {
        // No border to be had: the circle below still puts the zone in the right place.
      } finally {
        setBusy(null);
      }
    }
    onPlace({ kind: "point", label, lat: place.lat, lon: place.lon, radius: radiusForKind(place.kind) });
  }

  function pickMyLocation() {
    setProblem(null);
    if (!window.navigator.geolocation) return setProblem("This device can't share its location.");
    setBusy("me");
    window.navigator.geolocation.getCurrentPosition(
      (position) => {
        setBusy(null);
        onPlace({ kind: "point", label: "", lat: position.coords.latitude, lon: position.coords.longitude, radius: DEFAULT_RADIUS });
      },
      () => {
        setBusy(null);
        setProblem("Couldn't get your location. Allow location access, or type the place instead.");
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  const row = "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-white/[0.06] active:bg-white/[0.1]";
  return (
    <div>
      <h2 className="mb-2 text-[13px] font-bold text-neutral-100">Where is the place?</h2>
      <div className="relative">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
        <input
          aria-label="Place, area or radio"
          autoFocus
          className="field-input py-2.5 pl-9 text-[12px]"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="A town, area, building or radio"
          value={query}
        />
      </div>

      <div className="mt-1.5 rounded-lg border border-white/10 bg-white/[0.02] p-1">
        <button className={row} disabled={Boolean(busy)} onClick={pickMyLocation} type="button">
          {busy === "me" ? <LoaderCircle className="animate-spin text-sky-300" size={14} /> : <LocateFixed className="text-sky-300" size={14} />}
          <span className="text-[11px] font-bold text-neutral-200">My location</span>
          <span className="ml-auto text-[9px] text-neutral-500">Where this device is</span>
        </button>

        {places.length ? <p className="px-2.5 pb-0.5 pt-2 text-[9px] font-bold uppercase tracking-wide text-neutral-600">Places</p> : null}
        {places.map((place) => (
          <button
            className={row}
            disabled={Boolean(busy)}
            key={`${place.osm || place.name}-${place.detail}`}
            onClick={() => pickPlace(place)}
            // The border is usually loaded before the click lands.
            onMouseEnter={() => place.osm && queryClient.prefetchQuery(borderQuery(place.osm))}
            type="button"
          >
            {busy === place.osm ? <LoaderCircle className="animate-spin text-neutral-400" size={14} /> : <MapPin className="text-neutral-500" size={14} />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-bold text-neutral-200">{place.name}</span>
              <span className="block truncate text-[9px] text-neutral-500">{[place.kind, place.detail].filter(Boolean).join(" · ")}</span>
            </span>
            {place.osm ? <span className="shrink-0 rounded bg-emerald-400/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300">Has border</span> : null}
          </button>
        ))}

        {radioMatches.length ? <p className="px-2.5 pb-0.5 pt-2 text-[9px] font-bold uppercase tracking-wide text-neutral-600">Radios</p> : null}
        {radioMatches.map((radio) => (
          <button
            className={row}
            disabled={Boolean(busy)}
            key={radio.key}
            onClick={() => onPlace({ kind: "point", label: `${radio.name} area`, lat: radio.lat, lon: radio.lon, radius: DEFAULT_RADIUS })}
            type="button"
          >
            <Radio className="text-neutral-500" size={14} />
            <span className="truncate text-[11px] font-bold text-neutral-200">{radio.name}</span>
            <span className="ml-auto shrink-0 text-[9px] text-neutral-500">Where it is now</span>
          </button>
        ))}

        {needle.length >= 3 && !places.length && !radioMatches.length ? (
          <p className="px-2.5 py-2 text-[10px] text-neutral-500">Nothing found by that name. Try a nearby town, or draw it yourself.</p>
        ) : null}
      </div>

      {problem ? <p className="mt-1.5 text-[10px] text-amber-300">{problem}</p> : null}

      <div className="mt-3 flex items-center gap-2 text-[10px] text-neutral-600">
        <span className="h-px flex-1 bg-white/10" /> or <span className="h-px flex-1 bg-white/10" />
      </div>
      <div className="mt-2 grid gap-1.5">
        <button
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-white/[0.08] px-3 py-2.5 text-[11px] font-bold text-neutral-100 hover:bg-white/[0.12] active:bg-white/[0.16]"
          onClick={onDraw}
          type="button"
        >
          <PenLine size={13} /> Draw it myself
        </button>
        {aroundCount ? (
          <button
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-2 text-[10px] font-bold text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-100"
            onClick={onAround}
            type="button"
          >
            <Users size={12} /> Around the {aroundCount} radio{aroundCount === 1 ? "" : "s"} you chose
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Pick radios one by one, ticking as many as needed; the list stays open.
 * Units and channels sit underneath as a shortcut for "all of them".
 */
function TargetPicker({ rule, targets, onToggle }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const needle = query.trim().toLowerCase();
  const match = (name, id) => !needle || String(name || "").toLowerCase().includes(needle) || String(id).toLowerCase().includes(needle);
  const groups = [
    {
      title: "Radios",
      items: (targets?.radios || []).filter((r) => match(r.name, r.device_id)).map((r) => ({
        type: "radio", id: String(r.device_id), name: r.name || `Radio ${r.device_id}`, meta: r.device_id,
      })),
    },
    {
      title: "Drones",
      items: (targets?.drones || []).filter((d) => match(d.name, d.sysid)).map((d) => ({
        type: "drone", id: String(d.sysid), name: d.name || `Drone ${d.sysid}`, meta: `#${d.sysid}`,
      })),
    },
    {
      title: "Whole unit (includes radios added later)",
      items: (targets?.units || []).filter((u) => match(u.name, u.id)).map((u) => ({
        type: "unit", id: String(u.id), name: u.name, meta: `${u.members?.length || 0}`,
      })),
    },
    {
      title: "Whole channel (includes radios added later)",
      items: (targets?.channels || []).filter((c) => match(c.name, c.id)).map((c) => ({
        type: "channel", id: String(c.id), name: c.name, meta: `${c.members?.length || 0}`,
      })),
    },
  ].filter((group) => group.items.length);

  return (
    <div className="relative" ref={rootRef}>
      <button
        className={`flex w-full items-center gap-1.5 rounded-md border px-2.5 py-2 text-left text-[11px] font-bold transition-colors ${
          rule.targets.length
            ? "border-white/15 bg-white/[0.04] text-neutral-300 hover:bg-white/[0.08]"
            : "border-red-400/40 bg-red-500/[0.06] text-red-200 hover:bg-red-500/10"
        }`}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Plus size={12} />
        <span className="truncate">{rule.targets.length ? "Add or remove radios" : "Choose radios"}</span>
        <ChevronDown className="ml-auto shrink-0 text-neutral-500" size={12} />
      </button>
      {open ? (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-white/15 bg-[#0d0d0d] shadow-2xl">
          <div className="relative border-b border-white/10 p-2">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-600" size={12} />
            <input
              autoFocus
              className="field-input pl-7"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name or ID"
              value={query}
            />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {groups.map((group) => (
              <div key={group.title}>
                <div className="px-3 pb-1 pt-2 text-[9px] font-bold uppercase tracking-wide text-neutral-600">{group.title}</div>
                {group.items.slice(0, needle ? 100 : 60).map((item) => {
                  const selected = hasTarget(rule, item.type, item.id);
                  return (
                    <button
                      aria-pressed={selected}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] hover:bg-white/5 ${selected ? "text-neutral-100" : "text-neutral-400"}`}
                      key={`${item.type}:${item.id}`}
                      onClick={() => onToggle(item.type, item.id)}
                      type="button"
                    >
                      <span
                        className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded border ${selected ? "border-red-400 bg-red-400 text-black" : "border-white/25"}`}
                      >
                        {selected ? <Check size={10} strokeWidth={3} /> : null}
                      </span>
                      <span className="truncate">{item.name}</span>
                      <span className="ml-auto shrink-0 font-mono text-[9px] text-neutral-600">{item.meta}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {!groups.length ? <p className="px-3 py-4 text-center text-[10px] text-neutral-600">Nothing matches.</p> : null}
          </div>
          <div className="border-t border-white/10 p-2">
            <button
              className="w-full rounded-md bg-red-400 px-3 py-1.5 text-[10px] font-bold text-black hover:opacity-90"
              onClick={() => setOpen(false)}
              type="button"
            >
              Done · {rule.targets.length} selected
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The chosen radios as removable chips; long lists fold behind "+N more". */
function TargetChips({ rule, index, onToggle }) {
  const [expanded, setExpanded] = useState(false);
  if (!rule.targets.length) return null;
  const shown = expanded ? rule.targets : rule.targets.slice(0, 8);
  return (
    <div className="mb-2 flex flex-wrap gap-1">
      {shown.map((target) => (
        <span
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-white/15 bg-white/[0.06] py-0.5 pl-2 pr-1 text-[10px] font-bold text-neutral-200"
          key={`${target.target_type}:${target.target_id}`}
        >
          {target.target_type === "unit" || target.target_type === "channel" ? <Users size={10} /> : <Radio size={10} />}
          <span className="truncate">{targetLabel(index, target)}</span>
          <button
            aria-label={`Remove ${targetLabel(index, target)}`}
            className="rounded-full p-0.5 text-neutral-500 hover:bg-white/10 hover:text-neutral-100"
            onClick={() => onToggle(target.target_type, target.target_id)}
            type="button"
          >
            <X size={10} />
          </button>
        </span>
      ))}
      {rule.targets.length > 8 ? (
        <button className="px-1 text-[10px] font-bold text-neutral-500 hover:text-neutral-200" onClick={() => setExpanded((v) => !v)} type="button">
          {expanded ? "Show less" : `+${rule.targets.length - 8} more`}
        </button>
      ) : null}
    </div>
  );
}

function verdictText(rule, verdict) {
  if (!rule.targets.length || !verdict) return null;
  const { summary, members } = verdict;
  if (!summary.total) return { tone: "text-neutral-500", text: "No radios in that group yet." };
  // A no-go zone's steps sit outside it, so a breach may be "too close", not yet in.
  const okWord = rule.trigger === "exit" ? "inside" : "clear";
  const breachWord = rule.trigger === "exit" ? "outside" : "too close";
  const breached = members.filter((member) => member.state === "breach");
  const parts = summary.ok || !breached.length ? [`${summary.ok} of ${summary.total} ${okWord}`] : [];
  if (breached.length) {
    const names = breached.slice(0, 2).map((member) => member.name).join(", ");
    const loudest = breached.reduce((top, member) => (LEVEL_RANK[member.level] > LEVEL_RANK[top] ? member.level : top), breached[0].level);
    const level = rule.steps.length > 1 && LEVEL_STYLES[loudest] ? ` (${LEVEL_STYLES[loudest].label})` : "";
    parts.push(`${names}${breached.length > 2 ? ` +${breached.length - 2}` : ""} ${breachWord}${level}`);
  }
  if (summary.unknown) parts.push(`${summary.unknown} not reporting`);
  return { tone: breached.length ? "text-amber-300" : "text-green-300", text: parts.join(" · ") };
}

/**
 * The alarm as steps out from the edge. Pick how loud it is at the edge, then
 * optionally more steps further out: louder for a keep-in zone, quieter early
 * warnings for a no-go zone.
 */
function AlarmSteps({ rule, onChange }) {
  const order = levelsOutward(rule.trigger);
  const setSteps = (steps) => onChange({ steps: keepInOrder(steps, rule.trigger) });
  const update = (index, patch) => setSteps(rule.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  const next = nextStep(rule.steps, rule.trigger);
  return (
    <div className="mt-2 space-y-1.5">
      {rule.steps.map((step, index) => {
        const previous = rule.steps[index - 1];
        const choices = previous ? order.filter((level) => outwardRank(rule.trigger, level) > outwardRank(rule.trigger, previous.level)) : order;
        return (
          <div className="rounded-md border border-white/10 bg-black/20 p-1.5" key={index}>
            <div className="flex items-center gap-1">
              {choices.map((level) => {
                const style = LEVEL_STYLES[level];
                const on = step.level === level;
                return (
                  <button
                    className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-bold transition-colors ${on ? style.chip : "border-white/10 text-neutral-500 hover:text-neutral-300"}`}
                    key={level}
                    onClick={() => update(index, { level })}
                    title={LEVEL_MEANING[level]}
                    type="button"
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: style.dot, opacity: on ? 1 : 0.5 }} />
                    {style.label}
                  </button>
                );
              })}
              {index ? (
                <button
                  aria-label="Remove this step"
                  className="rounded p-1.5 text-neutral-600 hover:bg-white/5 hover:text-neutral-200"
                  onClick={() => setSteps(rule.steps.filter((_, i) => i !== index))}
                  type="button"
                >
                  <X size={11} />
                </button>
              ) : null}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 px-0.5 text-[10px] text-neutral-400">
              <span>at</span>
              <input
                aria-label={`Distance for ${LEVEL_STYLES[step.level].label}`}
                className="field-input w-20 py-1 text-[10px]"
                max={MAX_STEP_M}
                min={index ? "1" : "0"}
                onChange={(event) => update(index, { distance_m: event.target.value })}
                type="number"
                value={step.distance_m}
              />
              <span>m outside the edge</span>
              <span className="ml-auto text-[9px] text-neutral-600">{LEVEL_MEANING[step.level]}</span>
            </div>
          </div>
        );
      })}
      {next ? (
        <button
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-white/15 px-2 py-1.5 text-[10px] font-bold text-neutral-400 hover:border-white/30 hover:text-neutral-200"
          onClick={() => setSteps([...rule.steps, next])}
          type="button"
        >
          <Plus size={11} /> {rule.trigger === "enter" ? "Warn earlier:" : "Then"} {LEVEL_STYLES[next.level].label} further out
        </button>
      ) : null}
    </div>
  );
}

function RuleCard({ rule, targets, index, verdict, focused, onFocus, onChange, onToggle, onRemove, removable }) {
  const [advanced, setAdvanced] = useState(false);
  const status = verdictText(rule, verdict);
  return (
    <div
      className={`rounded-lg border p-2.5 transition-colors ${focused ? "border-white/25 bg-white/[0.04]" : "border-white/10 bg-white/[0.02]"}`}
      onFocusCapture={onFocus}
      onPointerDown={onFocus}
    >
      {removable ? (
        <div className="-mt-1 mb-1 flex justify-end">
          <button
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold text-neutral-600 hover:bg-red-500/10 hover:text-red-300"
            onClick={onRemove}
            type="button"
          >
            <Trash2 size={10} /> Remove rule
          </button>
        </div>
      ) : null}
      <TargetChips index={index} onToggle={onToggle} rule={rule} />
      <TargetPicker onToggle={onToggle} rule={rule} targets={targets} />

      <div className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-black/30 p-0.5">
        {["exit", "enter"].map((trigger) => (
          <button
            className={`rounded px-2 py-1.5 text-[10px] font-bold transition-colors ${rule.trigger === trigger ? "bg-white/[0.12] text-neutral-100 shadow-sm" : "text-neutral-500 hover:text-neutral-300"}`}
            key={trigger}
            onClick={() => onChange({ trigger, steps: stepsForTrigger(rule.steps, rule.trigger, trigger) })}
            type="button"
          >
            {trigger === "exit" ? "Must stay inside" : "Must not enter"}
          </button>
        ))}
      </div>

      <AlarmSteps rule={rule} onChange={onChange} />

      {status ? <p className={`mt-1.5 text-[10px] font-bold ${status.tone}`}>{status.text}</p> : null}

      <button
        className="mt-1.5 inline-flex items-center gap-1 text-[9px] font-bold text-neutral-600 hover:text-neutral-300"
        onClick={() => setAdvanced((value) => !value)}
        type="button"
      >
        <Settings2 size={10} /> Alarm settings
        <ChevronDown className={`transition-transform ${advanced ? "" : "-rotate-90"}`} size={10} />
      </button>
      {advanced ? (
        <div className="mt-2 space-y-2 rounded-md border border-white/10 bg-black/20 p-2">
          <div>
            <label className="block w-1/2 text-[9px] text-neutral-500">
              Readings before alarm
              <input
                className="field-input mt-1"
                max="10"
                min="1"
                onChange={(event) => onChange({ confirmations_required: event.target.value })}
                type="number"
                value={rule.confirmations_required}
              />
            </label>
          </div>
          <p className="text-[9px] leading-relaxed text-neutral-600">
            {Number(rule.confirmations_required) > 1
              ? `Each step alarms after ${rule.confirmations_required} readings in a row past its line, about ${Number(rule.confirmations_required) * 5} seconds for a radio.`
              : "Each step alarms on the first reading past its line. Raise this if GPS jitter sets off false alarms."}
          </p>
          <label className="flex items-center gap-2 text-[10px] text-neutral-400">
            <input checked={rule.active} onChange={(event) => onChange({ active: event.target.checked })} type="checkbox" />
            Rule switched on
          </label>
        </div>
      ) : null}
    </div>
  );
}

export function GeofencesRoute() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [zone, setZone] = useState(EMPTY_ZONE);
  const [rules, setRules] = useState([]);
  const [focusKey, setFocusKey] = useState(null);
  const [drawing, setDrawing] = useState(false);
  const [drawMode, setDrawMode] = useState("tap");
  // What the area was made from: a place's name, and its own border while that
  // is still what's on the map, so Bigger and Smaller can work from it.
  const [area, setArea] = useState(null);
  const [quiet, setQuiet] = useState(true);
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [basemap, setBasemap] = useState("satellite");
  const [fitToken, setFitToken] = useState(null);
  const [filter, setFilter] = useState("");
  const fittedRef = useRef(false);

  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const user = meQuery.data?.user;
  const isAdmin = isPlatformStaff(user);
  const membership = user?.active_membership || user?.memberships?.[0];
  const canManage = isPlatformOperator(user) || ["org_owner", "org_admin", "unit_admin", "admin"].includes(membership?.role);

  const zonesQuery = useQuery({ queryKey: ["geofences"], queryFn: listGeofences, refetchInterval: 30_000 });
  const organizationsQuery = useQuery({ queryKey: ["organizations"], queryFn: listOrganizations, enabled: isAdmin });
  const organizations = organizationsQuery.data?.organizations || [];
  const orgId = zone.organization_id || String(membership?.organization_id || "");

  const zones = useMemo(() => zonesQuery.data?.zones || [], [zonesQuery.data]);

  // Staff see zones from many organizations, so names are loaded for each of
  // them; everyone else has one organization and this is a single request.
  const targetOrgs = useMemo(() => {
    const ids = new Set(orgId ? [orgId] : []);
    if (isAdmin) zones.forEach((item) => ids.add(String(item.organization_id)));
    return [...ids];
  }, [orgId, isAdmin, zones]);
  const targetQueries = useQueries({
    queries: (targetOrgs.length || isAdmin ? targetOrgs : [""]).map((id) => ({
      queryKey: ["geofence-targets", id],
      queryFn: () => getGeofenceTargets(id),
      staleTime: 60_000,
    })),
  });
  const targetsData = targetQueries.map((query) => query.data);
  const targetsKey = targetsData.map((data) => (data ? 1 : 0)).join("") + targetQueries.map((query) => query.dataUpdatedAt).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allTargets = useMemo(() => targetsData.filter(Boolean), [targetsKey]);
  const targets = targetQueries[targetOrgs.indexOf(orgId)]?.data || (!isAdmin ? targetQueries[0]?.data : null);
  const index = useTargetIndex(allTargets);

  // Radios report every 5 s; the map follows at the same pace.
  const radiosQuery = useQuery({ queryKey: ["locations"], queryFn: () => getLocations(), refetchInterval: 5_000 });
  const dronesQuery = useQuery({ queryKey: ["drone-positions"], queryFn: getDronePositions, refetchInterval: 10_000 });

  const positions = useMemo(() => {
    const map = new Map();
    for (const row of radiosQuery.data?.data || []) {
      const lat = Number(row.Lat);
      const lon = Number(row.Lng ?? row.Lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
      map.set(`radio:${row.Uid}`, { lat, lon });
    }
    for (const drone of dronesQuery.data?.drones || []) {
      const lat = Number(drone.lat);
      const lon = Number(drone.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
      map.set(`drone:${drone.sysid}`, { lat, lon });
    }
    return map;
  }, [radiosQuery.data, dronesQuery.data]);

  // Only this organization's radios, once we know which those are.
  const radios = useMemo(() => {
    const source = editing ? (targets ? [targets] : []) : allTargets;
    const known = source.length ? new Set(source.flatMap((item) => (item.radios || []).map((radio) => `radio:${radio.device_id}`))) : null;
    const list = [];
    for (const [key, position] of positions) {
      if (!key.startsWith("radio:")) continue;
      if (known && !known.has(key)) continue;
      list.push({ key, id: key.slice(6), name: index.names.get(key) || `Radio ${key.slice(6)}`, ...position });
    }
    return list;
  }, [positions, targets, allTargets, editing, index]);

  // Everyone the rules being edited watch.
  const highlighted = useMemo(() => {
    const keys = new Set();
    if (!editing) return keys;
    for (const rule of rules) {
      for (const target of rule.targets) {
        for (const key of index.members.get(`${target.target_type}:${target.target_id}`) || []) keys.add(key);
      }
    }
    return keys;
  }, [editing, rules, index]);

  const placed = isPlaced(zone);
  const crossed = zone.shape_type === "polygon" && zone.points.length >= 4 && polygonSelfIntersects(zone.points);
  const expanded = useMemo(() => rules.flatMap(expandRule), [rules]);

  const previewInput = useSettled(
    editing && placed && !crossed && !drawing && expanded.length && orgId
      ? JSON.stringify({ organization_id: Number(orgId), ...zonePayload(zone), rules: expanded.map((item) => item.payload) })
      : null,
    300,
  );
  const previewQuery = useQuery({
    queryKey: ["geofence-preview", previewInput],
    queryFn: () => previewGeofence(JSON.parse(previewInput)),
    enabled: Boolean(previewInput),
    staleTime: 5_000,
    placeholderData: (previous) => previous,
  });
  // The server answers per stored rule; each card shows the union of its own,
  // one entry per radio even when a radio is picked and also in a chosen unit.
  const previewFor = previewInput;
  const verdictByKey = useMemo(() => {
    const map = new Map();
    const answers = previewQuery.data?.rules;
    if (!answers) return map;
    const sent = previewFor ? JSON.parse(previewFor).rules : [];
    const cardOf = new Map(expanded.map((item) => [JSON.stringify(item.payload), item]));
    sent.forEach((payload, i) => {
      const item = cardOf.get(JSON.stringify(payload));
      if (!item || !answers[i]) return;
      const entry = map.get(item.cardKey) || { members: new Map(), freshBreach: new Set() };
      for (const member of answers[i].members) {
        const key = `${member.asset_type}:${member.asset_id}`;
        const known = entry.members.get(key);
        // A radio past several steps is shown at the loudest one it is past.
        const louder = member.state === "breach" && (known?.state !== "breach" || LEVEL_RANK[item.level] > LEVEL_RANK[known.level]);
        if (!known || louder) entry.members.set(key, member.state === "breach" ? { ...member, level: item.level } : member);
        if (item.fresh && member.state === "breach") entry.freshBreach.add(key);
      }
      map.set(item.cardKey, entry);
    });
    for (const [key, entry] of map) {
      const members = [...entry.members.values()];
      map.set(key, {
        members,
        freshBreach: entry.freshBreach.size,
        summary: {
          total: members.length,
          ok: members.filter((m) => m.state === "ok").length,
          breach: members.filter((m) => m.state === "breach").length,
          unknown: members.filter((m) => m.state === "unknown").length,
        },
      });
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewQuery.data]);

  const focusRule = rules.find((rule) => rule.key === focusKey) || rules[0] || null;

  // Coloured dots: the server's verdict for the focused rule, else just "watched".
  const members = useMemo(() => {
    const map = new Map();
    if (!editing) return map;
    const verdict = focusRule ? verdictByKey.get(focusRule.key) : null;
    if (verdict && placed) {
      for (const member of verdict.members) {
        const breachWord = focusRule.trigger === "exit" ? "outside" : "too close";
        const okWord = focusRule.trigger === "exit" ? "inside" : "clear";
        map.set(`${member.asset_type}:${member.asset_id}`, {
          ...member,
          label:
            member.state === "breach"
              ? `${breachWord} · ${LEVEL_STYLES[member.level]?.label || "alarm"}`
              : member.state === "ok" ? okWord : "not reporting",
        });
      }
      return map;
    }
    for (const key of highlighted) {
      const position = positions.get(key);
      if (position) map.set(key, { ...position, name: index.names.get(key) || key, state: "pending", label: "watched" });
    }
    return map;
  }, [editing, focusRule, verdictByKey, placed, highlighted, positions, index]);

  // Only new or changed rules are affected by "don't alarm": the rest keep
  // their state, and anyone in breach on them has already alarmed.
  const breachTotal = [...verdictByKey.values()].reduce((sum, verdict) => sum + verdict.freshBreach, 0);

  // First load: frame the zones and radios, so the map opens where the work is.
  useEffect(() => {
    if (fittedRef.current || !zonesQuery.isSuccess || !radiosQuery.isSuccess) return;
    fittedRef.current = true;
    const points = [...radios.map((radio) => [radio.lat, radio.lon])];
    for (const other of zones) {
      if (other.shape_type === "circle") points.push([Number(other.center_lat), Number(other.center_lon)]);
      else for (const [lon, lat] of other.geometry?.coordinates?.[0] || []) points.push([lat, lon]);
    }
    if (points.length) setFitToken({ bounds: L.latLngBounds(points).pad(0.1), key: Date.now() });
  }, [zonesQuery.isSuccess, radiosQuery.isSuccess, radios, zones]);

  const fitTo = useCallback((points, pad = 0.4) => {
    if (!points.length) return;
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon]));
    // One radio, or a tight cluster: show its neighbourhood rather than rooftops.
    const small = bounds.getSouthWest().distanceTo(bounds.getNorthEast()) < 600;
    setFitToken({ bounds: small ? bounds.getCenter().toBounds(1200) : bounds.pad(pad), key: Date.now() });
  }, []);

  // With no zone drawn yet, the map follows whoever has been picked.
  const highlightedKey = [...highlighted].sort().join(",");
  useEffect(() => {
    if (!editing || isPlaced(zone) || !highlightedKey) return;
    fitTo(highlightedKey.split(",").map((key) => positions.get(key)).filter(Boolean));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedKey]);

  function focusZone(target) {
    if (target.shape_type === "circle") {
      const centre = L.latLng(Number(target.center_lat), Number(target.center_lon));
      setFitToken({ bounds: centre.toBounds(Number(target.radius_m) * 2.6), key: Date.now() });
      return;
    }
    fitTo((target.geometry?.coordinates?.[0] || target.points || []).map(([lon, lat]) => ({ lat, lon })), 0.3);
  }

  function openEditor(nextZone, nextRules) {
    setZone(nextZone);
    setRules(nextRules);
    setFocusKey(nextRules[0]?.key || null);
    setDrawing(nextZone.shape_type === "polygon" && nextZone.points.length < 3);
    setDrawMode("tap");
    setArea(null);
    setQuiet(true);
    setError(null);
    setFeedback(null);
    setEditing(true);
  }

  function closeEditor() {
    setEditing(false);
    setDrawing(false);
    setZone(EMPTY_ZONE);
    setRules([]);
    setError(null);
  }

  function startNew() {
    const org = String(membership?.organization_id || organizations[0]?.id || "");
    openEditor({ ...EMPTY_ZONE, organization_id: org }, [newRule()]);
    // Open where this organization's people are, not over the whole country.
    const own = targetQueries[targetOrgs.indexOf(org)]?.data?.radios;
    const keys = own ? new Set(own.map((radio) => `radio:${radio.device_id}`)) : null;
    const points = radios.filter((radio) => !keys || keys.has(radio.key));
    if (points.length) fitTo(points, 0.3);
  }

  function startEdit(target) {
    const form = toForm(target);
    openEditor(form.zone, form.rules.length ? form.rules : [newRule()]);
    focusZone(target);
  }

  /** From a radio on the map: a circle round it and a rule already pointing at it. */
  function startFromRadio(radio, trigger) {
    const org = String(membership?.organization_id || organizations[0]?.id || "");
    const rule = newRule({ targets: [{ target_type: "radio", target_id: radio.id }], trigger });
    openEditor(
      {
        ...EMPTY_ZONE,
        organization_id: org,
        name: trigger === "exit" ? `${radio.name} area` : "",
        center_lat: radio.lat,
        center_lon: radio.lon,
        radius_m: trigger === "exit" ? SIZES[2].radius : DEFAULT_RADIUS,
      },
      [rule],
    );
    setFitToken({ bounds: L.latLng(radio.lat, radio.lon).toBounds(1500), key: Date.now() });
  }

  function onRadioAction(radio, action) {
    // Adds the radio to the rule being worked on, or takes it out again.
    if (action === "watch") {
      const card = focusRule || rules[0];
      if (card) toggleTarget(card.key, "radio", radio.id);
      else setRules([newRule({ targets: [{ target_type: "radio", target_id: radio.id }] })]);
      return;
    }
    if (canManage) startFromRadio(radio, action);
  }

  function updateZone(patch) {
    setError(null);
    setZone((current) => ({ ...current, ...patch }));
  }

  function updateRule(key, patch) {
    setError(null);
    setRules((current) => current.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)));
  }

  function toggleTarget(key, type, id) {
    setError(null);
    setRules((current) =>
      current.map((rule) => {
        if (rule.key !== key) return rule;
        return hasTarget(rule, type, id)
          ? { ...rule, targets: rule.targets.filter((t) => !(t.target_type === type && String(t.target_id) === String(id))) }
          : { ...rule, targets: [...rule.targets, { target_type: type, target_id: String(id) }] };
      }),
    );
  }

  /** A pick from "Where is the place?": a real border, or a point that gets a circle. */
  function placeArea(choice) {
    const name = zone.name.trim() || !choice.label ? {} : { name: choice.label };
    setDrawing(false);
    if (choice.kind === "border") {
      setArea({ label: choice.label, border: choice.points, margin: 0 });
      updateZone({ shape_type: "polygon", points: choice.points, center_lat: null, center_lon: null, ...name });
      fitTo(choice.points.map(([lon, lat]) => ({ lat, lon })), 0.2);
      return;
    }
    setArea({ label: choice.label });
    updateZone({ shape_type: "circle", points: [], center_lat: choice.lat, center_lon: choice.lon, radius_m: choice.radius, ...name });
    setFitToken({ bounds: L.latLng(choice.lat, choice.lon).toBounds(choice.radius * 2.8), key: Date.now() });
  }

  /** Back to the question, with nothing on the map. */
  function changePlace() {
    setArea(null);
    setDrawing(false);
    updateZone({ shape_type: "circle", points: [], center_lat: null, center_lon: null, radius_m: DEFAULT_RADIUS });
  }

  function startDrawing() {
    setArea(null);
    setDrawMode("tap");
    updateZone({ shape_type: "polygon", points: [], center_lat: null, center_lon: null });
    setDrawing(true);
  }

  /** A finished finger trace becomes a shape with a sensible number of corners. */
  function finishTrace(points) {
    const ring = simplifyRing(points, 40);
    if (!ring || ring.length < 3) return;
    updateZone({ points: ring });
    setDrawing(false);
  }

  /** Pushes a place's own border out by a margin; Smaller steps back towards it. */
  function stepMargin(direction) {
    if (!area?.border) return;
    const at = MARGINS.indexOf(area.margin);
    const margin = MARGINS[Math.min(MARGINS.length - 1, Math.max(0, at + direction))];
    const ring = margin ? grownRing(area.border, margin) : area.border;
    if (!ring) return;
    setArea({ ...area, margin });
    updateZone({ points: margin ? simplifyRing(ring, 120) : ring });
  }

  /** Shape changes from the map. Moving a corner by hand ends Bigger/Smaller. */
  function shapeChangedOnMap(patch) {
    if (patch.points && area?.border) setArea({ label: area.label });
    updateZone(patch);
  }

  /** Draws the zone round where the watched people are right now. */
  function drawAround() {
    const points = [...highlighted].map((key) => positions.get(key)).filter(Boolean);
    if (!points.length) {
      setError("None of the chosen radios are reporting a position right now.");
      return;
    }
    setArea({ label: "" });
    updateZone({ shape_type: "circle", points: [], ...circleAroundAssets(points, AROUND_MARGIN_M) });
    setDrawing(false);
    fitTo(points);
  }

  const saveMutation = useMutation({
    mutationFn: saveGeofence,
    onSuccess: async (data) => {
      const quieted = Number(data?.quieted) || 0;
      setFeedback(
        quieted
          ? `Zone saved. ${quieted} already on the wrong side ${quieted === 1 ? "was" : "were"} recorded without an alarm.`
          : "Zone saved. Monitoring is on.",
      );
      closeEditor();
      await queryClient.invalidateQueries({ queryKey: ["geofences"] });
    },
    onError: (err) => setError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteGeofence,
    // Gone from the list at once; put back if the server refuses.
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["geofences"] });
      const previous = queryClient.getQueryData(["geofences"]);
      queryClient.setQueryData(["geofences"], (current) =>
        current ? { ...current, zones: current.zones.filter((item) => Number(item.id) !== Number(id)) } : current,
      );
      return { previous };
    },
    onError: (err, _id, context) => {
      if (context?.previous) queryClient.setQueryData(["geofences"], context.previous);
      setFeedback(err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["geofences"] }),
  });

  function submit(event) {
    event.preventDefault();
    if (!zone.name.trim()) return setError("Give the zone a name.");
    if (!placed) return setError(zone.shape_type === "circle" ? "Draw the circle on the map." : "Finish the shape on the map: at least three corners.");
    if (drawing) return setError("Close the shape: click its first corner, or press Done.");
    if (crossed) return setError("The shape crosses over itself. Drag a corner to untangle it.");
    if (rules.length > 1 && rules.some((rule) => !rule.targets.length)) return setError("A rule has no radios. Choose some, or remove it.");
    const outOfOrder = rules.some((rule) => rule.steps.some((step, i) => i && !(Number(step.distance_m) > Number(rule.steps[i - 1].distance_m))));
    if (outOfOrder) return setError("Each step has to be further from the edge than the one before.");
    if (rules.some((rule) => rule.steps.some((step) => Number(step.distance_m) > MAX_STEP_M))) return setError(`Steps can be at most ${formatDistance(MAX_STEP_M)} from the edge.`);
    if (!orgId) return setError("Choose an organization.");
    saveMutation.mutate({
      id: zone.id,
      organization_id: Number(orgId),
      ...zonePayload(zone),
      rules: expanded.map((item) => item.payload),
      quiet,
    });
  }

  const place = previewQuery.data?.place;
  const summary = zoneSummary(zone, placed && !drawing, area?.label || place?.label, radios);
  const visibleZones = filter.trim()
    ? zones.filter((item) => item.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : zones;

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-ops-bg pt-[var(--ops-chrome)] text-neutral-200">
      <div className="flex min-h-0 flex-1 flex-col-reverse xl:flex-row">
        <aside className="flex min-h-0 flex-1 flex-col border-white/10 xl:w-[380px] xl:flex-none xl:border-r">
          {editing ? (
            <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
              <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
                <button
                  aria-label="Back to zones"
                  className="rounded p-1 text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
                  onClick={closeEditor}
                  type="button"
                >
                  <ArrowLeft size={15} />
                </button>
                <h1 className="text-[12px] font-bold text-neutral-100">{zone.id ? "Edit zone" : "New zone"}</h1>
              </header>

              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
                {isAdmin && !zone.id ? (
                  <select
                    aria-label="Organization"
                    className="field-input"
                    onChange={(event) => {
                      updateZone({ organization_id: event.target.value });
                      setRules([newRule()]);
                    }}
                    value={orgId}
                  >
                    <option value="">Choose organization</option>
                    {organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
                  </select>
                ) : null}

                {!placed && !drawing ? (
                  <WherePicker
                    aroundCount={highlighted.size}
                    onAround={drawAround}
                    onDraw={startDrawing}
                    onPlace={placeArea}
                    radios={radios}
                  />
                ) : (
                  <>
                    <section>
                      <div className="mb-2 flex items-center justify-between">
                        <h2 className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">Area</h2>
                        <button
                          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-bold text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
                          onClick={changePlace}
                          type="button"
                        >
                          <ArrowLeft size={11} /> Change place
                        </button>
                      </div>

                      {drawing ? (
                        <>
                          <div className="grid grid-cols-2 gap-1 rounded-md bg-black/30 p-0.5">
                            {[["tap", MousePointerClick, "Tap corners"], ["trace", Spline, "Trace with finger"]].map(([mode, Icon, label]) => (
                              <button
                                className={`inline-flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[10px] font-bold transition-colors ${drawMode === mode ? "bg-white/[0.12] text-neutral-100 shadow-sm" : "text-neutral-500 hover:text-neutral-300"}`}
                                key={mode}
                                onClick={() => {
                                  setDrawMode(mode);
                                  updateZone({ points: [] });
                                }}
                                type="button"
                              >
                                <Icon size={12} /> {label}
                              </button>
                            ))}
                          </div>
                          <p className="mt-2 rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-2 text-[10px] leading-relaxed text-neutral-400">
                            {drawMode === "trace"
                              ? "Press on the map and draw all the way round the area, then let go. Zoom with the + and − buttons."
                              : `Tap the map at each corner (${zone.points.length} so far). Tap the first corner, or press Done, to close it.`}
                          </p>
                          {drawMode === "tap" && zone.points.length ? (
                            <div className="mt-2 flex gap-2">
                              <button
                                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-white/10 px-3 py-2 text-[10px] font-bold text-neutral-300 hover:bg-white/5"
                                onClick={() => updateZone({ points: zone.points.slice(0, -1) })}
                                type="button"
                              >
                                <Undo2 size={12} /> Undo last corner
                              </button>
                              {zone.points.length >= 3 ? (
                                <button
                                  className="flex-1 rounded-md bg-red-400 px-3 py-2 text-[10px] font-bold text-black hover:opacity-90"
                                  onClick={() => setDrawing(false)}
                                  type="button"
                                >
                                  Done
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </>
                      ) : zone.shape_type === "circle" ? (
                        <>
                          <p className="mb-1.5 text-[11px] font-bold text-neutral-200">How big?</p>
                          <div className="flex flex-wrap gap-1">
                            {SIZES.map((size) => (
                              <button
                                className={`rounded-full border px-2.5 py-1.5 text-[10px] font-bold transition-colors ${Number(zone.radius_m) === size.radius ? "border-red-400 bg-red-400 text-black" : "border-white/10 text-neutral-300 hover:border-white/25 hover:text-neutral-100"}`}
                                key={size.label}
                                onClick={() => {
                                  updateZone({ radius_m: size.radius });
                                  setFitToken({ bounds: L.latLng(zone.center_lat, zone.center_lon).toBounds(size.radius * 2.8), key: Date.now() });
                                }}
                                type="button"
                              >
                                {size.label} <span className="font-normal opacity-70">{formatDistance(size.radius)}</span>
                              </button>
                            ))}
                          </div>
                          {/* Same as an alarm step: type the metres, and the words say what they are measured from. */}
                          <div className="mt-2 flex items-center gap-1.5 text-[10px] text-neutral-400">
                            <span>Radius</span>
                            <input
                              aria-label="Radius in metres"
                              className="field-input w-24 py-1 text-[10px]"
                              max={MAX_RADIUS_M}
                              min="1"
                              onChange={(event) => updateZone({ radius_m: event.target.value === "" ? "" : Math.min(MAX_RADIUS_M, Math.max(0, Number(event.target.value))) })}
                              type="number"
                              value={zone.radius_m === "" ? "" : Math.round(Number(zone.radius_m))}
                            />
                            <span>m from the centre</span>
                          </div>
                          <p className="mt-1.5 text-[10px] text-neutral-500">Or drag the red dot on the map. Drag the white dot to move it.</p>
                        </>
                      ) : (
                        <>
                          {area?.border ? (
                            <div className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-2">
                              <span className="min-w-0 flex-1 text-[11px] text-neutral-300">
                                Border of <span className="font-bold text-neutral-100">{area.label}</span>
                                {area.margin ? <span className="text-neutral-500"> + {formatDistance(area.margin)}</span> : null}
                              </span>
                              <button
                                aria-label="Smaller"
                                className="rounded-md border border-white/10 p-1.5 text-neutral-300 hover:bg-white/5 disabled:opacity-30"
                                disabled={!area.margin}
                                onClick={() => stepMargin(-1)}
                                title="Smaller"
                                type="button"
                              >
                                <Minus size={12} />
                              </button>
                              <button
                                aria-label="Bigger"
                                className="rounded-md border border-white/10 p-1.5 text-neutral-300 hover:bg-white/5 disabled:opacity-30"
                                disabled={area.margin === MARGINS[MARGINS.length - 1]}
                                onClick={() => stepMargin(1)}
                                title="Bigger"
                                type="button"
                              >
                                <Plus size={12} />
                              </button>
                            </div>
                          ) : null}
                          <p className="mt-2 text-[10px] leading-relaxed text-neutral-500">
                            Drag a corner to move it. Drag an edge dot to add a corner. Double-click a corner to remove it.
                          </p>
                        </>
                      )}
                    </section>

                    <section>
                      <input
                        aria-label="Zone name"
                        className="field-input text-[12px] font-bold"
                        onChange={(event) => updateZone({ name: event.target.value })}
                        placeholder="Zone name, e.g. Kaduna base"
                        value={zone.name}
                      />
                    </section>

                    <section>
                      <h2 className="mb-2 text-[10px] font-bold uppercase tracking-wide text-neutral-500">Radios to watch</h2>
                      <div className="space-y-2">
                        {rules.map((rule) => (
                          <RuleCard
                            focused={focusRule?.key === rule.key}
                            index={index}
                            key={rule.key}
                            onChange={(patch) => updateRule(rule.key, patch)}
                            onFocus={() => setFocusKey(rule.key)}
                            onRemove={() => setRules((current) => current.filter((item) => item.key !== rule.key))}
                            onToggle={(type, id) => toggleTarget(rule.key, type, id)}
                            removable={rules.length > 1}
                            rule={rule}
                            targets={targets}
                            verdict={verdictByKey.get(rule.key)}
                          />
                        ))}
                      </div>
                      <button
                        className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-white/15 px-3 py-2 text-[10px] font-bold text-neutral-400 hover:border-white/30 hover:text-neutral-200"
                        onClick={() => {
                          const rule = newRule();
                          setRules((current) => [...current, rule]);
                          setFocusKey(rule.key);
                        }}
                        type="button"
                      >
                        <Plus size={12} /> Add radios with a different alarm
                      </button>
                      <p className="mt-1.5 text-[9px] text-neutral-600">Tip: click radios on the map to add or remove them.</p>
                    </section>
                  </>
                )}
              </div>

              {!placed && !drawing ? null : (
              <footer className="border-t border-white/10 bg-black/40 p-3">
                {summary ? <p className="mb-2 text-[11px] leading-relaxed text-neutral-300">{summary}</p> : null}
                {error ? (
                  <p className="mb-2 rounded border border-red-400/25 bg-red-500/[0.07] px-2 py-1.5 text-[10px] text-red-200">{error}</p>
                ) : null}
                {breachTotal ? (
                  <label className="mb-2 flex cursor-pointer items-start gap-2 rounded border border-amber-400/25 bg-amber-400/[0.06] p-2 text-[10px] text-amber-200">
                    <input checked={quiet} className="mt-0.5" onChange={(event) => setQuiet(event.target.checked)} type="checkbox" />
                    <span>
                      Don&apos;t alarm for the {breachTotal} already on the wrong side.
                      <span className="mt-0.5 block text-amber-100/60">They alarm normally the next time they cross.</span>
                    </span>
                  </label>
                ) : null}
                {!expanded.length ? <p className="mb-2 text-[10px] text-neutral-500">No one is watched yet. The zone will be saved without alarms.</p> : null}
                <button
                  className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-red-400 px-4 py-2.5 text-xs font-bold text-black transition-opacity hover:opacity-90 active:opacity-80 disabled:opacity-40"
                  disabled={saveMutation.isPending}
                  type="submit"
                >
                  <Save size={14} /> {saveMutation.isPending ? "Saving…" : "Save zone"}
                </button>
              </footer>
              )}
            </form>
          ) : (
            <>
              <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
                <MapPinned className="text-red-400" size={16} />
                <h1 className="text-[12px] font-bold text-neutral-100">Geofences</h1>
                <span className="text-[10px] text-neutral-600">{zones.length}</span>
                {canManage ? (
                  <button
                    className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-red-400 px-2.5 py-1.5 text-[10px] font-bold text-black hover:opacity-90 active:opacity-80"
                    onClick={startNew}
                    type="button"
                  >
                    <Plus size={12} /> New zone
                  </button>
                ) : null}
              </header>

              {feedback ? (
                <div className="flex items-start gap-2 border-b border-green-400/25 bg-green-400/[0.07] px-3 py-2 text-[10px] text-green-200" role="status">
                  <span className="flex-1">{feedback}</span>
                  <button aria-label="Dismiss" className="opacity-60 hover:opacity-100" onClick={() => setFeedback(null)} type="button">
                    <X size={12} />
                  </button>
                </div>
              ) : null}

              {zones.length > 6 ? (
                <div className="relative border-b border-white/10 px-3 py-2">
                  <Search className="absolute left-[22px] top-1/2 -translate-y-1/2 text-neutral-600" size={12} />
                  <input
                    aria-label="Filter zones"
                    className="field-input pl-8"
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="Filter zones"
                    value={filter}
                  />
                </div>
              ) : null}

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                {zonesQuery.isLoading
                  ? [0, 1, 2].map((n) => <div className="h-20 animate-pulse rounded-lg bg-white/[0.03]" key={n} />)
                  : null}
                {visibleZones.map((item) => (
                  <ZoneCard
                    canManage={canManage}
                    index={index}
                    key={item.id}
                    onDelete={() =>
                      window.confirm(`Delete ${item.name}? Its alarms stop.`) &&
                      deleteMutation.mutate(item.id)
                    }
                    onEdit={() => startEdit(item)}
                    onFocus={() => focusZone(item)}
                    zone={item}
                  />
                ))}
                {zonesQuery.isSuccess && !visibleZones.length ? (
                  <div className="rounded-lg border border-white/10 p-6 text-center">
                    <p className="text-xs font-bold text-neutral-300">{zones.length ? "No zones match." : "No zones yet"}</p>
                    {!zones.length ? (
                      <p className="mt-1 text-[10px] leading-relaxed text-neutral-500">
                        Draw one with New zone, or click a radio on the map to start from it.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </aside>

        <section className="relative h-[45vh] shrink-0 overflow-hidden xl:h-auto xl:flex-1">
          <ZoneMap
            basemap={basemap}
            drawing={drawing}
            editing={editing}
            fitToken={fitToken}
            cards={rules}
            highlighted={highlighted}
            members={members}
            onAddPoint={(point) => updateZone({ points: [...zone.points, point] })}
            onBasemapChange={setBasemap}
            onFinishPolygon={() => setDrawing(false)}
            onRadioAction={onRadioAction}
            onShapeChange={shapeChangedOnMap}
            onTrace={finishTrace}
            radios={radios}
            tracing={editing && drawing && drawMode === "trace"}
            zone={zone}
            zones={zones}
          />
          {editing ? null : <PlaceSearch onPick={(place) => setFitToken({ centre: { lat: place.lat, lon: place.lon }, zoom: 13, key: Date.now() })} />}
        </section>
      </div>
    </main>
  );
}

/** "Covers Barnawa, about 1.2 km across. 8 radios inside now." */
function zoneSummary(zone, ready, where, radios) {
  if (!ready) return null;
  let across = Number(zone.radius_m) * 2;
  if (zone.shape_type === "polygon") {
    const lats = zone.points.map(([, lat]) => lat);
    const lons = zone.points.map(([lon]) => lon);
    const south = Math.min(...lats);
    const west = Math.min(...lons);
    across = Math.max(
      metresBetween({ lat: south, lon: west }, { lat: Math.max(...lats), lon: west }),
      metresBetween({ lat: south, lon: west }, { lat: south, lon: Math.max(...lons) }),
    );
  }
  const inside = radios.filter((radio) => insideZone(radio, zone)).length;
  const size = zone.shape_type === "circle" ? `${formatDistance(Number(zone.radius_m))} radius` : `about ${formatDistance(across)} across`;
  const first = where ? `Covers ${where}, ${size}.` : `${size[0].toUpperCase()}${size.slice(1)}.`;
  const count = inside ? `${inside} radio${inside === 1 ? "" : "s"} inside now.` : "No radios inside now.";
  return `${first} ${count}`;
}

function ZoneCard({ zone, index, canManage, onFocus, onEdit, onDelete }) {
  // A radio past the Red step is also past Amber and Yellow; counting the
  // nearest step alone counts each radio once.
  const cards = useMemo(() => {
    const breachById = new Map(zone.rules.map((rule) => [rule.id, Number(rule.in_breach) || 0]));
    return cardsFromRules(zone.rules).map((card) => ({
      ...card,
      outside: card.targets.reduce((sum, target) => sum + (breachById.get(card.saved[savedKey(target, card.trigger, card.steps[0].level)]) || 0), 0),
    }));
  }, [zone.rules]);
  const breached = cards.reduce((sum, card) => sum + card.outside, 0);
  const kind = zoneKind(zone.rules);
  const kinds = [...new Set(cards.map((card) => card.trigger))].filter((trigger) => TRIGGER_LOOK[trigger]);
  return (
    <article
      className="group rounded-lg border border-l-2 border-white/10 bg-white/[0.02] p-3 transition-colors hover:border-white/20"
      style={{ borderLeftColor: zoneColour(zone) }}
    >
      <div className="flex items-start gap-2">
        <button className="min-w-0 flex-1 text-left" onClick={onFocus} title="Show on map" type="button">
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: zoneColour(zone) }} />
            <span className="truncate text-[12px] font-bold text-neutral-100">{zone.name}</span>
            {breached ? (
              <span className="shrink-0 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[9px] font-bold text-red-300">
                {breached} {kind ? TRIGGER_LOOK[kind].breach : "in breach"}
              </span>
            ) : null}
          </span>
          {kinds.length ? (
            <span className="mt-1 flex flex-wrap gap-1">
              {kinds.map((trigger) => {
                const look = TRIGGER_LOOK[trigger];
                return (
                  <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-bold ${look.chip}`} key={trigger}>
                    <look.Icon size={9} /> {look.zone}
                  </span>
                );
              })}
            </span>
          ) : null}
          <span className="mt-0.5 block text-[9px] text-neutral-600">
            {zone.shape_type === "circle" ? `Circle · ${formatDistance(Number(zone.radius_m))} radius` : "Shape"}
          </span>
        </button>
        {canManage ? (
          <div className="flex shrink-0 gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
            <button aria-label={`Edit ${zone.name}`} className="rounded p-1.5 text-neutral-400 hover:bg-white/5 hover:text-neutral-100" onClick={onEdit} type="button">
              <Pencil size={13} />
            </button>
            <button aria-label={`Delete ${zone.name}`} className="rounded p-1.5 text-neutral-400 hover:bg-red-500/10 hover:text-red-300" onClick={onDelete} type="button">
              <Trash2 size={13} />
            </button>
          </div>
        ) : null}
      </div>
      {zone.rules.length ? (
        <ul className="mt-2 space-y-1">
          {cards.map((card) => (
            <li className={`flex items-center gap-2 text-[10px] ${card.active ? "text-neutral-400" : "text-neutral-600 line-through"}`} key={card.key}>
              <span className="flex shrink-0 gap-0.5" title={card.steps.map((step) => LEVEL_STYLES[step.level].label).join(" → ")}>
                {card.steps.map((step) => (
                  <span className="h-2 w-2 rounded-full" key={step.level} style={{ background: LEVEL_STYLES[step.level].dot }} />
                ))}
              </span>
              {(() => {
                const look = TRIGGER_LOOK[card.trigger];
                return look ? <look.Icon className={`shrink-0 ${look.icon}`} size={10} /> : null;
              })()}
              <span className="truncate">
                <span className="font-bold text-neutral-300">{targetsSummary(index, card.targets, 3)}</span> {TRIGGER_LABEL[card.trigger]}
              </span>
              {card.outside ? <span className="ml-auto shrink-0 font-bold text-red-300">{card.outside}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[10px] text-neutral-600">No rules: watches nobody.</p>
      )}
    </article>
  );
}
