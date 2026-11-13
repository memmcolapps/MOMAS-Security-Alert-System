import { canManageOrganization, isPlatformOperator, isPlatformStaff, primaryOrganization } from "../auth";
import * as db from "../db";

export function orgScope(c: any) {
  const user = c.get("user");
  if (!user || isPlatformStaff(user)) return {};
  const org = primaryOrganization(user);
  return org
    ? {
        organizationId: org.organization_id,
        unitId: org.scope_level === "unit" ? org.unit_id : null,
        assignedOnly: !canManageOrganization(org),
        // Radio and Vehicle modules decide which device types come back.
        modules: org.modules,
      }
    : { organizationId: -1 };
}

// Every tier sees the whole radio estate; only ops and above may move it.
export function isPlatformAdmin(c: any) {
  return isPlatformStaff(c.get("user"));
}

export function canEditEstate(c: any) {
  return isPlatformOperator(c.get("user"));
}

export async function ensureDeviceAccess(c: any, deviceIds: string[]) {
  if (isPlatformAdmin(c)) return true;
  const allowed = new Set(
    (await db.listDevices(orgScope(c))).map((device: any) =>
      String(device.device_id),
    ),
  );
  return deviceIds.every((deviceId) => allowed.has(String(deviceId)));
}

export const formUrlencoded = (obj: Record<string, unknown>) =>
  Object.entries(obj)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join("&");

export function jsonError(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error) };
}

export function statusFromAxios(error: any) {
  return error?.response?.status || 502;
}
