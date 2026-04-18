'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { scrapeAll }       = require('../scrapers/rss');
const { fetchHAPI }       = require('../scrapers/hapi');
const { scrapeReliefWeb } = require('../scrapers/reliefweb');
const { scrapeGDELT }     = require('../scrapers/gdelt');
const { scrapeNewsAPI }   = require('../scrapers/newsapi');
const { scrapeGuardian }  = require('../scrapers/guardian');

// ── Simple TTL cache (2-minute window, cleared on scrape) ─────────────────────
const _cache = new Map();
const CACHE_TTL_MS = 2 * 60 * 1000;

function getCached(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return hit.data;
}
function setCache(key, data) {
  _cache.set(key, { data, ts: Date.now() });
  if (_cache.size > 100) _cache.delete([..._cache.keys()][0]);
}
function clearCache() { _cache.clear(); }

// ── GET /api/incidents ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { state, type, severity, from, to, limit = 100, offset = 0 } = req.query;
    const key = JSON.stringify({ state, type, severity, from, to, limit, offset });
    const cached = getCached(key);
    if (cached) return res.json(cached);

    const [incidents, agg] = await Promise.all([
      db.getIncidents({ state, type, severity, from, to, limit, offset }),
      db.countIncidents({ state, type, severity, from, to }),
    ]);
    const payload = {
      total: agg.total,
      sum_fatalities: agg.sum_fatalities,
      sum_victims: agg.sum_victims,
      count: incidents.length,
      incidents,
    };
    setCache(key, payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/incidents/stats ──────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    res.json(await db.getStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/incidents/recent ─────────────────────────────────────────────────
router.get('/recent', async (req, res) => {
  try {
    const { limit = 50, severity } = req.query;
    const incidents = await db.getIncidents({ severity, limit });
    res.json({ count: incidents.length, incidents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/incidents/:id ────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const row = await db.getById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/incidents/scrape ────────────────────────────────────────────────
router.post('/scrape', async (req, res) => {
  res.json({ message: 'Scrape started', timestamp: new Date().toISOString() });
  try {
    const d = parseInt(req.body?.days_back) || 7;
    await Promise.all([
      scrapeAll(),
      fetchHAPI(d),
      scrapeReliefWeb(d),
      scrapeGDELT(d),
      scrapeNewsAPI(Math.min(d, 2)),
      scrapeGuardian(Math.min(d, 2)),
    ]);
    clearCache();
  } catch (err) {
    console.error('[Scrape] Manual scrape error:', err.message);
  }
});

// ── DELETE /api/incidents ─────────────────────────────────────────────────────
router.delete('/', async (req, res) => {
  try {
    await db.clearAll();
    res.json({ message: 'All incidents and scrape logs cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
