/**
 * Incident classifier for Nigeria security events.
 *
 * Pipeline: cheap keyword prefilter → in-memory LRU cache → Groq batch call.
 * Groq is still the final gatekeeper, but most items never reach it.
 *
 * Graceful failure: if GROQ_API_KEY is unset, or the call fails after retries,
 * or the response is unparseable, the per-item result is null. Callers MUST
 * treat null as "skip this item" — there is no regex fallback.
 */

import axios from "axios";
import crypto from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { looksLikeSecurityIncident } from "./prefilter";
import { extractState, geocode } from "../geocoder";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const GROQ_TIMEOUT_MS = parseInt(process.env.GROQ_TIMEOUT_MS || "30000", 10);
const GROQ_MAX_RETRIES = parseInt(process.env.GROQ_MAX_RETRIES || "5", 10);
// 15s interval ≈ 4 calls/min. With ~1.5K tokens/batch this stays under the
// 6K TPM cap on llama-3.1-8b-instant while leaving RPM headroom.
const GROQ_MIN_INTERVAL_MS = parseInt(
  process.env.GROQ_MIN_INTERVAL_MS || "15000",
  10,
);
const GROQ_BATCH_SIZE = Math.max(
  1,
  parseInt(process.env.GROQ_BATCH_SIZE || "10", 10),
);
const CLASSIFIER_MAX_TITLE_CHARS = parseInt(
  process.env.CLASSIFIER_MAX_TITLE_CHARS || "300",
  10,
);
const CLASSIFIER_MAX_DESCRIPTION_CHARS = parseInt(
  process.env.CLASSIFIER_MAX_DESCRIPTION_CHARS || "1200",
  10,
);
const CACHE_MAX = Math.max(
  100,
  parseInt(process.env.CLASSIFIER_CACHE_MAX || "5000", 10),
);

const INCIDENT_TYPES = [
  "bombing",
  "kidnapping",
  "massacre",
  "banditry",
  "herder_clash",
  "terrorism",
  "armed_attack",
  "cult_violence",
  "displacement",
];

const SEVERITIES = ["RED", "ORANGE", "YELLOW", "BLUE"];

const NON_INCIDENT = Object.freeze({
  is_security_incident: false,
  reasoning: null,
  type: null,
  location_text: null,
  date: null,
  actors: null,
  fatalities: 0,
  victims: 0,
  severity: "BLUE",
  summary: null,
});

const FOLLOW_UP_RE = new RegExp(
  [
    'contacts?\\s+.*family',
    'seeks?\\s+release',
    'demands?\\s+(rescue|release|action|justice)',
    'pledges?\\s+rescue',
    'vows?\\s+rescue',
    'talks?\\b',
    'negotiat(?:e|es|ed|ing|ion)',
    'condition\\b',
    'protests?\\b',
    'rall(?:y|ies)',
    'solidarity',
    'strike\\b',
    'faults?\\s+security',
    'tracking\\s+.*kidnappers?',
    'nabs?\\b',
    'arrests?\\b',
    'rescues?\\b',
    'rescued\\b',
    'releases?\\b',
    'released\\b',
    'mourns?\\b',
    'condemns?\\b',
    'outrage\\s+spreads',
    'morning\\s+recap',
    'high\\s+alert',
  ].join('|'),
  'i',
);

const FOREIGN_PLACE_RE = new RegExp(
  [
    'pakistan',
    'iraq',
    'london',
    'ukraine',
    'russia',
    'chad',
    'mali',
    'south\\s+africa',
    'east\\s+london',
    'poltava',
  ].join('|'),
  'i',
);

const ClassificationSchema = z.object({
  is_security_incident: z.boolean(),
  reasoning: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  type: z.enum(INCIDENT_TYPES as [string, ...string[]]).nullable().optional(),
  location_text: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  actors: z.string().nullable().optional(),
  fatalities: z.number().int().min(0).max(500).nullable().optional(),
  casualty_count: z.number().int().min(0).max(500).nullable().optional(),
  victims: z.number().int().min(0).max(500).nullable().optional(),
  severity: z.enum(SEVERITIES as [string, ...string[]]).nullable().optional(),
  summary: z.string().nullable().optional(),
});

const SYSTEM_PROMPT = `You are a security analyst. Your job: identify events that require a NEW security intervention.

CRITICAL: You must distinguish between the VIOLENCE itself and everything that follows it (rescues, arrests, trials, condemnations, investigations). Only the violence is a new incident.

For each item, follow these steps IN ORDER:

STEP 1 — WHAT IS THE NEW EVENT BEING REPORTED?
Identify what actually happened that is new news. Be precise:
- "Police rescue 15 abducted people" → the NEW event is the RESCUE, not the abduction
- "President condemns bombing" → the NEW event is the STATEMENT, not the bombing
- "Gunmen ambush convoy, kill 5" → the NEW event is the ATTACK itself
- "Court arraigns suspect for past murder" → the NEW event is the COURT PROCEEDING

STEP 2 — DOES THE NEW EVENT REQUIRE SECURITY INTERVENTION?
Set is_security_incident=true ONLY if the new event itself is an active act of violence or imminent threat:
- Active attacks, ambushes, bombings, kidnappings, massacres, armed assaults
- Fresh displacement caused by violence happening now/recently

Set is_security_incident=false for everything else:
- Rescue/recovery operations ("police rescue hostages", "victims freed", "bodies recovered") — the violence already happened
- Arrests or security operations referencing past crimes — the violence already happened
- Political reactions/condemnations ("X condemns Y", "X calls for investigation")
- Court/legal proceedings about past violence (bail, arraignment, trial, sentencing)
- Retrospective/cumulative reports ("X killed since 2020", "toll rises this year")
- Feature/analysis/opinion journalism
- Road accidents, disease outbreaks, economics, appointments, weather

STEP 3 — TYPE (pick exactly one if is_security_incident=true):
bombing | kidnapping | massacre | banditry | herder_clash | terrorism | armed_attack | cult_violence | displacement

STEP 4 — EXTRACT STRUCTURED INCIDENT FACTS (THIS incident only):
- location_text: most specific location mentioned, or null
- date: when it happened as YYYY-MM-DD if available from the text, else null
- actors: people/groups involved, or null
- summary: one sentence describing only the new incident
- fatalities: killed IN THIS EVENT (0 if unknown)
- victims:    abducted/kidnapped/displaced IN THIS EVENT (0 if not applicable)

STEP 5 — SEVERITY:
RED    → ≥30 killed, OR bombing/massacre with deaths, OR ≥100 kidnapped/displaced
ORANGE → ≥10 killed, OR ≥20 kidnapped, OR terrorism with deaths, OR ≥5 kidnapped
YELLOW → ≥1 fatality or victim, OR bombing/terrorism/kidnapping with unconfirmed count
BLUE   → security news with no casualties

---
FEW-SHOT EXAMPLES:

Input:
[
  {"id":0,"text":"Headline: Gunmen attack military convoy in Borno, kill 5 soldiers\\n\\nDescription: Suspected ISWAP fighters ambushed an army patrol vehicle on the Maiduguri-Damboa road on Thursday, killing five soldiers and injuring two others."},
  {"id":1,"text":"Headline: Tinubu condemns Kaduna market bombing, orders probe\\n\\nDescription: President Bola Tinubu has condemned the deadly explosion at Kasuwan Barci market and directed security agencies to investigate."},
  {"id":2,"text":"Headline: Lagos frees policemen who killed six traders over land\\n\\nDescription: Lagos DPP releases four policemen accused in the Owode Onirin traders killing, citing self-defence. Activist Femi Falana contests the decision."},
  {"id":3,"text":"Headline: 1,000 Abducted Nigerians: Families Face Agonizing Silence\\n\\nDescription: More than a thousand Nigerians abducted by bandits since 2020 remain missing as families wait for news."},
  {"id":4,"text":"Headline: Bandits abduct 43 passengers on Abuja-Kaduna highway\\n\\nDescription: Armed men intercepted a luxury bus on Thursday, marching 43 passengers into the forest. A ransom demand has been made."},
  {"id":5,"text":"Headline: IED blast kills 3 traders at Biu market, Borno\\n\\nDescription: A roadside bomb exploded near the Monday market in Biu, killing three civilians and wounding several others."},
  {"id":6,"text":"Headline: Police rescue 15 abducted on Calabar – Oron waterway\\n\\nDescription: Police have rescued 15 persons who were abducted by gunmen along the Calabar-Oron waterway in Cross River State. The suspects fled into the forest after a shootout with security operatives."},
  {"id":7,"text":"Headline: Army kills 12 bandits, rescues 30 hostages in Zamfara\\n\\nDescription: Troops of Operation Hadin Kai engaged armed bandits in their forest hideout, killing 12 and freeing 30 captives who were being held for ransom."}
]

Output:
[
  {"id":0,"reasoning":"Fresh ambush attack with confirmed soldier fatalities","is_security_incident":true,"type":"terrorism","location_text":"Maiduguri-Damboa road, Borno","date":null,"actors":"Suspected ISWAP fighters; Nigerian soldiers","fatalities":5,"victims":0,"severity":"ORANGE","summary":"Suspected ISWAP fighters ambushed an army patrol on the Maiduguri-Damboa road, killing five soldiers."},
  {"id":1,"reasoning":"Presidential condemnation of past event, not the incident","is_security_incident":false,"type":null,"location_text":null,"date":null,"actors":null,"fatalities":0,"victims":0,"severity":"BLUE","summary":null},
  {"id":2,"reasoning":"Court/DPP decision about a past killing, violence is not new","is_security_incident":false,"type":null,"location_text":null,"date":null,"actors":null,"fatalities":0,"victims":0,"severity":"BLUE","summary":null},
  {"id":3,"reasoning":"Retrospective feature on cumulative abductions since 2020","is_security_incident":false,"type":null,"location_text":null,"date":null,"actors":null,"fatalities":0,"victims":0,"severity":"BLUE","summary":null},
  {"id":4,"reasoning":"New kidnapping with confirmed victim count reported today","is_security_incident":true,"type":"kidnapping","location_text":"Abuja-Kaduna highway","date":null,"actors":"Armed men; bus passengers","fatalities":0,"victims":43,"severity":"RED","summary":"Armed men intercepted a bus on the Abuja-Kaduna highway and abducted 43 passengers."},
  {"id":5,"reasoning":"New IED blast with confirmed civilian deaths at market","is_security_incident":true,"type":"bombing","location_text":"Biu market, Borno","date":null,"actors":"Unknown bombers; traders","fatalities":3,"victims":0,"severity":"ORANGE","summary":"An IED exploded near Biu market in Borno, killing three traders."},
  {"id":6,"reasoning":"Rescue operation; abduction already happened","is_security_incident":false,"type":null,"location_text":null,"date":null,"actors":null,"fatalities":0,"victims":0,"severity":"BLUE","summary":null},
  {"id":7,"reasoning":"Military rescue operation, not new attack","is_security_incident":false,"type":null,"location_text":null,"date":null,"actors":null,"fatalities":0,"victims":0,"severity":"BLUE","summary":null}
]

---
Now classify the real input. Respond ONLY with a JSON array. Each element must be:
{"id": <same id as input>, "reasoning": "<≤16 words>", "is_security_incident": boolean, "type": string|null, "location_text": string|null, "date": "YYYY-MM-DD"|null, "actors": string|null, "fatalities": integer, "victims": integer, "severity": string, "summary": string|null}
Do not include any other text.`;

// ── Slot-based rate limiter ────────────────────────────────────────────────
let _nextSlot = 0;

async function _enforceRateLimit() {
  const now = Date.now();
  const waitUntil = Math.max(_nextSlot, now);
  _nextSlot = waitUntil + GROQ_MIN_INTERVAL_MS;
  const waitMs = waitUntil - now;
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
}

// ── LRU cache keyed by sha1(title|description) ─────────────────────────────
const _cache = new Map();

function cacheKey(title, description) {
  return crypto
    .createHash("sha1")
    .update(`${title}\n${description || ""}`)
    .digest("hex");
}

function cacheGet(key) {
  if (!_cache.has(key)) return undefined;
  const val = _cache.get(key);
  _cache.delete(key);
  _cache.set(key, val);
  return val;
}

function cacheSet(key, val) {
  if (_cache.has(key)) _cache.delete(key);
  _cache.set(key, val);
  if (_cache.size > CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

function isGroqEnabled() {
  return Boolean(process.env.GROQ_API_KEY);
}

function sanitize(raw) {
  if (!raw || typeof raw !== "object") return null;

  const parsed = ClassificationSchema.safeParse(raw);
  if (!parsed.success) return { ...NON_INCIDENT };
  const value = parsed.data;

  if (value.is_security_incident !== true) {
    return {
      ...NON_INCIDENT,
      reasoning: value.reasoning || value.reason || null,
    };
  }

  if (!value.type || !INCIDENT_TYPES.includes(value.type)) {
    return { ...NON_INCIDENT, reasoning: value.reasoning || value.reason || null };
  }

  const type = value.type;
  const severity = value.severity && SEVERITIES.includes(value.severity) ? value.severity : "YELLOW";

  // Cap at 500 — genuine single-incident counts rarely exceed this;
  // larger numbers usually come from cumulative/retrospective reporting.
  const fatalities = Number.isFinite(value.fatalities) ? Math.floor(value.fatalities || 0) : 0;
  const victims = Number.isFinite(value.victims) ? Math.floor(value.victims || 0) : 0;

  return {
    is_security_incident: true,
    reasoning: value.reasoning || value.reason || null,
    type,
    location_text: value.location_text || null,
    date: value.date || null,
    actors: value.actors || null,
    fatalities,
    casualty_count: fatalities,
    victims,
    severity,
    summary: value.summary || null,
  };
}

function extractJSON(text) {
  if (!text || typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {}

  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }

  // Try object or array slice
  for (const [open, close] of [
    ["[", "]"],
    ["{", "}"],
  ]) {
    const s = text.indexOf(open);
    const e = text.lastIndexOf(close);
    if (s !== -1 && e > s) {
      try {
        return JSON.parse(text.slice(s, e + 1));
      } catch {}
    }
  }
  return null;
}

async function callGroqBatch(batch) {
  const payload = batch.map((b, i) => ({
    id: i,
    text: `Headline: ${(b.title || "").slice(0, CLASSIFIER_MAX_TITLE_CHARS)}\n\nDescription: ${(b.description || "(none)").slice(0, CLASSIFIER_MAX_DESCRIPTION_CHARS)}`,
  }));

  for (let attempt = 1; attempt <= GROQ_MAX_RETRIES; attempt++) {
    await _enforceRateLimit();

    try {
      const resp = await axios.post(
        GROQ_API_URL,
        {
          model: GROQ_MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(payload) },
          ],
          temperature: 0,
          max_tokens: 320 * batch.length + 200,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: GROQ_TIMEOUT_MS,
        },
      );

      const content = resp.data?.choices?.[0]?.message?.content;
      if (!content) throw new Error("Groq returned empty content");

      const parsed = extractJSON(content);
      if (!Array.isArray(parsed)) {
        throw new Error(`Expected JSON array, got: ${content.slice(0, 200)}`);
      }

      const byId = new Map();
      for (const r of parsed) {
        if (r && Number.isInteger(r.id)) {
          byId.set(r.id, r);
          if (r.reasoning || r.reason) {
            const verdict = r.is_security_incident ? `✓ ${r.type}` : "✗ skip";
            console.log(`  [${verdict}] ${r.reasoning || r.reason}`);
          }
        }
      }
      return batch.map((_, i) => sanitize(byId.get(i)));
    } catch (err) {
      const status = err.response?.status;

      if (status === 429 && attempt < GROQ_MAX_RETRIES) {
        const retryAfterMs =
          parseInt(err.response?.headers?.["retry-after"] || "0", 10) * 1000 ||
          0;
        const backoffMs = Math.min(
          retryAfterMs || GROQ_MIN_INTERVAL_MS * Math.pow(2, attempt - 1),
          60000,
        );
        console.warn(
          `[classifier] 429 (attempt ${attempt}/${GROQ_MAX_RETRIES}), waiting ${Math.round(backoffMs / 1000)}s…`,
        );
        _nextSlot = Date.now() + backoffMs;
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      if (status === 503 && attempt < GROQ_MAX_RETRIES) {
        const backoffMs = Math.min(
          GROQ_MIN_INTERVAL_MS * Math.pow(2, attempt - 1),
          30000,
        );
        console.warn(
          `[classifier] 503 (attempt ${attempt}/${GROQ_MAX_RETRIES}), waiting ${Math.round(backoffMs / 1000)}s…`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      if (status === 413 && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        console.warn(
          `[classifier] Batch too large (${batch.length}); splitting into ${mid}+${batch.length - mid}.`,
        );
        const left = await callGroqBatch(batch.slice(0, mid));
        const right = await callGroqBatch(batch.slice(mid));
        return [...left, ...right];
      }

      const msg = err.response?.data?.error?.message || err.message;
      console.warn(
        `[classifier] Groq batch failed (${status ?? "n/a"}): ${msg}. Dropping batch.`,
      );
      return batch.map(() => null);
    }
  }

  return batch.map(() => null);
}

const ClassifierGraphState = Annotation.Root({
  runId: Annotation<string>(),
  items: Annotation<any[]>(),
  results: Annotation<any[]>(),
  toCall: Annotation<any[]>(),
  stats: Annotation<any>(),
});

function classifierPrefilterNode(state) {
  const results = new Array(state.items.length);
  const toCall = [];

  for (let i = 0; i < state.items.length; i++) {
    const title = state.items[i].title || "";
    const description = state.items[i].description || "";

    if (!looksLikeSecurityIncident(title, description)) {
      results[i] = { ...NON_INCIDENT };
      continue;
    }

    const key = cacheKey(title, description);
    const cached = cacheGet(key);
    if (cached !== undefined) {
      results[i] = cached;
      continue;
    }

    toCall.push({ index: i, key, title, description });
  }

  const filteredOrCached = state.items.length - toCall.length;
  console.log(
    `[graph:${state.runId}:prefilter] ${state.items.length} item(s) -> ${filteredOrCached} filtered/cached, ${toCall.length} need LLM`,
  );

  return {
    results,
    toCall,
    stats: {
      input: state.items.length,
      filteredOrCached,
      llmItems: toCall.length,
    },
  };
}

function routeAfterPrefilter(state) {
  const route = state.toCall?.length ? "triage_extract" : "done";
  console.log(`[graph:${state.runId}:route] prefilter -> ${route}`);
  return route;
}

async function triageExtractNode(state) {
  const results = [...state.results];
  console.log(`[graph:${state.runId}:triage_extract] entering with ${state.toCall.length} item(s)`);

  if (!isGroqEnabled()) {
    console.warn("[classifier] GROQ_API_KEY not set — skipping LLM items.");
    for (const t of state.toCall) results[t.index] = null;
    console.log(`[graph:${state.runId}:triage_extract] no Groq key -> returning null results`);
    return { results };
  }

  const batches = [];
  for (let i = 0; i < state.toCall.length; i += GROQ_BATCH_SIZE) {
    batches.push(state.toCall.slice(i, i + GROQ_BATCH_SIZE));
  }

  console.log(
    `[classifier:${state.runId}] ${state.items.length} items: ${state.stats.filteredOrCached} filtered/cached, ${state.toCall.length} → ${batches.length} LLM batch(es)`,
  );

  let incidents = 0;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    console.log(
      `[graph:${state.runId}:triage_extract] Groq batch ${batchIndex + 1}/${batches.length}: ${batch.length} item(s)`,
    );
    const batchResults = await callGroqBatch(
      batch.map((t) => ({ title: t.title, description: t.description })),
    );

    for (let j = 0; j < batch.length; j++) {
      const t = batch[j];
      const r = batchResults[j];
      results[t.index] = r;
      if (r) {
        cacheSet(t.key, r);
        if (r.is_security_incident) incidents++;
      }
    }
  }

  console.log(
    `[graph:${state.runId}:triage_extract] ${state.toCall.length} LLM item(s) -> ${incidents} incident(s)`,
  );

  return {
    results,
    stats: {
      ...state.stats,
      incidents,
      batches: batches.length,
    },
  };
}

function publishGuardNode(state) {
  const results = [...state.results];
  let guardRejected = 0;
  let incidents = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result?.is_security_incident) continue;

    const item = state.items[i] || {};
    const text = `${item.title || ""} ${item.description || ""}`;
    const locationText = result.location_text || "";
    const guardText = `${text} ${locationText}`;
    const geo = geocode(locationText) || geocode(text);
    const stateName = geo?.state || extractState(guardText);

    let reason = null;
    if (FOLLOW_UP_RE.test(text)) {
      reason = "Follow-up story, not a fresh incident";
    } else if (FOREIGN_PLACE_RE.test(guardText) && !stateName) {
      reason = "Foreign or non-Nigeria story";
    } else if (!geo && !stateName) {
      reason = "No concrete Nigerian map location";
    }

    if (reason) {
      guardRejected++;
      results[i] = {
        ...NON_INCIDENT,
        reasoning: reason,
      };
      continue;
    }

    incidents++;
  }

  console.log(
    `[graph:${state.runId}:publish_guard] ${state.stats.incidents || 0} candidate incident(s) -> ${incidents} publishable, ${guardRejected} rejected`,
  );

  return {
    results,
    stats: {
      ...state.stats,
      incidents,
      guardRejected,
    },
  };
}

const classifierGraph = new StateGraph(ClassifierGraphState)
  .addNode("prefilter", classifierPrefilterNode)
  .addNode("triage_extract", triageExtractNode)
  .addNode("publish_guard", publishGuardNode)
  .addEdge(START, "prefilter")
  .addConditionalEdges("prefilter", routeAfterPrefilter, {
    triage_extract: "triage_extract",
    done: END,
  })
  .addEdge("triage_extract", "publish_guard")
  .addEdge("publish_guard", END)
  .compile();

/**
 * Classify a single item. Returns the sanitized result, or null on failure.
 * Goes through prefilter and cache, same as classifyMany.
 */
async function classify(title, description = "") {
  const [result] = await classifyMany([{ title, description }]);
  return result;
}

/**
 * Classify many items. Preserves input order. Each result is either a
 * sanitized object or null (on per-item failure).
 *
 * Steps per item:
 *   1. prefilter  — regex gate; misses return NON_INCIDENT without API call
 *   2. cache      — sha1(title|description) lookup
 *   3. batch call — remaining items grouped into Groq calls of BATCH_SIZE
 */
async function classifyMany(items) {
  const start = Date.now();
  const runId = crypto.randomBytes(2).toString("hex");
  const finalState = await classifierGraph.invoke({ runId, items });
  const results = finalState.results || new Array(items.length).fill(null);
  const stats = finalState.stats || {};

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!stats.llmItems) {
    console.log(
      `[classifier:${runId}] ${items.length} items: ${stats.filteredOrCached ?? items.length} filtered/cached, 0 LLM calls`,
    );
  }
  console.log(
    `[classifier:${runId}] LangGraph done in ${elapsed}s — ${stats.incidents || 0} incidents from ${stats.llmItems || 0} LLM items`,
  );
  return results;
}

export { classify, classifyMany, isGroqEnabled };
