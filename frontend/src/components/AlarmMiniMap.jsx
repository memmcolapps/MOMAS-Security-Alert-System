import L from "leaflet";
import { useEffect, useRef } from "react";

/**
 * A static locator map for a single alarm. An alarm's most important fact is
 * where it is, so the drawer shows the position rather than asking the operator
 * to read coordinates. Panning and zooming stay available; scroll-wheel zoom is
 * off so scrolling the drawer never hijacks into the map.
 */
export function AlarmMiniMap({ lat, lon, label, accent = "#ff4444" }) {
  const node = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);

  // Builds the map once; the effect below follows lat/lon from there on.
  useEffect(() => {
    if (!node.current || mapRef.current) return undefined;
    const map = L.map(node.current, {
      zoomControl: false,
      attributionControl: false,
      scrollWheelZoom: false,
      dragging: true,
    }).setView([lat, lon], 15);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 21,
      maxNativeZoom: 20,
    }).addTo(map);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setView([lat, lon], map.getZoom() || 15);
    const icon = L.divIcon({
      className: "",
      html: `<span style="display:block;width:16px;height:16px;border-radius:9999px;background:${accent};box-shadow:0 0 0 5px ${accent}33,0 0 0 11px ${accent}1a"></span>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    if (markerRef.current) markerRef.current.setLatLng([lat, lon]).setIcon(icon);
    else markerRef.current = L.marker([lat, lon], { icon, keyboard: false }).addTo(map);
    // The drawer animates in, so the container has no size on first paint.
    const timer = window.setTimeout(() => map.invalidateSize(), 60);
    return () => window.clearTimeout(timer);
  }, [lat, lon, accent]);

  return (
    <div
      ref={node}
      className="h-44 w-full overflow-hidden rounded-md border border-white/10"
      role="img"
      aria-label={label ? `Map showing the location of ${label}` : "Alarm location map"}
    />
  );
}
