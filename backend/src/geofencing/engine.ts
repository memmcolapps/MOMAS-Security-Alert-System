import { env } from "../config";
import { bus } from "../events";
import { fetchLastLocations } from "../pocstars/locations";
import { assetKey, currentAssetPositions } from "./positions";
import {
  classify,
  inBounds,
  ruleMembers,
  signedDistanceMetres,
  step,
  zoneBounds,
  type Membership,
  type RuleState,
  type Side,
} from "./rules";
import * as store from "./store";

export type PositionUpdate = {
  asset_type: "radio" | "drone";
  asset_id: string;
  lat: number;
  lon: number;
  altitude_m?: number | null;
  observed_at: Date | string | number;
  source?: string;
};

type IndexedRule = any & { bounds: ReturnType<typeof zoneBounds> };
type MemoryState = RuleState & { last_observed_ms: number };

// Rules and who they cover live in memory, so a fix costs no database read.
// Rebuilt when a rule is saved and once a minute, which is how quickly a radio
// moved between units elsewhere in the console starts being watched.
const INDEX_REFRESH_MS = 60_000;
let rulesByAsset = new Map<string, IndexedRule[]>();
let rulesById = new Map<number, IndexedRule>();
let membership: Membership = { radioUnit: new Map(), droneUnit: new Map(), channelRadios: new Map(), unitChildren: new Map() };
let assetNames = new Map<string, string>();
let refreshing: Promise<void> | null = null;

const states = new Map<string, MemoryState>();
const stateKey = (ruleId: number, key: string) => `${ruleId}|${key}`;

const queues = new Map<string, Promise<void>>();
let radioPolling = false;
let started = false;

async function buildIndex() {
  const [rules, raw] = await Promise.all([store.loadActiveRules(), store.loadMembership()]);
  const assetOrg = new Map<string, string>();
  const names = new Map<string, string>();
  const next: Membership = { radioUnit: new Map(), droneUnit: new Map(), channelRadios: new Map(), unitChildren: new Map() };
  for (const device of raw.devices) {
    next.radioUnit.set(String(device.device_id), device.unit_id == null ? null : String(device.unit_id));
    assetOrg.set(`radio:${device.device_id}`, String(device.organization_id));
    names.set(`radio:${device.device_id}`, device.name || `Radio ${device.device_id}`);
  }
  for (const drone of raw.drones) {
    next.droneUnit.set(String(drone.sysid), drone.unit_id == null ? null : String(drone.unit_id));
    assetOrg.set(`drone:${drone.sysid}`, String(drone.organization_id));
    names.set(`drone:${drone.sysid}`, drone.name || `Drone ${drone.sysid}`);
  }
  for (const row of raw.channels) {
    const list = next.channelRadios.get(String(row.channel_id)) || [];
    list.push(String(row.device_id));
    next.channelRadios.set(String(row.channel_id), list);
  }
  for (const unit of raw.units) {
    if (unit.parent_unit_id == null) continue;
    const list = next.unitChildren.get(String(unit.parent_unit_id)) || [];
    list.push(String(unit.id));
    next.unitChildren.set(String(unit.parent_unit_id), list);
  }

  const byAsset = new Map<string, IndexedRule[]>();
  const byId = new Map<number, IndexedRule>();
  for (const rule of rules) {
    const indexed = { ...rule, id: Number(rule.id), bounds: zoneBounds(rule, (Number(rule.buffer_m) || 0) + 5) };
    byId.set(indexed.id, indexed);
    for (const key of ruleMembers(rule, next)) {
      // A rule only ever watches its own organization's assets.
      if (assetOrg.get(key) !== String(rule.organization_id)) continue;
      const list = byAsset.get(key) || [];
      list.push(indexed);
      byAsset.set(key, list);
    }
  }
  membership = next;
  assetNames = names;
  rulesByAsset = byAsset;
  rulesById = byId;
}

export function refreshIndex() {
  if (!refreshing) {
    refreshing = buildIndex()
      .catch((error) => console.error("[Geofence] rule index refresh failed:", error?.message || error))
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

/** Which side of a rule a position is on, with the exact distance only when it matters. */
function judge(rule: IndexedRule, lat: number, lon: number): { side: Side; distanceM: number } {
  // Nowhere near the zone: clearly outside, which is a breach for "must stay
  // inside" and safe for "must not enter". Most fixes take this path.
  if (!inBounds(rule.bounds, lat, lon)) {
    if (rule.trigger === "enter") return { side: "safe", distanceM: 0 };
    return classify("exit", rule.buffer_m, signedDistanceMetres(rule, lat, lon));
  }
  return classify(rule.trigger, rule.buffer_m, signedDistanceMetres(rule, lat, lon));
}

async function evaluatePosition(position: PositionUpdate) {
  const lat = Number(position.lat);
  const lon = Number(position.lon);
  const observedAt = new Date(position.observed_at);
  const observedMs = observedAt.getTime();
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0) || Number.isNaN(observedMs)) return;

  const key = assetKey(position.asset_type, String(position.asset_id));
  const rules = rulesByAsset.get(key);
  if (!rules?.length) return;
  const normalized = { ...position, asset_id: String(position.asset_id), lat, lon, observed_at: observedAt };

  for (const rule of rules) {
    const sk = stateKey(rule.id, key);
    const previous = states.get(sk) || null;
    if (previous && observedMs <= previous.last_observed_ms) continue;

    const verdict = judge(rule, lat, lon);
    const result = step(previous, verdict.side, rule.confirmations_required || env.GEOFENCE_CONFIRMATIONS);
    states.set(sk, { ...result.state, last_observed_ms: observedMs });

    if (result.changed) {
      await store.saveRuleState({
        rule_id: rule.id,
        asset_type: position.asset_type,
        asset_id: normalized.asset_id,
        in_breach: result.state.in_breach,
        breach_count: result.state.breach_count,
        last_lat: lat,
        last_lon: lon,
        last_observed_at: observedAt,
      });
    }
    if (result.event === "breach") {
      const alert = await store.createRuleAlert(rule, normalized, Math.round(verdict.distanceM));
      if (alert) bus.emit("operational-alert:new", alert);
    } else if (result.event === "clear") {
      const cleared = await store.markRuleCleared(rule, normalized);
      cleared.forEach((alert) => bus.emit("operational-alert:updated", alert));
    }
  }
}

/** Direct entry point for deterministic integration tests and trusted ingest. */
export async function evaluatePositionNow(position: PositionUpdate) {
  await evaluatePosition(position);
}

export function queuePosition(position: PositionUpdate) {
  const key = `${position.asset_type}:${position.asset_id}`;
  // Nothing watches this asset: skip the queue entirely.
  if (!rulesByAsset.has(key)) return;
  const previous = queues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => evaluatePosition(position))
    .catch((error) => console.error(`[Geofence] ${key} evaluation failed:`, error?.message || error))
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  queues.set(key, next);
}

/** The assets a rule (saved or draft) covers right now, with display names. */
export function membersOf(rule: { target_type: string; target_id: string }) {
  return ruleMembers(rule, membership).map((key) => {
    const [asset_type, ...rest] = key.split(":");
    return { asset_type, asset_id: rest.join(":"), name: assetNames.get(key) || key };
  });
}

/** Where every watched asset stands on every rule, for the zone list. */
export function breachedCounts() {
  const counts = new Map<number, number>();
  for (const [key, state] of states) {
    if (!state.in_breach) continue;
    const ruleId = Number(key.split("|")[0]);
    if (rulesById.has(ruleId)) counts.set(ruleId, (counts.get(ruleId) || 0) + 1);
  }
  return counts;
}

export { judge as judgeRule };

/**
 * Called after rules are saved. Rebuilds the index and, for rules that are new
 * or now ask a different question, records where everyone stands right now.
 *
 * With `quiet`, an asset already on the wrong side is recorded as in breach
 * without an alarm, so drawing a no-go zone over a radio already parked in it
 * does not ring the moment it is saved. It alarms normally the next time it
 * crosses. Without it, those assets alarm on their next fixes.
 */
export async function rulesChanged(freshIds: number[], removedIds: number[], quiet: boolean) {
  const dropped = new Set([...freshIds, ...removedIds].map(Number));
  for (const key of [...states.keys()]) {
    if (dropped.has(Number(key.split("|")[0]))) states.delete(key);
  }
  await refreshIndex();
  if (!quiet || !freshIds.length) return 0;

  let seeded = 0;
  for (const id of freshIds) {
    const rule = rulesById.get(Number(id));
    if (!rule) continue;
    const members = membersOf(rule);
    const positions = await currentAssetPositions(members);
    for (const member of members) {
      const position = positions.get(assetKey(member.asset_type, member.asset_id));
      if (!position) continue;
      const verdict = judge(rule, position.lat, position.lon);
      if (verdict.side !== "violating") continue;
      const observed = position.observed_at ? new Date(position.observed_at) : new Date();
      const needed = Math.max(1, Number(rule.confirmations_required) || 1);
      states.set(stateKey(rule.id, assetKey(member.asset_type, member.asset_id)), {
        in_breach: true,
        breach_count: needed,
        last_observed_ms: observed.getTime(),
      });
      await store.saveRuleState({
        rule_id: rule.id,
        asset_type: member.asset_type,
        asset_id: member.asset_id,
        in_breach: true,
        breach_count: needed,
        last_lat: position.lat,
        last_lon: position.lon,
        last_observed_at: observed,
      });
      seeded++;
    }
  }
  return seeded;
}

/** Used only when the shared position recorder is switched off. */
async function pollRadios() {
  if (radioPolling) return;
  radioPolling = true;
  try {
    const uids = [...rulesByAsset.keys()].filter((key) => key.startsWith("radio:")).map((key) => key.slice(6));
    if (!uids.length) return;
    const response = await fetchLastLocations(uids);
    const rows = Array.isArray(response?.data) ? response.data : [];
    for (const row of rows) {
      queuePosition({
        asset_type: "radio",
        asset_id: String(row.Uid ?? row.uid ?? ""),
        lat: Number(row.Lat ?? row.lat),
        lon: Number(row.Lng ?? row.lng ?? row.Lon ?? row.lon),
        observed_at: row.GpsTime || row.gpsTime || row.UpdateTime || Date.now(),
        source: "pocstars",
      });
    }
  } catch (error: any) {
    console.warn("[Geofence] radio location poll failed:", error?.message || error);
  } finally {
    radioPolling = false;
  }
}

async function loadStates() {
  for (const row of await store.loadRuleStates()) {
    states.set(stateKey(Number(row.rule_id), assetKey(row.asset_type, String(row.asset_id))), {
      in_breach: Boolean(row.in_breach),
      breach_count: Number(row.breach_count) || 0,
      last_observed_ms: row.last_observed_at ? new Date(row.last_observed_at).getTime() : 0,
    });
  }
}

export async function startGeofenceMonitor() {
  if (started || !env.GEOFENCE_ENABLE) return;
  started = true;
  try {
    await Promise.all([loadStates(), refreshIndex()]);
  } catch (error: any) {
    console.error("[Geofence] could not load rules:", error?.message || error);
  }
  setInterval(() => void refreshIndex(), INDEX_REFRESH_MS);
  // Drones, and radios via the shared recorder, arrive on the bus as they land.
  bus.on("position:update", queuePosition);
  if (env.RADIO_TRACK_ENABLE) {
    console.log("[Geofence] monitoring enabled; radio fixes from the shared position recorder");
    return;
  }
  void pollRadios();
  setInterval(() => void pollRadios(), env.GEOFENCE_RADIO_POLL_SEC * 1000);
  console.log(`[Geofence] monitoring enabled; radio poll every ${env.GEOFENCE_RADIO_POLL_SEC}s`);
}
