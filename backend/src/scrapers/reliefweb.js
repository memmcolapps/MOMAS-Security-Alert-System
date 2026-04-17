'use strict';

const axios = require('axios');
const { classifyMany } = require('../classifier');
const { geocode, extractState } = require('../geocoder');
const db = require('../db');

const RELIEFWEB_URL = 'https://api.reliefweb.int/v2/reports';
const APPNAME = process.env.RELIEFWEB_APPNAME || 'momas-security-alert';

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

  console.log(`[ReliefWeb] ${reports.length} reports fetched, classifying…`);

  const reportItems = reports.map((report) => {
    const fields = report.fields || {};
    return {
      title: fields.title || '',
      description: fields.description || '',
      sourceName: fields.source?.name || 'ReliefWeb',
      sourceUrl: fields.url || 'https://reliefweb.int',
      dateCreated: fields.date?.created || new Date().toISOString(),
      keywords: fields.keyword || [],
      reportId: report.id,
    };
  });

  console.log(`[ReliefWeb] Classifying ${reportItems.length} reports…`);

  const results = await classifyMany(
    reportItems.map((ri) => ({ title: ri.title, description: ri.description })),
  );

  let added = 0;
  let skipped = 0;

  for (let i = 0; i < reportItems.length; i++) {
    const ri = reportItems[i];
    const result = results[i];

    if (!result || !result.is_security_incident) {
      skipped++;
      continue;
    }

    const { type, fatalities, victims, severity } = result;
    const fullText = `${ri.title} ${ri.description} ${ri.keywords.join(' ')}`;
    const geo = geocode(fullText) || geocode(ri.title);
    const state = geo?.state || extractState(fullText) || null;
    const dateStr = ri.dateCreated.slice(0, 10);

    const inserted = await db.insertIncident({
      external_id: `reliefweb:${ri.reportId}`,
      title: ri.title.slice(0, 500),
      description: ri.description.slice(0, 2000),
      date: dateStr,
      location: geo ? geo.matched.charAt(0).toUpperCase() + geo.matched.slice(1) : state || 'Nigeria',
      state,
      lat: geo?.lat ?? null,
      lon: geo?.lon ?? null,
      type,
      severity,
      fatalities,
      victims,
      source: ri.sourceName,
      source_url: ri.sourceUrl,
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