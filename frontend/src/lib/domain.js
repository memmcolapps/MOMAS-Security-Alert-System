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

// Armoured vehicle: sloped nose, hull, roof hatch, three road wheels. Drawn
// here because Font Awesome free has no armoured vehicle - its nearest is a
// military supply truck, which reads as logistics rather than a protected
// patrol unit. No weapon on it: these are escort and cash-in-transit vehicles,
// not military ones, and a gun barrel would say the wrong thing about the
// operation. Inherits the pin's colour through currentColor.
const ARMOURED_VEHICLE_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
  <rect x="8.4" y="5.2" width="5" height="2.6" rx="0.6"/>
  <path d="M3.4 7.8h11.4l4.3 3.4v4.1H3.4z"/>
  <circle cx="7" cy="17.6" r="2.3"/>
  <circle cx="12" cy="17.6" r="2.3"/>
  <circle cx="17" cy="17.6" r="2.3"/>
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
