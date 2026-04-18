'use strict';

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

const axios = require('axios');
const crypto = require('crypto');
const { looksLikeSecurityIncident } = require('./prefilter');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const GROQ_TIMEOUT_MS = parseInt(process.env.GROQ_TIMEOUT_MS || '30000', 10);
const GROQ_MAX_RETRIES = parseInt(process.env.GROQ_MAX_RETRIES || '5', 10);
// 15s interval ≈ 4 calls/min. With ~1.5K tokens/batch this stays under the
// 6K TPM cap on llama-3.1-8b-instant while leaving RPM headroom.
const GROQ_MIN_INTERVAL_MS = parseInt(process.env.GROQ_MIN_INTERVAL_MS || '15000', 10);
const GROQ_BATCH_SIZE = Math.max(1, parseInt(process.env.GROQ_BATCH_SIZE || '10', 10));
const CACHE_MAX = Math.max(100, parseInt(process.env.CLASSIFIER_CACHE_MAX || '5000', 10));

const INCIDENT_TYPES = [
  'bombing',
  'kidnapping',
  'massacre',
  'banditry',
  'herder_clash',
  'terrorism',
  'armed_attack',
  'cult_violence',
  'displacement',
];

const SEVERITIES = ['RED', 'ORANGE', 'YELLOW', 'BLUE'];

const NON_INCIDENT = Object.freeze({
  is_security_incident: false, type: null, fatalities: 0, victims: 0, severity: 'BLUE',
});

const SYSTEM_PROMPT = `You classify short news reports about security events in Nigeria.

You will receive a JSON array of items, each with an "id" and "text". For each item decide:
1. Whether it is a security incident. Set "is_security_incident" to false if the text is NOT about a concrete security event that actually occurred. REJECT: political reactions, condemnations, statements about security ("X condemns Y", "X calls for investigation", "X expresses concern"), opinion pieces, editorials, calls to action, routine press conferences, election violence coverage with no specific event, economics, court cases, appointments, road accidents, disease outbreaks, sports, weather/flooding with no human cause, routine humanitarian assistance with no violence.
2. If it IS a security incident, pick exactly ONE "type":
   - bombing         (IED, suicide bomb, blast, landmine, air strike)
   - kidnapping      (abduction, hostage-taking, ransom)
   - massacre        (mass killing, slaughter of civilians)
   - banditry        (armed robbery, rustling, looting by bandit groups)
   - herder_clash    (farmer-herder, pastoralist violence)
   - terrorism       (Boko Haram, ISWAP, JNIM, Lakurawa, Ansaru, jihadist attacks)
   - armed_attack    (generic gunmen raid/ambush without clearer label)
   - cult_violence   (confraternity / campus / street-gang clashes)
   - displacement    (IDPs, people fleeing, refugee movement caused by conflict)
3. Extract integer counts — ONLY for this single specific new event, NOT cumulative totals:
   - "fatalities": people killed IN THIS INCIDENT (0 if unknown/none)
   - "victims":    people abducted/kidnapped/displaced IN THIS INCIDENT (0 if not applicable)
   IMPORTANT: If the text is a retrospective, feature story, or reports a cumulative statistic
   ("X people have been abducted since 2020", "toll rises to X this year", "families still waiting"),
   set is_security_incident to false. Do NOT extract historical totals as if they were a new event.
4. Pick a "severity":
   - RED:    mass-casualty (>=30 killed, or any bombing/massacre with deaths, or >=100 kidnapped/displaced)
   - ORANGE: serious (>=10 killed, or >=20 kidnapped, or terrorism with deaths, or >=5 kidnapped)
   - YELLOW: at least one fatality or victim, or bombing/terrorism/kidnapping with no confirmed count
   - BLUE:   general security news with no casualties (e.g., fire outbreak, building collapse, security alert with no deaths)

Respond ONLY with a JSON array. Each element must be:
{"id": <same id as input>, "is_security_incident": boolean, "type": string|null, "fatalities": integer, "victims": integer, "severity": string}
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
  return crypto.createHash('sha1').update(`${title}\n${description || ''}`).digest('hex');
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
  if (!raw || typeof raw !== 'object') return null;

  if (raw.is_security_incident !== true) return { ...NON_INCIDENT };

  const type = INCIDENT_TYPES.includes(raw.type) ? raw.type : 'armed_attack';
  const severity = SEVERITIES.includes(raw.severity) ? raw.severity : 'YELLOW';

  // Cap at 500 — genuine single-incident counts rarely exceed this;
  // larger numbers usually come from cumulative/retrospective reporting.
  const fatalities = Number.isFinite(raw.fatalities) && raw.fatalities >= 0 && raw.fatalities <= 500
    ? Math.floor(raw.fatalities) : 0;
  const victims = Number.isFinite(raw.victims) && raw.victims >= 0 && raw.victims <= 500
    ? Math.floor(raw.victims) : 0;

  return { is_security_incident: true, type, fatalities, victims, severity };
}

function extractJSON(text) {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch {}

  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }

  // Try object or array slice
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    const s = text.indexOf(open);
    const e = text.lastIndexOf(close);
    if (s !== -1 && e > s) {
      try { return JSON.parse(text.slice(s, e + 1)); } catch {}
    }
  }
  return null;
}

async function callGroqBatch(batch) {
  const payload = batch.map((b, i) => ({
    id: i,
    text: `Headline: ${b.title}\n\nDescription: ${b.description || '(none)'}`,
  }));

  for (let attempt = 1; attempt <= GROQ_MAX_RETRIES; attempt++) {
    await _enforceRateLimit();

    try {
      const resp = await axios.post(
        GROQ_API_URL,
        {
          model: GROQ_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(payload) },
          ],
          temperature: 0,
          max_tokens: 200 * batch.length + 200,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: GROQ_TIMEOUT_MS,
        },
      );

      const content = resp.data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Groq returned empty content');

      const parsed = extractJSON(content);
      if (!Array.isArray(parsed)) {
        throw new Error(`Expected JSON array, got: ${content.slice(0, 200)}`);
      }

      const byId = new Map();
      for (const r of parsed) {
        if (r && Number.isInteger(r.id)) byId.set(r.id, r);
      }
      return batch.map((_, i) => sanitize(byId.get(i)));
    } catch (err) {
      const status = err.response?.status;

      if (status === 429 && attempt < GROQ_MAX_RETRIES) {
        const retryAfterMs = (parseInt(err.response?.headers?.['retry-after'] || '0', 10) * 1000) || 0;
        const backoffMs = Math.min(retryAfterMs || (GROQ_MIN_INTERVAL_MS * Math.pow(2, attempt - 1)), 60000);
        console.warn(`[classifier] 429 (attempt ${attempt}/${GROQ_MAX_RETRIES}), waiting ${Math.round(backoffMs / 1000)}s…`);
        _nextSlot = Date.now() + backoffMs;
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      if (status === 503 && attempt < GROQ_MAX_RETRIES) {
        const backoffMs = Math.min(GROQ_MIN_INTERVAL_MS * Math.pow(2, attempt - 1), 30000);
        console.warn(`[classifier] 503 (attempt ${attempt}/${GROQ_MAX_RETRIES}), waiting ${Math.round(backoffMs / 1000)}s…`);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      const msg = err.response?.data?.error?.message || err.message;
      console.warn(`[classifier] Groq batch failed (${status ?? 'n/a'}): ${msg}. Dropping batch.`);
      return batch.map(() => null);
    }
  }

  return batch.map(() => null);
}

/**
 * Classify a single item. Returns the sanitized result, or null on failure.
 * Goes through prefilter and cache, same as classifyMany.
 */
async function classify(title, description = '') {
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
  const results = new Array(items.length);
  const toCall = [];

  for (let i = 0; i < items.length; i++) {
    const title = items[i].title || '';
    const description = items[i].description || '';

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

  const prefiltered = items.length - toCall.length;
  if (!toCall.length) {
    console.log(`[classifier] ${items.length} items: ${prefiltered} filtered/cached, 0 LLM calls`);
    return results;
  }

  if (!isGroqEnabled()) {
    console.warn('[classifier] GROQ_API_KEY not set — skipping LLM items.');
    for (const t of toCall) results[t.index] = null;
    return results;
  }

  const batches = [];
  for (let i = 0; i < toCall.length; i += GROQ_BATCH_SIZE) {
    batches.push(toCall.slice(i, i + GROQ_BATCH_SIZE));
  }

  const start = Date.now();
  console.log(`[classifier] ${items.length} items: ${prefiltered} filtered/cached, ${toCall.length} → ${batches.length} LLM batch(es)`);

  let incidents = 0;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
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

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[classifier] Batch done in ${elapsed}s — ${incidents} incidents from ${toCall.length} LLM items`);
  return results;
}

module.exports = { classify, classifyMany, isGroqEnabled };
