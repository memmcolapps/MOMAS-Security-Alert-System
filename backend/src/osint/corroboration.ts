/**
 * Whether two news reports describe the same real-world security event, for
 * corroboration only.
 *
 * This is deliberately looser than fingerprintsMatch, which the scrapers use
 * to merge duplicate incidents and must stay strict. Here a false "same event"
 * only lets two outlets vouch for each other; a false "different event" - what
 * the strict rules produced - left every report single-source and below the
 * auto-approval bar. Measured on 29 Oct 2026: four outlets reported the same
 * Taraba massacre as "massacre" and "banditry", dated 25-27 Oct, one with no
 * state, and none of them corroborated another.
 */

const NIGERIAN_STATES = [
  "abia", "adamawa", "akwa ibom", "anambra", "bauchi", "bayelsa", "benue", "borno",
  "cross river", "delta", "ebonyi", "edo", "ekiti", "enugu", "gombe", "imo", "jigawa",
  "kaduna", "kano", "katsina", "kebbi", "kogi", "kwara", "lagos", "nasarawa", "niger",
  "ogun", "ondo", "osun", "oyo", "plateau", "rivers", "sokoto", "taraba", "yobe",
  "zamfara", "fct", "abuja",
];

// The classifier's types overlap: one outlet's "massacre" is another's
// "banditry" or "armed attack". Only displacement is a different kind of event.
function typeFamily(type: any) {
  const value = String(type || "").toLowerCase();
  return value === "displacement" ? "displacement" : "violence";
}

// Reports of the same event appear days apart, and the classifier's reading of
// "on Sunday" or "last week" wanders by a day or two.
export const SAME_EVENT_DAYS = 3;
// When both reports name the same village or town, the place is identity
// enough to look a little further: dates read from news copy can be a week out.
export const SAME_PLACE_DAYS = 7;

// Words every violent-incident report shares. Two reports agreeing on these
// alone says nothing about whether they describe the same event.
const COMMON = new Set([
  "kill", "death", "dead", "die", "bandit", "attack", "gunmen", "gunman", "terrorist", "abduct",
  "kidnap", "kidnapper", "troop", "soldier", "military", "army", "police", "villager", "resident",
  "community", "village", "people", "person", "local", "government", "area", "state", "nigeria",
  "nigerian", "official", "confirm", "report", "said", "says", "spokesperson", "command", "security",
  "least", "other", "several", "many", "victim", "injure", "injured", "wound", "missing", "also",
  "after", "were", "have", "that", "this", "with", "from", "their", "they", "them", "while", "which",
  "when", "where", "into", "over", "about", "against", "during", "between", "week", "weekend",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "night", "morning",
  "news", "breaking", "update", "latest", "video", "photo", "family", "families", "life", "lives",
  "operation", "force", "forces", "group", "armed", "suspected", "fresh", "toll", "rise", "rises",
  // Reporting boilerplate and outlet names, which say nothing about the event.
  "allegedly", "reportedly", "statement", "commissioner", "read", "more", "http", "https", "www",
  "punchng", "punch", "gazette", "peopl", "people", "daily", "trust", "premium", "times", "channel",
  "vanguard", "guardian", "press", "told", "according", "spoke", "spokesperson", "incident", "happen",
  "actually", "there", "include", "includ", "gather", "bring", "number", "those", "locally", "known",
  "country", "northeastern", "northwestern", "northern", "southern", "criminal", "farm", "farmer",
  "deploy", "team", "scene", "early", "also", "added", "further", "noted", "recently", "earlier",
  "situation", "calm", "normalcy", "restore", "investigation", "ongoing", "manhunt", "arrest",
  "suspect", "perpetrator", "commend", "condemn", "urge", "assure", "residents", "youth", "youths",
  // Words from press statements and military reports, which recur across
  // unrelated incidents - the same spokesman comments on every attack in his area.
  "spokesman", "spokeswoman", "association", "joint", "task", "north", "south", "east", "west",
  "central", "impos", "operativ", "recover", "invad", "repel", "foil", "neutralis", "neutraliz",
  "january", "february", "march", "april", "june", "july", "august", "september", "october",
  "november", "december",
]);

// Crude stemming, enough that "bandits", "killed" and "killing" meet "bandit"
// and "kill".
function stem(word: string) {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function text(item: any) {
  return `${item?.title || ""} ${item?.description || ""} ${item?.content_text || ""}`
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ");
}

/** The state an event happened in, from the classifier or, failing that, the place it names. */
export function stateOf(item: any) {
  const stated = String(item?.state || item?.event_state || "").toLowerCase().replace(/\bstate\b/g, "").trim();
  if (stated) return stated;
  const place = String(item?.claimed_location || item?.event_location || item?.location || "").toLowerCase();
  return NIGERIAN_STATES.find((state) => new RegExp(`\\b${state}\\b`).test(place)) || "";
}

/** True when the named place is no more specific than the state itself. */
export function onlyStateLevel(item: any) {
  const place = String(item?.claimed_location || item?.event_location || item?.location || "").toLowerCase();
  const state = stateOf(item);
  const rest = place
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word && word !== "state" && word !== "nigeria" && word !== "community" && word !== "area" && !state.split(" ").includes(word));
  return rest.length === 0;
}

/**
 * The words that can tell one event from another: places, names, numbers,
 * unusual details. Common violence vocabulary and the state name are left out.
 */
export function distinctiveTokens(item: any) {
  const state = stateOf(item);
  const tokens = new Set<string>();
  for (const raw of text(item).replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (/^\d+$/.test(raw)) {
      // A casualty count is distinctive; a year or a lone digit is not.
      const n = Number(raw);
      if (n >= 3 && n < 1900) tokens.add(raw);
      continue;
    }
    if (raw.length < 4) continue;
    const word = stem(raw);
    if (COMMON.has(word) || COMMON.has(raw) || state.split(" ").includes(raw)) continue;
    tokens.add(word);
  }
  return tokens;
}

// Words in a place name that say what kind of place it is, not which one.
const PLACE_KINDS = new Set([
  "lga", "local", "government", "area", "community", "communities", "village", "town", "district",
  "ward", "state", "nigeria", "quarter", "quarters", "street", "road", "market", "site", "camp",
  "axis", "and",
]);

// The state is checked on its own, so it is left out of place names: "Borno"
// at the head of a location says nothing about which village.
function placeWords(value: string, state = "") {
  const stateWords = state.split(" ");
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !PLACE_KINDS.has(word) && !stateWords.includes(word))
      .map(stem),
  );
}

function placeOf(item: any) {
  return String(item?.claimed_location || item?.event_location || item?.location || "");
}

/** Every named place in a report's location: village, LGA, town. */
function placeTokens(item: any) {
  return placeWords(placeOf(item), stateOf(item));
}

/** The most specific place a report names - its village or town. */
function specificPlace(item: any) {
  return placeWords(placeOf(item).split(",")[0] || "", stateOf(item));
}

// Place names are spelled loosely - Nassarawa and Nassarawo, Karim-Lamdo and
// Karim-Lamido - so one letter either way still names the same place.
function sameWord(a: string, b: string) {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Whether two reports name the same place. One may be less precise than the
 * other - "Jos North" and "Chorbe market, Jos North LGA" - so a report's most
 * specific place only has to appear somewhere in the other's location.
 */
function samePlace(a: any, b: any) {
  // Every word of the place must be there: "Jos North" is in "Chorbe market,
  // Jos North LGA" but not in "Bukuru, Jos South".
  const within = (specific: Set<string>, all: Set<string>) =>
    specific.size > 0 && [...specific].every((word) => [...all].some((other) => sameWord(word, other)));
  return within(specificPlace(a), placeTokens(b)) || within(specificPlace(b), placeTokens(a));
}

function sharedCount(a: Set<string>, b: Set<string>, ignore = new Set<string>()) {
  let shared = 0;
  for (const token of a) if (b.has(token) && !ignore.has(token)) shared++;
  return shared;
}

// Unresolved places are stored at their state's or LGA's centre, so equal
// coordinates prove little. Coordinates only rule a match out, when two
// reports are placed further apart than any one incident spreads.
function farApart(a: any, b: any) {
  const lat1 = Number(a?.lat ?? a?.event_lat);
  const lon1 = Number(a?.lon ?? a?.event_lon);
  const lat2 = Number(b?.lat ?? b?.event_lat);
  const lon2 = Number(b?.lon ?? b?.event_lon);
  if (![lat1, lon1, lat2, lon2].every((value) => Number.isFinite(value) && value !== 0)) return false;
  const rad = (value: number) => (value * Math.PI) / 180;
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) > 100;
}

function dayGap(a: any, b: any) {
  const left = new Date(a?.date ?? a?.event_date ?? "").getTime();
  const right = new Date(b?.date ?? b?.event_date ?? "").getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.abs(left - right) / 86_400_000;
}

/**
 * Whether two reports describe the same event. Each rule is a reason they
 * cannot be; whatever survives them all is corroboration.
 */
export function describeSameEvent(a: any, b: any) {
  if (typeFamily(a?.type ?? a?.event_type) !== typeFamily(b?.type ?? b?.event_type)) return false;

  const stateA = stateOf(a);
  const stateB = stateOf(b);
  if (!stateA || !stateB || stateA !== stateB) return false;

  if (farApart(a, b)) return false;

  // Several incidents can happen in one state, even one LGA, in a few days.
  // What tells them apart is the detail: a name, a casualty count, the kind of
  // victim. Place names are left out of that count - two attacks in Barkin
  // Ladi share "Barkin Ladi" and nothing else - and judged on their own.
  const places = new Set([...placeTokens(a), ...placeTokens(b)]);
  const details = sharedCount(distinctiveTokens(a), distinctiveTokens(b), places);
  const gap = dayGap(a, b);

  const precise = !onlyStateLevel(a) && !onlyStateLevel(b);
  if (precise) {
    // Both name a village or town. The same one makes the place itself the
    // identity, enough to allow dates read a week apart.
    if (samePlace(a, b)) {
      return (gap === null || gap <= SAME_PLACE_DAYS) && details >= 1;
    }
    // Different villages are different incidents. Outlets do sometimes place
    // one event differently, but in Plateau two attacks a day apart on mining
    // sites in neighbouring villages were exactly that - two attacks.
    return false;
  }
  if (gap !== null && gap > SAME_EVENT_DAYS) return false;
  return details >= 2;
}
