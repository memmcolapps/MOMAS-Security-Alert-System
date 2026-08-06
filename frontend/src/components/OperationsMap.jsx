import L from "leaflet";
import "leaflet.heat";
import "leaflet.markercluster";
import { useEffect, useRef } from "react";
import { escapeHtml, severityColors, severityLabels, typeIcons } from "../lib/domain";

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
}) {
  const mapNode = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef({});

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;

    const map = L.map(mapNode.current, {
      zoomControl: false,
      maxBounds: NIGERIA_BOUNDS.pad(0.2),
      maxBoundsViscosity: 0.85,
      maxZoom: 21,
    }).setView(NIGERIA_CENTER, 6);

    const baseLayers = {
      dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: "&copy; OpenStreetMap &copy; CARTO",
        maxZoom: 21,
        maxNativeZoom: 20,
      }),
      streets: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap",
        maxZoom: 21,
        maxNativeZoom: 19,
      }),
      satellite: L.tileLayer(
        "https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { attribution: "Tiles &copy; Esri Clarity", maxZoom: 21, maxNativeZoom: 19 },
      ),
    };

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
    const deviceLayer = L.layerGroup([deviceClusterLayer, deviceAlertLayer]);
    const sosLayer = L.layerGroup();
    const droneLayer = assetClusterGroup("drone", DRONE_SVG);
    const geofenceLayer = L.layerGroup();
    const followLayer = L.layerGroup();

    baseLayers.dark.addTo(map);
    incidentLayer.addTo(map);
    geofenceLayer.addTo(map);
    followLayer.addTo(map);
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
      activeBase: baseLayers.dark,
      incidentLayer,
      heatLayer,
      deviceLayer,
      deviceClusterLayer,
      deviceAlertLayer,
      sosLayer,
      droneLayer,
      geofenceLayer,
      followLayer,
    };
    mapRef.current = map;

    return () => {
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
    const next = layers.baseLayers[basemap] || layers.baseLayers.dark;
    if (layers.activeBase !== next) {
      if (layers.activeBase) map.removeLayer(layers.activeBase);
      next.addTo(map);
      layers.activeBase = next;
      next.bringToBack();
    }
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
    const map = mapRef.current;
    const { deviceClusterLayer, deviceAlertLayer } = layersRef.current;
    if (!map || !deviceClusterLayer || !deviceAlertLayer) return;
    deviceClusterLayer.clearLayers();
    deviceAlertLayer.clearLayers();
    const registry = new Map(devices.map((device) => [String(device.device_id), device]));
    const clustered = [];

    for (const location of locations) {
      const lat = Number(location.Lat);
      const lon = Number(location.Lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const sos = location.processStatus === 1;
      const row = registry.get(String(location.Uid));
      const label = row?.name || location.Uid;
      const icon = L.divIcon({
        className: "",
        html: `<div class="device-pin ${sos ? "sos" : ""}"><i class="fas fa-walkie-talkie"></i></div><div class="device-label ${sos ? "sos" : ""}">${escapeHtml(label)}</div>`,
        iconSize: [26, 42],
        iconAnchor: [13, 13],
      });
      // Hover identifies the pin; clicking opens the radio console, which can
      // do what a popup built from an HTML string never could - call the
      // handset, talk to it, message it - and leaves the map visible while it
      // is open.
      const marker = L.marker([lat, lon], { icon }).bindTooltip(
        `${escapeHtml(label)}${row?.pocstars_online ? "" : " · offline"}`,
        { direction: "top", offset: [0, -14], opacity: 0.95 },
      );
      marker.on("click", () => onRadioSelect?.(row || { device_id: String(location.Uid) }));
      if (sos) marker.addTo(deviceAlertLayer);
      else clustered.push(marker);
    }
    // One bulk insert rather than one reflow per radio.
    deviceClusterLayer.addLayers(clustered);
  }, [devices, locations, onRadioSelect]);

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
