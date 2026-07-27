import axios from "axios";
import { env } from "../config";

const formUrlencoded = (obj: Record<string, unknown>) =>
  Object.entries(obj)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");

/** Fetch last-known WGS84 positions directly from POCSTARS. */
export async function fetchLastLocations(uids: string[]) {
  const clean = [...new Set(uids.map(String).map((value) => value.trim()).filter(Boolean))];
  if (!clean.length) return { code: 200, data: [], success: true };
  const { data } = await axios.post(
    `${env.POCSTARS_LOC_BASE}/shanli/gps/api/locations/LastLocation`,
    formUrlencoded({ Uids: clean.join(","), CorrdinateType: "Wgs84" }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 8000 },
  );
  return data;
}

