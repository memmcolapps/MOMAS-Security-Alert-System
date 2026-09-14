export const NIGERIAN_STATES = [
  "Abia",
  "Adamawa",
  "Akwa Ibom",
  "Anambra",
  "Bauchi",
  "Bayelsa",
  "Benue",
  "Borno",
  "Cross River",
  "Delta",
  "Ebonyi",
  "Edo",
  "Ekiti",
  "Enugu",
  "FCT",
  "Gombe",
  "Imo",
  "Jigawa",
  "Kaduna",
  "Kano",
  "Katsina",
  "Kebbi",
  "Kogi",
  "Kwara",
  "Lagos",
  "Nasarawa",
  "Niger",
  "Ogun",
  "Ondo",
  "Osun",
  "Oyo",
  "Plateau",
  "Rivers",
  "Sokoto",
  "Taraba",
  "Yobe",
  "Zamfara",
];

export const severityColors = {
  RED: "#ffb300",
  ORANGE: "#ff6600",
  YELLOW: "#00bbaa",
  BLUE: "#3399ff",
};

export const severityLabels = {
  RED: "AMBER",
  ORANGE: "ORANGE",
  YELLOW: "TEAL",
  BLUE: "BLUE",
};

export const typeIcons = {
  bombing: "fa-bomb",
  kidnapping: "fa-user-secret",
  massacre: "fa-skull",
  banditry: "fa-horse",
  herder_clash: "fa-people-arrows",
  terrorism: "fa-biohazard",
  armed_attack: "fa-gun",
  cult_violence: "fa-mask",
  displacement: "fa-tent",
};

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysISO(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function rangeForMode(mode, today = todayISO()) {
  if (mode === "yesterday") {
    const yesterday = addDaysISO(today, -1);
    return [yesterday, yesterday];
  }
  if (mode === "7d") return [addDaysISO(today, -6), today];
  if (mode === "30d") return [addDaysISO(today, -29), today];
  if (mode === "90d") return [addDaysISO(today, -89), today];
  if (mode === "ytd") return [`${today.slice(0, 4)}-01-01`, today];
  if (mode === "all") return ["", ""];
  return [today, today];
}

export function relativeDate(value) {
  if (!value) return "";
  const diff = Math.floor((Date.now() - new Date(value)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return `${diff}d ago`;
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

export function deviceTypeLabel(type) {
  return (
    {
      handheld: "Handheld radio",
      vehicle: "Vehicle tracker",
      fixed: "Fixed unit",
      other: "Other",
    }[type] || "Other"
  );
}

// Armoured vehicle, posterized from a side-on photograph of the patrol
// vehicles this fleet actually runs: blunt nose, high hull on wheel arches,
// raked windscreen, armoured greenhouse with vision blocks, roof mast. Drawn
// here because Font Awesome free has no armoured vehicle - its nearest is a
// military supply truck, which reads as logistics rather than a protected
// patrol unit. Four flat tones instead of a single silhouette (roof lightest
// through tyres solid), because at 15px a one-tone shape loses the greenhouse
// entirely and reads as a van. Tones are fill-opacity on currentColor rather
// than fixed greys, so the whole icon still takes the pin's colour - including
// the grey an offline radio gets. The roof station - pedestal, barrel, muzzle -
// carries the solid tone against the light roof plate, which is the only way it
// survives at pin size; the whip antenna aft of it stays mid-tone so the two do
// not merge into one shape.
const ARMOURED_VEHICLE_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
  <path fill-opacity=".82" fill-rule="evenodd" d="M2.9 12.6 L9.1 11.2 H23 V16 H21.8 A3.3 3.3 0 0 0 15.2 16 H10.5 A3.3 3.3 0 0 0 3.9 16 H2.9 Z M3.6 13.2 h1.8 v1.7 H3.6 Z"/>
  <path fill-opacity=".55" fill-rule="evenodd" d="M9 11.2 L11.5 6.2 H23 V11.2 Z M10.5 10.5 L12.2 7.1 H13.7 V10.5 Z M15.2 7.2 h2.1 v2.3 h-2.1 Z M18.7 7.2 h2.1 v2.3 h-2.1 Z"/>
  <path fill-opacity=".32" d="M11.1 5.4 H23.1 v1 H11.1 Z"/>
  <path d="M12.66 4.05 L8.76 3.55 L8.64 4.45 L12.54 4.95 Z"/>
  <path d="M8.2 3.4 h0.9 v1.2 h-0.9 Z"/>
  <path d="M11.9 3.8 h2.1 v1.7 h-2.1 Z"/>
  <path fill-opacity=".55" d="M20.6 3.7 h0.7 v1.8 h-0.7 Z"/>
  <path d="M1.7 14.1 h1.5 v1.6 H1.7 Z"/>
  <path fill-rule="evenodd" d="M7.2 12.7a3.3 3.3 0 1 0 0 6.6 3.3 3.3 0 0 0 0-6.6Z M7.2 14.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z"/>
  <path fill-rule="evenodd" d="M18.5 12.7a3.3 3.3 0 1 0 0 6.6 3.3 3.3 0 0 0 0-6.6Z M18.5 14.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z"/>
</svg>`;

// Map pins used one walkie-talkie glyph for everything, so a vehicle tracker
// and a handheld were indistinguishable at a glance - which is most of what a
// map is for. Returns markup rather than a class name because not every type
// has a Font Awesome equivalent.
export function deviceTypeGlyph(type) {
  if (type === "vehicle") return ARMOURED_VEHICLE_SVG;
  const icon = {
    handheld: "fa-walkie-talkie",
    fixed: "fa-tower-broadcast",
    other: "fa-circle-dot",
  }[type] || "fa-walkie-talkie";
  return `<i class="fas ${icon}"></i>`;
}

// One role vocabulary for both admin surfaces. The platform page used to offer
// "admin" and "viewer" while the organization page offered five other values,
// so the same person ended up with a different role string depending on which
// page created them - all resolving to the same permissions, and all displayed
// differently. New assignments come from this list only.
export const ORG_ROLES = [
  ["org_owner", "Org owner"],
  ["org_admin", "Org admin"],
  ["unit_admin", "Unit admin"],
  ["operator", "Operator"],
  ["viewer", "Viewer"],
];

// Values that exist on old rows and are still accepted by the API. They are
// labelled so the users list reads sensibly, but never offered for new users.
const LEGACY_ORG_ROLE_LABELS = {
  admin: "Org admin",
};

export function orgRoleLabel(value) {
  return (
    ORG_ROLES.find(([key]) => key === value)?.[1]
    || LEGACY_ORG_ROLE_LABELS[value]
    || value
    || "-"
  );
}
