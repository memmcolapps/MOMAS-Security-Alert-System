import L from "leaflet";
import "leaflet.heat";
import "leaflet.markercluster";
import { useEffect, useRef } from "react";
import { escapeHtml, severityColors, severityLabels, typeIcons } from "../lib/domain";

const NIGERIA_BOUNDS = L.latLngBounds([4.3, 2.7], [13.9, 14.7]);
const NIGERIA_CENTER = [9.0, 8.5];

function incidentPopup(incident) {
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

function devicePopup(device, registry) {
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

export function OperationsMap({
  incidents,
  devices,
  locations,
  activeLayers,
  basemap,
  onIncidentFocus,
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
    }).setView(NIGERIA_CENTER, 6);

    const baseLayers = {
      dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: "&copy; OpenStreetMap &copy; CARTO",
      }),
      streets: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap",
      }),
      satellite: L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { attribution: "Tiles &copy; Esri" },
      ),
    };

    const incidentLayer = L.markerClusterGroup({ maxClusterRadius: 46 });
    const heatLayer = L.heatLayer([], {
      radius: 28,
      blur: 22,
      maxZoom: 10,
      gradient: { 0.2: "#3399ff", 0.45: "#00bbaa", 0.7: "#ff6600", 1: "#ffb300" },
    });
    const deviceLayer = L.layerGroup();

    baseLayers.dark.addTo(map);
    incidentLayer.addTo(map);
    deviceLayer.addTo(map);
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

    layersRef.current = { baseLayers, activeBase: baseLayers.dark, incidentLayer, heatLayer, deviceLayer };
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
      L.circle([lat, lon], {
        radius: incident.severity === "RED" ? 28000 : 16000,
        color,
        fillColor: color,
        fillOpacity: 0.08,
        weight: 1,
      }).addTo(incidentLayer);
    }

    heatLayer.setLatLngs(heatPoints);
  }, [incidents, onIncidentFocus]);

  useEffect(() => {
    const map = mapRef.current;
    const { deviceLayer } = layersRef.current;
    if (!map || !deviceLayer) return;
    deviceLayer.clearLayers();
    const registry = new Map(devices.map((device) => [String(device.device_id), device]));

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
      L.marker([lat, lon], { icon }).bindPopup(devicePopup(location, registry)).addTo(deviceLayer);
    }
  }, [devices, locations]);

  useEffect(() => {
    const map = mapRef.current;
    const { incidentLayer, heatLayer, deviceLayer } = layersRef.current;
    if (!map || !incidentLayer || !heatLayer || !deviceLayer) return;
    const syncLayer = (layer, enabled) => {
      if (enabled && !map.hasLayer(layer)) map.addLayer(layer);
      if (!enabled && map.hasLayer(layer)) map.removeLayer(layer);
    };
    syncLayer(incidentLayer, activeLayers.live);
    syncLayer(heatLayer, activeLayers.heat);
    syncLayer(deviceLayer, activeLayers.devices);
  }, [activeLayers]);

  return <div ref={mapNode} className="ops-map" />;
}
