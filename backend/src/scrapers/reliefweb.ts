import axios from "axios";
import { classifyMany } from "../classifier";
import { geocode, extractState } from "../geocoder";
import { buildFingerprint, fingerprintsMatch } from "../classifier/fingerprint";
import * as db from "../db";

const RELIEFWEB_URL = 'https://api.reliefweb.int/v2/reports';
const APPNAME = process.env.RELIEFWEB_APPNAME || 'momas-security-alert';

function reliefWebDate(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

const NIGERIA_CONTEXT_RE = /\b(nigeria|nigerian|borno|yobe|adamawa|kaduna|katsina|zamfara|sokoto|kebbi|niger|plateau|benue|kogi|kwara|taraba|bauchi|gombe|fct|abuja|lagos|ogun|oyo|ondo|ekiti|edo|delta|rivers|bayelsa|akwa ibom|cross river|imo|abia|anambra|enugu|ebonyi|jigawa|kano|maiduguri|chibok|bama|gwoza|damboa|konduga|gusau|birnin gwari|chikun|kajuru|zangon kataf|makurdi|bokkos|mangu|zamfara state|katsina state)\b/i;
const SECURITY_CONTEXT_RE = /\b(attack|killed|killings?|kidnap|abduct|bandit|gunmen|violence|conflict|displacement|displaced|insecurity|iswap|boko haram|armed|clash|raid)\b/i;

function firstName(value, fallback = '') {
  if (Array.isArray(value)) return value.map((v) => v?.name).filter(Boolean).join(', ') || fallback;
  return value?.name || fallback;
}

function focusNigeriaText(title, body) {
  const chunks = String(body || '')
    .split(/\n{2,}|(?:\r?\n\s*){2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const focused = chunks.filter(
    (p) => NIGERIA_CONTEXT_RE.test(p) || (NIGERIA_CONTEXT_RE.test(title) && SECURITY_CONTEXT_RE.test(p)),
  );

  const selected = focused.length ? focused : chunks.filter((p) => SECURITY_CONTEXT_RE.test(p));
  return selected.slice(0, 6).join('\n\n') || String(body || '').slice(0, 1800);
}

function fetchReliefWeb(daysBack = 30) {
  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const sinceStr = reliefWebDate(since);
  const todayStr = reliefWebDate(new Date());

  const query = {
    offset: 0,
    limit: 500,
    sort: ['date.created:desc'],
    filter: {
      operator: 'AND',
      conditions: [
        {
          field: 'country.name',
          value: 'Nigeria',
        },
        {
          field: 'date.created',
          value: { from: sinceStr, to: todayStr },
        },
        {
          field: 'format.name',
          value: ['News and Press Release', 'Situation Report', 'Other'],
        },
      ],
    },
    query: {
      value: 'attack OR killed OR kidnap OR abduct OR bandit OR gunmen OR violence OR conflict OR displacement OR insecurity OR iswap',
      fields: ['title', 'body'],
    },
    fields: {
      include: [
        'title',
        'date.created',
        'source.name',
        'body',
        'format.name',
        'country.name',
        'country.primary',
        'url',
        'disaster.name',
        'theme.name',
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
    const msg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    console.error(`[ReliefWeb] Fetch failed — HTTP ${status ?? 'N/A'}: ${msg}`);

    await db.logScrape({ source: 'reliefweb', status: 'error', items_found: 0, items_added: 0, error: `HTTP ${status}: ${msg}` });
    return { found: 0, added: 0, error: msg };
  }

  console.log(`[ReliefWeb] ${reports.length} reports fetched, classifying…`);

  const reportItems = reports.map((report) => {
    const fields = report.fields || {};
    const title = fields.title || '';
    const body = fields.body || '';
    return {
      title,
      description: focusNigeriaText(title, body),
      contentText: body,
      sourceName: firstName(fields.source, 'ReliefWeb'),
      sourceUrl: fields.url || 'https://reliefweb.int',
      dateCreated: fields.date?.created || new Date().toISOString(),
      keywords: [
        firstName(fields.theme),
        firstName(fields.disaster),
        firstName(fields.country),
      ].filter(Boolean),
      reportId: report.id,
      raw: fields,
    };
  });

  await db.upsertSourceItems(
    reportItems.map((ri) => ({
      external_id: `reliefweb:${ri.reportId}`,
      source_type: 'reliefweb',
      source: ri.sourceName,
      title: ri.title,
      description: ri.description,
      content_text: ri.contentText,
      source_url: ri.sourceUrl,
      published_at: ri.dateCreated,
      raw: ri.raw,
    })),
  );

  const knownIncidentIds = await db.existingExternalIds(
    reportItems.map((ri) => `reliefweb:${ri.reportId}`),
  );
  const processedSourceIds = await db.existingProcessedSourceItemIds(
    reportItems.map((ri) => `reliefweb:${ri.reportId}`),
  );

  await Promise.all(
    reportItems
      .filter((ri) => knownIncidentIds.has(`reliefweb:${ri.reportId}`))
      .map((ri) =>
        db.markSourceItemProcessed(`reliefweb:${ri.reportId}`, {
          status: 'incident',
        }),
      ),
  );

  const newReportItems = reportItems.filter((ri) => {
    const id = `reliefweb:${ri.reportId}`;
    return !knownIncidentIds.has(id) && !processedSourceIds.has(id);
  });

  console.log(`[ReliefWeb] Classifying ${newReportItems.length} fresh report(s)…`);

  const results = await classifyMany(
    newReportItems.map((ri) => ({ title: ri.title, description: ri.description })),
  );

  let added = 0;
  let skipped = reportItems.length - newReportItems.length;

  for (let i = 0; i < newReportItems.length; i++) {
    const ri = newReportItems[i];
    const result = results[i];
    const external_id = `reliefweb:${ri.reportId}`;

    if (!result || !result.is_security_incident) {
      skipped++;
      await db.markSourceItemProcessed(external_id, {
        status: 'non_incident',
        content_text: ri.contentText || null,
      });
      continue;
    }

    const { type, fatalities, victims, severity } = result;
    const fullText = `${ri.title} ${ri.description} ${ri.keywords.join(' ')}`;
    const geo = geocode(fullText) || geocode(ri.title);
    const state = geo?.state || extractState(fullText) || null;
    const dateStr = ri.dateCreated.slice(0, 10);

    // Check for existing incident with matching fingerprint
    const fp = buildFingerprint({ date: dateStr, state, type, title: ri.title, description: ri.description });
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
          source: ri.sourceName,
          source_url: ri.sourceUrl,
          fatalities,
          victims,
        });
        if (merged) {
          await db.markSourceItemProcessed(external_id, {
            status: 'merged',
            incident_id: existing.id,
            content_text: ri.contentText || null,
          });
          console.log(`[ReliefWeb] Merged into existing incident #${existing.id}: ${ri.title.slice(0, 60)}…`);
        }
        break;
      }
    }

    if (!merged) {
      const inserted = await db.insertIncident({
        external_id,
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
      if (inserted) {
        await db.markSourceItemProcessed(external_id, {
          status: 'incident',
          incident_id: inserted.id,
          content_text: ri.contentText || null,
        });
      }
    }
  }

  await db.logScrape({ source: 'reliefweb', status: 'ok', items_found: reports.length, items_added: added, error: null });
  console.log(`[ReliefWeb] Done. Found ${reports.length}, skipped ${skipped}, added ${added} new incidents.`);
  return { found: reports.length, added, skipped };
}

function isReliefWebEnabled() {
  return process.env.RELIEFWEB_ENABLED !== 'false';
}

export { scrapeReliefWeb, isReliefWebEnabled };
