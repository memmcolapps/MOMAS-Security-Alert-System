import axios from "axios";
import { classifyMany } from "../classifier";
import { geocode, extractState } from "../geocoder";
import { looksLikeSecurityIncident } from "../classifier/prefilter";
import { buildFingerprint, fingerprintsMatch } from "../classifier/fingerprint";
import * as db from "../db";

// Free tier: 100 req/day. With 30-min scrape cycles (48/day) we use 1 broad
// query per run = 48 req/day, leaving headroom for manual scrapes.
const QUERY =
  'nigeria (attack OR killed OR bomb OR explosion OR kidnap OR abduct OR bandits OR gunmen OR massacre OR terrorism OR shooting OR clash OR ambush OR herdsmen OR communal OR village raid OR hostage)';

function isEnabled() {
  return !!process.env.NEWSAPI_KEY;
}

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function buildId(url) {
  return `newsapi:${Buffer.from(url || '').toString('base64').slice(0, 40)}`;
}

function stripHtml(str) {
  return (str || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function scrapeNewsAPI(daysBack = 2) {
  const key = process.env.NEWSAPI_KEY;
  if (!key) {
    console.log('[NewsAPI] NEWSAPI_KEY not set — skipping');
    return [];
  }

  const from = daysAgoISO(daysBack);
  let raw = [];

  try {
    const params = new URLSearchParams({
      q: QUERY,
      language: 'en',
      sortBy: 'publishedAt',
      from,
      pageSize: '100',
      apiKey: key,
    });
    const resp = await axios.get(`https://newsapi.org/v2/everything?${params}`, {
      timeout: 15000,
    });
    raw = resp.data?.articles || [];
    console.log(`[NewsAPI] Fetched ${raw.length} articles`);
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.warn(`[NewsAPI] Fetch failed: ${msg}`);
    await db.logScrape({ source: 'newsapi', status: 'error', items_found: 0, items_added: 0, error: msg });
    return [];
  }

  // 1. Build candidates from valid articles only
  const candidates = raw
    .filter((a) => a.url && a.title && a.title !== '[Removed]')
    .map((a) => ({
      external_id: buildId(a.url),
      title: stripHtml(a.title).slice(0, 500),
      description: stripHtml(a.description || a.content || '').slice(0, 1000),
      date: a.publishedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      source: a.source?.name || 'NewsAPI',
      source_url: a.url,
    }));

  // 2. Pre-filter: must look like a real Nigerian security incident, not commentary
  const prefiltered = candidates.filter((c) =>
    looksLikeSecurityIncident(c.title, c.description),
  );

  // 3. Skip already-stored articles (no wasted Groq calls)
  const knownIds = await db.existingExternalIds(prefiltered.map((c) => c.external_id));
  const newItems = prefiltered.filter((c) => !knownIds.has(c.external_id));

  console.log(
    `[NewsAPI] ${raw.length} fetched → ${prefiltered.length} pass prefilter → ${newItems.length} new`,
  );

  if (!newItems.length) {
    await db.logScrape({ source: 'newsapi', status: 'ok', items_found: raw.length, items_added: 0, error: null });
    return [];
  }

  // 4. LLM classification
  const classifications = await classifyMany(
    newItems.map((i) => ({ title: i.title, description: i.description })),
  );

  let added = 0;
  for (let i = 0; i < newItems.length; i++) {
    const item = newItems[i];
    const result = classifications[i];
    if (!result?.is_security_incident) continue;

    const fullText = `${item.title} ${item.description}`;
    const geo = geocode(fullText) || geocode(item.title);
    const state = geo?.state || extractState(fullText) || null;

    // Check for existing incident with matching fingerprint
    const fp = buildFingerprint({ date: item.date, state, type: result.type, title: item.title, description: item.description });
    const matches = await db.findMatchingIncidents({ date: item.date, state, type: result.type });

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
          source: item.source,
          source_url: item.source_url,
          fatalities: result.fatalities,
          victims: result.victims,
        });
        if (merged) {
          console.log(`[NewsAPI] Merged into existing incident #${existing.id}: ${item.title.slice(0, 60)}…`);
        }
        break;
      }
    }

    if (!merged) {
      const inserted = await db.insertIncident({
        external_id: item.external_id,
        title: item.title,
        description: item.description.slice(0, 2000),
        date: item.date,
        location: geo
          ? geo.matched.charAt(0).toUpperCase() + geo.matched.slice(1)
          : state || 'Nigeria',
        state,
        lat: geo?.lat ?? null,
        lon: geo?.lon ?? null,
        type: result.type,
        severity: result.severity,
        fatalities: result.fatalities,
        victims: result.victims,
        source: item.source,
        source_url: item.source_url,
        source_type: 'newsapi',
        verified: 0,
      });
      if (inserted) added++;
    }
  }

  console.log(`[NewsAPI] Done. added=${added}`);
  await db.logScrape({ source: 'newsapi', status: 'ok', items_found: raw.length, items_added: added, error: null });
  return [{ found: raw.length, added }];
}

const isNewsAPIEnabled = isEnabled;

export { scrapeNewsAPI, isNewsAPIEnabled };
