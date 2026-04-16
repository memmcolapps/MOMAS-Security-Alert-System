'use strict';

/**
 * HAPI (Humanitarian API) scraper — fetches conflict events and displacement data.
 *
 * API: https://hapi.humdata.org
 * Docs: https://hapi.humdata.org/docs
 */

const axios = require('axios');
const { classify } = require('../classifier');
const { geocode, extractState } = require('../geocoder');
const db = require('../db');

const HAPI_BASE = 'https://hapi.humdata.org/api/v2';
const APP_NAME = process.env.HAPI_APP_NAME || 'momas-security-alert';
const APP_EMAIL = process.env.HAPI_APP_EMAIL || 'user@example.com';

// Cache the encoded app identifier
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
  } catch (err) {
    // Fallback: manually encode
    const identifier = `${APP_NAME}:${APP_EMAIL}`;
    encodedAppIdentifier = Buffer.from(identifier).toString('base64');
    return encodedAppIdentifier;
  }
}

// Event type mapping from HAPI to our internal types
const EVENT_TYPE_MAP = {
  'political_violence': 'armed_attack',
  'civilian_targeting': 'massacre',
  'demonstration': 'displacement',
};

// Sub-event type mapping
const SUB_EVENT_TYPE_MAP = {
  'armed_clash': 'armed_attack',
  'attack': 'armed_attack',
  'suicide_bomb': 'bombing',
  'remote_explosive_landmine_ied': 'bombing',
  'air_drone_strike': 'bombing',
  'grenade': 'bombing',
  'abduction_forced_disappearance': 'kidnapping',
  'looting_property_destruction': 'banditry',
  'mob_violence': 'cult_violence',
  'peaceful_protest': 'displacement',
  'protest_with_intervention': 'displacement',
  'violent_demonstration': 'armed_attack',
  'strategic_development': 'armed_attack',
  'agreement': 'displacement',
  'change_to_group_fabric': 'displacement',
  'non_violent_transfer_of_power': 'displacement',
};

function hapiSeverity(fatalities, type) {
  if (fatalities >= 30 || type === 'massacre') return 'RED';
  if (type === 'bombing' && fatalities > 0) return 'RED';
  if (fatalities >= 10) return 'ORANGE';
  if (type === 'terrorism' && fatalities > 0) return 'ORANGE';
  if (fatalities >= 1) return 'YELLOW';
  if (type === 'kidnapping') return 'YELLOW';
  return 'BLUE';
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
      start_date: sinceStr,
      end_date: todayStr,
      limit: 10000,
      output_format: 'json',
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
      start_date: sinceStr,
      end_date: todayStr,
      limit: 10000,
      output_format: 'json',
    },
    timeout: 30000,
  });

  return resp.data?.data || [];
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

  // Process conflict events
  for (const event of conflictEvents) {
    const eventType = EVENT_TYPE_MAP[event.event_type] || 'armed_attack';
    const fatalities = event.fatalities || 0;
    const location = event.admin2_name || event.admin1_name || event.location_name || 'Nigeria';
    const state = event.admin1_name || null;
    
    // HAPI provides aggregated events with counts, not individual incidents
    // We create one incident record per event with the event count as metadata
    const title = `${event.event_type.replace(/_/g, ' ')} in ${location}${state ? ` (${state})` : ''}`;
    const description = `${event.events} conflict events recorded with ${fatalities} fatalities between ${event.reference_period_start?.slice(0, 10)} and ${event.reference_period_end?.slice(0, 10)}`;
    
    const severity = hapiSeverity(fatalities, eventType);
    
    // Try to get coordinates from admin codes (HAPI doesn't provide direct lat/lon in conflict events)
    // We'll use the geocoder to find approximate location
    const geo = geocode(location) || geocode(state || '');
    
    const dateStr = event.reference_period_start?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    
    const inserted = await db.insertIncident({
      external_id: `hapi:${event.resource_hdx_id}:${event.event_type}:${event.reference_period_start?.slice(0, 10)}`,
      title: title.slice(0, 500),
      description: description.slice(0, 2000),
      date: dateStr,
      location: location,
      state: state,
      lat: geo?.lat ?? null,
      lon: geo?.lon ?? null,
      type: eventType,
      severity: severity,
      fatalities: fatalities,
      victims: 0,
      source: 'HAPI (ACLED)',
      source_url: 'https://hapi.humdata.org',
      source_type: 'hapi',
      verified: 1,
    });

    if (inserted) added++;
  }

  // Process IDP data
  for (const idp of idpData) {
    const location = idp.admin2_name || idp.admin1_name || idp.location_name || 'Nigeria';
    const state = idp.admin1_name || null;
    const population = idp.population || 0;
    
    if (population === 0) continue; // Skip records with no population data
    
    const title = `${population.toLocaleString()} IDPs in ${location}${state ? ` (${state})` : ''}`;
    const description = `Internally displaced persons (${idp.assessment_type || 'baseline assessment'}) — reporting round ${idp.reporting_round || 'N/A'}`;
    
    const geo = geocode(location) || geocode(state || '');
    const dateStr = idp.reference_period_start?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    
    const inserted = await db.insertIncident({
      external_id: `hapi:idp:${idp.resource_hdx_id}:${idp.reference_period_start?.slice(0, 10)}`,
      title: title.slice(0, 500),
      description: description.slice(0, 2000),
      date: dateStr,
      location: location,
      state: state,
      lat: geo?.lat ?? null,
      lon: geo?.lon ?? null,
      type: 'displacement',
      severity: population > 100000 ? 'RED' : population > 50000 ? 'ORANGE' : population > 10000 ? 'YELLOW' : 'BLUE',
      fatalities: 0,
      victims: population,
      source: 'HAPI (IOM DTM)',
      source_url: 'https://hapi.humdata.org',
      source_type: 'hapi',
      verified: 1,
    });

    if (inserted) added++;
  }

  await db.logScrape({ 
    source: 'hapi', 
    status: 'ok', 
    items_found: conflictEvents.length + idpData.length, 
    items_added: added, 
    error: null 
  });
  console.log(`[HAPI] Done. Found ${conflictEvents.length} conflict events, ${idpData.length} IDP records. Added ${added} new incidents.`);
  return { found: conflictEvents.length + idpData.length, added };
}

function isHAPIEnabled() {
  return process.env.HAPI_ENABLED !== 'false';
}

module.exports = { fetchHAPI, isHAPIEnabled };
