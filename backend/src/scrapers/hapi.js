'use strict';

const axios = require('axios');
const { geocode } = require('../geocoder');
const db = require('../db');

const HAPI_BASE = 'https://hapi.humdata.org/api/v2';
const APP_NAME = process.env.HAPI_APP_NAME || 'momas-security-alert';
const APP_EMAIL = process.env.HAPI_APP_EMAIL || 'user@example.com';

let encodedAppIdentifier = null;

async function getAppIdentifier() {
  if (encodedAppIdentifier) return encodedAppIdentifier;

  try {
    const resp = await axios.get(`${HAPI_BASE}/encode_app_identifier`, {
      params: { application: APP_NAME, email: APP_EMAIL },
      timeout: 10000,
    });
    encodedAppIdentifier = resp.data.encoded_app_identifier;
    return encodedAppIdentifier;
  } catch {
    const identifier = `${APP_NAME}:${APP_EMAIL}`;
    encodedAppIdentifier = Buffer.from(identifier).toString('base64');
    return encodedAppIdentifier;
  }
}

async function fetchConflictEvents(daysBack = 30) {
  const appIdentifier = await getAppIdentifier();
  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);

  const resp = await axios.get(`${HAPI_BASE}/coordination-context/conflict-events`, {
    params: {
      app_identifier: appIdentifier,
      location_code: 'NGA',
      reference_period_start_min: sinceStr,
      reference_period_start_max: todayStr,
      limit: 10000,
    },
    timeout: 30000,
  });

  return resp.data?.data || [];
}

async function fetchIDPData(daysBack = 30) {
  const appIdentifier = await getAppIdentifier();
  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);

  const resp = await axios.get(`${HAPI_BASE}/affected-people/idps`, {
    params: {
      app_identifier: appIdentifier,
      location_code: 'NGA',
      reference_period_start_min: sinceStr,
      reference_period_start_max: todayStr,
      limit: 10000,
    },
    timeout: 30000,
  });

  return resp.data?.data || [];
}

// ── Direct ACLED → internal mapping (no LLM) ──────────────────────────────
// ACLED event_type values: Battles, Violence against civilians, Explosions/Remote violence,
// Riots, Protests, Strategic developments.
function mapEventType(acledType) {
  const t = (acledType || '').toLowerCase();
  if (t.includes('explos') || t.includes('remote')) return 'bombing';
  if (t.includes('violence against civilians')) return 'massacre';
  if (t.includes('battle')) return 'armed_attack';
  if (t.includes('riot')) return 'armed_attack';
  return 'armed_attack';
}

function severityFromFatalities(fatalities, type) {
  if (fatalities >= 30) return 'RED';
  if (type === 'bombing' || type === 'massacre') {
    if (fatalities > 0) return 'RED';
  }
  if (fatalities >= 10) return 'ORANGE';
  if (fatalities >= 1) return 'YELLOW';
  return 'BLUE';
}

function severityFromDisplaced(victims) {
  if (victims >= 100_000) return 'RED';
  if (victims >= 10_000) return 'ORANGE';
  if (victims >= 1_000) return 'YELLOW';
  return 'BLUE';
}

async function fetchHAPI(daysBack = 30) {
  if (!isHAPIEnabled()) {
    await db.logScrape({ source: 'hapi', status: 'skipped', items_found: 0, items_added: 0, error: 'Disabled by HAPI_ENABLED=false' });
    return { found: 0, added: 0, skipped: true, reason: 'disabled' };
  }

  let conflictEvents = [];
  let idpData = [];

  try {
    console.log(`[HAPI] Fetching conflict events for Nigeria (last ${daysBack} days)…`);
    conflictEvents = await fetchConflictEvents(daysBack);
    console.log(`[HAPI] Received ${conflictEvents.length} conflict events`);
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    console.error(`[HAPI] Conflict events fetch failed — HTTP ${status ?? 'N/A'}: ${msg}`);
    await db.logScrape({ source: 'hapi-conflict', status: 'error', items_found: 0, items_added: 0, error: `HTTP ${status}: ${msg}` });
  }

  try {
    console.log(`[HAPI] Fetching IDP data for Nigeria (last ${daysBack} days)…`);
    idpData = await fetchIDPData(daysBack);
    console.log(`[HAPI] Received ${idpData.length} IDP records`);
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    console.error(`[HAPI] IDP data fetch failed — HTTP ${status ?? 'N/A'}: ${msg}`);
    await db.logScrape({ source: 'hapi-idp', status: 'error', items_found: 0, items_added: 0, error: `HTTP ${status}: ${msg}` });
  }

  let added = 0;

  for (const event of conflictEvents) {
    const fatalities = Number.isFinite(event.fatalities) ? Math.max(0, event.fatalities) : 0;
    const type = mapEventType(event.event_type);
    const severity = severityFromFatalities(fatalities, type);

    const location = event.admin2_name || event.admin1_name || event.location_name || 'Nigeria';
    const state = event.admin1_name || null;
    const title = `${(event.event_type || 'conflict event').replace(/_/g, ' ')} in ${location}${state && state !== location ? ` (${state})` : ''}`;
    const description = `${event.events || 1} conflict event(s) recorded with ${fatalities} fatalities between ${event.reference_period_start?.slice(0, 10) || 'N/A'} and ${event.reference_period_end?.slice(0, 10) || 'N/A'}`;

    const geo = geocode(location) || geocode(state || '');

    const inserted = await db.insertIncident({
      external_id: `hapi:${event.resource_hdx_id}:${event.event_type}:${event.reference_period_start?.slice(0, 10)}`,
      title: title.slice(0, 500),
      description: description.slice(0, 2000),
      date: event.reference_period_start?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      location: geo ? geo.matched.charAt(0).toUpperCase() + geo.matched.slice(1) : location,
      state: geo?.state || state,
      lat: geo?.lat ?? null,
      lon: geo?.lon ?? null,
      type,
      severity,
      fatalities,
      victims: 0,
      source: 'HAPI (ACLED)',
      source_url: 'https://hapi.humdata.org',
      source_type: 'hapi',
      verified: 1,
    });
    if (inserted) added++;
  }

  for (const idp of idpData) {
    const population = Number.isFinite(idp.population) ? Math.max(0, idp.population) : 0;
    if (population === 0) continue;

    const location = idp.admin2_name || idp.admin1_name || idp.location_name || 'Nigeria';
    const state = idp.admin1_name || null;
    const title = `${population.toLocaleString()} IDPs in ${location}${state && state !== location ? ` (${state})` : ''}`;
    const description = `Internally displaced persons (${idp.assessment_type || 'baseline assessment'}) — reporting round ${idp.reporting_round || 'N/A'}`;

    const geo = geocode(location) || geocode(state || '');
    const severity = severityFromDisplaced(population);

    const inserted = await db.insertIncident({
      external_id: `hapi:idp:${idp.resource_hdx_id}:${idp.reference_period_start?.slice(0, 10)}`,
      title: title.slice(0, 500),
      description: description.slice(0, 2000),
      date: idp.reference_period_start?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      location: geo ? geo.matched.charAt(0).toUpperCase() + geo.matched.slice(1) : location,
      state: geo?.state || state,
      lat: geo?.lat ?? null,
      lon: geo?.lon ?? null,
      type: 'displacement',
      severity,
      fatalities: 0,
      victims: Math.min(population, 4999),
      source: 'HAPI (IOM DTM)',
      source_url: 'https://hapi.humdata.org',
      source_type: 'hapi',
      verified: 1,
    });
    if (inserted) added++;
  }

  const totalCount = conflictEvents.length + idpData.length;
  await db.logScrape({
    source: 'hapi',
    status: 'ok',
    items_found: totalCount,
    items_added: added,
    error: null,
  });
  console.log(`[HAPI] Done. ${totalCount} records → ${added} new incidents (no LLM calls).`);
  return { found: totalCount, added };
}

function isHAPIEnabled() {
  return process.env.HAPI_ENABLED !== 'false';
}

module.exports = { fetchHAPI, isHAPIEnabled };
