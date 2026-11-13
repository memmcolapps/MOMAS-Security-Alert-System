import { pool } from "../db";
import { deviceTypeCondition } from "../modules";

export type Scope = { organizationId?: number | null; unitId?: number | null; modules?: string[] };

function scopeSql(scope: Scope, alias: string, start = 1) {
  const values: any[] = [];
  const conditions: string[] = [];
  if (scope.organizationId) {
    values.push(scope.organizationId);
    conditions.push(`${alias}.organization_id = $${start + values.length - 1}`);
  }
  if (scope.unitId) {
    values.push(scope.unitId);
    conditions.push(`${alias}.unit_id = $${start + values.length - 1}`);
  }
  // Alarms ("a") on a radio follow the Radio/Vehicle module of that device.
  if (alias === "a") {
    const byModule = deviceTypeCondition(
      scope.modules,
      `(SELECT md.device_type FROM devices md WHERE md.device_id = ${alias}.asset_id)`,
    );
    if (byModule) conditions.push(`(${alias}.asset_type <> 'radio' OR ${byModule})`);
  }
  return { values, conditions };
}

export async function transaction<T>(fn: (client: any) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Everything a rule can point at in one organization, lean enough to load
 * with the editor: units, channels, radios and drones. A unit-scoped admin
 * gets their own unit subtree only.
 */
export async function listTargets(organizationId: number, unitIds: number[] | null, modules?: string[]) {
  const unitFilter = unitIds ? "AND unit_id = ANY($2::int[])" : "";
  // Only radios of a type the caller's Radio/Vehicle modules allow.
  const radioFilter = deviceTypeCondition(modules, "device_type");
  const values = unitIds ? [organizationId, unitIds] : [organizationId];
  const [units, channels, radios, drones] = await Promise.all([
    pool.query(
      `SELECT id, name, parent_unit_id FROM organization_units
        WHERE organization_id=$1 ${unitIds ? "AND id = ANY($2::int[])" : ""} ORDER BY name`,
      values,
    ),
    pool.query(
      `SELECT id, name, unit_id FROM channels
        WHERE organization_id=$1 AND active = true ${unitFilter} ORDER BY name`,
      values,
    ),
    pool.query(
      `SELECT device_id, name, unit_id FROM devices
        WHERE organization_id=$1 AND active = true ${unitFilter} ${radioFilter ? `AND ${radioFilter}` : ""}
        ORDER BY name NULLS LAST, device_id`,
      values,
    ),
    pool.query(
      `SELECT sysid, name, unit_id FROM drones
        WHERE organization_id=$1 ${unitFilter} ORDER BY name NULLS LAST, sysid`,
      values,
    ),
  ]);
  return { units: units.rows, channels: channels.rows, radios: radios.rows, drones: drones.rows };
}

const RULES_JSON = `COALESCE(
  json_agg(
    json_build_object(
      'id', r.id, 'target_type', r.target_type, 'target_id', r.target_id,
      'trigger', r.trigger, 'level', r.level, 'buffer_m', r.buffer_m,
      'confirmations_required', r.confirmations_required, 'active', r.active
    ) ORDER BY r.id
  ) FILTER (WHERE r.id IS NOT NULL),
  '[]'::json
) AS rules`;

/** Zones with their rules nested, so the editor needs one request. */
export async function listZones(scope: Scope = {}) {
  const scoped = scopeSql(scope, "g");
  const where = scoped.conditions.length ? `WHERE ${scoped.conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT g.id, g.organization_id, g.unit_id, g.name, g.shape_type, g.geometry,
            g.center_lat, g.center_lon, g.radius_m, g.created_at, g.updated_at,
            ${RULES_JSON}
       FROM geofences g
       LEFT JOIN geofence_rules r ON r.geofence_id = g.id
       ${where}
      GROUP BY g.id
      ORDER BY g.name`,
    scoped.values,
  );
  return rows;
}

export async function getZone(id: number, scope: Scope = {}) {
  const scoped = scopeSql(scope, "g", 2);
  const { rows } = await pool.query(
    `SELECT g.id, g.organization_id, g.unit_id, g.name, g.shape_type, g.geometry,
            g.center_lat, g.center_lon, g.radius_m, g.created_by, g.created_at, g.updated_at,
            ${RULES_JSON}
       FROM geofences g
       LEFT JOIN geofence_rules r ON r.geofence_id = g.id
      WHERE g.id=$1 ${scoped.conditions.length ? `AND ${scoped.conditions.join(" AND ")}` : ""}
      GROUP BY g.id`,
    [id, ...scoped.values],
  );
  return rows[0] || null;
}

export async function saveZone(client: any, input: any) {
  const values = [
    input.organization_id,
    input.unit_id || null,
    input.name,
    input.shape_type,
    input.geometry ? JSON.stringify(input.geometry) : null,
    input.center_lat ?? null,
    input.center_lon ?? null,
    input.radius_m ?? null,
  ];
  const { rows } = input.id
    ? await client.query(
        `UPDATE geofences SET
           unit_id=$2, name=$3, shape_type=$4, geometry=$5::jsonb,
           center_lat=$6, center_lon=$7, radius_m=$8, updated_at=NOW()
         WHERE id=$9 AND organization_id=$1
         RETURNING *`,
        [...values, input.id],
      )
    : await client.query(
        `INSERT INTO geofences
           (organization_id, unit_id, name, shape_type, geometry, center_lat, center_lon, radius_m, created_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
         RETURNING *`,
        [...values, input.created_by || null],
      );
  return rows[0] || null;
}

/**
 * Makes the zone's rules match `rules`, keeping the id (and so the breach
 * state) of every rule that survives. A rule whose target or direction
 * changed is a different question, so its state is cleared; one that only
 * changed level or tuning keeps it, and an asset already in breach does not
 * re-alarm because somebody turned amber into red.
 *
 * Returns the ids whose state was cleared or created, which are the ones the
 * caller seeds from live positions.
 */
export async function syncRules(client: any, zoneId: number, organizationId: number, rules: any[], userId: number | null) {
  const { rows: existing } = await client.query("SELECT * FROM geofence_rules WHERE geofence_id=$1", [zoneId]);
  const byId = new Map(existing.map((rule: any) => [Number(rule.id), rule]));
  const keep = new Set(rules.filter((rule) => rule.id && byId.has(Number(rule.id))).map((rule) => Number(rule.id)));
  const removed = existing.filter((rule: any) => !keep.has(Number(rule.id))).map((rule: any) => Number(rule.id));
  if (removed.length) await client.query("DELETE FROM geofence_rules WHERE id = ANY($1::bigint[])", [removed]);

  const fresh: number[] = [];
  for (const rule of rules) {
    const previous: any = rule.id ? byId.get(Number(rule.id)) : null;
    const values = [
      rule.target_type, String(rule.target_id), rule.trigger, rule.level,
      rule.buffer_m, rule.confirmations_required, rule.active,
    ];
    if (previous) {
      const sameQuestion =
        previous.target_type === rule.target_type &&
        String(previous.target_id) === String(rule.target_id) &&
        previous.trigger === rule.trigger;
      await client.query(
        `UPDATE geofence_rules SET target_type=$1, target_id=$2, trigger=$3, level=$4,
           buffer_m=$5, confirmations_required=$6, active=$7, updated_at=NOW()
         WHERE id=$8`,
        [...values, previous.id],
      );
      if (!sameQuestion) {
        await client.query("DELETE FROM geofence_rule_states WHERE rule_id=$1", [previous.id]);
        fresh.push(Number(previous.id));
      }
      continue;
    }
    const { rows } = await client.query(
      `INSERT INTO geofence_rules
         (geofence_id, organization_id, target_type, target_id, trigger, level,
          buffer_m, confirmations_required, active, created_by)
       VALUES ($8,$9,$1,$2,$3,$4,$5,$6,$7,$10)
       RETURNING id`,
      [...values, zoneId, organizationId, userId],
    );
    fresh.push(Number(rows[0].id));
  }
  return { fresh, removed };
}

export async function deleteZone(id: number, organizationId?: number | null) {
  const values: any[] = [id];
  let condition = "";
  if (organizationId) {
    values.push(organizationId);
    condition = " AND organization_id=$2";
  }
  const result = await pool.query(`DELETE FROM geofences WHERE id=$1${condition}`, values);
  return Boolean(result.rowCount);
}

/** Every active rule with its zone's shape, for the engine's in-memory index. */
export async function loadActiveRules() {
  const { rows } = await pool.query(
    `SELECT r.*, g.name AS zone_name, g.unit_id AS zone_unit_id, g.shape_type, g.geometry,
            g.center_lat, g.center_lon, g.radius_m
       FROM geofence_rules r
       JOIN geofences g ON g.id = r.geofence_id
      WHERE r.active = true`,
  );
  return rows;
}

/** Who belongs to what: the inputs for resolving unit and channel rules. */
export async function loadMembership() {
  const [devices, drones, channels, units] = await Promise.all([
    pool.query("SELECT device_id, unit_id, organization_id, name FROM devices WHERE active = true"),
    pool.query("SELECT sysid, unit_id, organization_id, name FROM drones"),
    pool.query(
      `SELECT cd.channel_id, cd.device_id FROM channel_devices cd
         JOIN channels c ON c.id = cd.channel_id AND c.active = true`,
    ),
    pool.query("SELECT id, parent_unit_id, organization_id FROM organization_units"),
  ]);
  return { devices: devices.rows, drones: drones.rows, channels: channels.rows, units: units.rows };
}

export async function loadRuleStates() {
  const { rows } = await pool.query("SELECT * FROM geofence_rule_states");
  return rows;
}

export async function saveRuleState(input: any) {
  await pool.query(
    `INSERT INTO geofence_rule_states
       (rule_id, asset_type, asset_id, in_breach, breach_count, last_lat, last_lon, last_observed_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (rule_id, asset_type, asset_id) DO UPDATE SET
       in_breach=EXCLUDED.in_breach,
       breach_count=EXCLUDED.breach_count,
       last_lat=EXCLUDED.last_lat,
       last_lon=EXCLUDED.last_lon,
       last_observed_at=EXCLUDED.last_observed_at,
       updated_at=NOW()`,
    [
      input.rule_id,
      input.asset_type,
      input.asset_id,
      input.in_breach,
      input.breach_count,
      input.last_lat,
      input.last_lon,
      input.last_observed_at,
    ],
  );
}

export async function createRuleAlert(rule: any, position: any, distanceM: number) {
  const registry =
    position.asset_type === "radio"
      ? await pool.query("SELECT name, organization_id, unit_id FROM devices WHERE device_id=$1", [position.asset_id])
      : await pool.query("SELECT name, organization_id, unit_id FROM drones WHERE sysid=$1", [Number(position.asset_id)]);
  const asset = registry.rows[0];
  if (!asset?.organization_id || Number(asset.organization_id) !== Number(rule.organization_id)) return null;

  const { rows } = await pool.query(
    `INSERT INTO operational_alerts
       (organization_id, unit_id, asset_type, asset_id, asset_name, geofence_id, geofence_name,
        rule_id, trigger, level, triggered_at, location_lat, location_lon, distance_outside_m, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
     ON CONFLICT (rule_id, asset_type, asset_id)
       WHERE status < 2 AND returned_at IS NULL AND rule_id IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [
      rule.organization_id,
      asset.unit_id || rule.zone_unit_id || null,
      position.asset_type,
      position.asset_id,
      asset.name || null,
      rule.geofence_id,
      rule.zone_name,
      rule.id,
      rule.trigger,
      rule.level,
      position.observed_at,
      position.lat,
      position.lon,
      distanceM,
      JSON.stringify({ source: position.source || position.asset_type, target_type: rule.target_type, target_id: rule.target_id }),
    ],
  );
  const alert = rows[0];
  if (!alert) return null;
  await pool.query(
    `INSERT INTO operational_alert_events (alert_id, event_type, metadata)
     VALUES ($1,'breach',$2::jsonb)`,
    [alert.id, JSON.stringify({ distance_m: distanceM, trigger: rule.trigger })],
  );
  return alert;
}

export async function markRuleCleared(rule: any, position: any) {
  const { rows } = await pool.query(
    `UPDATE operational_alerts SET
       returned_at=$4, updated_at=NOW()
     WHERE rule_id=$1 AND asset_type=$2 AND asset_id=$3
       AND status < 2 AND returned_at IS NULL
     RETURNING *`,
    [rule.id, position.asset_type, position.asset_id, position.observed_at],
  );
  for (const alert of rows) {
    await pool.query(
      `INSERT INTO operational_alert_events (alert_id, event_type, metadata)
       VALUES ($1,'returned',$2::jsonb)`,
      [alert.id, JSON.stringify({ lat: position.lat, lon: position.lon })],
    );
  }
  return rows;
}

const QUIETER_LEVELS: Record<string, string[]> = { red: ["amber", "yellow"], amber: ["yellow"], yellow: [] };

/**
 * A radio that moves from the Amber step to the Red one gets the Red alarm;
 * the Amber alarm it already had for the same zone is closed as escalated, so
 * an operator answers one alarm, not a pile of them.
 */
export async function escalateLowerAlerts(rule: any, position: any, alert: any) {
  const quieter = QUIETER_LEVELS[rule.level] || [];
  if (!quieter.length || rule.geofence_id == null) return [];
  const { rows } = await pool.query(
    `UPDATE operational_alerts SET
       status=2, resolved_at=NOW(), resolution_note=$6, updated_at=NOW()
     WHERE geofence_id=$1 AND trigger=$2 AND asset_type=$3 AND asset_id=$4
       AND level = ANY($5::text[]) AND status < 2 AND id <> $7
     RETURNING *`,
    [rule.geofence_id, rule.trigger, position.asset_type, position.asset_id, quieter, `Escalated to ${rule.level}`, alert.id],
  );
  for (const lower of rows) {
    await pool.query(
      `INSERT INTO operational_alert_events (alert_id, event_type, metadata)
       VALUES ($1,'escalated',$2::jsonb)`,
      [lower.id, JSON.stringify({ to_alert_id: alert.id, level: rule.level })],
    );
  }
  return rows;
}

/** Shared predicate so the alarm list and its badge counts describe one population. */
function operationalAlertFilterSql(scope: Scope = {}, filters: any = {}, { includeStatus = true } = {}) {
  const scoped = scopeSql(scope, "a");
  const values = [...scoped.values];
  const conditions = [...scoped.conditions];
  if (includeStatus) {
    if (filters.status === "open") conditions.push("a.status < 2");
    if (filters.status === "new") conditions.push("a.status = 0");
    if (filters.status === "in_progress") conditions.push("a.status = 1");
    if (filters.status === "resolved") conditions.push("a.status = 2");
    // Geofence alarms are raised and closed inside this platform, so they have
    // no radio-network push to fail. "sync_failed" can never match one.
    if (filters.status === "sync_failed") conditions.push("FALSE");
  }
  if (filters.search) {
    values.push(`%${String(filters.search).trim()}%`);
    conditions.push(`(a.asset_id ILIKE $${values.length} OR COALESCE(a.asset_name,'') ILIKE $${values.length} OR COALESCE(a.geofence_name,'') ILIKE $${values.length})`);
  }
  if (filters.from) {
    values.push(filters.from);
    conditions.push(`a.triggered_at >= $${values.length}::timestamptz`);
  }
  if (filters.to) {
    values.push(filters.to);
    conditions.push(`a.triggered_at < ($${values.length}::date + INTERVAL '1 day')`);
  }
  return { values, where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "" };
}

export async function listOperationalAlerts(scope: Scope = {}, filters: any = {}) {
  const { values, where } = operationalAlertFilterSql(scope, filters);
  values.push(Math.min(Math.max(Number(filters.limit) || 200, 1), 500));
  const { rows } = await pool.query(
    `SELECT a.*, o.name AS organization_name, ou.name AS unit_name
       FROM operational_alerts a
       LEFT JOIN organizations o ON o.id=a.organization_id
       LEFT JOIN organization_units ou ON ou.id=a.unit_id
       ${where}
      ORDER BY a.triggered_at DESC
      LIMIT $${values.length}`,
    values,
  );
  return rows;
}

export async function countOperationalAlerts(scope: Scope = {}, filters: any = {}) {
  const { values, where } = operationalAlertFilterSql(scope, filters, { includeStatus: false });
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int                             AS all,
            COUNT(*) FILTER (WHERE a.status < 2)::int AS open,
            COUNT(*) FILTER (WHERE a.status = 0)::int AS new,
            COUNT(*) FILTER (WHERE a.status = 1)::int AS in_progress,
            COUNT(*) FILTER (WHERE a.status = 2)::int AS resolved,
            0                                         AS sync_failed
       FROM operational_alerts a
       ${where}`,
    values,
  );
  return rows[0];
}

export async function getOperationalAlert(id: number, scope: Scope = {}) {
  const scoped = scopeSql(scope, "a", 2);
  const { rows } = await pool.query(
    `SELECT a.*, o.name AS organization_name, ou.name AS unit_name,
            acknowledged_user.name AS acknowledged_by_name,
            acknowledged_user.email AS acknowledged_by_email,
            resolved_user.name AS resolved_by_name,
            resolved_user.email AS resolved_by_email
       FROM operational_alerts a
       LEFT JOIN organizations o ON o.id=a.organization_id
       LEFT JOIN organization_units ou ON ou.id=a.unit_id
       LEFT JOIN users acknowledged_user ON acknowledged_user.id=a.acknowledged_by
       LEFT JOIN users resolved_user ON resolved_user.id=a.resolved_by
      WHERE a.id=$1 ${scoped.conditions.length ? `AND ${scoped.conditions.join(" AND ")}` : ""}`,
    [id, ...scoped.values],
  );
  return rows[0] || null;
}

export async function listOperationalAlertEvents(id: number, scope: Scope = {}) {
  const alert = await getOperationalAlert(id, scope);
  if (!alert) return null;
  const { rows } = await pool.query(
    `SELECT e.*, u.name AS actor_name, u.email AS actor_email
       FROM operational_alert_events e
       LEFT JOIN users u ON u.id=e.actor_user_id
      WHERE e.alert_id=$1 ORDER BY e.created_at`,
    [id],
  );
  return { alert, events: rows };
}

const OPERATIONAL_ALERT_SQL = {
  start: `UPDATE operational_alerts SET status=1, acknowledged_at=COALESCE(acknowledged_at,NOW()),
            acknowledged_by=COALESCE(acknowledged_by,$2), updated_at=NOW()
          WHERE id=$1 AND status=0 RETURNING *`,
  resolve: `UPDATE operational_alerts SET status=2, resolved_at=NOW(), resolved_by=$2,
              resolution_note=$3, updated_at=NOW() WHERE id=$1 AND status<2 RETURNING *`,
  // Rewind to "in progress" and clear the resolution. The discarded outcome
  // stays on the reopen event so the operational record remains complete.
  reopen: `UPDATE operational_alerts SET status=1, resolved_at=NULL, resolved_by=NULL,
             resolution_note=NULL, acknowledged_at=COALESCE(acknowledged_at,NOW()),
             acknowledged_by=COALESCE(acknowledged_by,$2), updated_at=NOW()
           WHERE id=$1 AND status=2 RETURNING *`,
};

const OPERATIONAL_ALERT_EVENTS = { start: "response_started", resolve: "resolved", reopen: "reopened" };

export async function updateOperationalAlert(
  id: number,
  userId: number,
  action: "start" | "resolve" | "reopen",
  note?: string,
) {
  const previous = action === "reopen" ? await getOperationalAlert(id) : null;
  const { rows } = await pool.query(
    OPERATIONAL_ALERT_SQL[action],
    action === "resolve" ? [id, userId, note || null] : [id, userId],
  );
  const alert = rows[0] || (await pool.query("SELECT * FROM operational_alerts WHERE id=$1", [id])).rows[0];
  if (rows[0]) {
    await pool.query(
      `INSERT INTO operational_alert_events (alert_id, actor_user_id, event_type, note, metadata)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [
        id,
        userId,
        OPERATIONAL_ALERT_EVENTS[action],
        note || null,
        JSON.stringify(action === "reopen" ? { discarded_resolution_note: previous?.resolution_note || null } : {}),
      ],
    );
  }
  return alert || null;
}
