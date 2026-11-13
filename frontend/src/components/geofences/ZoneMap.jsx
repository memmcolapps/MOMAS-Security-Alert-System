import L from "leaflet";
import { useEffect, useRef } from "react";
import { LEVEL_STYLES } from "../../lib/alarm-levels";
import { IMAGERY_LABEL_TILES, IMAGERY_ROAD_TILES, LABELLED_BASEMAPS, satelliteLayer, vectorBasemapLayer } from "../../lib/basemaps";
import { escapeHtml } from "../../lib/domain";
import { polygonSelfIntersects } from "../../lib/fence-placement";
import { addZoneName, hideZoneNamesWhenFar, zoneColour } from "../../lib/zone-colours";
import { drawZoneSteps, zoneSteps } from "../../lib/zone-steps";
import { BASEMAPS, MEMBER_COLOURS, TRIGGER_LOOK, isPlaced, zoneKind } from "./zone-model";

export function ZoneMap({
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
      satellite: satelliteLayer(L),
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


export function viewRadius(map) {
  const bounds = map.getBounds();
  const width = bounds.getSouthWest().distanceTo(bounds.getSouthEast());
  return Math.max(50, Math.round(width * 0.12));
}

export function eastOf(centre, metres) {
  const dLon = metres / (111_320 * Math.cos((centre.lat * Math.PI) / 180));
  return L.latLng(centre.lat, centre.lng + dLon);
}

export function midpointOf(a, b) {
  return [(a[1] + b[1]) / 2, (a[0] + b[0]) / 2];
}

/** Built as DOM so its buttons call straight into React without a global lookup. */
export function radioPopup(map, radio, editing, handlers) {
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
