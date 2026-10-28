import L from "leaflet";
import "leaflet.heat";
import "leaflet.markercluster";
import { useCallback, useEffect, useRef, useState } from "react";
import { DARK_TILES, IMAGERY_LABEL_TILES, LABELLED_BASEMAPS, SATELLITE_TILES } from "../lib/basemaps";
import { deviceTypeGlyph, escapeHtml, severityColors, severityLabels, typeIcons } from "../lib/domain";
import { advanceMotion, fixAgeSec, fixFromLocation, formatAge, isStale, trailSegments } from "../lib/radio-motion";

// The radio fleet is mostly switched-off handsets at any hour, so the map
// reads as a field of grey pins unless an operator can narrow it to the ones
// that can actually answer a call - or to the ones that have gone quiet.
const RADIO_FILTERS = [
  { key: "all", label: "ALL", title: "Show every radio" },
  { key: "online", label: "ONLINE", title: "Only radios the network is hearing from" },
  { key: "offline", label: "OFFLINE", title: "Only radios that are offline" },
];

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
    const offline = cluster.getAllChildMarkers().every((marker) => marker.options.assetOffline);
    return L.divIcon({
      className: "",
      html: `<div class="asset-cluster ${kind}${offline ? " offline" : ""}" style="width:${size}px;height:${size}px">
               <span class="asset-cluster-glyph">${glyph}</span>
               <span class="asset-cluster-count">${count}</span>
             </div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  };
}

function assetClusterGroup(kind, glyph) {
  return L.markerClusterGroup({
    maxClusterRadius: 44,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    // Individual assets from here in. Operators zoom in to work a specific
    // area, and at that point they need the pins and their labels, not a count.
    disableClusteringAtZoom: 16,
    chunkedLoading: true,
    iconCreateFunction: assetClusterIcon(kind, glyph),
  });
}

// Once a fix is this old the pin says so in its label, not only in the tooltip.
function radioIcon({ label, glyph, sos, offline, stale, moving, bearing, tracked, ageSec }) {
  const tone = `${sos ? "sos" : ""} ${offline ? "offline" : ""} ${stale ? "stale" : ""}`;
  const heading =
    moving && Number.isFinite(bearing)
      ? `<div class="device-heading" style="transform:rotate(${Math.round(bearing)}deg)"></div>`
      : "";
  const age = stale ? ` · ${escapeHtml(formatAge(ageSec))}` : "";
  return L.divIcon({
    className: "",
    // A vehicle tracker and a handheld should not look identical on a map.
    // An SOS keeps the alarm glyph whatever the device is - what it is
    // matters less than that it is shouting.
    html: `${heading}<div class="device-pin ${tone} ${tracked ? "tracked" : ""}">${sos ? '<i class="fas fa-triangle-exclamation"></i>' : glyph}</div><div class="device-label ${tone}">${escapeHtml(label)}${age}</div>`,
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
// The staleness label and the arrow must age even when no new data arrives.
const RADIO_RECHECK_MS = 15_000;

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
  onTrackRadio,
  onTrackPause,
  onTrackedMotion,
}) {
  const mapNode = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef({});
  const radioFilterRef = useRef(null);
  const [radioFilter, setRadioFilter] = useState("all");
  const [radioClock, setRadioClock] = useState(0);
  // One entry per radio on the map, kept across refreshes so a pin can move
  // rather than be torn down and redrawn: { marker, motion, layer, iconKey, row }.
  const radiosRef = useRef(new Map());
  const glidesRef = useRef(new Map());
  const glideFrameRef = useRef(null);
  const trackRef = useRef({ id: null, paused: false, lastCheck: 0 });
  const callbacksRef = useRef({});
  callbacksRef.current = { onRadioSelect, onTrackRadio, onTrackPause, onTrackedMotion };
  trackRef.current.id = trackedRadioId;
  trackRef.current.paused = trackPaused;

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;

    const map = L.map(mapNode.current, {
      zoomControl: false,
      maxBounds: NIGERIA_BOUNDS.pad(0.2),
      maxBoundsViscosity: 0.85,
      maxZoom: 21,
    }).setView(NIGERIA_CENTER, 6);

    const baseLayers = {
      dark: L.tileLayer(DARK_TILES.url, DARK_TILES.options),
      streets: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap",
        maxZoom: 21,
        maxNativeZoom: 19,
      }),
      satellite: L.tileLayer(SATELLITE_TILES.url, SATELLITE_TILES.options),
    };
    const labelLayer = L.tileLayer(IMAGERY_LABEL_TILES.url, IMAGERY_LABEL_TILES.options);

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
    const sosLayer = L.layerGroup();
    const droneLayer = assetClusterGroup("drone", DRONE_SVG);
    const geofenceLayer = L.layerGroup();
    const followLayer = L.layerGroup();

    baseLayers.satellite.addTo(map);
    labelLayer.addTo(map);
    incidentLayer.addTo(map);
    geofenceLayer.addTo(map);
    followLayer.addTo(map);
    trailLayer.addTo(map);
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

    const radioFilterControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd() {
        const container = L.DomUtil.create("div", "leaflet-bar map-filter-bar");
        for (const option of RADIO_FILTERS) {
          const button = L.DomUtil.create("button", "map-utility-btn map-filter-btn", container);
          button.type = "button";
          button.textContent = option.label;
          button.title = option.title;
          button.dataset.filter = option.key;
          L.DomEvent.on(button, "click", (event) => {
            L.DomEvent.stop(event);
            setRadioFilter(option.key);
          });
        }
        L.DomEvent.disableClickPropagation(container);
        radioFilterRef.current = container;
        return container;
      },
    });
    map.addControl(new radioFilterControl());

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

    const glides = glidesRef.current;
    const radios = radiosRef.current;
    return () => {
      if (glideFrameRef.current) window.cancelAnimationFrame(glideFrameRef.current);
      glideFrameRef.current = null;
      glides.clear();
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
    // Resolved once, so an unknown key falls back to satellite *and* its labels
    // rather than landing on bare imagery with nothing named on it.
    const key = layers.baseLayers[basemap] ? basemap : "satellite";
    const next = layers.baseLayers[key];
    if (layers.activeBase !== next) {
      if (layers.activeBase) map.removeLayer(layers.activeBase);
      next.addTo(map);
      layers.activeBase = next;
      next.bringToBack();
    }
    // Labels ride above the imagery but stay inside the tile pane, so every
    // marker, cluster and fence still draws over them.
    const wantsLabels = LABELLED_BASEMAPS.has(key);
    if (wantsLabels && !map.hasLayer(layers.labelLayer)) layers.labelLayer.addTo(map);
    else if (!wantsLabels && map.hasLayer(layers.labelLayer)) map.removeLayer(layers.labelLayer);
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

  useEffect(() => {
    const timer = window.setInterval(() => setRadioClock((value) => value + 1), RADIO_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const keepTrackedInView = useCallback((latlng, force = false) => {
    const map = mapRef.current;
    const track = trackRef.current;
    if (!map || !track.id || track.paused) return;
    const now = Date.now();
    if (!force && now - track.lastCheck < 500) return;
    track.lastCheck = now;
    if (force || !map.getBounds().pad(TRACK_INNER_PAD).contains(latlng)) {
      map.panTo(latlng, { animate: true, duration: 0.8 });
    }
  }, []);

  // One animation loop for every gliding radio. Linear on purpose: a constant
  // pace between fixes is what the radio most plausibly did.
  const runGlides = useCallback(() => {
    const now = window.performance.now();
    for (const [uid, glide] of glidesRef.current) {
      const t = Math.min(1, (now - glide.start) / glide.duration);
      const lat = glide.from.lat + (glide.to.lat - glide.from.lat) * t;
      const lng = glide.from.lng + (glide.to.lng - glide.from.lng) * t;
      glide.marker.setLatLng([lat, lng]);
      if (uid === trackRef.current.id) keepTrackedInView(L.latLng(lat, lng));
      if (t >= 1) glidesRef.current.delete(uid);
    }
    glideFrameRef.current = glidesRef.current.size ? window.requestAnimationFrame(runGlides) : null;
  }, [keepTrackedInView]);

  useEffect(() => {
    const map = mapRef.current;
    const { deviceClusterLayer, deviceAlertLayer, deviceMovingLayer } = layersRef.current;
    if (!map || !deviceClusterLayer || !deviceAlertLayer || !deviceMovingLayer) return;
    const layerFor = { cluster: deviceClusterLayer, alert: deviceAlertLayer, moving: deviceMovingLayer };
    const radios = radiosRef.current;
    const registry = new Map(devices.map((device) => [String(device.device_id), device]));
    const now = Date.now();
    const seen = new Set();
    const toCluster = [];

    const detach = (entry) => {
      if (entry.layer === "cluster") deviceClusterLayer.removeLayer(entry.marker);
      else layerFor[entry.layer]?.removeLayer(entry.marker);
      entry.layer = null;
    };

    for (const location of locations) {
      const uid = String(location.Uid);
      const fix = fixFromLocation(location);
      if (!fix) continue;
      const sos = location.processStatus === 1;
      const row = registry.get(uid);
      const tracked = uid === trackedRadioId;
      // A radio the network is not hearing from goes grey, matching the
      // tooltip below. An SOS stays red whatever the handset's last check-in.
      const offline = !sos && !row?.pocstars_online;
      // An SOS is never filtered away, nor is the radio being tracked. Whichever
      // slice the operator is looking at, those are the pins they came for.
      if (!sos && !tracked) {
        if ((radioFilter === "online" && offline) || (radioFilter === "offline" && !offline)) continue;
      }
      seen.add(uid);

      let entry = radios.get(uid);
      const { state: motion, action, durationMs } = advanceMotion(entry?.motion, fix, now);
      if (!entry) {
        // Hover identifies the pin; clicking opens the radio console, which can
        // do what a popup built from an HTML string never could - call the
        // handset, talk to it, message it - and leaves the map visible while it
        // is open.
        const marker = L.marker([motion.lat, motion.lon]);
        entry = { marker, motion, layer: null, iconKey: null, tooltip: null, row };
        marker.on("click", () =>
          callbacksRef.current.onRadioSelect?.(entry.row || { device_id: uid }),
        );
        radios.set(uid, entry);
      }
      entry.motion = motion;
      entry.row = row;

      // Stale only says something about a radio that should be reporting.
      const ageSec = fixAgeSec(fix, now);
      const stale = !sos && !offline && isStale(fix, now);
      const label = row?.name || uid;
      const glyph = deviceTypeGlyph(row?.device_type);
      const moving = motion.moving && !stale;
      const iconKey = [label, glyph, sos, offline, stale, moving, moving ? Math.round(motion.bearing / 5) : "", tracked, stale ? formatAge(ageSec) : ""].join("|");
      if (iconKey !== entry.iconKey) {
        entry.marker.setIcon(radioIcon({ label, glyph, sos, offline, stale, moving, bearing: motion.bearing, tracked, ageSec }));
        entry.marker.setZIndexOffset(sos ? 1000 : tracked ? 900 : 0);
        entry.iconKey = iconKey;
      }
      const tooltip = `${escapeHtml(label)}${row?.pocstars_online ? "" : " · offline"}${stale ? ` · no new fix for ${escapeHtml(formatAge(ageSec))}` : ""}`;
      if (tooltip !== entry.tooltip) {
        if (entry.marker.getTooltip()) entry.marker.setTooltipContent(tooltip);
        else entry.marker.bindTooltip(tooltip, { direction: "top", offset: [0, -14], opacity: 0.95 });
        entry.tooltip = tooltip;
      }

      // A radio in alarm never clusters - it would disappear into a count at
      // the exact moment someone needs to see where it is.
      const gliding = glidesRef.current.has(uid) || action === "glide";
      const want = sos ? "alert" : tracked || moving || gliding ? "moving" : "cluster";
      if (entry.layer !== want) {
        if (entry.layer) detach(entry);
        if (want === "cluster") toCluster.push(entry.marker);
        else layerFor[want].addLayer(entry.marker);
        entry.layer = want;
      }

      if (action === "glide") {
        glidesRef.current.set(uid, {
          marker: entry.marker,
          from: entry.marker.getLatLng(),
          to: L.latLng(motion.lat, motion.lon),
          start: window.performance.now(),
          duration: durationMs,
        });
      } else if (action === "jump") {
        glidesRef.current.delete(uid);
        entry.marker.setLatLng([motion.lat, motion.lon]);
        if (tracked) keepTrackedInView(entry.marker.getLatLng());
      }
    }

    for (const [uid, entry] of radios) {
      if (seen.has(uid)) continue;
      glidesRef.current.delete(uid);
      detach(entry);
      radios.delete(uid);
    }
    // One bulk insert rather than one reflow per radio.
    if (toCluster.length) deviceClusterLayer.addLayers(toCluster);
    if (glidesRef.current.size && !glideFrameRef.current) {
      glideFrameRef.current = window.requestAnimationFrame(runGlides);
    }

    const trackedEntry = trackedRadioId ? radios.get(String(trackedRadioId)) : null;
    const { onTrackedMotion: report } = callbacksRef.current;
    if (report) {
      const motion = trackedEntry?.motion;
      report(
        motion
          ? {
              present: true,
              moving: motion.moving,
              bearing: motion.bearing,
              speedMs: motion.speedMs,
              seenMs: motion.lastSeenMs,
            }
          : { present: false },
      );
    }
  }, [devices, locations, radioFilter, trackedRadioId, radioClock, runGlides, keepTrackedInView]);

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

  // The trail fades with age: the last few minutes are what the operator acts
  // on, the start of the window is context.
  useEffect(() => {
    const { trailLayer } = layersRef.current;
    if (!trailLayer) return;
    trailLayer.clearLayers();
    if (!trackedRadioId) return;
    const segments = trailSegments(trail);
    const times = segments.flat().map((point) => point.ms);
    if (!times.length) return;
    const oldest = Math.min(...times);
    const span = Math.max(1, Date.now() - oldest);
    for (const segment of segments) {
      for (let index = 1; index < segment.length; index += 1) {
        const from = segment[index - 1];
        const to = segment[index];
        const recency = 1 - Math.min(1, (Date.now() - to.ms) / span);
        L.polyline(
          [
            [from.lat, from.lon],
            [to.lat, to.lon],
          ],
          { color: "#00cc66", weight: 4, opacity: 0.15 + 0.75 * recency, lineCap: "round", interactive: false },
        ).addTo(trailLayer);
      }
    }
  }, [trail, trackedRadioId]);

  // The bar is only meaningful while radios are on the map, and its buttons
  // have to show which slice is live - neither is something Leaflet's control
  // knows, since it is built once outside React.
  useEffect(() => {
    const container = radioFilterRef.current;
    if (!container) return;
    container.classList.toggle("map-filter-bar-off", !activeLayers.devices);
    for (const button of container.querySelectorAll("button")) {
      button.classList.toggle("active", button.dataset.filter === radioFilter);
    }
  }, [radioFilter, activeLayers.devices]);

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
