// The modules the platform switches on per organization. Keep in step with
// backend/src/modules.ts, which enforces them.
export const MODULES = ["radio", "vehicle", "drone", "osint", "geofence"];

export const MODULE_OPTIONS = [
  ["radio", "Radios"],
  ["vehicle", "Vehicles"],
  ["drone", "Drones"],
  ["osint", "OSINT"],
  ["geofence", "Geofences"],
];

/** The organization's modules as a Set; none listed means all of them. */
export function moduleSet(modules) {
  return new Set(Array.isArray(modules) && modules.length ? modules : MODULES);
}

/**
 * Radio and Vehicle split one estate: a device typed "vehicle" is a Vehicle,
 * every other type a Radio. The radio network itself - channels, Listen,
 * replay, alarms - opens with either.
 */
export function hasRadioNetwork(modules) {
  return modules.has("radio") || modules.has("vehicle");
}

export function isVehicle(device) {
  return device?.device_type === "vehicle";
}
