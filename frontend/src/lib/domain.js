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
