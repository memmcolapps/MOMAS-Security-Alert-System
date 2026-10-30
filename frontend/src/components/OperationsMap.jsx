import L from "leaflet";
import "leaflet.heat";
import "leaflet.markercluster";
import { useCallback, useEffect, useRef, useState } from "react";
import { IMAGERY_LABEL_TILES, IMAGERY_ROAD_TILES, LABELLED_BASEMAPS, SATELLITE_TILES, VECTOR_STYLES, vectorBasemapLayer } from "../lib/basemaps";
import { deviceTypeGlyph, escapeHtml, severityColors, severityLabels, typeIcons } from "../lib/domain";
import { MOTION, distanceMetres, fixAgeSec, fixFromLocation, formatAge, trailSegments } from "../lib/radio-motion";
import { newestPoint, sampleTrack } from "../lib/radio-playback";
import { replayPosition } from "../lib/radio-replay";

// What a radio is doing, in the order an operator cares about it. One status
// per radio drives its pin, the counts bar and the fleet list alike.
export const RADIO_STATUSES = ["sos", "moving", "online", "nofix", "offline"];

// Which statuses each counts-bar filter shows. "online" means the network can
// reach the radio, so it takes in the moving and no-fix ones too.
const FILTER_SHOWS = {
  all: null,
  moving: new Set(["moving"]),
  online: new Set(["moving", "online", "nofix"]),
  nofix: new Set(["nofix"]),
  offline: new Set(["offline"]),
  // Radios with no position are not on the map; this filter shows the list.
  nopos: new Set(),
};

const NIGERIA_BOUNDS = L.latLngBounds([4.3, 2.7], [13.9, 14.7]);
const NIGERIA_CENTER = [9.0, 8.5];

export function incidentPopup(incident) {
  const color = severityColors[incident.severity] || severityColors.BLUE;
  const killed = incident.fatalities ?? incident.killed ?? 0;
  const abducted = incident.victims ?? incident.abducted ?? 0;
  const source = incident.source_url
    ? `<a href="${escapeHtml(incident.source_url)}" target="_blank" rel="noreferrer" style="color:${color}">Open source</a>`
    : escapeHtml(incident.source || "Source unavailable");

  return `
    <div>
      <div style="font-size:13px;font-weight:700;color:${color};margin-bottom:5px">${escapeHtml(incident.title || incident.type || "Incident")}</div>
      <div style="font-size:11px;color:#ccc"><strong>Where:</strong> ${escapeHtml([incident.location, incident.state].filter(Boolean).join(", ") || "Nigeria")}</div>
      <div style="font-size:11px;color:#ccc"><strong>When:</strong> ${escapeHtml(incident.date || incident.created_at || "")}</div>
      <div style="font-size:11px;color:#ccc"><strong>Severity:</strong> ${severityLabels[incident.severity] || incident.severity || "BLUE"}</div>
      <div style="font-size:11px;color:#ccc"><strong>Impact:</strong> ${killed} killed · ${abducted} abducted/victims</div>
      <div style="margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,.08);font-size:11px;color:#888">${escapeHtml(incident.description || "")}</div>
      <div style="margin-top:7px;font-size:10px">${source}</div>
    </div>
  `;
}

export function devicePopup(device, registry) {
  const row = registry.get(String(device.Uid)) || {};
  const name = row.name || `Device ${device.Uid}`;
  return `
    <div>
      <div style="font-size:13px;font-weight:700;color:#00cc66;margin-bottom:5px">${escapeHtml(name)}</div>
      <div style="font-size:11px;color:#ccc"><strong>UID:</strong> ${escapeHtml(device.Uid)}</div>
      <div style="font-size:11px;color:#ccc"><strong>Company:</strong> ${escapeHtml(row.company || "—")}</div>
      <div style="font-size:11px;color:#ccc"><strong>Operator:</strong> ${escapeHtml(row.operator || "—")}</div>
      <div style="font-size:11px;color:#ccc"><strong>Status:</strong> ${device.processStatus === 1 ? "SOS alarm" : "Reporting"}</div>
      <div style="font-size:11px;color:#888"><strong>Updated:</strong> ${device.GpsTime ? new Date(device.GpsTime).toLocaleString() : "—"}</div>
    </div>
  `;
}

export function sosPopup(alert) {
  const isGeofence = alert.source === "geofence" || alert.alert_type === "geofence_breach";
  // A person in distress may keep moving, so an alarm from a radio offers to
  // track it rather than leave the operator watching where it was raised.
  const radioId = !isGeofence || alert.asset_type === "radio" ? alert.device_id : null;
  return `
    <div>
      <div style="font-size:13px;font-weight:700;color:#ff4444;margin-bottom:5px">${isGeofence ? "Geofence Breach" : "SOS Alarm"}</div>
      <div style="font-size:11px;color:#ccc"><strong>Device:</strong> ${escapeHtml(alert.asset_name || alert.dev_name || alert.device_name || `Device ${alert.device_id}`)}</div>
      <div style="font-size:11px;color:#ccc"><strong>UID:</strong> ${escapeHtml(alert.device_id || "—")}</div>
      ${isGeofence ? `<div style="font-size:11px;color:#ccc"><strong>Fence:</strong> ${escapeHtml(alert.geofence_name || "—")}</div>` : ""}
      <div style="font-size:11px;color:#ccc"><strong>When:</strong> ${escapeHtml(alert.triggered_at ? new Date(alert.triggered_at).toLocaleString() : "—")}</div>
      <div style="font-size:11px;color:#ccc"><strong>Location:</strong> ${
        Number.isFinite(Number(alert.map_lat)) && Number.isFinite(Number(alert.map_lon))
          ? `${Number(alert.map_lat).toFixed(5)}, ${Number(alert.map_lon).toFixed(5)}`
          : "Unknown"
      }</div>
      <div style="font-size:10px;color:#888">${isGeofence ? `${Math.round(Number(alert.distance_outside_m) || 0)} m outside` : alert.map_location_source === "device" ? "Using latest device location" : "Using SOS location"}</div>
      ${radioId ? `<button type="button" class="popup-track-btn" data-track-radio="${escapeHtml(radioId)}">Track this radio</button>` : ""}
    </div>
  `;
}

// Plane glyph, drawn nose-up (pointing toward 0°/north) so rotating by
// heading_deg points it in the direction of travel. Inherits color via
// currentColor.
const DRONE_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2 C12.9 2 13.6 3.1 13.6 5 L13.6 9.4 L21 14 L21 15.8 L13.6 13.4 L13.6 18.6 L16 20.2 L16 21.6 L12 20.6 L8 21.6 L8 20.2 L10.4 18.6 L10.4 13.4 L3 15.8 L3 14 L10.4 9.4 L10.4 5 C10.4 3.1 11.1 2 12 2 Z"/>
</svg>`;

export function dronePopup(drone) {
  const online = drone.online;
  const color = online ? "#33bbff" : "#888";
  const num = (value, unit, digits = 0) =>
    Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}${unit}` : "—";
  const status = online ? (drone.armed ? "Armed / flying" : "Connected") : "Offline";
  return `
    <div>
      <div style="font-size:13px;font-weight:700;color:${color};margin-bottom:5px">${escapeHtml(drone.name || `Drone ${drone.sysid}`)}</div>
      <div style="font-size:11px;color:#ccc"><strong>System ID:</strong> ${escapeHtml(String(drone.sysid))}</div>
      <div style="font-size:11px;color:#ccc"><strong>Registration:</strong> ${escapeHtml(drone.registration || "—")}</div>
      <div style="font-size:11px;color:#ccc"><strong>Model:</strong> ${escapeHtml(drone.model || "—")}</div>
      <div style="font-size:11px;color:#ccc"><strong>Status:</strong> ${escapeHtml(status)}</div>
      <div style="font-size:11px;color:#ccc"><strong>Altitude:</strong> ${num(drone.relative_alt_m, " m AGL")}</div>
      <div style="font-size:11px;color:#ccc"><strong>Heading:</strong> ${num(drone.heading_deg, "°")}</div>
      <div style="font-size:11px;color:#ccc"><strong>Ground speed:</strong> ${num(drone.ground_speed_ms, " m/s", 1)}</div>
      <div style="font-size:11px;color:#ccc"><strong>GPS:</strong> ${drone.satellites ?? "—"} sats · fix ${drone.gps_fix ?? "—"}</div>
      <div style="font-size:11px;color:#ccc"><strong>Battery:</strong> ${
        drone.battery_pct != null ? `${drone.battery_pct}%` : "—"
      }${drone.battery_voltage != null ? ` · ${Number(drone.battery_voltage).toFixed(1)} V` : ""}</div>
      <div style="font-size:10px;color:#888;margin-top:5px">Updated ${
        drone.age_sec != null ? `${drone.age_sec}s ago` : "—"
      }${drone.registered ? "" : " · unregistered sysid"}</div>
    </div>
  `;
}

const RADIO_GLYPH = '<i class="fas fa-walkie-talkie"></i>';

// Radios and drones cluster in their own groups, so a cluster always means "n
// of one kind" and never mixes fleets that are read differently. Two separate
// markerClusterGroups never merge with each other, which is the whole trick.
function assetClusterIcon(kind, glyph) {
  return (cluster) => {
    const count = cluster.getChildCount();
    const size = count < 10 ? 34 : count < 50 ? 40 : 46;
    const children = cluster.getAllChildMarkers();
    const live = children.filter((marker) => !marker.options.assetOffline).length;
    // "14 · 3 on": how many are here, and how many of them can answer.
    const onCount = live && live < count ? `<span class="asset-cluster-live">${live} on</span>` : "";
    return L.divIcon({
      className: "",
      html: `<div class="asset-cluster ${kind}${live ? "" : " offline"}" style="width:${size}px;height:${size}px">
               <span class="asset-cluster-glyph">${glyph}</span>
               <span class="asset-cluster-count">${count}</span>
               ${onCount}
             </div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  };
}

// From this zoom in, a group is a stack of radios in one building rather than
// a region: it only forms where pins would sit on top of each other, and
// clicking it fans the radios out instead of zooming further.
const STACK_ZOOM = 17;

function assetClusterGroup(kind, glyph) {
  const group = L.markerClusterGroup({
    maxClusterRadius: (zoom) => (zoom >= STACK_ZOOM ? 22 : 44),
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    zoomToBoundsOnClick: false,
    chunkedLoading: true,
    iconCreateFunction: assetClusterIcon(kind, glyph),
  });
  group.on("clusterclick", (event) => {
    const cluster = event.layer;
    if (group._map && group._map.getZoom() >= STACK_ZOOM) cluster.spiderfy();
    else cluster.zoomToBounds({ padding: [40, 40] });
  });
  return group;
}

// Takes a pin out of whichever layer holds it. While the radio layer is
// switched off, markercluster's removeLayer forgets the pin but leaves its move
// listener attached, so the next setLatLng quietly queues the pin back into the
// cluster group; turning the layer on again then leaves stale entries in the
// cluster grid and every later add throws "reading 'x'".
function removePin(layer, marker) {
  layer.removeLayer(marker);
  if (layer._childMarkerEventHandlers && !layer._map) marker.off(layer._childMarkerEventHandlers, layer);
}

// A radio's pin, drawn from its status. Offline radios shrink to a dot: they
// stay findable, but they are most of the fleet at any hour and should not
// drown out the ones that can answer. Names show only where they earn the
// space - moving, tracked, in alarm - and on hover everywhere else.
function radioIcon({ label, glyph, status, bearing, tracked, ageSec }) {
  if (status === "offline" && !tracked) {
    return L.divIcon({ className: "", html: '<div class="device-dot"></div>', iconSize: [10, 10], iconAnchor: [5, 5] });
  }
  const sos = status === "sos";
  const heading =
    status === "moving" && Number.isFinite(bearing)
      ? `<div class="device-heading" style="transform:rotate(${Math.round(bearing)}deg)"></div>`
      : "";
  const labelled = sos || tracked || status === "moving";
  const age = status === "nofix" ? ` · ${escapeHtml(formatAge(ageSec))}` : "";
  return L.divIcon({
    className: "",
    // A vehicle tracker and a handheld should not look identical on a map.
    // An SOS keeps the alarm glyph whatever the device is - what it is
    // matters less than that it is shouting.
    html: `${heading}<div class="device-pin status-${status} ${tracked ? "tracked" : ""}">${sos ? '<i class="fas fa-triangle-exclamation"></i>' : glyph}</div>${
      labelled ? `<div class="device-label status-${status}">${escapeHtml(label)}${age}</div>` : ""
    }`,
    iconSize: [26, 42],
    iconAnchor: [13, 13],
  });
}

// Keeps a tracked radio in the middle part of the screen. Panning only when it
// nears the edge, rather than on every frame, is what keeps the map readable.
const TRACK_INNER_PAD = -0.25;
// Close enough to see which building, and no closer than the imagery goes:
// past zoom 19 the satellite tiles are only upscaled and turn to mush.
const TRACK_ZOOM_MIN = 17;
const TRACK_ZOOM_MAX = 19;
// Pins move on every frame; icons, labels, layers and the trail are rechecked
// this often, which is plenty for things that change on a scale of seconds.
const RADIO_VISUAL_MS = 250;
const TRAIL_REDRAW_MS = 2000;

export function OperationsMap({
  incidents,
  devices,
  locations,
  sosAlerts = [],
  drones = [],
  geofences = [],
  activeLayers,
  basemap,
  onIncidentFocus,
  onRadioSelect,
  followLine,
  focusTarget,
  trackedRadioId = null,
  trackPaused = false,
  trail = [],
  radioTracks = null,
  radioFilter = "all",
  onRadioStatuses,
  replay = null,
  replayTime = null,
  coverage = null,
  onTrackRadio,
  onTrackPause,
  onTrackedMotion,
}) {
  const mapNode = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef({});
  // One entry per radio on the map, kept across refreshes so a pin can move
  // rather than be torn down and redrawn: { marker, fix, motion, layer, ... }.
  const radiosRef = useRef(new Map());
  const frameRef = useRef(null);
  const trackRef = useRef({ id: null, paused: false, lastCheck: 0 });
  const callbacksRef = useRef({});
  const trailRef = useRef(trail);
  callbacksRef.current = { onRadioSelect, onTrackRadio, onTrackPause, onTrackedMotion, onRadioStatuses };
  const filterRef = useRef(radioFilter);
  filterRef.current = radioFilter;
  trackRef.current.id = trackedRadioId;
  trackRef.current.paused = trackPaused;
  trailRef.current = trail;

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;

    const map = L.map(mapNode.current, {
      zoomControl: false,
      maxBounds: NIGERIA_BOUNDS.pad(0.2),
      maxBoundsViscosity: 0.85,
      maxZoom: 21,
    }).setView(NIGERIA_CENTER, 6);

    // Vector basemaps are created on first use (see the basemap effect).
    const baseLayers = {
      satellite: L.tileLayer(SATELLITE_TILES.url, SATELLITE_TILES.options),
    };
    // Street names under place names, so a town label is never hidden by a road.
    const labelLayer = L.layerGroup([
      L.tileLayer(IMAGERY_ROAD_TILES.url, IMAGERY_ROAD_TILES.options),
      L.tileLayer(IMAGERY_LABEL_TILES.url, IMAGERY_LABEL_TILES.options),
    ]);

    const incidentLayer = L.markerClusterGroup({ maxClusterRadius: 46 });
    const heatLayer = L.heatLayer([], {
      radius: 28,
      blur: 22,
      maxZoom: 10,
      gradient: { 0.2: "#3399ff", 0.45: "#00bbaa", 0.7: "#ff6600", 1: "#ffb300" },
    });
    const deviceClusterLayer = assetClusterGroup("radio", RADIO_GLYPH);
    // A radio in alarm never clusters - it would disappear into a count at the
    // exact moment someone needs to see where it is.
    const deviceAlertLayer = L.layerGroup();
    // Moving and tracked radios. A marker sliding inside a cluster group is
    // re-clustered on every frame, so anything that animates lives out here.
    const deviceMovingLayer = L.layerGroup();
    const deviceLayer = L.layerGroup([deviceClusterLayer, deviceAlertLayer, deviceMovingLayer]);
    const trailLayer = L.layerGroup();
    const replayLayer = L.layerGroup();
    // Coverage can be thousands of squares; canvas keeps that cheap.
    const coverageLayer = L.layerGroup();
    const coverageRenderer = L.canvas({ padding: 0.3 });
    const sosLayer = L.layerGroup();
    const droneLayer = assetClusterGroup("drone", DRONE_SVG);
    const geofenceLayer = L.layerGroup();
    const followLayer = L.layerGroup();

    baseLayers.satellite.addTo(map);
    labelLayer.addTo(map);
    incidentLayer.addTo(map);
    geofenceLayer.addTo(map);
    coverageLayer.addTo(map);
    followLayer.addTo(map);
    trailLayer.addTo(map);
    replayLayer.addTo(map);
    deviceLayer.addTo(map);
    droneLayer.addTo(map);
    sosLayer.addTo(map);
    L.control.zoom({ position: "topleft" }).addTo(map);
    L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);

    const recenter = L.Control.extend({
      options: { position: "topleft" },
      onAdd() {
        const container = L.DomUtil.create("div", "leaflet-bar");
        const button = L.DomUtil.create("button", "map-utility-btn", container);
        button.type = "button";
        button.innerHTML = '<i class="fas fa-crosshairs"></i>';
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.on(button, "click", (event) => {
          L.DomEvent.stop(event);
          map.fitBounds(NIGERIA_BOUNDS, { padding: [20, 20] });
        });
        return container;
      },
    });
    map.addControl(new recenter());


    layersRef.current = {
      baseLayers,
      labelLayer,
      activeBase: baseLayers.satellite,
      incidentLayer,
      heatLayer,
      deviceLayer,
      deviceClusterLayer,
      deviceAlertLayer,
      deviceMovingLayer,
      trailLayer,
      replayLayer,
      coverageLayer,
      coverageRenderer,
      sosLayer,
      droneLayer,
      geofenceLayer,
      followLayer,
    };
    mapRef.current = map;

    // Grabbing the map means the operator wants to look somewhere else; the
    // camera stops chasing the tracked radio until they ask it to.
    map.on("dragstart", () => {
      if (trackRef.current.id && !trackRef.current.paused) callbacksRef.current.onTrackPause?.();
    });
    map.on("popupopen", (event) => {
      const button = event.popup.getElement()?.querySelector("[data-track-radio]");
      if (!button) return;
      L.DomEvent.on(button, "click", (click) => {
        L.DomEvent.stop(click);
        callbacksRef.current.onTrackRadio?.(button.dataset.trackRadio);
        map.closePopup(event.popup);
      });
    });

    const radios = radiosRef.current;
    return () => {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      radios.clear();
      const node = mapNode.current;
      try {
        map.off();
        map.remove();
      } catch (error) {
        console.warn("[Map] Leaflet cleanup skipped:", error);
      }
      if (node) {
        node.replaceChildren();
        delete node._leaflet_id;
      }
      mapRef.current = null;
      layersRef.current = {};
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layers = layersRef.current;
    if (!map || !layers.baseLayers) return;
    let cancelled = false;
    // Resolved once, so an unknown key falls back to satellite *and* its labels
    // rather than landing on bare imagery with nothing named on it.
    const key = basemap in VECTOR_STYLES || basemap === "satellite" ? basemap : "satellite";
    const show = (next) => {
      if (cancelled || mapRef.current !== map) return;
      if (layers.activeBase !== next) {
        if (layers.activeBase) map.removeLayer(layers.activeBase);
        next.addTo(map);
        layers.activeBase = next;
        next.bringToBack?.();
      }
      // Labels ride above the imagery but stay inside the tile pane, so every
      // marker, cluster and fence still draws over them.
      const wantsLabels = LABELLED_BASEMAPS.has(key);
      if (wantsLabels && !map.hasLayer(layers.labelLayer)) layers.labelLayer.addTo(map);
      else if (!wantsLabels && map.hasLayer(layers.labelLayer)) map.removeLayer(layers.labelLayer);
    };
    if (layers.baseLayers[key]) show(layers.baseLayers[key]);
    else {
      vectorBasemapLayer(L, key)
        .then((layer) => {
          layers.baseLayers[key] = layer;
          show(layer);
        })
        // No WebGL, or the tile service is unreachable: stay on imagery.
        .catch((error) => {
          console.warn("[Map] vector basemap unavailable:", error);
          show(layers.baseLayers.satellite);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [basemap]);

  useEffect(() => {
    const map = mapRef.current;
    const { incidentLayer, heatLayer } = layersRef.current;
    if (!map || !incidentLayer || !heatLayer) return;

    incidentLayer.clearLayers();
    const heatPoints = [];

    for (const incident of incidents) {
      const lat = Number(incident.lat);
      const lon = Number(incident.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const color = severityColors[incident.severity] || severityColors.BLUE;
      const icon = L.divIcon({
        className: "",
        html: `<div class="live-marker sev-${incident.severity || "BLUE"}"></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      const marker = L.marker([lat, lon], { icon }).bindPopup(incidentPopup(incident));
      marker.on("click", () => onIncidentFocus?.(incident));
      incidentLayer.addLayer(marker);
      heatPoints.push([lat, lon, incident.severity === "RED" ? 1 : incident.severity === "ORANGE" ? 0.7 : 0.4]);
    }

    heatLayer.setLatLngs(heatPoints);
  }, [incidents, onIncidentFocus]);

  useEffect(() => {
    const { geofenceLayer } = layersRef.current;
    if (!geofenceLayer) return;
    geofenceLayer.clearLayers();
    for (const fence of geofences) {
      if (!fence.active) continue;
      const style = { color: "#fb7185", weight: 2, fillColor: "#ef4444", fillOpacity: 0.06, dashArray: "6 5" };
      let layer = null;
      if (fence.shape_type === "circle") {
        const lat = Number(fence.center_lat);
        const lon = Number(fence.center_lon);
        const radius = Number(fence.radius_m);
        if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(radius)) {
          layer = L.circle([lat, lon], { ...style, radius });
        }
      } else {
        const ring = fence.geometry?.coordinates?.[0];
        if (Array.isArray(ring)) layer = L.polygon(ring.map(([lon, lat]) => [lat, lon]), style);
      }
      layer?.bindTooltip(escapeHtml(fence.name || "Geofence")).addTo(geofenceLayer);
    }
  }, [geofences]);

  const keepTrackedInView = useCallback((latlng) => {
    const map = mapRef.current;
    const track = trackRef.current;
    if (!map || !track.id || track.paused) return;
    const now = Date.now();
    if (now - track.lastCheck < 500) return;
    track.lastCheck = now;
    if (!map.getBounds().pad(TRACK_INNER_PAD).contains(latlng)) {
      map.panTo(latlng, { animate: true, duration: 0.8 });
    }
  }, []);

  // Everything about a radio's pin except where it is: icon, label, tooltip,
  // and which layer it lives in. Cheap to call; it only touches Leaflet when
  // something actually changed.
  const refreshRadio = useCallback((uid, entry, now) => {
    const { deviceClusterLayer, deviceAlertLayer, deviceMovingLayer } = layersRef.current;
    if (!deviceClusterLayer) return;
    const layerFor = { cluster: deviceClusterLayer, alert: deviceAlertLayer, moving: deviceMovingLayer };
    const track = radioTracks?.current?.get(uid);
    const tracked = uid === trackRef.current.id;
    // Age comes from the stream when there is one: it is when the radio's
    // newest batch actually arrived.
    const ageSec = track?.lastArrivalMs ? Math.round((now - track.lastArrivalMs) / 1000) : fixAgeSec(entry.fix, now);
    const stale = !entry.sos && !entry.offline && ageSec != null && ageSec > MOTION.staleSec;
    const status = entry.sos
      ? "sos"
      : entry.offline
        ? "offline"
        : stale
          ? "nofix"
          : entry.motion?.moving
            ? "moving"
            : "online";
    const bearing = entry.motion?.bearing;
    const iconKey = [entry.label, entry.glyph, status, status === "moving" ? Math.round(bearing / 5) : "", tracked, status === "nofix" ? formatAge(ageSec) : ""].join("|");
    if (iconKey !== entry.iconKey) {
      entry.marker.setIcon(radioIcon({ label: entry.label, glyph: entry.glyph, status, bearing, tracked, ageSec }));
      entry.marker.setZIndexOffset(status === "sos" ? 1000 : tracked ? 900 : status === "moving" ? 500 : status === "offline" ? -500 : 0);
      entry.iconKey = iconKey;
    }
    const tooltip = `${escapeHtml(entry.label)}${status === "offline" ? " · offline" : ""}${status === "nofix" ? ` · no new fix for ${escapeHtml(formatAge(ageSec))}` : ""}`;
    if (tooltip !== entry.tooltip) {
      if (entry.marker.getTooltip()) entry.marker.setTooltipContent(tooltip);
      else entry.marker.bindTooltip(tooltip, { direction: "top", offset: [0, -10], opacity: 0.95 });
      entry.tooltip = tooltip;
    }
    // A stack in one building counts how many of its radios can answer.
    if (entry.marker.options.assetOffline !== (status === "offline")) {
      entry.marker.options.assetOffline = status === "offline";
      if (entry.layer === "cluster") deviceClusterLayer.refreshClusters(entry.marker);
    }
    // An SOS is never filtered away, nor is the radio being tracked. Whichever
    // slice the operator is looking at, those are the pins they came for.
    const shows = FILTER_SHOWS[filterRef.current];
    const hidden = !tracked && status !== "sos" && shows && !shows.has(status);
    // A radio in alarm never clusters - it would disappear into a count at the
    // exact moment someone needs to see where it is. Moving and tracked radios
    // stay out too: a marker sliding inside a cluster group is re-clustered on
    // every frame.
    const want = hidden ? null : status === "sos" ? "alert" : tracked || status === "moving" ? "moving" : "cluster";
    if (entry.layer !== want) {
      if (entry.layer) removePin(layerFor[entry.layer], entry.marker);
      if (want) layerFor[want].addLayer(entry.marker);
      entry.layer = want;
    }
    entry.ageSec = ageSec;
    entry.stale = stale;
    entry.status = status;
  }, [radioTracks]);

  // The trail behind the tracked radio, cut off where the pin is so it never
  // runs ahead of it, and fading with age: the last few minutes are what the
  // operator acts on, the start of the window is context.
  const drawTrail = useCallback((renderT, pin) => {
    const { trailLayer } = layersRef.current;
    if (!trailLayer) return;
    trailLayer.clearLayers();
    if (!trackRef.current.id) return;
    const points = (trailRef.current || []).filter((point) => new Date(point.observed_at).getTime() <= renderT);
    if (pin) points.push({ lat: pin.lat, lon: pin.lng, observed_at: new Date(renderT).toISOString() });
    const segments = trailSegments(points);
    const times = segments.flat().map((point) => point.ms);
    if (!times.length) return;
    const oldest = Math.min(...times);
    const span = Math.max(1, renderT - oldest);
    for (const segment of segments) {
      for (let index = 1; index < segment.length; index += 1) {
        const from = segment[index - 1];
        const to = segment[index];
        const recency = 1 - Math.min(1, (renderT - to.ms) / span);
        L.polyline(
          [
            [from.lat, from.lon],
            [to.lat, to.lon],
          ],
          { color: "#00cc66", weight: 4, opacity: 0.15 + 0.75 * recency, lineCap: "round", interactive: false },
        ).addTo(trailLayer);
      }
    }
  }, []);

  // The animation loop. Every frame, each radio with streamed points is placed
  // where playback says it was; a few times a second, everything else about it
  // is brought up to date.
  useEffect(() => {
    let lastVisual = 0;
    let lastTrail = 0;
    let latestDot = null;
    let lastReport = "";
    let lastStatusAt = 0;
    let lastStatuses = "";
    const frame = () => {
      frameRef.current = window.requestAnimationFrame(frame);
      const map = mapRef.current;
      const { trailLayer } = layersRef.current;
      if (!map || !trailLayer) return;
      const now = Date.now();
      const visual = now - lastVisual >= RADIO_VISUAL_MS;
      if (visual) lastVisual = now;
      const trackedId = trackRef.current.id;
      let trackedState = null;

      for (const [uid, entry] of radiosRef.current) {
        const track = radioTracks?.current?.get(uid);
        let sample = null;
        let renderT = now;
        if (track?.path.length) {
          // An alarm is never shown late: an SOS radio sits on its newest point.
          if (entry.sos) {
            const newest = newestPoint(track);
            sample = { lat: newest.lat, lon: newest.lon, moving: false, bearing: null, speedMs: 0 };
          } else {
            renderT = now - track.delayMs;
            sample = sampleTrack(track, renderT);
          }
        }
        entry.motion = sample;
        const target = sample ? { lat: sample.lat, lon: sample.lon } : entry.fix;
        if (target) {
          const current = entry.marker.getLatLng();
          // Clustered pins are only nudged on the slower tick, and only for a
          // real move: each move inside a cluster group re-clusters it.
          const moved = distanceMetres({ lat: current.lat, lon: current.lng }, target);
          if (entry.layer === "cluster" ? visual && moved > 2 : moved > 0.05) entry.marker.setLatLng([target.lat, target.lon]);
        }
        if (visual) refreshRadio(uid, entry, now);
        if (uid === trackedId) {
          keepTrackedInView(entry.marker.getLatLng());
          trackedState = { entry, track, renderT };
        }
      }

      if (!visual) return;
      // A faint dot on the newest point received, ahead of the pin: playback
      // shows the path, the dot shows the latest truth.
      const newest = trackedState?.track && !trackedState.entry.sos ? newestPoint(trackedState.track) : null;
      if (newest) {
        if (!latestDot) {
          latestDot = L.circleMarker([newest.lat, newest.lon], {
            radius: 5,
            color: "#ffffff",
            weight: 1.5,
            fillColor: "#00cc66",
            fillOpacity: 0.35,
            opacity: 0.6,
            interactive: false,
          }).addTo(map);
        } else latestDot.setLatLng([newest.lat, newest.lon]);
      } else if (latestDot) {
        latestDot.remove();
        latestDot = null;
      }
      if (trackedState ? now - lastTrail >= TRAIL_REDRAW_MS : lastTrail) {
        lastTrail = trackedState ? now : 0;
        drawTrail(trackedState?.renderT ?? now, trackedState?.entry.marker.getLatLng());
      }

      // The page's counts bar and fleet list, once a second at most and only
      // when something they show has changed.
      const reportStatuses = callbacksRef.current.onRadioStatuses;
      if (reportStatuses && now - lastStatusAt >= 1000) {
        lastStatusAt = now;
        const statuses = {};
        for (const [uid, entry] of radiosRef.current) {
          if (!entry.status) continue;
          const moving = entry.status === "moving";
          statuses[uid] = {
            status: entry.status,
            speedMs: moving ? Math.round((entry.motion?.speedMs ?? 0) * 10) / 10 : 0,
            bearing: moving && entry.motion?.bearing != null ? Math.round(entry.motion.bearing / 5) * 5 : null,
            ageSec: entry.ageSec == null ? null : entry.ageSec < 60 ? Math.round(entry.ageSec / 5) * 5 : Math.round(entry.ageSec / 60) * 60,
          };
        }
        const key = JSON.stringify(statuses);
        if (key !== lastStatuses) {
          lastStatuses = key;
          reportStatuses(statuses);
        }
      }

      const report = callbacksRef.current.onTrackedMotion;
      if (report) {
        const { entry, track } = trackedState || {};
        const next = entry
          ? {
              present: true,
              moving: Boolean(entry.motion?.moving) && !entry.stale,
              bearing: entry.motion?.bearing == null ? null : Math.round(entry.motion.bearing / 5) * 5,
              speedMs: entry.motion?.speedMs == null ? null : Math.round(entry.motion.speedMs * 10) / 10,
              seenMs: track?.lastArrivalMs ?? entry.fix?.seenMs ?? null,
              behindSec: track?.path.length && !entry.sos ? Math.round(track.delayMs / 1000) : 0,
            }
          : { present: false };
        const key = JSON.stringify(next);
        if (key !== lastReport) {
          lastReport = key;
          report(next);
        }
      }
    };
    frameRef.current = window.requestAnimationFrame(frame);
    return () => {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      latestDot?.remove();
    };
  }, [radioTracks, refreshRadio, keepTrackedInView, drawTrail]);

  // Which radios are on the map, and what is known about each from the
  // registry and the polled positions. Movement is the animation loop's job.
  useEffect(() => {
    const map = mapRef.current;
    const { deviceClusterLayer, deviceAlertLayer, deviceMovingLayer } = layersRef.current;
    if (!map || !deviceClusterLayer || !deviceAlertLayer || !deviceMovingLayer) return;
    const layerFor = { cluster: deviceClusterLayer, alert: deviceAlertLayer, moving: deviceMovingLayer };
    const radios = radiosRef.current;
    const registry = new Map(devices.map((device) => [String(device.device_id), device]));
    const now = Date.now();
    const seen = new Set();

    for (const location of locations) {
      const uid = String(location.Uid);
      const fix = fixFromLocation(location);
      if (!fix) continue;
      const sos = location.processStatus === 1;
      const row = registry.get(uid);
      // A radio the network is not hearing from goes grey. An SOS stays red
      // whatever the handset's last check-in.
      const offline = !sos && !row?.pocstars_online;
      seen.add(uid);

      let entry = radios.get(uid);
      if (!entry) {
        // Hover identifies the pin; clicking opens the radio console, which can
        // do what a popup built from an HTML string never could - call the
        // handset, talk to it, message it - and leaves the map visible while it
        // is open.
        const marker = L.marker([fix.lat, fix.lon]);
        entry = { marker, layer: null, iconKey: null, tooltip: null, motion: null };
        marker.on("click", () => callbacksRef.current.onRadioSelect?.(entry.row || { device_id: uid }));
        radios.set(uid, entry);
      }
      Object.assign(entry, {
        fix,
        row,
        sos,
        offline,
        label: row?.name || uid,
        glyph: deviceTypeGlyph(row?.device_type),
      });
      refreshRadio(uid, entry, now);
    }

    for (const [uid, entry] of radios) {
      if (seen.has(uid)) continue;
      if (entry.layer) removePin(layerFor[entry.layer], entry.marker);
      radios.delete(uid);
    }
  }, [devices, locations, radioFilter, trackedRadioId, refreshRadio]);

  // Replay: the whole route faint, the part already travelled bright, a pin
  // where the radio was at the replay time, and a ring at each stop sized by
  // how long it stayed.
  const replayRef = useRef({ marker: null, progress: null });
  useEffect(() => {
    const map = mapRef.current;
    const { replayLayer } = layersRef.current;
    if (!map || !replayLayer) return;
    replayLayer.clearLayers();
    replayRef.current = { marker: null, progress: null };
    if (!replay?.path.length) return;
    const pieces = [];
    let piece = [];
    for (const point of replay.path) {
      if (point.jump && piece.length) {
        pieces.push(piece);
        piece = [];
      }
      piece.push([point.lat, point.lon]);
    }
    pieces.push(piece);
    L.polyline(pieces, { color: "#a78bfa", weight: 3, opacity: 0.35, dashArray: "4 6", interactive: false }).addTo(replayLayer);
    const time = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    for (const stop of replay.stops) {
      L.circleMarker([stop.lat, stop.lon], {
        radius: Math.min(16, 6 + stop.durationSec / 300),
        color: "#c4b5fd",
        weight: 1.5,
        fillColor: "#7c3aed",
        fillOpacity: 0.25,
      })
        .bindTooltip(`Stopped ${Math.round(stop.durationSec / 60)} min · ${time(stop.from)}–${time(stop.to)}`, { direction: "top" })
        .addTo(replayLayer);
    }
    replayRef.current.progress = L.polyline([], { color: "#c4b5fd", weight: 4, opacity: 0.95, interactive: false }).addTo(replayLayer);
    replayRef.current.marker = L.marker([replay.path[0].lat, replay.path[0].lon], {
      icon: L.divIcon({ className: "", html: '<div class="replay-pin"><div class="replay-heading"></div></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      zIndexOffset: 2000,
      interactive: false,
    }).addTo(replayLayer);
    // Framed clear of the fleet panel on the left, the replay bar on top and
    // the key on the right, so no part of the route starts out hidden.
    map.fitBounds(L.latLngBounds(replay.path.map((point) => [point.lat, point.lon])), {
      paddingTopLeft: [360, 180],
      paddingBottomRight: [250, 60],
      maxZoom: 18,
    });
  }, [replay]);

  useEffect(() => {
    const { marker, progress } = replayRef.current;
    if (!replay?.path.length || !marker || replayTime == null) return;
    const here = replayPosition(replay, replayTime);
    if (!here) return;
    marker.setLatLng([here.lat, here.lon]);
    const heading = marker.getElement()?.querySelector(".replay-heading");
    if (heading) {
      heading.style.display = here.moving ? "block" : "none";
      if (here.moving) heading.style.transform = `rotate(${Math.round(here.bearing)}deg)`;
    }
    const travelled = replay.path.filter((point) => point.t <= replayTime).map((point) => [point.lat, point.lon]);
    travelled.push([here.lat, here.lon]);
    progress.setLatLngs(travelled);
  }, [replay, replayTime]);

  // Patrol coverage: every square a radio passed through in the window, bright
  // where the visit was recent and fading with time. The gaps are the point -
  // they are the places nobody has been.
  useEffect(() => {
    const { coverageLayer, coverageRenderer } = layersRef.current;
    if (!coverageLayer) return;
    coverageLayer.clearLayers();
    if (!coverage?.cells?.length) return;
    const now = Date.now();
    const span = coverage.hours * 3600_000;
    const time = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    for (const cell of coverage.cells) {
      const recency = 1 - Math.min(1, (now - cell.lastAt) / span);
      L.rectangle(
        [
          [cell.lat, cell.lon],
          [cell.lat + coverage.cellDeg, cell.lon + coverage.cellDeg],
        ],
        {
          renderer: coverageRenderer,
          stroke: false,
          fillColor: recency > 0.75 ? "#22c55e" : recency > 0.4 ? "#84cc16" : "#eab308",
          fillOpacity: 0.12 + 0.4 * recency,
        },
      )
        .bindTooltip(`Last visit ${time(cell.lastAt)} · ${cell.radios} radio${cell.radios === 1 ? "" : "s"}`, { sticky: true })
        .addTo(coverageLayer);
    }
  }, [coverage]);

  // Starting to track, or "Re-centre", brings the radio into view at once.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !trackedRadioId || trackPaused) return;
    const entry = radiosRef.current.get(String(trackedRadioId));
    if (!entry) return;
    // Hold off the edge-panning until the flight lands, or it cuts it short.
    trackRef.current.lastCheck = Date.now() + 1300;
    map.flyTo(entry.marker.getLatLng(), Math.min(Math.max(map.getZoom(), TRACK_ZOOM_MIN), TRACK_ZOOM_MAX), { duration: 1.2 });
  }, [trackedRadioId, trackPaused]);

  useEffect(() => {
    const map = mapRef.current;
    const { sosLayer } = layersRef.current;
    if (!map || !sosLayer) return;
    sosLayer.clearLayers();

    for (const alert of sosAlerts) {
      if (Number(alert.status) >= 2) continue;
      const lat = Number(alert.map_lat ?? alert.location_lat);
      const lon = Number(alert.map_lon ?? alert.location_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const label = alert.asset_name || alert.dev_name || alert.device_name || `Device ${alert.device_id}`;
      const icon = L.divIcon({
        className: "",
        html: `<div class="device-pin sos"><i class="fas fa-triangle-exclamation"></i></div><div class="device-label sos">${escapeHtml(label)}</div>`,
        iconSize: [30, 46],
        iconAnchor: [15, 15],
      });
      L.marker([lat, lon], { icon, zIndexOffset: 1000 }).bindPopup(sosPopup(alert)).addTo(sosLayer);
    }
  }, [sosAlerts]);

  useEffect(() => {
    const map = mapRef.current;
    const { droneLayer } = layersRef.current;
    if (!map || !droneLayer) return;
    droneLayer.clearLayers();
    const clustered = [];

    for (const drone of drones) {
      const lat = Number(drone.lat);
      const lon = Number(drone.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const offline = !drone.online;
      const heading = Number(drone.heading_deg);
      const rotation = Number.isFinite(heading) ? heading : 0;
      const label = drone.name || `Drone ${drone.sysid}`;
      const icon = L.divIcon({
        className: "",
        html: `<div class="drone-pin ${offline ? "offline" : ""}"><span class="drone-glyph" style="transform:rotate(${rotation}deg)">${DRONE_SVG}</span></div><div class="device-label drone ${offline ? "offline" : ""}">${escapeHtml(label)}</div>`,
        iconSize: [28, 44],
        iconAnchor: [14, 14],
      });
      // assetOffline lets a cluster of entirely offline drones dim itself.
      clustered.push(
        L.marker([lat, lon], { icon, zIndexOffset: 500, assetOffline: offline })
          .bindPopup(dronePopup(drone)),
      );
    }
    droneLayer.addLayers(clustered);
  }, [drones]);

  useEffect(() => {
    const map = mapRef.current;
    const { incidentLayer, heatLayer, deviceLayer, sosLayer, droneLayer, geofenceLayer } = layersRef.current;
    if (!map || !incidentLayer || !heatLayer || !deviceLayer || !sosLayer || !droneLayer || !geofenceLayer) return;
    const syncLayer = (layer, enabled) => {
      if (enabled && !map.hasLayer(layer)) map.addLayer(layer);
      if (!enabled && map.hasLayer(layer)) map.removeLayer(layer);
    };
    syncLayer(incidentLayer, activeLayers.live);
    syncLayer(heatLayer, activeLayers.heat);
    syncLayer(deviceLayer, activeLayers.devices);
    syncLayer(droneLayer, activeLayers.drones);
    syncLayer(geofenceLayer, activeLayers.fences);
    syncLayer(sosLayer, true);
  }, [activeLayers]);

  // The responding vehicle and where it is going. A straight line on purpose -
  // there is no routing engine behind this, and drawing a road route we cannot
  // actually compute would be a confident lie about the last few kilometres.
  useEffect(() => {
    const { followLayer } = layersRef.current;
    if (!followLayer) return;
    followLayer.clearLayers();
    if (!followLine?.from || !followLine?.to) return;
    const from = [followLine.from.lat, followLine.from.lon];
    const to = [followLine.to.lat, followLine.to.lon];
    L.polyline([from, to], {
      color: "#ff4444",
      weight: 2.5,
      opacity: 0.9,
      dashArray: "9 7",
    }).addTo(followLayer);
    L.circleMarker(from, {
      radius: 6,
      color: "#ff4444",
      weight: 2,
      fillColor: "#ff4444",
      fillOpacity: 0.55,
    })
      .bindTooltip("You", { direction: "top", offset: [0, -8] })
      .addTo(followLayer);
  }, [followLine]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusTarget) return;
    const lat = Number(focusTarget.lat);
    const lon = Number(focusTarget.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    map.flyTo([lat, lon], focusTarget.zoom ?? 13, { duration: 1.4 });
    if (focusTarget.popupHtml) {
      L.popup({ closeButton: false, className: "tour-popup" })
        .setLatLng([lat, lon])
        .setContent(focusTarget.popupHtml)
        .openOn(map);
    }
  }, [focusTarget]);

  return <div ref={mapNode} className="ops-map" />;
}
