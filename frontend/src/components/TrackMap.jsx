import L from "leaflet";
import { useEffect, useRef } from "react";
import { IMAGERY_LABEL_TILES, IMAGERY_ROAD_TILES, SATELLITE_TILES } from "../lib/basemaps";
import { onFrame } from "../lib/frame-ticker";
import { MOTION, distanceMetres, fixAgeSec, fixFromLocation, trailSegments } from "../lib/radio-motion";
import { newestPoint, sampleTrack } from "../lib/radio-playback";
import { radioIcon } from "./OperationsMap";

// Same framing as tracking on the main map: close enough to see which
// building, no closer than the imagery goes.
const FOLLOW_ZOOM = 17;
const FIT_MAX_ZOOM = 18;
const INNER_PAD = -0.25;
const VISUAL_MS = 250;
const TRAIL_MS = 2000;
const CAMERA_MS = 500;

/** What a tracked radio is doing, from what the tile knows about it. */
function statusOf(entry, ageSec) {
  if (entry.sos) return "sos";
  if (entry.offline) return "offline";
  if (ageSec != null && ageSec > MOTION.staleSec) return "nofix";
  return entry.motion?.moving ? "moving" : "online";
}

/**
 * A small live map following one tracked radio - or, in the Together view,
 * keeping several in frame at once. Imagery only: every tile is its own map,
 * and the vector basemaps each need a WebGL context, which browsers run out
 * of after about sixteen.
 *
 * Positions come from the same streamed tracks the main map plays back, and
 * one shared frame loop drives every tile.
 */
export function TrackMap({ radios, radioTracks, trails, paused, onPause, onState, recentreKey, hidden = false }) {
  const nodeRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef(null);
  const entriesRef = useRef(new Map());
  const propsRef = useRef({});
  propsRef.current = { radios, trails, paused, onPause, onState, hidden };
  const cameraRef = useRef({ framed: false, lastCheck: 0 });

  useEffect(() => {
    const map = L.map(nodeRef.current, {
      zoomControl: false,
      attributionControl: false,
      maxZoom: 21,
      fadeAnimation: false,
    }).setView([9, 8.5], 6);
    const tileOptions = { updateWhenIdle: true, keepBuffer: 1 };
    L.tileLayer(SATELLITE_TILES.url, { ...SATELLITE_TILES.options, ...tileOptions }).addTo(map);
    L.tileLayer(IMAGERY_ROAD_TILES.url, { ...IMAGERY_ROAD_TILES.options, ...tileOptions }).addTo(map);
    L.tileLayer(IMAGERY_LABEL_TILES.url, { ...IMAGERY_LABEL_TILES.options, ...tileOptions }).addTo(map);
    // One canvas for every trail segment is far cheaper than an SVG path each.
    const trailLayer = L.layerGroup().addTo(map);
    layersRef.current = { trailLayer, renderer: L.canvas({ padding: 0.2 }) };
    // Dragging means the operator wants to look around: the camera stops
    // following until they press Re-centre.
    map.on("dragstart", () => propsRef.current.onPause?.());
    mapRef.current = map;

    const resize = new window.ResizeObserver(() => map.invalidateSize({ pan: false }));
    resize.observe(nodeRef.current);
    const entries = entriesRef.current;
    return () => {
      resize.disconnect();
      map.remove();
      mapRef.current = null;
      entries.clear();
    };
  }, []);

  // Which radios this map shows, and what the registry and the polled
  // positions say about each. Movement is the frame loop's job.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const entries = entriesRef.current;
    const wanted = new Set();
    for (const radio of radios) {
      wanted.add(radio.uid);
      let entry = entries.get(radio.uid);
      if (!entry) {
        entry = { marker: null, dot: null, iconKey: null, motion: null, reported: "" };
        entries.set(radio.uid, entry);
      }
      const fix = fixFromLocation(radio.location);
      const sos = radio.location?.processStatus === 1;
      Object.assign(entry, { radio, fix, sos, offline: !sos && !radio.online });
    }
    for (const [uid, entry] of entries) {
      if (wanted.has(uid)) continue;
      entry.marker?.remove();
      entry.dot?.remove();
      entries.delete(uid);
    }
  }, [radios]);

  // Re-centre, or a change in which radios are shown, frames them again.
  useEffect(() => {
    cameraRef.current.framed = false;
  }, [recentreKey, radios.length]);

  useEffect(() => {
    let lastVisual = 0;
    let lastTrail = 0;
    return onFrame((now) => {
      const map = mapRef.current;
      const { hidden: off, trails: trailMap, paused: held, onState: report } = propsRef.current;
      if (!map || off) return;
      const visual = now - lastVisual >= VISUAL_MS;
      if (visual) lastVisual = now;
      const pins = [];

      for (const [uid, entry] of entriesRef.current) {
        const track = radioTracks?.current?.get(uid);
        let sample = null;
        entry.renderT = now;
        if (track?.path.length) {
          // An alarm is never shown late: an SOS radio sits on its newest point.
          if (entry.sos) {
            const newest = newestPoint(track);
            sample = { lat: newest.lat, lon: newest.lon, moving: false, bearing: null, speedMs: 0 };
          } else {
            entry.renderT = now - track.delayMs;
            sample = sampleTrack(track, entry.renderT);
          }
        }
        entry.motion = sample;
        const at = sample ? { lat: sample.lat, lon: sample.lon } : entry.fix;
        if (!at) continue;
        if (!entry.marker) {
          entry.marker = L.marker([at.lat, at.lon], { keyboard: false }).addTo(map);
        } else {
          // A walking radio moves well under a pixel a frame; across a wall of
          // tiles, skipping those redraws is most of the frame budget.
          const current = entry.marker.getLatLng();
          const metresPerPixel = (156543 * Math.cos((at.lat * Math.PI) / 180)) / 2 ** map.getZoom();
          if (distanceMetres({ lat: current.lat, lon: current.lng }, at) >= metresPerPixel * 0.5) entry.marker.setLatLng([at.lat, at.lon]);
        }
        pins.push(entry.marker.getLatLng());

        if (!visual) continue;
        const ageSec = track?.lastArrivalMs ? Math.round((now - track.lastArrivalMs) / 1000) : fixAgeSec(entry.fix, now);
        const status = statusOf(entry, ageSec);
        const bearing = entry.motion?.bearing;
        const iconKey = [status, status === "moving" ? Math.round(bearing / 5) : "", entry.radio.colour, entry.radio.label].join("|");
        if (iconKey !== entry.iconKey) {
          entry.marker.setIcon(
            radioIcon({ label: entry.radio.label, glyph: entry.radio.glyph, status, bearing, tracked: true, ageSec, ring: entry.radio.colour }),
          );
          entry.iconKey = iconKey;
        }
        // A faint dot on the newest point received, ahead of the pin.
        const newest = track && !entry.sos ? newestPoint(track) : null;
        if (newest) {
          if (!entry.dot) {
            entry.dot = L.circleMarker([newest.lat, newest.lon], {
              radius: 5,
              color: "#ffffff",
              weight: 1.5,
              fillColor: entry.radio.colour,
              fillOpacity: 0.35,
              opacity: 0.6,
              interactive: false,
            }).addTo(map);
          } else entry.dot.setLatLng([newest.lat, newest.lon]);
        } else if (entry.dot) {
          entry.dot.remove();
          entry.dot = null;
        }
        if (report) {
          const moving = status === "moving";
          const state = {
            status,
            moving,
            speedMs: moving && entry.motion?.speedMs != null ? Math.round(entry.motion.speedMs * 10) / 10 : null,
            bearing: moving && bearing != null ? Math.round(bearing / 5) * 5 : null,
            seenMs: track?.lastArrivalMs ?? entry.fix?.seenMs ?? null,
            behindSec: track?.path.length && !entry.sos ? Math.round(track.delayMs / 1000) : 0,
          };
          const key = JSON.stringify(state);
          if (key !== entry.reported) {
            entry.reported = key;
            report(uid, state);
          }
        }
      }

      // The camera: straight onto the radios the first time, then only when
      // one nears the edge, so the map stays readable.
      const camera = cameraRef.current;
      if (pins.length && !held) {
        if (!camera.framed) {
          camera.framed = true;
          camera.lastCheck = now + 900;
          if (pins.length === 1) map.setView(pins[0], Math.max(map.getZoom(), FOLLOW_ZOOM), { animate: false });
          else map.fitBounds(L.latLngBounds(pins), { padding: [40, 40], maxZoom: FIT_MAX_ZOOM, animate: false });
        } else if (now - camera.lastCheck >= CAMERA_MS) {
          camera.lastCheck = now;
          const inner = map.getBounds().pad(INNER_PAD);
          const outside = pins.some((pin) => !inner.contains(pin));
          if (outside) {
            if (pins.length === 1) map.panTo(pins[0], { animate: true, duration: 0.8 });
            else map.fitBounds(L.latLngBounds(pins), { padding: [40, 40], maxZoom: FIT_MAX_ZOOM, animate: true, duration: 0.8 });
          }
        }
      }

      if (now - lastTrail >= TRAIL_MS) {
        lastTrail = now;
        drawTrails(layersRef.current, entriesRef.current, trailMap);
      }
    });
  }, [radioTracks]);

  return <div ref={nodeRef} className="h-full w-full bg-black" />;
}

// Each radio's trail in its own colour, cut off where its pin is so it never
// runs ahead, and fading with age.
function drawTrails(layers, entries, trails) {
  if (!layers) return;
  const { trailLayer, renderer } = layers;
  trailLayer.clearLayers();
  for (const [uid, entry] of entries) {
    const renderT = entry.renderT ?? Date.now();
    const points = (trails?.[uid] || []).filter((point) => new Date(point.observed_at).getTime() <= renderT);
    const pin = entry.marker?.getLatLng();
    if (pin) points.push({ lat: pin.lat, lon: pin.lng, observed_at: new Date(renderT).toISOString() });
    const segments = trailSegments(points);
    const times = segments.flat().map((point) => point.ms);
    if (!times.length) continue;
    const span = Math.max(1, renderT - Math.min(...times));
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
          { renderer, color: entry.radio.colour, weight: 4, opacity: 0.15 + 0.75 * recency, lineCap: "round", interactive: false },
        ).addTo(trailLayer);
      }
    }
  }
}
