/**
 * The decision a geofence rule makes about one position, with no database.
 *
 * A zone is only a place. A rule says who it watches, which way of crossing
 * the boundary is the problem, and how loud the alarm is:
 *
 *   exit  — "must stay inside": alarms once the asset is clearly outside.
 *   enter — "must not enter":   alarms once the asset is clearly inside.
 *
 * "Clearly" is the drift allowance (buffer_m). For an exit rule the alarm line
 * sits buffer_m outside the drawn shape; for an enter rule it sits buffer_m
 * inside it. Either way GPS jitter along the boundary cannot fire it.
 *
 * Clearing is deliberately harder than firing: a breached asset only counts as
 * back once it is on the safe side of the drawn shape itself. Between the
 * shape and the alarm line nothing changes, so a radio parked on the line does
 * not flap between "breached" and "returned" on every fix.
 */
import { distanceToPolygonMetres, haversineMetres, pointInPolygon, type GeofenceShape } from "./geometry";

export type Trigger = "exit" | "enter";
export type Level = "red" | "amber" | "yellow";
export type TargetType = "radio" | "drone" | "unit" | "channel";
export type Side = "violating" | "edge" | "safe";

export const TRIGGERS: Trigger[] = ["exit", "enter"];
export const LEVELS: Level[] = ["red", "amber", "yellow"];
export const TARGET_TYPES: TargetType[] = ["radio", "drone", "unit", "channel"];

export type RuleState = {
  in_breach: boolean;
  breach_count: number;
  last_observed_at?: Date | string | null;
};

/** Metres from the boundary: negative inside the shape, positive outside it. */
export function signedDistanceMetres(zone: GeofenceShape, lat: number, lon: number) {
  if (zone.shape_type === "circle") {
    return haversineMetres(lat, lon, Number(zone.center_lat), Number(zone.center_lon)) - (Number(zone.radius_m) || 0);
  }
  const boundary = distanceToPolygonMetres(lat, lon, zone.geometry);
  return pointInPolygon(lat, lon, zone.geometry) ? -boundary : boundary;
}

/**
 * Which side of the rule this position is on, and how far past the boundary
 * it is in the direction that matters (metres outside for exit, metres inside
 * for enter; 0 when on the safe side).
 */
export function classify(trigger: Trigger, bufferM: number, signed: number): { side: Side; distanceM: number } {
  const buffer = Math.max(0, Number(bufferM) || 0);
  const past = trigger === "exit" ? signed : -signed;
  if (past > buffer) return { side: "violating", distanceM: past };
  if (past <= 0) return { side: "safe", distanceM: 0 };
  return { side: "edge", distanceM: past };
}

export type StepResult = {
  state: RuleState;
  event: "breach" | "clear" | null;
  /** True when the stored row needs writing; most fixes change nothing. */
  changed: boolean;
};

/**
 * Advances one rule/asset pair by one classified fix.
 *
 * `confirmations` consecutive violating fixes raise the breach. An edge fix
 * neither confirms nor clears: it resets a half-counted breach (the asset came
 * back towards the line) but leaves a confirmed one standing.
 */
export function step(previous: RuleState | null, side: Side, confirmations: number): StepResult {
  const needed = Math.max(1, Math.floor(Number(confirmations) || 1));
  const was = previous || { in_breach: false, breach_count: 0 };

  if (side === "violating") {
    if (was.in_breach) return { state: { ...was, breach_count: needed }, event: null, changed: was.breach_count !== needed };
    const count = Math.min(needed, (Number(was.breach_count) || 0) + 1);
    const confirmed = count >= needed;
    return { state: { in_breach: confirmed, breach_count: count }, event: confirmed ? "breach" : null, changed: true };
  }

  if (side === "safe" && was.in_breach) {
    return { state: { in_breach: false, breach_count: 0 }, event: "clear", changed: true };
  }

  if (was.in_breach) return { state: was, event: null, changed: false };
  return { state: { in_breach: false, breach_count: 0 }, event: null, changed: Number(was.breach_count) !== 0 || !previous };
}

export type Bounds = { minLat: number; maxLat: number; minLon: number; maxLon: number };

/** The zone's bounding box grown by `marginM`, for a cheap "nowhere near it" test. */
export function zoneBounds(zone: GeofenceShape, marginM: number): Bounds | null {
  let minLat: number, maxLat: number, minLon: number, maxLon: number;
  if (zone.shape_type === "circle") {
    const lat = Number(zone.center_lat);
    const lon = Number(zone.center_lon);
    const r = Number(zone.radius_m) || 0;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const dLat = r / 111_320;
    const dLon = r / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
    [minLat, maxLat, minLon, maxLon] = [lat - dLat, lat + dLat, lon - dLon, lon + dLon];
  } else {
    const ring = zone.geometry?.coordinates?.[0];
    if (!Array.isArray(ring) || !ring.length) return null;
    const lats = ring.map((point: number[]) => Number(point[1]));
    const lons = ring.map((point: number[]) => Number(point[0]));
    [minLat, maxLat, minLon, maxLon] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  }
  const mLat = marginM / 111_320;
  const mLon = marginM / (111_320 * Math.max(0.01, Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180)));
  return { minLat: minLat - mLat, maxLat: maxLat + mLat, minLon: minLon - mLon, maxLon: maxLon + mLon };
}

export function inBounds(bounds: Bounds | null, lat: number, lon: number) {
  return Boolean(bounds) && lat >= bounds!.minLat && lat <= bounds!.maxLat && lon >= bounds!.minLon && lon <= bounds!.maxLon;
}

export type Membership = {
  /** radio id → its unit, from the device registry. */
  radioUnit: Map<string, string | null>;
  /** drone sysid → its unit. */
  droneUnit: Map<string, string | null>;
  /** channel id → radio ids on it. */
  channelRadios: Map<string, string[]>;
  /** unit id → its child unit ids. */
  unitChildren: Map<string, string[]>;
};

/** A unit and every unit beneath it: a rule on a company covers its platoons. */
export function unitAndDescendants(unitId: string, children: Map<string, string[]>) {
  const seen = new Set<string>();
  const queue = [String(unitId)];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(children.get(id) || []));
  }
  return seen;
}

/** Every asset a rule watches right now, as `type:id` keys. */
export function ruleMembers(rule: { target_type: string; target_id: string }, membership: Membership) {
  const id = String(rule.target_id);
  if (rule.target_type === "radio" || rule.target_type === "drone") return [`${rule.target_type}:${id}`];
  if (rule.target_type === "channel") return (membership.channelRadios.get(id) || []).map((radio) => `radio:${radio}`);
  if (rule.target_type === "unit") {
    const units = unitAndDescendants(id, membership.unitChildren);
    const members: string[] = [];
    for (const [radio, unit] of membership.radioUnit) if (unit && units.has(unit)) members.push(`radio:${radio}`);
    for (const [drone, unit] of membership.droneUnit) if (unit && units.has(unit)) members.push(`drone:${drone}`);
    return members;
  }
  return [];
}
