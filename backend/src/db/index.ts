import { Pool } from "pg";
import { env } from "../config";
import { bus } from "../events";

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
      organization_id INTEGER,
      name        TEXT,
      company     TEXT,
      operator    TEXT,
      device_type TEXT,
      notes       TEXT,
      active      BOOLEAN     DEFAULT true,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS organizations (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      slug        TEXT UNIQUE NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active',
      all_states  BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      name          TEXT,
      password_hash TEXT NOT NULL,
      platform_role TEXT NOT NULL DEFAULT 'none',
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS organization_memberships (
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role            TEXT NOT NULL DEFAULT 'viewer',
      unit_id         INTEGER,
      scope_level     TEXT NOT NULL DEFAULT 'organization',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (organization_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS organization_states (
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      state           TEXT NOT NULL,
      PRIMARY KEY (organization_id, state)
    );

    CREATE TABLE IF NOT EXISTS organization_units (
      id              SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      parent_unit_id  INTEGER REFERENCES organization_units(id) ON DELETE SET NULL,
      name            TEXT NOT NULL,
      type            TEXT,
      state           TEXT,
      lga             TEXT,
      location        TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id              SERIAL PRIMARY KEY,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action          TEXT NOT NULL,
      target_type     TEXT,
      target_id       TEXT,
      metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_memberships_user ON organization_memberships(user_id);
    CREATE INDEX IF NOT EXISTS idx_units_org ON organization_units(organization_id);
    CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(organization_id, created_at DESC);
  `);

  // Add new columns if they don't exist (idempotent migration)
  try {
    await pool.query(`
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS report_count INTEGER DEFAULT 1;
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS sources TEXT DEFAULT '[]';
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS organization_id INTEGER;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS unit_id INTEGER;
      ALTER TABLE organization_memberships ADD COLUMN IF NOT EXISTS unit_id INTEGER;
      ALTER TABLE organization_memberships ADD COLUMN IF NOT EXISTS scope_level TEXT NOT NULL DEFAULT 'organization';
      ALTER TABLE organization_units ALTER COLUMN type DROP NOT NULL;
      ALTER TABLE organization_units ALTER COLUMN type DROP DEFAULT;
      CREATE INDEX IF NOT EXISTS idx_devices_org ON devices(organization_id);
      CREATE INDEX IF NOT EXISTS idx_devices_unit ON devices(unit_id);
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

  await bootstrapPlatformAdmin();
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** Insert one incident. Returns the inserted row, or null on duplicate. */
async function insertIncident(p) {
  const result = await pool.query(
    `
    INSERT INTO incidents
      (external_id, title, description, date, location, state, lat, lon,
       type, severity, fatalities, victims, source, source_url, source_type, verified)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (external_id) DO NOTHING
    RETURNING *
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
  const row = result.rows[0] || null;
  if (row) bus.emit("incident:new", row);
  return row;
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

async function bootstrapPlatformAdmin() {
  if (!env.EPAIL_ADMIN_EMAIL || !env.EPAIL_ADMIN_PASSWORD) return;
  const existing = await getUserByEmail(env.EPAIL_ADMIN_EMAIL);
  if (existing) return;
  const password_hash = await (Bun as any).password.hash(env.EPAIL_ADMIN_PASSWORD, {
    algorithm: "bcrypt",
    cost: 10,
  });
  await pool.query(
    `INSERT INTO users (email, name, password_hash, platform_role)
     VALUES ($1, $2, $3, 'admin')`,
    [env.EPAIL_ADMIN_EMAIL.toLowerCase(), "EPAIL Admin", password_hash],
  );
  console.log(`[DB] Bootstrapped EPAIL admin user ${env.EPAIL_ADMIN_EMAIL}`);
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
  allowedStates,
  allStates = true,
}: any = {}) {
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
  if (!allStates) {
    const states = Array.isArray(allowedStates) ? allowedStates.filter(Boolean) : [];
    if (!states.length) {
      conds.push("1=0");
    } else {
      conds.push(`state = ANY($${i++})`);
      vals.push(states);
    }
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
async function countIncidents({ state, type, severity, from, to, allowedStates, allStates = true }: any = {}) {
  const conds = ["1=1"];
  const vals = [];
  let i = 1;

  if (state)    { conds.push(`state    = $${i++}`); vals.push(state); }
  if (type)     { conds.push(`type     = $${i++}`); vals.push(type); }
  if (severity) { conds.push(`severity = $${i++}`); vals.push(severity); }
  if (from)     { conds.push(`date    >= $${i++}`); vals.push(from); }
  if (to)       { conds.push(`date    <= $${i++}`); vals.push(to); }
  if (!allStates) {
    const states = Array.isArray(allowedStates) ? allowedStates.filter(Boolean) : [];
    if (!states.length) {
      conds.push("1=0");
    } else {
      conds.push(`state = ANY($${i++})`);
      vals.push(states);
    }
  }

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
       AND (state IS NULL OR LOWER(state) = $3 OR $3 IS NULL)
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
async function getStats(scope: any = {}) {
  const conds = ["1=1"];
  const vals = [];
  let i = 1;
  if (!scope.allStates) {
    const states = Array.isArray(scope.allowedStates) ? scope.allowedStates.filter(Boolean) : [];
    if (!states.length) {
      conds.push("1=0");
    } else {
      conds.push(`state = ANY($${i++})`);
      vals.push(states);
    }
  }
  const where = conds.join(" AND ");
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
    FROM incidents WHERE ${where}
  `, vals);

  const { rows: byState } = await pool.query(`
    SELECT state, COUNT(*)::int AS count, COALESCE(SUM(fatalities),0)::int AS fatalities
    FROM incidents WHERE state IS NOT NULL AND ${where}
    GROUP BY state ORDER BY count DESC LIMIT 15
  `, vals);

  const { rows: byType } = await pool.query(`
    SELECT type, COUNT(*)::int AS count
    FROM incidents WHERE ${where} GROUP BY type ORDER BY count DESC
  `, vals);

  const { rows: last30 } = await pool.query(`
    SELECT date::text, COUNT(*)::int AS count
    FROM incidents
    WHERE date >= NOW() - INTERVAL '30 days' AND ${where}
    GROUP BY date ORDER BY date
  `, vals);

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

// SELECT clause shared by all SOS reads — joins registered device fields
const SOS_WITH_DEVICE_COLS = `
  s.*,
  d.name        AS dev_name,
  d.company     AS dev_company,
  d.operator    AS dev_operator,
  d.device_type AS dev_type,
  d.notes       AS dev_notes
`;

async function _getSosWithDevice(sos_msg_id) {
  const { rows } = await pool.query(
    `SELECT ${SOS_WITH_DEVICE_COLS}
       FROM sos_alerts s
       LEFT JOIN devices d ON d.device_id = s.device_id
      WHERE s.sos_msg_id = $1`,
    [sos_msg_id],
  );
  return rows[0] ?? null;
}

async function insertSosAlert({ sos_msg_id, device_id, device_name, triggered_at, location_lat, location_lon, location_raw }) {
  const { rows } = await pool.query(
    `INSERT INTO sos_alerts (sos_msg_id, device_id, device_name, triggered_at, location_lat, location_lon, location_raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (sos_msg_id) DO NOTHING
     RETURNING sos_msg_id`,
    [sos_msg_id, device_id, device_name, triggered_at, location_lat ?? null, location_lon ?? null, location_raw ?? null],
  );
  if (!rows[0]) return null; // duplicate
  return _getSosWithDevice(rows[0].sos_msg_id);
}

async function acknowledgeSosAlert(sos_msg_id) {
  const { rowCount } = await pool.query(
    `UPDATE sos_alerts SET status=1, acknowledged_at=NOW()
     WHERE sos_msg_id=$1 AND status=0`,
    [sos_msg_id],
  );
  if (!rowCount) return null;
  return _getSosWithDevice(sos_msg_id);
}

async function resolveSosAlert(sos_msg_id) {
  const { rowCount } = await pool.query(
    `UPDATE sos_alerts SET status=2, resolved_at=NOW()
     WHERE sos_msg_id=$1 AND status < 2`,
    [sos_msg_id],
  );
  if (!rowCount) return null;
  return _getSosWithDevice(sos_msg_id);
}

async function listSosAlerts(scope: any = {}) {
  // Show: unresolved (any date) + resolved today (by our clock, not POCSTARS clock)
  const vals = [];
  const conds = [];
  if (scope.organizationId) {
    conds.push(`d.organization_id = $${vals.length + 1}`);
    vals.push(scope.organizationId);
  }
  if (scope.unitId) {
    conds.push(`d.unit_id = $${vals.length + 1}`);
    vals.push(scope.unitId);
  }
  const scopedFilter = conds.length ? `AND ${conds.join(" AND ")}` : "";
  const { rows } = await pool.query(`
    SELECT ${SOS_WITH_DEVICE_COLS}
      FROM sos_alerts s
      LEFT JOIN devices d ON d.device_id = s.device_id
     WHERE (s.status < 2
        OR s.resolved_at::date = CURRENT_DATE)
       ${scopedFilter}
     ORDER BY s.created_at DESC
  `, vals);
  return rows;
}

async function allSosMsgIds() {
  // All IDs ever seen — used for sound dedup regardless of resolution status/date
  const { rows } = await pool.query(`SELECT sos_msg_id FROM sos_alerts`);
  return new Set(rows.map((r) => r.sos_msg_id));
}

// ── Device registry ───────────────────────────────────────────────────────────

async function listDevices(scope: any = {}) {
  const vals = [];
  const conds = ["1=1"];
  if (scope.organizationId) {
    conds.push(`d.organization_id = $${vals.length + 1}`);
    vals.push(scope.organizationId);
  }
  if (scope.unitId) {
    conds.push(`d.unit_id = $${vals.length + 1}`);
    vals.push(scope.unitId);
  }
  const { rows } = await pool.query(
    `SELECT d.*, o.name AS organization_name, ou.name AS unit_name, ou.type AS unit_type
       FROM devices d
       LEFT JOIN organizations o ON o.id = d.organization_id
       LEFT JOIN organization_units ou ON ou.id = d.unit_id
      WHERE ${conds.join(" AND ")}
      ORDER BY d.created_at DESC`,
    vals,
  );
  return rows;
}

async function upsertDevice({ device_id, name, company, operator, device_type, notes, active, organization_id, unit_id }) {
  const { rows } = await pool.query(
    `INSERT INTO devices (device_id, organization_id, unit_id, name, company, operator, device_type, notes, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (device_id) DO UPDATE SET
       organization_id = EXCLUDED.organization_id,
       unit_id     = EXCLUDED.unit_id,
       name        = EXCLUDED.name,
       company     = EXCLUDED.company,
       operator    = EXCLUDED.operator,
       device_type = EXCLUDED.device_type,
       notes       = EXCLUDED.notes,
       active      = EXCLUDED.active
     RETURNING *`,
    [device_id, organization_id || null, unit_id || null, name || null, company || null, operator || null, device_type || null, notes || null, active ?? true],
  );
  return rows[0];
}

async function getDevice(device_id) {
  const { rows } = await pool.query("SELECT * FROM devices WHERE device_id = $1", [device_id]);
  return rows[0] ?? null;
}

async function updateDeviceFields(device_id, { name, operator, device_type, notes, active }) {
  const { rows } = await pool.query(
    `UPDATE devices SET
       name        = COALESCE($2, name),
       operator    = COALESCE($3, operator),
       device_type = COALESCE($4, device_type),
       notes       = COALESCE($5, notes),
       active      = COALESCE($6, active)
     WHERE device_id = $1
     RETURNING *`,
    [device_id, name ?? null, operator ?? null, device_type ?? null, notes ?? null, active ?? null],
  );
  return rows[0] ?? null;
}

async function deleteDevice(device_id) {
  const { rowCount } = await pool.query(
    "DELETE FROM devices WHERE device_id = $1",
    [device_id],
  );
  return rowCount > 0;
}

// ── Organizations / users ────────────────────────────────────────────────────

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function getUserByEmail(email) {
  const { rows } = await pool.query("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
  return rows[0] ?? null;
}

async function getUserById(id) {
  const { rows } = await pool.query("SELECT id, email, name, platform_role, status, created_at FROM users WHERE id = $1", [id]);
  return rows[0] ?? null;
}

async function getMembershipsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT m.organization_id, m.role, m.unit_id, m.scope_level,
            o.name, o.slug, o.status, o.all_states,
            u.name AS unit_name, u.type AS unit_type, u.state AS unit_state,
            COUNT(os.state)::int AS state_count
       FROM organization_memberships m
       JOIN organizations o ON o.id = m.organization_id
       LEFT JOIN organization_units u ON u.id = m.unit_id
       LEFT JOIN organization_states os ON os.organization_id = o.id
      WHERE m.user_id = $1
      GROUP BY m.organization_id, m.role, m.unit_id, m.scope_level, o.name, o.slug, o.status, o.all_states, u.name, u.type, u.state
      ORDER BY o.name`,
    [userId],
  );
  return rows;
}

async function getMembership(organizationId, userId) {
  const { rows } = await pool.query(
    `SELECT m.*, u.name AS unit_name, u.type AS unit_type, u.state AS unit_state
       FROM organization_memberships m
       LEFT JOIN organization_units u ON u.id = m.unit_id
      WHERE m.organization_id = $1 AND m.user_id = $2`,
    [organizationId, userId],
  );
  return rows[0] ?? null;
}

async function getStatesForOrganization(organizationId) {
  const { rows } = await pool.query(
    "SELECT state FROM organization_states WHERE organization_id = $1 ORDER BY state",
    [organizationId],
  );
  return rows.map((row) => row.state);
}

async function createOrganization({ name, slug, all_states = false, states = [], status = "active" }) {
  const finalSlug = slugify(slug || name);
  const { rows } = await pool.query(
    `INSERT INTO organizations (name, slug, status, all_states)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [name, finalSlug, status, Boolean(all_states)],
  );
  await setOrganizationStates(rows[0].id, states);
  return getOrganization(rows[0].id);
}

async function listOrganizations() {
  const { rows } = await pool.query(`
    SELECT o.*,
      COALESCE(json_agg(DISTINCT os.state) FILTER (WHERE os.state IS NOT NULL), '[]') AS states,
      COUNT(DISTINCT d.device_id)::int AS device_count,
      COUNT(DISTINCT m.user_id)::int AS user_count
    FROM organizations o
    LEFT JOIN organization_states os ON os.organization_id = o.id
    LEFT JOIN devices d ON d.organization_id = o.id
    LEFT JOIN organization_memberships m ON m.organization_id = o.id
    GROUP BY o.id
    ORDER BY o.created_at DESC
  `);
  return rows;
}

async function getOrganization(id) {
  const { rows } = await pool.query(
    `SELECT o.*,
      COALESCE(json_agg(DISTINCT os.state) FILTER (WHERE os.state IS NOT NULL), '[]') AS states
     FROM organizations o
     LEFT JOIN organization_states os ON os.organization_id = o.id
     WHERE o.id = $1
     GROUP BY o.id`,
    [id],
  );
  return rows[0] ?? null;
}

async function updateOrganizationAccess(id, { all_states, states = [], status, name }) {
  const { rows } = await pool.query(
    `UPDATE organizations
        SET all_states = COALESCE($2, all_states),
            status = COALESCE($3, status),
            name = COALESCE($4, name),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, all_states === undefined ? null : Boolean(all_states), status || null, name || null],
  );
  if (!rows[0]) return null;
  await setOrganizationStates(id, states);
  return getOrganization(id);
}

async function setOrganizationStates(organizationId, states = []) {
  await pool.query("DELETE FROM organization_states WHERE organization_id = $1", [organizationId]);
  const clean = [...new Set((states || []).map((state) => String(state).trim()).filter(Boolean))];
  for (const state of clean) {
    await pool.query(
      `INSERT INTO organization_states (organization_id, state)
       VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [organizationId, state],
    );
  }
}

async function createUser({ email, name, password, platform_role = "none" }) {
  const password_hash = await (Bun as any).password.hash(password, {
    algorithm: "bcrypt",
    cost: 10,
  });
  const { rows } = await pool.query(
    `INSERT INTO users (email, name, password_hash, platform_role)
     VALUES ($1,$2,$3,$4)
     RETURNING id, email, name, platform_role, status, created_at`,
    [email.toLowerCase(), name || null, password_hash, platform_role],
  );
  return rows[0];
}

async function addOrganizationUser({ organization_id, email, name, password, role = "viewer" }) {
  let user = await getUserByEmail(email);
  if (!user) {
    user = await createUser({ email, name, password, platform_role: "none" });
  }
  await pool.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role)
     VALUES ($1,$2,$3)
     ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [organization_id, user.id, role],
  );
  return getUserById(user.id);
}

async function upsertOrganizationUser({
  organization_id,
  email,
  name,
  password,
  role = "viewer",
  unit_id = null,
  scope_level = "organization",
}) {
  let user = await getUserByEmail(email);
  if (!user) {
    if (!password) throw new Error("password is required for new users");
    user = await createUser({ email, name, password, platform_role: "none" });
  }
  const finalUnitId = unit_id ? Number(unit_id) : null;
  await pool.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role, unit_id, scope_level)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (organization_id, user_id) DO UPDATE SET
       role = EXCLUDED.role,
       unit_id = EXCLUDED.unit_id,
       scope_level = EXCLUDED.scope_level`,
    [organization_id, user.id, role, finalUnitId, scope_level || (finalUnitId ? "unit" : "organization")],
  );
  return getUserById(user.id);
}

async function assignDeviceToOrganization(deviceId, organizationId) {
  const { rows } = await pool.query(
    `UPDATE devices SET organization_id = $2, unit_id = CASE WHEN $2::int IS NULL THEN NULL ELSE unit_id END WHERE device_id = $1 RETURNING *`,
    [deviceId, organizationId],
  );
  return rows[0] ?? null;
}

async function assignDeviceToUnit(deviceId, organizationId, unitId) {
  const { rows } = await pool.query(
    `UPDATE devices
        SET unit_id = $3
      WHERE device_id = $1 AND organization_id = $2
      RETURNING *`,
    [deviceId, organizationId, unitId || null],
  );
  return rows[0] ?? null;
}

async function listOrganizationUsers(organizationId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.platform_role, u.status, u.created_at,
            m.role, m.unit_id, m.scope_level,
            ou.name AS unit_name, ou.type AS unit_type
       FROM organization_memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN organization_units ou ON ou.id = m.unit_id
      WHERE m.organization_id = $1
      ORDER BY u.created_at DESC`,
    [organizationId],
  );
  return rows;
}

async function removeOrganizationUser(organizationId, userId) {
  const { rowCount } = await pool.query(
    `DELETE FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId],
  );
  return rowCount > 0;
}

async function getOrganizationScope(organizationId) {
  const organization = await getOrganization(organizationId);
  if (!organization) return null;
  return {
    organizationId,
    allStates: Boolean(organization.all_states),
    allowedStates: organization.all_states ? [] : await getStatesForOrganization(organizationId),
  };
}

async function listOrganizationUnits(organizationId) {
  const { rows } = await pool.query(
    `SELECT ou.*,
            parent.name AS parent_name,
            COUNT(DISTINCT child.id)::int AS child_count,
            COUNT(DISTINCT m.user_id)::int AS user_count,
            COUNT(DISTINCT d.device_id)::int AS device_count
       FROM organization_units ou
       LEFT JOIN organization_units parent ON parent.id = ou.parent_unit_id
       LEFT JOIN organization_units child ON child.parent_unit_id = ou.id
       LEFT JOIN organization_memberships m ON m.unit_id = ou.id
       LEFT JOIN devices d ON d.unit_id = ou.id
      WHERE ou.organization_id = $1
      GROUP BY ou.id, parent.name
      ORDER BY ou.created_at DESC`,
    [organizationId],
  );
  return rows;
}

async function getOrganizationUnit(organizationId, unitId) {
  const { rows } = await pool.query(
    "SELECT * FROM organization_units WHERE organization_id = $1 AND id = $2",
    [organizationId, unitId],
  );
  return rows[0] ?? null;
}

async function createOrganizationUnit({ organization_id, parent_unit_id, name, type, state, lga, location }) {
  const { rows } = await pool.query(
    `INSERT INTO organization_units (organization_id, parent_unit_id, name, type, state, lga, location)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [organization_id, parent_unit_id || null, name, type || null, state || null, lga || null, location || null],
  );
  return rows[0];
}

async function updateOrganizationUnit(organizationId, unitId, { parent_unit_id, name, type, state, lga, location }) {
  const { rows } = await pool.query(
    `UPDATE organization_units
        SET parent_unit_id = $3,
            name = COALESCE($4, name),
            type = COALESCE($5, type),
            state = $6,
            lga = $7,
            location = $8,
            updated_at = NOW()
      WHERE organization_id = $1 AND id = $2
      RETURNING *`,
    [organizationId, unitId, parent_unit_id || null, name || null, type || null, state || null, lga || null, location || null],
  );
  return rows[0] ?? null;
}

async function deleteOrganizationUnit(organizationId, unitId) {
  const { rowCount } = await pool.query(
    "DELETE FROM organization_units WHERE organization_id = $1 AND id = $2",
    [organizationId, unitId],
  );
  return rowCount > 0;
}

async function createAuditLog({ organization_id, actor_user_id, action, target_type, target_id, metadata = {} }) {
  const { rows } = await pool.query(
    `INSERT INTO audit_logs (organization_id, actor_user_id, action, target_type, target_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [organization_id || null, actor_user_id || null, action, target_type || null, target_id ? String(target_id) : null, metadata],
  );
  return rows[0];
}

async function listAuditLogs(organizationId, limit = 100) {
  const { rows } = await pool.query(
    `SELECT a.*, u.email AS actor_email, u.name AS actor_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.organization_id = $1
      ORDER BY a.created_at DESC
      LIMIT $2`,
    [organizationId, limit],
  );
  return rows;
}

/** Clear all incidents and scrape logs. */
async function clearAll() {
  await pool.query("DELETE FROM incidents");
  await pool.query("DELETE FROM scrape_logs");
  console.log("[DB] All incidents and scrape logs cleared");
}

export {
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
  getDevice,
  updateDeviceFields,
  deleteDevice,
  getUserByEmail,
  getUserById,
  getMembershipsForUser,
  getMembership,
  getStatesForOrganization,
  createOrganization,
  listOrganizations,
  getOrganization,
  updateOrganizationAccess,
  createUser,
  addOrganizationUser,
  upsertOrganizationUser,
  assignDeviceToOrganization,
  assignDeviceToUnit,
  listOrganizationUsers,
  removeOrganizationUser,
  getOrganizationScope,
  listOrganizationUnits,
  getOrganizationUnit,
  createOrganizationUnit,
  updateOrganizationUnit,
  deleteOrganizationUnit,
  createAuditLog,
  listAuditLogs,
  insertSosAlert,
  acknowledgeSosAlert,
  resolveSosAlert,
  listSosAlerts,
  allSosMsgIds,
};
