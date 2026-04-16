'use strict';

/**
 * ReliefWeb API scraper — fetches humanitarian reports for Nigeria.
 *
 * API: https://api.reliefweb.int/v2/reports
 * Docs: https://apidoc.reliefweb.int/
 */

const axios = require('axios');
const { classify } = require('../classifier');
const { geocode, extractState } = require('../geocoder');
const db = require('../db');

const RELIEFWEB_URL = 'https://api.reliefweb.int/v2/reports';
const APPNAME = process.env.RELIEFWEB_APPNAME || 'momas-security-alert';

// ReliefWeb theme/category filters for security-related content
const SECURITY_THEMES = [
  'Safety and Security',
  'Protection and Human Rights',
  'Peacekeeping and Peacebuilding',
];

// Keywords that indicate security incidents in title/description
const SECURITY_KEYWORDS = [
  'attack', 'bomb', 'blast', 'explosion', 'ied', 'suicide',
  'kidnap', 'abduct', 'hostage', 'ransom',
  'kill', 'dead', 'death', 'massacre', 'slaughter',
  'gunmen', 'shooting', 'ambush', 'clash', 'conflict',
  'bandit', 'raider', 'loot', 'burn', 'destroy',
  'boko haram', 'iswap', 'terrorist', 'insurgent', 'extremist',
  'displace', 'refugee', 'flee', 'evacuat',
  'casualty', 'fatalities', 'injured', 'wounded',
  'violence', 'assault', 'raid', 'invasion',
  'militant', 'rebel', 'insurgency',
];

// Disqualifiers — reports about these are not security incidents
const EXCLUSION_KEYWORDS = [
  'funding', 'donor', 'donation', 'grant', 'budget',
  'meeting', 'conference', 'workshop', 'seminar',
  'training', 'capacity building', 'assessment',
  'policy', 'legislation', 'bill', 'parliament',
  'election', 'vote', 'campaign', 'candidate',
  'drought', 'flood', 'rainfall', 'weather', 'climate',
  'disease', 'outbreak', 'vaccination', 'immunization',
  'nutrition', 'malnutrition', 'food security',
  'shelter', 'housing', 'water supply', 'sanitation',
  'education', 'school enrollment', 'literacy',
  'economic', 'inflation', 'naira', 'gdp', 'trade',
  'agriculture', 'harvest', 'crop', 'livestock',
];

function isSecurityReport(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  
  // Must have at least one security keyword
  const hasSecurity = SECURITY_KEYWORDS.some(kw => text.includes(kw));
  if (!hasSecurity) return false;
  
  // Reject if clearly about non-security topics
  const hasExclusion = EXCLUSION_KEYWORDS.some(kw => text.includes(kw));
  if (hasExclusion) {
    // Double-check: if there are strong security terms, keep it anyway
    const strongSecurity = ['attack', 'bomb', 'blast', 'ied', 'suicide', 'kidnap', 'abduct', 'massacre', 'gunmen', 'shooting', 'boko haram', 'iswap', 'terrorist'];
    const hasStrong = strongSecurity.some(kw => text.includes(kw));
    if (!hasStrong) return false;
  }
  
  return true;
}

function mapSeverity(fatalities, type) {
  if (fatalities >= 30 || type === 'massacre') return 'RED';
  if (type === 'bombing' && fatalities > 0) return 'RED';
  if (fatalities >= 10) return 'ORANGE';
  if (type === 'terrorism' && fatalities > 0) return 'ORANGE';
  if (fatalities >= 1) return 'YELLOW';
  if (type === 'kidnapping') return 'YELLOW';
  return 'BLUE';
}

function extractFatalities(text) {
  // Try patterns like "12 killed", "killed 12", "12 dead", "12 people died"
  const patterns = [
    /(\d+)\s*(?:people|persons|civilians|soldiers)?\s*(?:killed|dead|died|dead|deaths)/i,
    /(?:killed|dead|deaths)[:\s]+(\d+)/i,
    /(\d+)\s*(?:killed|dead|deaths)/i,
    /at\s+least\s+(\d+)\s*(?:killed|dead|deaths)/i,
    /over\s+(\d+)\s*(?:killed|dead|deaths)/i,
    /more\s+than\s+(\d+)\s*(?:killed|dead|deaths)/i,
    /(\d+)\s*casualties/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > 0 && num < 100000) return num;
    }
  }
  return 0;
}

function extractVictims(text) {
  // Try patterns like "12 abducted", "kidnapped 12", "12 hostages"
  const patterns = [
    /(\d+)\s*(?:people|persons|students|civilians|girls|boys|women|men)?\s*(?:abducted|kidnapped|taken|captured|hostages)/i,
    /(?:abducted|kidnapped|taken|captured)[:\s]+(\d+)/i,
    /(\d+)\s*(?:abducted|kidnapped|hostages)/i,
    /at\s+least\s+(\d+)\s*(?:abducted|kidnapped)/i,
    /over\s+(\d+)\s*(?:abducted|kidnapped)/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > 0 && num < 100000) return num;
    }
  }
  return 0;
}

function fetchReliefWeb(daysBack = 30) {
  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);

  const query = {
    offset: 0,
    limit: 500,
    sort: { 'date.created': 'desc' },
    filter: {
      operator: 'AND',
      conditions: [
        {
          field: 'status',
          value: 'Archived',
          operator: '=',
        },
        {
          field: 'country.name',
          value: 'Nigeria',
          operator: '=',
        },
        {
          field: 'date.created',
          value: { from: sinceStr, to: todayStr },
          operator: 'BETWEEN',
        },
        {
          field: 'format.name',
          value: ['News and Press Release', 'Situation Report', 'Other'],
          operator: 'IN',
        },
      ],
    },
    fields: {
      include: [
        'title',
        'date.created',
        'date.modified',
        'source.name',
        'source.url',
        'description',
        'format.name',
        'country.name',
        'url',
        'disaster.name',
        'theme.name',
        'keyword',
      ],
    },
  };

  return axios.post(RELIEFWEB_URL, query, {
    params: { appname: APPNAME },
    timeout: 30000,
  });
}

async function scrapeReliefWeb(daysBack = 30) {
  if (!isReliefWebEnabled()) {
    await db.logScrape({ source: 'reliefweb', status: 'skipped', items_found: 0, items_added: 0, error: 'Disabled by RELIEFWEB_ENABLED=false' });
    return { found: 0, added: 0, skipped: true, reason: 'disabled' };
  }

  let reports = [];
  try {
    console.log(`[ReliefWeb] Fetching Nigeria reports (last ${daysBack} days)…`);
    const resp = await fetchReliefWeb(daysBack);
    
    if (!resp.data?.data) {
      throw new Error('Unexpected response structure');
    }
    
    reports = resp.data.data;
    console.log(`[ReliefWeb] Received ${reports.length} reports`);
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    console.error(`[ReliefWeb] Fetch failed — HTTP ${status ?? 'N/A'}: ${msg}`);
    
    await db.logScrape({ source: 'reliefweb', status: 'error', items_found: 0, items_added: 0, error: `HTTP ${status}: ${msg}` });
    return { found: 0, added: 0, error: msg };
  }

  let added = 0;
  let skipped = 0;

  for (const report of reports) {
    const fields = report.fields || {};
    const title = fields.title || '';
    const description = fields.description || '';
    const sourceName = fields.source?.name || 'ReliefWeb';
    const sourceUrl = fields.url || 'https://reliefweb.int';
    const dateCreated = fields.date?.created || new Date().toISOString();
    const themes = (fields.theme || []).map(t => t.name || '');
    const keywords = fields.keyword || [];
    
    // Combine title, description, themes, and keywords for analysis
    const fullText = `${title} ${description} ${themes.join(' ')} ${keywords.join(' ')}`;
    
    if (!isSecurityReport(title, description)) {
      skipped++;
      continue;
    }
    
    const { type, fatalities: classifiedFatalities, victims: classifiedVictims, severity } = classify(title, description);
    
    // Extract numbers from text as fallback
    const textFatalities = extractFatalities(fullText);
    const textVictims = extractVictims(fullText);
    
    const fatalities = classifiedFatalities || textFatalities;
    const victims = classifiedVictims || textVictims;
    const finalSeverity = classifiedFatalities || textFatalities ? mapSeverity(fatalities, type) : severity;
    
    const geo = geocode(fullText) || geocode(title);
    const state = geo?.state || extractState(fullText) || null;
    
    const dateStr = dateCreated.slice(0, 10);
    
    const inserted = await db.insertIncident({
      external_id: `reliefweb:${report.id}`,
      title: title.slice(0, 500),
      description: description.slice(0, 2000),
      date: dateStr,
      location: geo ? geo.matched.charAt(0).toUpperCase() + geo.matched.slice(1) : state || 'Nigeria',
      state,
      lat: geo?.lat ?? null,
      lon: geo?.lon ?? null,
      type,
      severity: finalSeverity,
      fatalities,
      victims,
      source: sourceName,
      source_url: sourceUrl,
      source_type: 'reliefweb',
      verified: 1,
    });
    
    if (inserted) added++;
  }

  await db.logScrape({ source: 'reliefweb', status: 'ok', items_found: reports.length, items_added: added, error: null });
  console.log(`[ReliefWeb] Done. Found ${reports.length}, skipped ${skipped}, added ${added} new incidents.`);
  return { found: reports.length, added, skipped };
}

function isReliefWebEnabled() {
  return process.env.RELIEFWEB_ENABLED !== 'false';
}

module.exports = { scrapeReliefWeb, isReliefWebEnabled };
