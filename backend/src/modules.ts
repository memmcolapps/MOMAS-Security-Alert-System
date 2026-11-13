// The modules the platform can switch on per organization. The single list:
// routes validate against it and the schema default is built from it.
export const MODULES = ["radio", "vehicle", "drone", "osint", "geofence"] as const;
export type Module = (typeof MODULES)[number];

export function normalizeModules(value: unknown): Module[] {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map((item) => String(item).trim()).filter((item): item is Module => (MODULES as readonly string[]).includes(item)))];
}

// Radio and Vehicle split one device estate by device type: a device typed
// "vehicle" belongs to the Vehicle module, every other type (handheld, fixed,
// other, or none set) to Radio. Audio is not split - a channel carries both.
//
// `modules` is the organization's list. None given, or an empty list, means
// everything, the same way the UI reads it; platform staff pass none.
function deviceAccess(modules: unknown) {
  if (!Array.isArray(modules) || !modules.length) return { radio: true, vehicle: true };
  return { radio: modules.includes("radio"), vehicle: modules.includes("vehicle") };
}

/** SQL condition on a device-type expression, or null when nothing is hidden. */
export function deviceTypeCondition(modules: unknown, column: string): string | null {
  const { radio, vehicle } = deviceAccess(modules);
  if (radio && vehicle) return null;
  if (radio) return `COALESCE(${column}, '') <> 'vehicle'`;
  if (vehicle) return `${column} = 'vehicle'`;
  return "FALSE";
}

/** The same rule as deviceTypeCondition, for one device already in hand. */
export function allowsDeviceType(modules: unknown, deviceType: unknown) {
  const { radio, vehicle } = deviceAccess(modules);
  return deviceType === "vehicle" ? vehicle : radio;
}

/** Live audio and channels: open to an organization with Radio or Vehicle. */
export function hasRadioNetwork(modules: unknown) {
  const { radio, vehicle } = deviceAccess(modules);
  return radio || vehicle;
}
