import { STATE_NAMES } from "../geocoder";

const ACTOR_PATTERNS = [
  "Boko Haram",
  "ISWAP",
  "Islamic State West Africa Province",
  "bandits",
  "gunmen",
  "herders",
  "Fulani herdsmen",
  "armed men",
  "terrorists",
  "cultists",
  "vigilantes",
  "troops",
  "police",
  "Nigerian Army",
  "NSCDC",
];

const ORG_PATTERNS = [
  "Nigerian Army",
  "Nigeria Police",
  "Police Command",
  "Civil Defence",
  "NSCDC",
  "DSS",
  "Department of State Services",
  "NEMA",
  "IOM",
  "UNHCR",
  "UNICEF",
  "Red Cross",
];

function wordBoundary(value: string) {
  return new RegExp(`(^|[^a-z0-9])(${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|[^a-z0-9])`, "i");
}

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function addEntity(seen: Set<string>, entities: any[], entity_type: string, value: string, confidence = 70) {
  const normalized = normalize(value);
  if (!normalized || normalized.length < 2) return;
  const key = `${entity_type}:${normalized.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  entities.push({ entity_type, value: normalized, confidence });
}

function extractEntitiesFromText(text: string) {
  const body = String(text || "");
  const seen = new Set<string>();
  const entities: any[] = [];

  for (const state of STATE_NAMES) {
    if (wordBoundary(state).test(body)) addEntity(seen, entities, "location", state, 82);
  }

  for (const actor of ACTOR_PATTERNS) {
    if (wordBoundary(actor).test(body)) addEntity(seen, entities, "actor", actor, 76);
  }

  for (const org of ORG_PATTERNS) {
    if (wordBoundary(org).test(body)) addEntity(seen, entities, "organization", org, 74);
  }

  const roadMatches = body.matchAll(/\b([A-Z][a-z]+(?:[- ][A-Z][a-z]+){1,4})\s+(?:road|highway|expressway|axis|route)\b/g);
  for (const match of roadMatches) addEntity(seen, entities, "route", match[0], 78);

  const casualtyMatches = body.matchAll(/\b(\d{1,3})\s+(?:people|persons|residents|villagers|soldiers|civilians|passengers|students)?\s*(killed|dead|abducted|kidnapped|displaced|injured)\b/gi);
  for (const match of casualtyMatches) {
    addEntity(seen, entities, "impact", `${match[1]} ${match[2].toLowerCase()}`, 72);
  }

  const quotedGroupMatches = body.matchAll(/\b(?:group|militia|sect|gang)\s+(?:called|known as|named)\s+["']?([A-Z][A-Za-z0-9 -]{2,60})["']?/g);
  for (const match of quotedGroupMatches) addEntity(seen, entities, "actor", match[1], 62);

  return entities.slice(0, 40);
}

export { extractEntitiesFromText };
