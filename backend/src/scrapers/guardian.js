'use strict';

const axios = require('axios');
const { classifyMany } = require('../classifier');
const { geocode, extractState } = require('../geocoder');
const { looksLikeSecurityIncident } = require('../classifier/prefilter');
const db = require('../db');

// Guardian API is free with no hard rate limit — run multiple focused queries.
// Each targets a different incident type so results don't heavily overlap.
const QUERIES = [
  'nigeria attack killed soldiers gunmen',
  'nigeria kidnap abduct hostage ransom',
  'boko haram ISWAP attack nigeria',
  'nigeria bomb explosion blast IED',
  'nigeria bandit massacre violence',
];

const QUERY_DELAY_MS = 1500; // polite pause between calls

function isEnabled() {
  return !!process.env.GUARDIAN_API_KEY;
}

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function buildId(webUrl) {
  return `guardian:${Buffer.from(webUrl || '').toString('base64').slice(0, 40)}`;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchQuery(query, fromDate, apiKey) {
  const params = new URLSearchParams({
    q: query,
    'api-key': apiKey,
    'show-fields': 'headline,bodyText,trailText',
    'order-by': 'newest',
    'page-size': '50',
    'from-date': fromDate,
  });
  const resp = await axios.get(
    `https://content.guardianapis.com/search?${params}`,
    { timeout: 15000 },
  );
  return resp.data?.response?.results || [];
}

async function scrapeGuardian(daysBack = 2) {
  const key = process.env.GUARDIAN_API_KEY;
  if (!key) {
    console.log('[Guardian] GUARDIAN_API_KEY not set — skipping');
    return [];
  }

  const fromDate = daysAgoISO(daysBack);
  const allResults = [];

  for (const query of QUERIES) {
    let articles = [];
    try {
      articles = await fetchQuery(query, fromDate, key);
      console.log(`[Guardian] "${query}": ${articles.length} articles`);
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.warn(`[Guardian] Query failed ("${query}"): ${msg}`);
      await db.logScrape({ source: `guardian:${query.slice(0, 40)}`, status: 'error', items_found: 0, items_added: 0, error: msg });
      await delay(QUERY_DELAY_MS);
      continue;
    }

    // 1. Build candidates — prefer bodyText > trailText for richer context
    const candidates = articles
      .filter((a) => a.webUrl && (a.fields?.headline || a.webTitle))
      .map((a) => {
        const title = (a.fields?.headline || a.webTitle || '').trim();
        const body = (a.fields?.bodyText || a.fields?.trailText || '').slice(0, 1000);
        return {
          external_id: buildId(a.webUrl),
          title: title.slice(0, 500),
          description: body,
          date: a.webPublicationDate?.slice(0, 10) || new Date().toISOString().slice(0, 10),
          source_url: a.webUrl,
        };
      });

    // 2. Pre-filter: block political reactions, require security + Nigeria signal
    const prefiltered = candidates.filter((c) =>
      looksLikeSecurityIncident(c.title, c.description),
    );

    // 3. Skip already-stored articles
    const knownIds = await db.existingExternalIds(prefiltered.map((c) => c.external_id));
    const newItems = prefiltered.filter((c) => !knownIds.has(c.external_id));

    console.log(
      `[Guardian] "${query}": ${prefiltered.length} pass prefilter, ${newItems.length} new`,
    );

    if (!newItems.length) {
      await db.logScrape({ source: `guardian:${query.slice(0, 40)}`, status: 'ok', items_found: articles.length, items_added: 0, error: null });
      await delay(QUERY_DELAY_MS);
      continue;
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
        source: 'The Guardian',
        source_url: item.source_url,
        source_type: 'guardian',
        verified: 0,
      });
      if (inserted) added++;
    }

    console.log(`[Guardian] "${query}": added=${added}`);
    await db.logScrape({ source: `guardian:${query.slice(0, 40)}`, status: 'ok', items_found: articles.length, items_added: added, error: null });
    allResults.push({ query, found: articles.length, added });
    await delay(QUERY_DELAY_MS);
  }

  const totalAdded = allResults.reduce((s, r) => s + r.added, 0);
  console.log(`[Guardian] Done. Total new: ${totalAdded}`);
  return allResults;
}

module.exports = { scrapeGuardian, isGuardianEnabled: isEnabled };
