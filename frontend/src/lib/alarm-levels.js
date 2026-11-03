// How loud an alarm is, and how a geofence alarm is said in words.
//
// red    — siren until someone answers, full-width banner, on every page.
// amber  — one chime and a quieter banner until someone answers.
// yellow — no sound and no banner; it is logged in the alarms list for review.
//
// A radio's SOS button is always red. Geofence alarms carry the level of the
// rule that raised them; ones raised before levels existed are red, which is
// how they rang.

export const LEVELS = ["red", "amber", "yellow"];

export const LEVEL_STYLES = {
  red: { label: "Red", dot: "#ef4444", text: "text-red-300", chip: "border-red-400/50 bg-red-500/10 text-red-300" },
  amber: { label: "Amber", dot: "#f59e0b", text: "text-amber-300", chip: "border-amber-400/50 bg-amber-400/10 text-amber-300" },
  yellow: { label: "Yellow", dot: "#facc15", text: "text-yellow-200", chip: "border-yellow-300/40 bg-yellow-300/10 text-yellow-200" },
};

export const LEVEL_MEANING = {
  red: "Siren until answered",
  amber: "One chime, needs an answer",
  yellow: "Silent, logged only",
};

export function isGeofenceAlarm(alert) {
  return alert?.source === "geofence" || alert?.alert_type === "geofence_breach";
}

export function levelOf(alert) {
  if (!isGeofenceAlarm(alert)) return "red";
  return LEVELS.includes(alert?.level) ? alert.level : "red";
}

/** "left Kaduna base" / "entered Airport", without the asset name. */
export function geofenceAction(alert) {
  const zone = alert?.geofence_name || "the zone";
  return alert?.trigger === "enter" ? `entered ${zone}` : `left ${zone}`;
}

export function alarmHeadline(alert) {
  const name = alert?.asset_name || alert?.dev_name || alert?.device_name || `Device ${alert?.device_id || alert?.asset_id}`;
  return isGeofenceAlarm(alert) ? `${name} ${geofenceAction(alert)}` : `SOS - ${name}`;
}
