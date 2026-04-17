"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/nigeria_security",
  ssl: process.env.DATABASE_URL?.includes("sslmode=require")
    ? { rejectUnauthorized: false }
    : false,
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

// ── Schema migrations ─────────────────────────────────────────────────────────
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS incidents (
      id          SERIAL PRIMARY KEY,
      external_id TEXT UNIQUE,
      title       TEXT NOT NULL,
      description TEXT,
      date        DATE NOT NULL,
      location    TEXT,
      state       TEXT,
      lat         REAL,
      lon         REAL,
      type        TEXT    DEFAULT 'armed_attack',
      severity    TEXT    DEFAULT 'YELLOW',
      fatalities  INTEGER DEFAULT 0,
      victims     INTEGER DEFAULT 0,
      source      TEXT,
      source_url  TEXT,
      source_type TEXT    DEFAULT 'rss',
      verified    INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scrape_logs (
      id          SERIAL PRIMARY KEY,
      source      TEXT NOT NULL,
      status      TEXT NOT NULL,
      items_found INTEGER DEFAULT 0,
      items_added INTEGER DEFAULT 0,
      error       TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_incidents_date     ON incidents(date);
    CREATE INDEX IF NOT EXISTS idx_incidents_state    ON incidents(state);
    CREATE INDEX IF NOT EXISTS idx_incidents_type     ON incidents(type);
    CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
  `);
  console.log("[DB] PostgreSQL schema ready");
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** Insert one incident. Returns true if inserted, false if duplicate. */
async function insertIncident(p) {
  const result = await pool.query(
    `
    INSERT INTO incidents
      (external_id, title, description, date, location, state, lat, lon,
       type, severity, fatalities, victims, source, source_url, source_type, verified)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (external_id) DO NOTHING
    RETURNING id
  `,
    [
      p.external_id,
      p.title,
      p.description,
      p.date,
      p.location,
      p.state,
      p.lat,
      p.lon,
      p.type,
      p.severity,
      p.fatalities,
      p.victims,
      p.source,
      p.source_url,
      p.source_type,
      p.verified,
    ],
  );
  return result.rowCount > 0;
}

/** Log a scrape run. */
async function logScrape(p) {
  await pool.query(
    `
    INSERT INTO scrape_logs (source, status, items_found, items_added, error)
    VALUES ($1,$2,$3,$4,$5)
  `,
    [
      p.source,
      p.status,
      p.items_found ?? 0,
      p.items_added ?? 0,
      p.error ?? null,
    ],
  );
}

/** Get incidents with optional filters + pagination. */
async function getIncidents({
  state,
  type,
  severity,
  from,
  to,
  limit = 100,
  offset = 0,
} = {}) {
  const conds = ["1=1"];
  const vals = [];
  let i = 1;

  if (state) {
    conds.push(`state    = $${i++}`);
    vals.push(state);
  }
  if (type) {
    conds.push(`type     = $${i++}`);
    vals.push(type);
  }
  if (severity) {
    conds.push(`severity = $${i++}`);
    vals.push(severity);
  }
  if (from) {
    conds.push(`date    >= $${i++}`);
    vals.push(from);
  }
  if (to) {
    conds.push(`date    <= $${i++}`);
    vals.push(to);
  }

  vals.push(Math.min(Number(limit) || 100, 500), Number(offset) || 0);

  const { rows } = await pool.query(
    `
    SELECT * FROM incidents
    WHERE ${conds.join(" AND ")}
    ORDER BY date DESC, id DESC
    LIMIT $${i++} OFFSET $${i}
  `,
    vals,
  );

  return rows;
}

/** Count incidents matching the same filters. */
async function countIncidents({ state, type, severity, from, to } = {}) {
  const conds = ["1=1"];
  const vals = [];
  let i = 1;

  if (state) {
    conds.push(`state    = $${i++}`);
    vals.push(state);
  }
  if (type) {
    conds.push(`type     = $${i++}`);
    vals.push(type);
  }
  if (severity) {
    conds.push(`severity = $${i++}`);
    vals.push(severity);
  }
  if (from) {
    conds.push(`date    >= $${i++}`);
    vals.push(from);
  }
  if (to) {
    conds.push(`date    <= $${i++}`);
    vals.push(to);
  }

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM incidents WHERE ${conds.join(" AND ")}`,
    vals,
  );
  return rows[0].total;
}

/** Aggregate stats + breakdowns for the dashboard. */
async function getStats() {
  const {
    rows: [stats],
  } = await pool.query(`
    SELECT
      COUNT(*)::int                                                  AS total,
      COALESCE(SUM(fatalities), 0)::int                             AS total_fatalities,
      COALESCE(SUM(victims),    0)::int                             AS total_victims,
      COUNT(*) FILTER (WHERE severity = 'RED')::int                 AS red_count,
      COUNT(*) FILTER (WHERE severity = 'ORANGE')::int              AS orange_count,
      COUNT(*) FILTER (WHERE severity = 'YELLOW')::int              AS yellow_count,
      COUNT(*) FILTER (WHERE severity = 'BLUE')::int                AS blue_count,
      COUNT(*) FILTER (WHERE source_type = 'acled')::int            AS acled_count,
      COUNT(*) FILTER (WHERE source_type = 'rss')::int              AS rss_count,
      COUNT(DISTINCT state) FILTER (WHERE state IS NOT NULL)::int   AS states_affected
    FROM incidents
  `);

  const { rows: byState } = await pool.query(`
    SELECT state, COUNT(*)::int AS count, COALESCE(SUM(fatalities),0)::int AS fatalities
    FROM incidents WHERE state IS NOT NULL
    GROUP BY state ORDER BY count DESC LIMIT 15
  `);

  const { rows: byType } = await pool.query(`
    SELECT type, COUNT(*)::int AS count
    FROM incidents GROUP BY type ORDER BY count DESC
  `);

  const { rows: last30 } = await pool.query(`
    SELECT date::text, COUNT(*)::int AS count
    FROM incidents
    WHERE date >= NOW() - INTERVAL '30 days'
    GROUP BY date ORDER BY date
  `);

  const { rows: logs } = await pool.query(`
    SELECT * FROM scrape_logs ORDER BY created_at DESC LIMIT 20
  `);

  return { stats, byState, byType, last30, logs };
}

/** Get a single incident by id. */
async function getById(id) {
  const { rows } = await pool.query("SELECT * FROM incidents WHERE id = $1", [
    id,
  ]);
  return rows[0] ?? null;
}

/** Clear all incidents and scrape logs. */
async function clearAll() {
  await pool.query("DELETE FROM incidents");
  await pool.query("DELETE FROM scrape_logs");
  console.log("[DB] All incidents and scrape logs cleared");
}

module.exports = {
  pool,
  init,
  insertIncident,
  logScrape,
  getIncidents,
  countIncidents,
  getStats,
  getById,
  clearAll,
};
