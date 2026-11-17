// How loud an alarm is, and how a geofence alarm is said in words.
//
// All three are alarms that ring until someone answers, of falling urgency,
// each with a banner in its colour on every page:
// red    — the siren.
// amber  — a fire-alarm style triple beep, every 1.5 s.
// yellow — a hi-lo warning burst, every 4 s.
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
  amber: "Beeping until answered",
  yellow: "Warning tone until answered",
};

/**
 * A no-go zone's warning steps sit outside it, so their alarm can come before
 * the radio is in. Those carry a negative distance: metres still to the edge.
 */
export function isNearMiss(alert) {
  return alert?.trigger === "enter" && Number(alert?.distance_outside_m) < 0;
}

// Alarms about a person rather than a radio, raised by sign-in security.
// They ride the zone-alarm path (source "geofence"), so each function below
// answers for them first.
export const PERSON_ALARMS = {
  duress: {
    title: "Panic sign-in",
    action: "signed in with their panic password",
    where: "Where the phone was",
    advice: "Silent alarm. The phone shows a normal-looking screen with nothing on it. Do not call or message that phone; follow your duress procedure.",
  },
  device_lost: {
    title: "Phone reported lost",
    action: "reported their phone lost",
    where: "Where it last signed in",
    advice: "The phone has been signed out and blocked. It cannot sign in again until an admin unblocks it.",
  },
  unusual_sign_in: {
    title: "Sign-in from an unusual place",
    action: "signed in from an unusual place",
    where: "Where the sign-in came from",
    advice: "More than 50 km from anywhere this person has signed in before. Check it was them; if not, sign the device out from their organization's People page.",
  },
};

export function isPersonAlarm(alert) {
  return alert?.asset_type === "user";
}

function personAlarm(alert) {
  return PERSON_ALARMS[alert?.alert_type] || { title: "Sign-in alarm", action: "raised a sign-in alarm", where: "Location", advice: "" };
}

/** What to do about a person alarm, or "" for any other alarm. */
export function personAlarmAdvice(alert) {
  return isPersonAlarm(alert) ? personAlarm(alert).advice : "";
}

/** "120 m outside", "40 m inside", "300 m from the edge": where the radio was when it alarmed. */
export function geofenceDistance(alert) {
  if (isPersonAlarm(alert)) return personAlarm(alert).where;
  const metres = Math.round(Math.abs(Number(alert?.distance_outside_m) || 0));
  if (alert?.trigger !== "enter") return `${metres} m outside`;
  return isNearMiss(alert) ? `${metres} m from the edge` : `${metres} m inside`;
}

/** Short heading for a zone alarm. */
export function geofenceTitle(alert) {
  if (isPersonAlarm(alert)) return personAlarm(alert).title;
  if (alert?.trigger !== "enter") return "Left zone";
  return isNearMiss(alert) ? "Near no-go zone" : "Entered zone";
}

export function isGeofenceAlarm(alert) {
  return alert?.source === "geofence" || alert?.alert_type === "geofence_breach";
}

export function levelOf(alert) {
  if (!isGeofenceAlarm(alert)) return "red";
  return LEVELS.includes(alert?.level) ? alert.level : "red";
}

/** "left Kaduna base" / "entered Airport", without the asset name. */
export function geofenceAction(alert) {
  if (isPersonAlarm(alert)) return personAlarm(alert).action;
  const zone = alert?.geofence_name || "the zone";
  if (alert?.trigger === "enter") return isNearMiss(alert) ? `is near ${zone}` : `entered ${zone}`;
  return `left ${zone}`;
}

export function alarmHeadline(alert) {
  const name = alert?.asset_name || alert?.dev_name || alert?.device_name || `Device ${alert?.device_id || alert?.asset_id}`;
  return isGeofenceAlarm(alert) ? `${name} ${geofenceAction(alert)}` : `SOS - ${name}`;
}
