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
      report_count INTEGER DEFAULT 1,
      sources     TEXT    DEFAULT '[]',
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

    CREATE TABLE IF NOT EXISTS sos_alerts (
      id           SERIAL PRIMARY KEY,
      sos_msg_id   INTEGER UNIQUE NOT NULL,
      device_id    TEXT NOT NULL,
      device_name  TEXT,
      triggered_at TIMESTAMPTZ NOT NULL,
      location_lat REAL,
      location_lon REAL,
      location_raw TEXT,
      status       INTEGER DEFAULT 0,
      resolved_at  TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_sos_status      ON sos_alerts(status);
    CREATE INDEX IF NOT EXISTS idx_sos_triggered   ON sos_alerts(triggered_at);
    CREATE INDEX IF NOT EXISTS idx_sos_device      ON sos_alerts(device_id);

    CREATE TABLE IF NOT EXISTS devices (
      device_id   TEXT PRIMARY KEY,
      name        TEXT,
      company     TEXT,
      operator    TEXT,
      device_type TEXT,
      notes       TEXT,
      active      BOOLEAN     DEFAULT true,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add new columns if they don't exist (idempotent migration)
  try {
    await pool.query(`
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS report_count INTEGER DEFAULT 1;
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS sources TEXT DEFAULT '[]';
    `);
  } catch (err) {
    console.warn("[DB] Column migration note:", err.message);
  }

  try {
    await pool.query(`
      ALTER TABLE sos_alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
    `);
  } catch (err) {
    console.warn("[DB] SOS migration note:", err.message);
  }

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

/** Count + aggregate incidents matching the same filters. */
async function countIncidents({ state, type, severity, from, to } = {}) {
  const conds = ["1=1"];
  const vals = [];
  let i = 1;

  if (state)    { conds.push(`state    = $${i++}`); vals.push(state); }
  if (type)     { conds.push(`type     = $${i++}`); vals.push(type); }
  if (severity) { conds.push(`severity = $${i++}`); vals.push(severity); }
  if (from)     { conds.push(`date    >= $${i++}`); vals.push(from); }
  if (to)       { conds.push(`date    <= $${i++}`); vals.push(to); }

  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int                       AS total,
       COALESCE(SUM(fatalities), 0)::int   AS sum_fatalities,
       COALESCE(SUM(victims),    0)::int   AS sum_victims
     FROM incidents WHERE ${conds.join(" AND ")}`,
    vals,
  );
  return rows[0];
}

/** Check which external_ids already exist (for dedup before LLM classification). */
async function existingExternalIds(ids) {
  if (!ids.length) return new Set();
  const { rows } = await pool.query(
    `SELECT external_id FROM incidents WHERE external_id = ANY($1)`,
    [ids],
  );
  return new Set(rows.map((r) => r.external_id));
}

/** Find incidents matching a fingerprint within the dedup window. */
async function findMatchingIncidents({ date, state, type }) {
  const { rows } = await pool.query(
    `SELECT id, date, state, type, fatalities, victims, title, description,
            report_count, sources, severity
     FROM incidents
     WHERE date >= $1::DATE - INTERVAL '1 day'
       AND date <= $1::DATE + INTERVAL '1 day'
       AND type = $2
       AND (state IS NULL OR state = $3 OR $3 IS NULL)
     ORDER BY date DESC, report_count DESC`,
    [date, type, state?.toLowerCase() || null],
  );
  return rows;
}

/**
 * Merge a new report into an existing incident.
 * Updates report_count, sources array, and takes the max casualty count.
 * Returns true if merged successfully.
 */
async function mergeIntoIncident(incidentId, { source, source_url, fatalities, victims }) {
  const result = await pool.query(
    `UPDATE incidents
     SET report_count = report_count + 1,
         sources = jsonb_build_array(
           jsonb_build_object('source', $2, 'url', $3)
         ) || sources,
         fatalities = GREATEST(fatalities, $4),
         victims = GREATEST(victims, $5),
         updated_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [incidentId, source, source_url, fatalities || 0, victims || 0],
  );
  return result.rowCount > 0;
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

// ── SOS alerts ────────────────────────────────────────────────────────────────

async function insertSosAlert({ sos_msg_id, device_id, device_name, triggered_at, location_lat, location_lon, location_raw }) {
  const { rows } = await pool.query(
    `INSERT INTO sos_alerts (sos_msg_id, device_id, device_name, triggered_at, location_lat, location_lon, location_raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (sos_msg_id) DO NOTHING
     RETURNING *`,
    [sos_msg_id, device_id, device_name, triggered_at, location_lat ?? null, location_lon ?? null, location_raw ?? null],
  );
  return rows[0] ?? null; // null = already existed (duplicate)
}

async function acknowledgeSosAlert(sos_msg_id) {
  const { rows } = await pool.query(
    `UPDATE sos_alerts SET status=1, acknowledged_at=NOW()
     WHERE sos_msg_id=$1 AND status=0
     RETURNING *`,
    [sos_msg_id],
  );
  return rows[0] ?? null;
}

async function resolveSosAlert(sos_msg_id) {
  const { rows } = await pool.query(
    `UPDATE sos_alerts SET status=2, resolved_at=NOW()
     WHERE sos_msg_id=$1 AND status < 2
     RETURNING *`,
    [sos_msg_id],
  );
  return rows[0] ?? null;
}

async function listSosAlerts() {
  // Show: unresolved (any date) + resolved today (by our clock, not POCSTARS clock)
  const { rows } = await pool.query(`
    SELECT * FROM sos_alerts
    WHERE status < 2
       OR resolved_at::date = CURRENT_DATE
    ORDER BY created_at DESC
  `);
  return rows;
}

async function allSosMsgIds() {
  // All IDs ever seen — used for sound dedup regardless of resolution status/date
  const { rows } = await pool.query(`SELECT sos_msg_id FROM sos_alerts`);
  return new Set(rows.map((r) => r.sos_msg_id));
}

// ── Device registry ───────────────────────────────────────────────────────────

async function listDevices() {
  const { rows } = await pool.query(
    "SELECT * FROM devices ORDER BY created_at DESC",
  );
  return rows;
}

async function upsertDevice({ device_id, name, company, operator, device_type, notes, active }) {
  const { rows } = await pool.query(
    `INSERT INTO devices (device_id, name, company, operator, device_type, notes, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (device_id) DO UPDATE SET
       name        = EXCLUDED.name,
       company     = EXCLUDED.company,
       operator    = EXCLUDED.operator,
       device_type = EXCLUDED.device_type,
       notes       = EXCLUDED.notes,
       active      = EXCLUDED.active
     RETURNING *`,
    [device_id, name || null, company || null, operator || null, device_type || null, notes || null, active ?? true],
  );
  return rows[0];
}

async function deleteDevice(device_id) {
  const { rowCount } = await pool.query(
    "DELETE FROM devices WHERE device_id = $1",
    [device_id],
  );
  return rowCount > 0;
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
  existingExternalIds,
  findMatchingIncidents,
  mergeIntoIncident,
  getStats,
  getById,
  clearAll,
  listDevices,
  upsertDevice,
  deleteDevice,
  insertSosAlert,
  acknowledgeSosAlert,
  resolveSosAlert,
  listSosAlerts,
  allSosMsgIds,
};
