import L from "leaflet";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Circle,
  Hexagon,
  MapPinned,
  Pencil,
  Plus,
  Radio,
  Save,
  Search,
  Settings2,
  Trash2,
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
  listGeofences,
  listOrganizations,
  previewGeofence,
  saveGeofence,
  searchPlaces,
} from "../lib/api";
import { DARK_TILES, IMAGERY_LABEL_TILES, SATELLITE_TILES } from "../lib/basemaps";
import {
  bufferRing,
  circleAroundAssets,
  circleToPolygon,
  formatArea,
  formatDistance,
  insetRing,
  polygonAroundAssets,
  polygonSelfIntersects,
  polygonToCircle,
} from "../lib/fence-placement";
import { isPlatformOperator, isPlatformStaff } from "../lib/platform-roles";

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

let ruleSeq = 0;
function newRule(patch = {}) {
  ruleSeq += 1;
  return {
    key: `new-${ruleSeq}`,
    id: null,
    target_type: "",
    target_id: "",
    trigger: "exit",
    level: "amber",
    buffer_m: 30,
    confirmations_required: 3,
    active: true,
    ...patch,
  };
}

const TRIGGER_LABEL = { exit: "must stay inside", enter: "must not enter" };
const AROUND_MARGIN_M = 150;

const BASEMAPS = {
  satellite: { label: "Satellite", url: SATELLITE_TILES.url, options: SATELLITE_TILES.options, labels: IMAGERY_LABEL_TILES },
  streets: {
    label: "Streets",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: { maxZoom: 21, maxNativeZoom: 19, attribution: "&copy; OpenStreetMap" },
  },
  dark: { label: "Dark", url: DARK_TILES.url, options: DARK_TILES.options },
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
    rules: (zone.rules || []).map((rule) => ({
      key: `rule-${rule.id}`,
      id: rule.id,
      target_type: rule.target_type,
      target_id: String(rule.target_id),
      trigger: rule.trigger,
      level: rule.level,
      buffer_m: Number(rule.buffer_m),
      confirmations_required: Number(rule.confirmations_required),
      active: rule.active !== false,
      saved_as: `${rule.target_type}:${rule.target_id}:${rule.trigger}`,
    })),
  };
}

/** New, or now asks a different question: the server records where everyone stands for these. */
function isFreshRule(rule) {
  return !rule.id || rule.saved_as !== `${rule.target_type}:${rule.target_id}:${rule.trigger}`;
}

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

function rulePayload(rule) {
  return {
    id: rule.id,
    target_type: rule.target_type,
    target_id: rule.target_id,
    trigger: rule.trigger,
    level: rule.level,
    buffer_m: Number(rule.buffer_m),
    confirmations_required: Number(rule.confirmations_required),
    active: rule.active,
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

function targetLabel(index, rule) {
  if (!rule.target_type) return "Choose who";
  const key = `${rule.target_type}:${rule.target_id}`;
  return index.names.get(key) || `${rule.target_type} ${rule.target_id}`;
}

function ZoneMap({
  basemap,
  onBasemapChange,
  zones,
  editing,
  zone,
  drawing,
  focusRule,
  radios,
  highlighted,
  members,
  fitToken,
  onShapeChange,
  onAddPoint,
  onFinishPolygon,
  onRadioAction,
}) {
  const nodeRef = useRef(null);
  const mapRef = useRef(null);
  const layers = useRef({});
  const handlers = useRef({});
  handlers.current = { onShapeChange, onAddPoint, onFinishPolygon, onRadioAction };
  const live = useRef({});
  live.current = { editing, zone, drawing };
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
      const { editing: isEditing, zone: current, drawing: isDrawing } = live.current;
      if (!isEditing) return;
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const config = BASEMAPS[basemap] || BASEMAPS.satellite;
    layers.current.base?.remove();
    layers.current.labels?.remove();
    layers.current.base = L.tileLayer(config.url, config.options).addTo(map);
    layers.current.labels = config.labels ? L.tileLayer(config.labels.url, config.labels.options).addTo(map) : null;
    layers.current.base.bringToBack();
  }, [basemap]);

  // Every other zone, faint, so a new one is drawn knowing what is already there.
  useEffect(() => {
    const layer = layers.current.zones;
    if (!layer) return;
    layer.clearLayers();
    for (const other of zones) {
      if (editing && Number(other.id) === Number(zone.id)) continue;
      const style = { color: "#94a3b8", weight: 1.5, fillColor: "#475569", fillOpacity: editing ? 0.05 : 0.12, interactive: !editing };
      const shape =
        other.shape_type === "circle"
          ? L.circle([Number(other.center_lat), Number(other.center_lon)], { ...style, radius: Number(other.radius_m) })
          : L.polygon((other.geometry?.coordinates?.[0] || []).map(([lon, lat]) => [lat, lon]), style);
      shape.bindTooltip(other.name).addTo(layer);
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
      }).bindTooltip(radio.name);
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

  // The dashed line where the focused rule actually fires: outside the shape
  // for "must stay inside", inside it for "must not enter".
  useEffect(() => {
    const layer = layers.current.alarm;
    if (!layer) return;
    layer.clearLayers();
    if (!editing || !focusRule || !isPlaced(zone) || drawing) return;
    const buffer = Number(focusRule.buffer_m) || 0;
    if (!(buffer > 0)) return;
    const style = { color: "#fbbf24", weight: 1.5, dashArray: "6 6", fill: false, interactive: false };
    if (zone.shape_type === "circle") {
      const radius = Number(zone.radius_m) + (focusRule.trigger === "enter" ? -buffer : buffer);
      if (radius > 0) L.circle([zone.center_lat, zone.center_lon], { ...style, radius }).addTo(layer);
      return;
    }
    if (polygonSelfIntersects(zone.points)) return;
    const ring = focusRule.trigger === "enter" ? insetRing(zone.points, buffer) : bufferRing(zone.points, buffer);
    if (ring) L.polygon(ring.map(([lon, lat]) => [lat, lon]), style).addTo(layer);
  }, [editing, focusRule, zone, drawing]);

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
        fillColor: MEMBER_COLOURS[member.state] || MEMBER_COLOURS.pending,
        fillOpacity: 1,
        interactive: !drawing,
        bubblingMouseEvents: false,
      })
        .bindTooltip(`${member.name} · ${member.label}`)
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
    ? [["watch", "Watch this radio"]]
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

/** Searchable picker over units, channels, radios and drones. */
function TargetPicker({ rule, targets, index, onPick }) {
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
      title: "Units",
      icon: Users,
      items: (targets?.units || []).filter((u) => match(u.name, u.id)).map((u) => ({
        type: "unit", id: String(u.id), name: u.name, meta: `${u.members?.length || 0} assets`,
      })),
    },
    {
      title: "Channels",
      icon: Users,
      items: (targets?.channels || []).filter((c) => match(c.name, c.id)).map((c) => ({
        type: "channel", id: String(c.id), name: c.name, meta: `${c.members?.length || 0} radios`,
      })),
    },
    {
      title: "Radios",
      icon: Radio,
      items: (targets?.radios || []).filter((r) => match(r.name, r.device_id)).map((r) => ({
        type: "radio", id: String(r.device_id), name: r.name || `Radio ${r.device_id}`, meta: r.device_id,
      })),
    },
    {
      title: "Drones",
      icon: Radio,
      items: (targets?.drones || []).filter((d) => match(d.name, d.sysid)).map((d) => ({
        type: "drone", id: String(d.sysid), name: d.name || `Drone ${d.sysid}`, meta: `#${d.sysid}`,
      })),
    },
  ].filter((group) => group.items.length);

  const chosen = Boolean(rule.target_type);
  return (
    <div className="relative min-w-0 flex-1" ref={rootRef}>
      <button
        className={`flex w-full items-center gap-1.5 rounded-md border px-2.5 py-2 text-left text-[11px] font-bold transition-colors ${
          chosen ? "border-white/15 bg-white/[0.05] text-neutral-100 hover:bg-white/[0.08]" : "border-red-400/40 bg-red-500/[0.06] text-red-200 hover:bg-red-500/10"
        }`}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {rule.target_type === "unit" || rule.target_type === "channel" ? <Users size={12} /> : <Radio size={12} />}
        <span className="truncate">{targetLabel(index, rule)}</span>
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
              placeholder="Search units, channels, radios"
              value={query}
            />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {groups.map((group) => (
              <div key={group.title}>
                <div className="px-3 pb-1 pt-2 text-[9px] font-bold uppercase tracking-wide text-neutral-600">{group.title}</div>
                {group.items.slice(0, needle ? 50 : 30).map((item) => {
                  const selected = rule.target_type === item.type && String(rule.target_id) === item.id;
                  return (
                    <button
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] hover:bg-white/5 ${selected ? "text-red-200" : "text-neutral-300"}`}
                      key={`${item.type}:${item.id}`}
                      onClick={() => {
                        onPick(item.type, item.id);
                        setOpen(false);
                        setQuery("");
                      }}
                      type="button"
                    >
                      {selected ? <Check className="shrink-0" size={12} /> : <span className="w-3 shrink-0" />}
                      <span className="truncate">{item.name}</span>
                      <span className="ml-auto shrink-0 font-mono text-[9px] text-neutral-600">{item.meta}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {!groups.length ? <p className="px-3 py-4 text-center text-[10px] text-neutral-600">Nothing matches.</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function verdictText(rule, verdict) {
  if (!rule.target_type) return null;
  if (!verdict) return null;
  const { summary, members } = verdict;
  if (!summary.total) return { tone: "text-neutral-500", text: "Nobody in this group yet." };
  const okWord = rule.trigger === "exit" ? "inside" : "outside";
  const breachWord = rule.trigger === "exit" ? "outside" : "inside";
  const breached = members.filter((member) => member.state === "breach");
  const parts = summary.ok || !breached.length ? [`${summary.ok} of ${summary.total} ${okWord}`] : [];
  if (breached.length) {
    const names = breached.slice(0, 2).map((member) => member.name).join(", ");
    parts.push(`${names}${breached.length > 2 ? ` +${breached.length - 2}` : ""} ${breachWord}`);
  }
  if (summary.unknown) parts.push(`${summary.unknown} not reporting`);
  return { tone: breached.length ? "text-amber-300" : "text-green-300", text: parts.join(" · ") };
}

function RuleCard({ rule, targets, index, verdict, focused, onFocus, onChange, onRemove }) {
  const [advanced, setAdvanced] = useState(false);
  const status = verdictText(rule, verdict);
  return (
    <div
      className={`rounded-lg border p-2.5 transition-colors ${focused ? "border-white/25 bg-white/[0.04]" : "border-white/10 bg-white/[0.02]"}`}
      onFocusCapture={onFocus}
      onPointerDown={onFocus}
    >
      <div className="flex items-center gap-1.5">
        <TargetPicker index={index} onPick={(type, id) => onChange({ target_type: type, target_id: id })} rule={rule} targets={targets} />
        <button
          aria-label="Remove rule"
          className="shrink-0 rounded p-1.5 text-neutral-600 hover:bg-red-500/10 hover:text-red-300"
          onClick={onRemove}
          type="button"
        >
          <X size={13} />
        </button>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-black/30 p-0.5">
        {["exit", "enter"].map((trigger) => (
          <button
            className={`rounded px-2 py-1.5 text-[10px] font-bold transition-colors ${rule.trigger === trigger ? "bg-white/[0.12] text-neutral-100 shadow-sm" : "text-neutral-500 hover:text-neutral-300"}`}
            key={trigger}
            onClick={() => onChange({ trigger })}
            type="button"
          >
            {trigger === "exit" ? "Must stay inside" : "Must not enter"}
          </button>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-1">
        {LEVELS.map((level) => {
          const style = LEVEL_STYLES[level];
          const on = rule.level === level;
          return (
            <button
              className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-bold transition-colors ${on ? style.chip : "border-white/10 text-neutral-500 hover:text-neutral-300"}`}
              key={level}
              onClick={() => onChange({ level })}
              title={LEVEL_MEANING[level]}
              type="button"
            >
              <span className="h-2 w-2 rounded-full" style={{ background: style.dot, opacity: on ? 1 : 0.5 }} />
              {style.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[9px] text-neutral-600">{LEVEL_MEANING[rule.level]}</p>

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
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[9px] text-neutral-500">
              GPS drift allowed (m)
              <input
                className="field-input mt-1"
                min="0"
                onChange={(event) => onChange({ buffer_m: event.target.value })}
                type="number"
                value={rule.buffer_m}
              />
            </label>
            <label className="text-[9px] text-neutral-500">
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
            Alarms after {rule.confirmations_required} readings in a row past the dashed line, about{" "}
            {Number(rule.confirmations_required) * 5} seconds for a radio.
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
      if (!rule.target_type) continue;
      for (const key of index.members.get(`${rule.target_type}:${rule.target_id}`) || []) keys.add(key);
    }
    return keys;
  }, [editing, rules, index]);

  const placed = isPlaced(zone);
  const crossed = zone.shape_type === "polygon" && zone.points.length >= 4 && polygonSelfIntersects(zone.points);
  const readyRules = rules.filter((rule) => rule.target_type);

  const previewInput = useSettled(
    editing && placed && !crossed && !drawing && readyRules.length && orgId
      ? JSON.stringify({ organization_id: Number(orgId), ...zonePayload(zone), rules: readyRules.map(rulePayload) })
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
  const verdictByKey = useMemo(() => {
    const map = new Map();
    if (!previewQuery.data?.rules) return map;
    readyRules.forEach((rule, i) => map.set(rule.key, previewQuery.data.rules[i]));
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
        const breachWord = focusRule.trigger === "exit" ? "outside" : "inside";
        const okWord = focusRule.trigger === "exit" ? "inside" : "outside";
        map.set(`${member.asset_type}:${member.asset_id}`, {
          ...member,
          label: member.state === "breach" ? breachWord : member.state === "ok" ? okWord : "not reporting",
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
  const breachTotal = rules
    .filter(isFreshRule)
    .reduce((sum, rule) => sum + (verdictByKey.get(rule.key)?.summary?.breach || 0), 0);

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
    setFitToken({ bounds: L.latLngBounds(points.map((p) => [p.lat, p.lon])).pad(pad), key: Date.now() });
  }, []);

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
    const rule = newRule({ target_type: "radio", target_id: radio.id, trigger });
    openEditor(
      {
        ...EMPTY_ZONE,
        organization_id: org,
        name: trigger === "exit" ? `${radio.name} area` : "",
        center_lat: radio.lat,
        center_lon: radio.lon,
        radius_m: trigger === "exit" ? 300 : 200,
      },
      [rule],
    );
    setFitToken({ bounds: L.latLng(radio.lat, radio.lon).toBounds(1500), key: Date.now() });
  }

  function onRadioAction(radio, action) {
    if (action === "watch") {
      if (rules.some((rule) => rule.target_type === "radio" && rule.target_id === radio.id)) return;
      const blank = rules.find((rule) => !rule.target_type);
      if (blank) updateRule(blank.key, { target_type: "radio", target_id: radio.id });
      else {
        const rule = newRule({ target_type: "radio", target_id: radio.id });
        setRules((current) => [...current, rule]);
        setFocusKey(rule.key);
      }
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
    // Picking who to watch brings them into view when there is no zone yet.
    if (patch.target_type && !placed) {
      const points = (index.members.get(`${patch.target_type}:${patch.target_id}`) || [])
        .map((key) => positions.get(key))
        .filter(Boolean);
      if (points.length) fitTo(points);
    }
  }

  function changeShape(shape) {
    if (shape === zone.shape_type) return;
    if (shape === "circle") {
      const circle = zone.points.length >= 3 ? polygonToCircle(zone.points) : null;
      updateZone({ shape_type: "circle", points: [], ...(circle || { center_lat: null, center_lon: null }) });
      setDrawing(false);
      return;
    }
    const ring = zone.center_lat != null ? circleToPolygon(zone.center_lat, zone.center_lon, Number(zone.radius_m)) : null;
    updateZone({ shape_type: "polygon", points: ring || [], center_lat: null, center_lon: null });
    setDrawing(!ring);
  }

  function redraw() {
    updateZone(zone.shape_type === "circle" ? { center_lat: null, center_lon: null } : { points: [] });
    setDrawing(zone.shape_type === "polygon");
  }

  /** Draws the zone round where the watched people are right now. */
  function drawAround() {
    const points = [...highlighted].map((key) => positions.get(key)).filter(Boolean);
    if (!points.length) {
      setError("None of the people these rules watch are reporting a position right now.");
      return;
    }
    if (zone.shape_type === "circle") updateZone(circleAroundAssets(points, AROUND_MARGIN_M));
    else updateZone({ points: polygonAroundAssets(points, AROUND_MARGIN_M) });
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
    if (rules.some((rule) => !rule.target_type)) return setError("Each rule needs someone to watch, or remove it.");
    if (!orgId) return setError("Choose an organization.");
    saveMutation.mutate({
      id: zone.id,
      organization_id: Number(orgId),
      ...zonePayload(zone),
      rules: rules.map(rulePayload),
      quiet,
    });
  }

  const metrics = previewQuery.data?.metrics;
  const place = previewQuery.data?.place;
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
                <section>
                  <input
                    aria-label="Zone name"
                    className="field-input text-[12px] font-bold"
                    onChange={(event) => updateZone({ name: event.target.value })}
                    placeholder="Zone name, e.g. Kaduna base"
                    value={zone.name}
                  />
                  {isAdmin && !zone.id ? (
                    <select
                      aria-label="Organization"
                      className="field-input mt-2"
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
                </section>

                <section>
                  <h2 className="mb-2 text-[10px] font-bold uppercase tracking-wide text-neutral-500">Who it watches</h2>
                  <div className="space-y-2">
                    {rules.map((rule) => (
                      <RuleCard
                        focused={focusRule?.key === rule.key}
                        index={index}
                        key={rule.key}
                        onChange={(patch) => updateRule(rule.key, patch)}
                        onFocus={() => setFocusKey(rule.key)}
                        onRemove={() => setRules((current) => current.filter((item) => item.key !== rule.key))}
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
                    <Plus size={12} /> Add another rule
                  </button>
                  <p className="mt-1.5 text-[9px] text-neutral-600">Tip: click a radio on the map to add it.</p>
                </section>

                <section>
                  <h2 className="mb-2 text-[10px] font-bold uppercase tracking-wide text-neutral-500">Area</h2>
                  <div className="grid grid-cols-2 gap-1 rounded-md bg-black/30 p-0.5">
                    {[["circle", Circle, "Circle"], ["polygon", Hexagon, "Shape"]].map(([shape, Icon, label]) => (
                      <button
                        className={`inline-flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[10px] font-bold transition-colors ${zone.shape_type === shape ? "bg-white/[0.12] text-neutral-100 shadow-sm" : "text-neutral-500 hover:text-neutral-300"}`}
                        key={shape}
                        onClick={() => changeShape(shape)}
                        type="button"
                      >
                        <Icon size={12} /> {label}
                      </button>
                    ))}
                  </div>

                  <div className="mt-2 rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-2 text-[10px] leading-relaxed text-neutral-400">
                    {zone.shape_type === "circle"
                      ? zone.center_lat == null
                        ? "Press on the map where the centre goes and drag out the size."
                        : "Drag the white dot to move it, the red dot to resize."
                      : drawing
                        ? `Click the map to place corners (${zone.points.length} so far). Click the first corner to close.`
                        : "Drag corners to move them. Drag an edge dot to add a corner. Double-click a corner to remove it."}
                  </div>

                  <div className="mt-2 flex gap-2">
                    <button
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-white/[0.08] px-3 py-2 text-[10px] font-bold text-neutral-100 hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={!highlighted.size}
                      onClick={drawAround}
                      title={highlighted.size ? "" : "Choose who it watches first"}
                      type="button"
                    >
                      <Users size={12} /> Draw around them
                    </button>
                    {drawing && zone.points.length >= 3 ? (
                      <button
                        className="rounded-md bg-red-400 px-3 py-2 text-[10px] font-bold text-black"
                        onClick={() => setDrawing(false)}
                        type="button"
                      >
                        Done
                      </button>
                    ) : null}
                    {drawing && zone.points.length ? (
                      <button
                        className="rounded-md border border-white/10 px-3 py-2 text-[10px] font-bold text-neutral-400 hover:text-neutral-100"
                        onClick={() => updateZone({ points: zone.points.slice(0, -1) })}
                        type="button"
                      >
                        Undo
                      </button>
                    ) : null}
                    {placed && !drawing ? (
                      <button
                        className="rounded-md border border-white/10 px-3 py-2 text-[10px] font-bold text-neutral-400 hover:text-neutral-100"
                        onClick={redraw}
                        type="button"
                      >
                        Redraw
                      </button>
                    ) : null}
                  </div>

                  {zone.shape_type === "circle" && zone.center_lat != null ? (
                    <label className="mt-2 flex items-center gap-2 text-[10px] text-neutral-500">
                      Radius
                      <input
                        className="field-input w-24"
                        min="10"
                        onChange={(event) => updateZone({ radius_m: event.target.value })}
                        type="number"
                        value={zone.radius_m}
                      />
                      m
                    </label>
                  ) : null}

                  {placed && metrics && !drawing ? (
                    <p className="mt-2 text-[10px] text-neutral-500">
                      {formatDistance(Math.max(metrics.width_m, metrics.height_m))} across · {formatArea(metrics.area_sq_m)}
                      {place ? ` · ${place.label}` : ""}
                    </p>
                  ) : null}
                </section>
              </div>

              <footer className="border-t border-white/10 bg-black/40 p-3">
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
                {!readyRules.length ? <p className="mb-2 text-[10px] text-neutral-500">No one is watched yet. The zone will be saved without alarms.</p> : null}
                <button
                  className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-red-400 px-4 py-2.5 text-xs font-bold text-black transition-opacity hover:opacity-90 active:opacity-80 disabled:opacity-40"
                  disabled={saveMutation.isPending}
                  type="submit"
                >
                  <Save size={14} /> {saveMutation.isPending ? "Saving…" : "Save zone"}
                </button>
              </footer>
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
                      window.confirm(`Delete ${item.name}? Its ${item.rules.length} rule${item.rules.length === 1 ? "" : "s"} stop alarming.`) &&
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
            focusRule={focusRule}
            highlighted={highlighted}
            members={members}
            onAddPoint={(point) => updateZone({ points: [...zone.points, point] })}
            onBasemapChange={setBasemap}
            onFinishPolygon={() => setDrawing(false)}
            onRadioAction={onRadioAction}
            onShapeChange={updateZone}
            radios={radios}
            zone={zone}
            zones={zones}
          />
          <PlaceSearch onPick={(place) => setFitToken({ centre: { lat: place.lat, lon: place.lon }, zoom: 13, key: Date.now() })} />
        </section>
      </div>
    </main>
  );
}

function ZoneCard({ zone, index, canManage, onFocus, onEdit, onDelete }) {
  const breached = zone.rules.reduce((sum, rule) => sum + (Number(rule.in_breach) || 0), 0);
  return (
    <article className="group rounded-lg border border-white/10 bg-white/[0.02] p-3 transition-colors hover:border-white/20">
      <div className="flex items-start gap-2">
        <button className="min-w-0 flex-1 text-left" onClick={onFocus} title="Show on map" type="button">
          <span className="flex items-center gap-2">
            <span className="truncate text-[12px] font-bold text-neutral-100">{zone.name}</span>
            {breached ? (
              <span className="shrink-0 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[9px] font-bold text-red-300">{breached} in breach</span>
            ) : null}
          </span>
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
          {zone.rules.map((rule) => (
            <li className={`flex items-center gap-2 text-[10px] ${rule.active ? "text-neutral-400" : "text-neutral-600 line-through"}`} key={rule.id}>
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: LEVEL_STYLES[rule.level]?.dot }} title={LEVEL_STYLES[rule.level]?.label} />
              <span className="truncate">
                <span className="font-bold text-neutral-300">{targetLabel(index, rule)}</span> {TRIGGER_LABEL[rule.trigger]}
              </span>
              {Number(rule.in_breach) ? <span className="ml-auto shrink-0 font-bold text-red-300">{rule.in_breach}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[10px] text-neutral-600">No rules: watches nobody.</p>
      )}
    </article>
  );
}
