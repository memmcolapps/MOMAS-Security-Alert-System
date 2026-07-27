/**
 * Current known position for a set of assets, keyed `type:id`.
 *
 * This is what lets a fence be placed from the assets rather than from the map:
 * the operator picks who they are protecting, and the editor already knows
 * where that is. The same lookup answers "who is inside this shape right now?"
 * when the fence is saved.
 */
import { getDronePositions } from "../drones/mavlink-listener";
import { fetchLastLocations } from "../pocstars/locations";

export type AssetRef = { asset_type: string; asset_id: string };
export type AssetPosition = {
  asset_type: string;
  asset_id: string;
  lat: number;
  lon: number;
  observed_at: string | null;
};

export const assetKey = (assetType: string, assetId: string) => `${assetType}:${assetId}`;

function usable(lat: any, lon: any) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  // (0,0) is the classic "no fix yet" sentinel from both transports.
  return Number.isFinite(latitude) && Number.isFinite(longitude) && !(latitude === 0 && longitude === 0)
    ? { lat: latitude, lon: longitude }
    : null;
}

function toIso(value: any) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Assets with no usable fix are simply absent from the map — callers report
 * them as "position unknown" rather than guessing a location for them.
 */
export async function currentAssetPositions(assets: AssetRef[]) {
  const positions = new Map<string, AssetPosition>();
  const radioIds = assets.filter((asset) => asset.asset_type === "radio").map((asset) => String(asset.asset_id));
  const wantsDrones = assets.some((asset) => asset.asset_type === "drone");

  if (radioIds.length) {
    try {
      const response = await fetchLastLocations(radioIds);
      const rows = Array.isArray(response?.data) ? response.data : [];
      for (const row of rows) {
        const point = usable(row.Lat ?? row.lat, row.Lng ?? row.lng ?? row.Lon ?? row.lon);
        const id = String(row.Uid ?? row.uid ?? "");
        if (!point || !id) continue;
        positions.set(assetKey("radio", id), {
          asset_type: "radio",
          asset_id: id,
          ...point,
          observed_at: toIso(row.GpsTime || row.gpsTime || row.UpdateTime),
        });
      }
    } catch (error: any) {
      console.warn("[Geofence] radio positions unavailable:", error?.message || error);
    }
  }

  if (wantsDrones) {
    for (const drone of getDronePositions()) {
      const point = usable(drone.lat, drone.lon);
      if (!point) continue;
      positions.set(assetKey("drone", String(drone.sysid)), {
        asset_type: "drone",
        asset_id: String(drone.sysid),
        ...point,
        observed_at: toIso((drone as any).last_seen ?? (drone as any).updated_at) ?? new Date().toISOString(),
      });
    }
  }

  return positions;
}
