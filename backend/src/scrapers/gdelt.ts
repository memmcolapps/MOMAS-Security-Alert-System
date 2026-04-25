import axios from "axios";
import { classifyMany } from "../classifier";
import { geocode, extractState } from "../geocoder";
import { buildFingerprint, fingerprintsMatch } from "../classifier/fingerprint";
import * as db from "../db";

const GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';

const QUERY_GROUPS = [
  'theme:KILL',
  'theme:KIDNAP',
  'theme:ATTACK',
  'theme:SUICIDE_BOMB',
  'theme:TERROR',
  'theme:WB_2432_CONFLICT',
  '"gunmen"',
  '"bandits"',
  '"herdsmen"',
  '"ambush"',
  '"massacre"',
  '"clash"',
  '"abducted"',
];

const QUERY_DELAY_MS = 15000;
const RATE_LIMIT_BACKOFF_MS = 15000;
const PROBE_MAX_WAIT_MS = 90000;
const PROBE_WAIT_STEP_MS = 15000;

// ─── Source credibility tiers ───────────────────────────────────────────────
const TIER_A_SOURCES = new Set([
  'punchng.com', 'premiumtimesng.com', 'channelstv.com',
  'thecable.ng', 'dailytrust.com', 'vanguardngr.com',
  'guardian.ng', 'thenationonlineng.net', 'tribuneonlineng.com',
  'thisday.ng', 'saharareporters.com',
]);

const TIER_B_SOURCES = new Set([
  'lindaikejisblog.com', 'legit.ng', 'naijanews.com',
  'pulse.ng', 'dailypost.ng', 'sunnewsonline.com', 'blueprint.ng',
]);

const WIRE_SOURCES = new Set([
  'reuters.com', 'aljazeera.com', 'bbc.com', 'bbc.co.uk',
  'apnews.com', 'france24.com',
]);

const SOURCE_MODIFIER = { wire: 15, A: 10, B: 0, C: -15 };

function getSourceTier(domain) {
  if (!domain) return 'C';
  const d = domain.toLowerCase().replace(/^www\./, '');
  if (WIRE_SOURCES.has(d)) return 'wire';
  if (TIER_A_SOURCES.has(d)) return 'A';
  if (TIER_B_SOURCES.has(d)) return 'B';
  return 'C';
}

// ─── Clustering ────────────────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildClusters(events, radiusKm = 50, timeWindowMs = 24 * 3600 * 1000) {
  const clusters = [];

  for (const ev of events) {
    if (!ev.lat || !ev.lon) {
      clusters.push({
        events: [ev],
        centroid: { lat: ev.lat || 0, lon: ev.lon || 0 },
        latestDateMs: ev.dateAddedMs,
        maxConfidence: ev.confidence || 0,
        sourceDomains: new Set([ev.domain || '']),
        closed: false,
      });
      continue;
    }

    let matched = null;
    for (const cl of clusters) {
      if (cl.closed) continue;

      const dist = haversineKm(cl.centroid.lat, cl.centroid.lon, ev.lat, ev.lon);
      const timeDiff = Math.abs(ev.dateAddedMs - cl.latestDateMs);

      if (dist < radiusKm && timeDiff < timeWindowMs) {
        matched = cl;
        break;
      }
    }

    if (matched) {
      matched.events.push(ev);
      const n = matched.events.length;
      matched.centroid.lat = ((matched.centroid.lat * (n - 1)) + ev.lat) / n;
      matched.centroid.lon = ((matched.centroid.lon * (n - 1)) + ev.lon) / n;
      matched.latestDateMs = Math.max(matched.latestDateMs, ev.dateAddedMs);
      matched.maxConfidence = Math.max(matched.maxConfidence, ev.confidence || 0);
      matched.sourceDomains.add(ev.domain || '');
    } else {
      clusters.push({
        events: [ev],
        centroid: { lat: ev.lat, lon: ev.lon },
        latestDateMs: ev.dateAddedMs,
        maxConfidence: ev.confidence || 0,
        sourceDomains: new Set([ev.domain || '']),
        closed: false,
      });
    }
  }

  return clusters;
}

function computeIncidentConfidence(cluster) {
  const baseScore = cluster.maxConfidence;
  let bestTier = 'C';
  for (const d of cluster.sourceDomains) {
    const t = getSourceTier(d);
    if (t === 'wire') { bestTier = 'wire'; break; }
    if (t === 'A' && bestTier !== 'wire') bestTier = 'A';
    if (t === 'B' && bestTier === 'C') bestTier = 'B';
  }
  const sourceMod = SOURCE_MODIFIER[bestTier];
  const volumeBonus = Math.min(cluster.sourceDomains.size * 3, 15);
  const tonePenalty = cluster.avgTone > -3 ? -10 : 0;

  const finalScore = baseScore + sourceMod + volumeBonus + tonePenalty;
  const tier = finalScore >= 80 ? 'HIGH' : finalScore >= 60 ? 'MEDIUM' : 'TENTATIVE';

  return { score: Math.round(finalScore), tier, bestTier };
}

// ─── GDELT API query ──────────────────────────────────────────────────────
function buildQueries() {
  return QUERY_GROUPS.map((group) => `sourcecountry:nigeria ${group}`);
}

function parseGDELTDate(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const [, y, mo, d, h, mi, se] = m;
  const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}Z`);
  return isNaN(dt.getTime()) ? null : dt;
}

function parseArticles(data) {
  if (!data?.articles || !Array.isArray(data.articles)) return [];
  return data.articles.map((a) => {
    const domain = (() => {
      try { return new URL(a.url).hostname; } catch { return ''; }
    })();
    const parsedDate = parseGDELTDate(a.seendate) || new Date();
    return {
      title: a.title || '',
      url: a.url || '',
      domain,
      sourceCountry: a.sourceCountry || '',
      datePublished: parsedDate.toISOString(),
      dateAddedMs: parsedDate.getTime(),
      tone: a.tone || 0,
      themes: a.themes || [],
      lat: a.lat || null,
      lon: a.lng || null,
      locationName: a.locationName || '',
    };
  });
}

async function probeRateLimit() {
  const probeUrl = `${GDELT_URL}?query=${encodeURIComponent('sourcecountry:nigeria')}&mode=artlist&format=json&timespan=1d&maxrecords=1`;
  const deadline = Date.now() + PROBE_MAX_WAIT_MS;

  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await axios.get(probeUrl, { timeout: 30000 });
      if (typeof resp.data === 'object' && resp.data !== null) {
        console.log(`[GDELT] Probe OK on attempt ${attempt} — rate-limit clear, proceeding.`);
        return { ok: true };
      }
      console.warn('[GDELT] Probe got non-JSON response — proceeding anyway.');
      return { ok: true };
    } catch (err) {
      const status = err.response?.status;
      if (status !== 429) {
        console.warn(`[GDELT] Probe failed (${status ?? 'N/A'}): ${err.message} — proceeding anyway.`);
        return { ok: true };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        console.error(`[GDELT] Probe still rate-limited after ${PROBE_MAX_WAIT_MS / 1000}s — aborting.`);
        return { ok: false, reason: 'rate_limited' };
      }
      const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '0', 10);
      const waitMs = Math.min(
        retryAfter > 0 ? retryAfter * 1000 : PROBE_WAIT_STEP_MS,
        remaining,
      );
      console.warn(`[GDELT] Probe ${attempt}: rate-limited. Waiting ${waitMs / 1000}s before re-probing (${Math.round(remaining / 1000)}s budget left)…`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function fetchOneQuery(query, daysBack, retries = 3) {
  const timespan = `${daysBack}d`;
  const url = `${GDELT_URL}?query=${encodeURIComponent(query)}&mode=artlist&format=json&timespan=${timespan}&maxrecords=250&sort=datedesc`;

  let hitRateLimit = false;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await axios.get(url, { timeout: 60000 });
      if (typeof resp.data !== 'object' || resp.data === null) {
        console.warn(`[GDELT] Non-JSON response for query: ${query}`);
        return { articles: [], hitRateLimit };
      }
      return { articles: parseArticles(resp.data), hitRateLimit };
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < retries) {
        hitRateLimit = true;
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '0', 10);
        const base = retryAfter > 0 ? retryAfter * 1000 : RATE_LIMIT_BACKOFF_MS;
        const waitMs = Math.min(base * attempt, 60000);
        console.warn(`[GDELT] Rate limited (429). Waiting ${waitMs / 1000}s before retry ${attempt}/${retries - 1}…`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      console.warn(`[GDELT] Query failed (${status ?? 'N/A'}): ${query} — ${err.message}`);
      return { articles: [], hitRateLimit: status === 429 };
    }
  }
  console.warn(`[GDELT] Query exhausted retries: ${query}`);
  return { articles: [], hitRateLimit: true };
}

async function fetchGDELTArticles(daysBack = 7) {
  const probe = await probeRateLimit();
  if (!probe.ok) {
    const err: any = new Error(`GDELT rate-limited (probe did not clear within ${PROBE_MAX_WAIT_MS / 1000}s)`);
    err.code = 'RATE_LIMITED';
    throw err;
  }

  const queries = buildQueries();
  const seen = new Map();
  let lastWasRateLimited = false;

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const delay = lastWasRateLimited ? QUERY_DELAY_MS * 2 : QUERY_DELAY_MS;
    await new Promise((r) => setTimeout(r, delay));

    const { articles, hitRateLimit } = await fetchOneQuery(q, daysBack);
    lastWasRateLimited = hitRateLimit;
    console.log(`[GDELT]   query "${q}" → ${articles.length} articles`);
    for (const a of articles) {
      if (a.url && !seen.has(a.url)) seen.set(a.url, a);
    }
  }

  return Array.from(seen.values());
}

// ─── Main scrape ──────────────────────────────────────────────────────────
async function scrapeGDELT(daysBack = 7) {
  if (!isGDELTEnabled()) {
    await db.logScrape({ source: 'gdelt', status: 'skipped', items_found: 0, items_added: 0, error: 'Disabled by GDELT_ENABLED=false' });
    return { found: 0, added: 0, skipped: true, reason: 'disabled' };
  }

  let articles = [];
  try {
    console.log(`[GDELT] Fetching Nigeria security articles (last ${daysBack} days)…`);
    articles = await fetchGDELTArticles(daysBack);
    console.log(`[GDELT] Received ${articles.length} articles`);
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error || err.message;
    console.error(`[GDELT] Fetch failed — HTTP ${status ?? 'N/A'}: ${msg}`);
    await db.logScrape({ source: 'gdelt', status: 'error', items_found: 0, items_added: 0, error: `HTTP ${status}: ${msg}` });
    return { found: 0, added: 0, error: msg };
  }

  if (articles.length === 0) {
    await db.logScrape({ source: 'gdelt', status: 'ok', items_found: 0, items_added: 0, error: null });
    return { found: 0, added: 0 };
  }

  const scored = articles.map((a) => {
    const tier = getSourceTier(a.domain);
    const modifier = SOURCE_MODIFIER[tier];
    const baseConfidence = 70;
    return {
      ...a,
      sourceTier: tier,
      confidence: Math.min(100, baseConfidence + modifier),
    };
  });

  const clusters = buildClusters(scored, 50, 24 * 3600 * 1000);

  // Filter out TENTATIVE clusters without tier-A/wire before classifying
  const candidateClusters = clusters.filter((cluster) => {
    const { tier: confidenceTier, bestTier } = computeIncidentConfidence(cluster);
    return !(confidenceTier === 'TENTATIVE' && bestTier !== 'wire' && bestTier !== 'A');
  });

  console.log(`[GDELT] Classifying ${candidateClusters.length} clusters…`);

  const classifyItems = candidateClusters.map((cluster) => {
    const firstEv = cluster.events[0];
    const allTitles = cluster.events.map(e => e.title).filter(Boolean);
    const title = allTitles[0] || `Security incident in ${firstEv.locationName || 'Nigeria'}`;
    const allUrls = [...new Set(cluster.events.map(e => e.url).filter(Boolean))];
    const description = `${cluster.events.length} report(s) from ${cluster.sourceDomains.size} source(s)`;
    return { title, description, cluster, allUrls };
  });

  const results = await classifyMany(
    classifyItems.map((ci) => ({ title: ci.title, description: ci.description })),
  );

  let added = 0;
  let skipped = 0;

  for (let i = 0; i < classifyItems.length; i++) {
    const { title, description, cluster, allUrls } = classifyItems[i];
    const firstEv = cluster.events[0];
    const result = results[i];

    if (!result || !result.is_security_incident) {
      skipped++;
      continue;
    }

    const { type, fatalities, victims, severity } = result;

    let geo = null;
    if (cluster.centroid.lat && cluster.centroid.lon) {
      geo = { lat: cluster.centroid.lat, lon: cluster.centroid.lon, matched: firstEv.locationName || '' };
    }
    if (!geo?.lat) {
      geo = geocode(`${title} ${description}`) || geocode(firstEv.locationName || '');
    }

    const state = geo?.state || extractState(`${title} ${description}`) || firstEv.locationName || null;
    const dateStr = firstEv.datePublished?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    const { tier: confidenceTier } = computeIncidentConfidence(cluster);

    // Check for existing incident with matching fingerprint
    const fp = buildFingerprint({ date: dateStr, state, type, title, description });
    const matches = await db.findMatchingIncidents({ date: dateStr, state, type });

    let merged = false;
    for (const existing of matches) {
      const existingFp = buildFingerprint({
        date: existing.date.toISOString().slice(0, 10),
        state: existing.state,
        type: existing.type,
        title: existing.title,
        description: existing.description,
      });
      if (fingerprintsMatch(fp, existingFp)) {
        merged = await db.mergeIntoIncident(existing.id, {
          source: `GDELT (${firstEv.domain || 'unknown'})`,
          source_url: allUrls[0],
          fatalities,
          victims,
        });
        if (merged) {
          console.log(`[GDELT] Merged into existing incident #${existing.id}: ${title.slice(0, 60)}…`);
        }
        break;
      }
    }

    if (!merged) {
      const inserted = await db.insertIncident({
        external_id: `gdelt:${Buffer.from(allUrls[0] || title).toString('base64').slice(0, 40)}`,
        title: title.slice(0, 500),
        description: description.slice(0, 2000),
        date: dateStr,
        location: geo?.matched?.charAt(0).toUpperCase() + (geo?.matched?.slice(1) || '') || state || 'Nigeria',
        state,
        lat: geo?.lat ?? null,
        lon: geo?.lon ?? null,
        type,
        severity,
        fatalities,
        victims,
        source: `GDELT (${firstEv.domain || 'unknown'})`,
        source_url: allUrls[0] || null,
        source_type: 'gdelt',
        verified: confidenceTier === 'HIGH' ? 1 : 0,
      });

      if (inserted) added++;
    }
  }

  await db.logScrape({ source: 'gdelt', status: 'ok', items_found: articles.length, items_added: added, error: null });
  console.log(`[GDELT] Done. Found ${articles.length} articles, clustered ${clusters.length}, classified ${candidateClusters.length}, skipped ${skipped}, added ${added} new incidents.`);
  return { found: articles.length, added, skipped, clusters: clusters.length };
}

function isGDELTEnabled() {
  return process.env.GDELT_ENABLED !== 'false';
}

export { scrapeGDELT, isGDELTEnabled };
