'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { scrapeAll }   = require('../scrapers/rss');
const { fetchHAPI }   = require('../scrapers/hapi');
const { scrapeReliefWeb } = require('../scrapers/reliefweb');
const { scrapeGDELT } = require('../scrapers/gdelt');

// ── GET /api/incidents ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { state, type, severity, from, to, limit = 100, offset = 0 } = req.query;
    const [incidents, total] = await Promise.all([
      db.getIncidents({ state, type, severity, from, to, limit, offset }),
      db.countIncidents({ state, type, severity, from, to }),
    ]);
    res.json({ total, count: incidents.length, incidents });
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
    await Promise.all([
      scrapeAll(),
      fetchHAPI(parseInt(req.body?.days_back) || 7),
      scrapeReliefWeb(parseInt(req.body?.days_back) || 7),
      scrapeGDELT(parseInt(req.body?.days_back) || 7),
    ]);
  } catch (err) {
    console.error('[Scrape] Manual scrape error:', err.message);
  }
});

module.exports = router;
