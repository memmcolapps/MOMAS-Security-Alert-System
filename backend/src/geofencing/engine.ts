import { env } from "../config";
import { bus } from "../events";
import { fetchLastLocations } from "../pocstars/locations";
import { evaluateFence } from "./geometry";
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

const queues = new Map<string, Promise<void>>();
let radioPolling = false;
let started = false;

async function evaluatePosition(position: PositionUpdate) {
  const lat = Number(position.lat);
  const lon = Number(position.lon);
  const observedAt = new Date(position.observed_at);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    (lat === 0 && lon === 0) ||
    Number.isNaN(observedAt.getTime())
  ) return;

  const normalized = { ...position, lat, lon, observed_at: observedAt };
  const fences = await store.assignmentsForAsset(position.asset_type, String(position.asset_id));
  for (const fence of fences) {
    const state = await store.getGeofenceState(fence.assignment_id);
    if (
      state?.last_observed_at &&
      observedAt.getTime() <= new Date(state.last_observed_at).getTime()
    ) {
      continue;
    }
    const result = evaluateFence(fence, lat, lon);
    const confirmations = Math.max(1, Number(fence.confirmations_required) || env.GEOFENCE_CONFIRMATIONS);

    if (result.outside) {
      const outsideCount = (state?.is_outside ? confirmations : Number(state?.outside_count) || 0) + 1;
      const confirmed = Boolean(state?.is_outside) || outsideCount >= confirmations;
      if (confirmed && !state?.is_outside) {
        const alert = await store.createBreachAlert(fence, normalized, result.distanceOutsideM);
        if (alert) bus.emit("operational-alert:new", alert);
      }
      await store.saveGeofenceState({
        assignment_id: fence.assignment_id,
        is_outside: confirmed,
        outside_count: Math.min(outsideCount, confirmations),
        last_lat: lat,
        last_lon: lon,
        last_observed_at: observedAt,
      });
      continue;
    }

    if (state?.is_outside) {
      const returned = await store.markAssetReturned(fence, normalized);
      returned.forEach((alert) => bus.emit("operational-alert:updated", alert));
    }
    await store.saveGeofenceState({
      assignment_id: fence.assignment_id,
      is_outside: false,
      outside_count: 0,
      last_lat: lat,
      last_lon: lon,
      last_observed_at: observedAt,
    });
  }
}

/** Direct entry point for deterministic integration tests and trusted ingest. */
export async function evaluatePositionNow(position: PositionUpdate) {
  await evaluatePosition(position);
}

export function queuePosition(position: PositionUpdate) {
  const key = `${position.asset_type}:${position.asset_id}`;
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

async function pollRadios() {
  if (radioPolling) return;
  radioPolling = true;
  try {
    const uids = await store.listAssignedRadios();
    if (!uids.length) return;
    const response = await fetchLastLocations(uids);
    const rows = Array.isArray(response?.data) ? response.data : [];
    for (const row of rows) {
      const observed = row.GpsTime || row.gpsTime || row.UpdateTime || Date.now();
      queuePosition({
        asset_type: "radio",
        asset_id: String(row.Uid ?? row.uid ?? ""),
        lat: Number(row.Lat ?? row.lat),
        lon: Number(row.Lng ?? row.lng ?? row.Lon ?? row.lon),
        observed_at: observed,
        source: "pocstars",
      });
    }
  } catch (error: any) {
    console.warn("[Geofence] radio location poll failed:", error?.message || error);
  } finally {
    radioPolling = false;
  }
}

export function startGeofenceMonitor() {
  if (started || !env.GEOFENCE_ENABLE) return;
  started = true;
  bus.on("position:update", queuePosition);
  void pollRadios();
  setInterval(() => void pollRadios(), env.GEOFENCE_RADIO_POLL_SEC * 1000);
  console.log(`[Geofence] monitoring enabled; radio poll every ${env.GEOFENCE_RADIO_POLL_SEC}s`);
}
