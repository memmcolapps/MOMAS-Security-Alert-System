// A zone's alarm steps drawn on a map: one dashed line per level, in that
// level's colour, where it fires. Every line sits outside the shape: how far a
// keep-in radio may stray, or a warning ring round a no-go zone. Shared by the
// Geofences map and the main map so both show the same lines.

import L from "leaflet";
import { LEVEL_STYLES, LEVELS } from "./alarm-levels";
import { formatDistance, offsetRings } from "./fence-placement";

/**
 * The distinct steps in a zone's stored rules. Many radios share a step, so
 * one line is drawn per direction, level and distance, not per radio.
 */
export function zoneSteps(rules = []) {
  const steps = new Map();
  for (const rule of rules) {
    if (rule.active === false || !LEVEL_STYLES[rule.level]) continue;
    // 0 m is a step on the edge itself; it is drawn over the edge.
    const distance = Math.max(0, Number(rule.buffer_m) || 0);
    const key = stepKey(rule);
    if (!steps.has(key)) steps.set(key, { trigger: rule.trigger, level: rule.level, distance_m: distance });
  }
  // Quietest first, so the loudest line is drawn on top.
  return [...steps.values()].sort((a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level) || a.distance_m - b.distance_m);
}

// Offset lines take real work on a long border, so each is worked out once.
const offsetCache = new Map();
function cachedOffset(points, distance) {
  const key = `${distance}|${points.join(";")}`;
  if (offsetCache.has(key)) return offsetCache.get(key);
  const rings = offsetRings(points, distance);
  if (offsetCache.size > 200) offsetCache.delete(offsetCache.keys().next().value);
  offsetCache.set(key, rings);
  return rings;
}

const distanceWords = (step) => (step.distance_m > 0 ? formatDistance(step.distance_m) : "at edge");

const chip = (step, note = "") =>
  `<span style="position:absolute;transform:translate(-50%,-115%);white-space:nowrap;padding:1px 6px;border-radius:9999px;background:rgba(0,0,0,.75);color:${LEVEL_STYLES[step.level].dot};font:700 10px system-ui;box-shadow:0 1px 3px rgba(0,0,0,.5)">${LEVEL_STYLES[step.level].label} · ${distanceWords(step)}${note ? ` · ${note}` : ""}</span>`;

/** The key that tells two steps apart, the same one zoneSteps groups by. */
export const stepKey = (step) => `${step.trigger}|${step.level}|${Math.max(0, Number(step.buffer_m ?? step.distance_m) || 0)}`;

/**
 * Adds a zone's step lines to `layer`.
 *
 * `zone` is either a stored zone (geometry) or the editor's draft (points).
 * `labels` puts a "Amber · 100 m" chip at the top of each line; without it the
 * same words show on hover, which keeps a busy map readable.
 * `style` and `className` restyle the lines (the main map uses them for a
 * crossed step); `note` adds words to a step's chip, such as who crossed it.
 */
export function drawZoneSteps(layer, zone, steps, { labels = false, name = "", opacity = 1, style: extra = null, className = "", note = null } = {}) {
  const points = zone.points || zone.geometry?.coordinates?.[0];
  for (const step of steps) {
    const style = { color: LEVEL_STYLES[step.level].dot, weight: 2, opacity, dashArray: "6 6", fill: false, interactive: !labels, className, ...extra };
    let line = null;
    let top = null;
    if (zone.shape_type === "circle") {
      const lat = Number(zone.center_lat);
      const lon = Number(zone.center_lon);
      const radius = Number(zone.radius_m) + step.distance_m;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(radius > 0)) continue;
      line = L.circle([lat, lon], { ...style, radius });
      top = [lat + radius / 111_320, lon];
    } else {
      if (!Array.isArray(points) || points.length < 3) continue;
      const rings = step.distance_m > 0 ? cachedOffset(points, step.distance_m) : [points];
      if (!rings) continue;
      line = L.polygon(rings.map((ring) => ring.map(([lon, lat]) => [lat, lon])), style);
      const peak = rings[0].reduce((best, point) => (point[1] > best[1] ? point : best), rings[0][0]);
      top = [peak[1], peak[0]];
    }
    const words = `${LEVEL_STYLES[step.level].label} · ${step.distance_m > 0 ? `${formatDistance(step.distance_m)} outside` : "at the edge"}`;
    if (labels) {
      L.marker(top, { interactive: false, keyboard: false, icon: L.divIcon({ className: "", iconSize: [0, 0], html: chip(step, note?.(step) || "") }) }).addTo(layer);
    } else {
      line.bindTooltip(name ? `${name} · ${words}` : words, { sticky: true });
    }
    line.addTo(layer);
  }
}
