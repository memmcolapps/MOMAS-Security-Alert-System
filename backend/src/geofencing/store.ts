import { pool } from "../db";

export type Scope = { organizationId?: number | null; unitId?: number | null };

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
  return { values, conditions };
}

export async function listGeofences(scope: Scope = {}) {
  const scoped = scopeSql(scope, "g");
  const where = scoped.conditions.length ? `WHERE ${scoped.conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT g.*,
            COALESCE(
              json_agg(
                json_build_object('id', ga.id, 'asset_type', ga.asset_type, 'asset_id', ga.asset_id)
                ORDER BY ga.asset_type, ga.asset_id
              ) FILTER (WHERE ga.id IS NOT NULL),
              '[]'::json
            ) AS assignments
       FROM geofences g
       LEFT JOIN geofence_assignments ga ON ga.geofence_id = g.id
       ${where}
      GROUP BY g.id
      ORDER BY g.name`,
    scoped.values,
  );
  return rows;
}

export async function getGeofence(id: number, scope: Scope = {}) {
  const scoped = scopeSql(scope, "g", 2);
  const { rows } = await pool.query(
    `SELECT g.* FROM geofences g
      WHERE g.id=$1 ${scoped.conditions.length ? `AND ${scoped.conditions.join(" AND ")}` : ""}`,
    [id, ...scoped.values],
  );
  return rows[0] || null;
}

export async function saveGeofence(input: any) {
  const values = [
    input.organization_id,
    input.unit_id || null,
    input.name,
    input.shape_type,
    input.geometry ? JSON.stringify(input.geometry) : null,
    input.center_lat ?? null,
    input.center_lon ?? null,
    input.radius_m ?? null,
    input.buffer_m,
    input.confirmations_required,
    input.active,
    input.created_by || null,
  ];
  const { rows } = input.id
    ? await pool.query(
        `UPDATE geofences SET
           unit_id=$2, name=$3, shape_type=$4, geometry=$5::jsonb,
           center_lat=$6, center_lon=$7, radius_m=$8, buffer_m=$9,
           confirmations_required=$10, active=$11, updated_at=NOW()
         WHERE id=$13 AND organization_id=$1
         RETURNING *`,
        [...values, input.id],
      )
    : await pool.query(
        `INSERT INTO geofences
           (organization_id, unit_id, name, shape_type, geometry, center_lat, center_lon,
            radius_m, buffer_m, confirmations_required, active, created_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        values,
      );
  return rows[0] || null;
}

/**
 * Only assets that actually left the fence are dropped, and only new ones are
 * inserted. Deleting the whole set and re-adding it cascaded `geofence_states`
 * away on every save, so renaming a fence wiped its breach state and every
 * asset still outside re-alarmed a few polls later.
 */
export async function replaceAssignments(geofenceId: number, assignments: any[]) {
  const keep = assignments.map((assignment) => `${assignment.asset_type}:${String(assignment.asset_id)}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM geofence_assignments
        WHERE geofence_id=$1 AND (asset_type || ':' || asset_id) <> ALL($2::text[])`,
      [geofenceId, keep],
    );
    for (const assignment of assignments) {
      await client.query(
        `INSERT INTO geofence_assignments (geofence_id, asset_type, asset_id)
         VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [geofenceId, assignment.asset_type, String(assignment.asset_id)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Marks assets as already-outside without raising an alarm, for the case where
 * a fence is drawn around assets that are currently elsewhere. Seeding the
 * state rather than muting the alert keeps the engine honest: nothing fires
 * now, and the asset alarms normally the next time it leaves.
 */
export async function seedOutsideStates(geofenceId: number, positions: any[]) {
  if (!positions.length) return 0;
  const { rows } = await pool.query(
    `SELECT ga.id AS assignment_id, ga.asset_type, ga.asset_id, g.confirmations_required
       FROM geofence_assignments ga
       JOIN geofences g ON g.id = ga.geofence_id
      WHERE ga.geofence_id=$1`,
    [geofenceId],
  );
  const byKey = new Map(rows.map((row: any) => [`${row.asset_type}:${row.asset_id}`, row]));
  let seeded = 0;
  for (const position of positions) {
    const assignment: any = byKey.get(`${position.asset_type}:${position.asset_id}`);
    if (!assignment) continue;
    await saveGeofenceState({
      assignment_id: assignment.assignment_id,
      is_outside: true,
      outside_count: Number(assignment.confirmations_required) || 1,
      last_lat: position.lat,
      last_lon: position.lon,
      last_observed_at: position.observed_at ? new Date(position.observed_at) : new Date(),
    });
    seeded++;
  }
  return seeded;
}

export async function deleteGeofence(id: number, organizationId?: number | null) {
  const values: any[] = [id];
  let condition = "";
  if (organizationId) {
    values.push(organizationId);
    condition = " AND organization_id=$2";
  }
  const result = await pool.query(`DELETE FROM geofences WHERE id=$1${condition}`, values);
  return Boolean(result.rowCount);
}

export async function assignmentsForAsset(assetType: string, assetId: string) {
  const { rows } = await pool.query(
    `SELECT ga.id AS assignment_id, g.*
       FROM geofence_assignments ga
       JOIN geofences g ON g.id=ga.geofence_id
      WHERE ga.asset_type=$1 AND ga.asset_id=$2 AND g.active=true`,
    [assetType, assetId],
  );
  return rows;
}

export async function listAssignedRadios() {
  const { rows } = await pool.query(
    `SELECT DISTINCT d.device_id
       FROM devices d
       JOIN geofence_assignments ga ON ga.asset_type='radio' AND ga.asset_id=d.device_id
       JOIN geofences g ON g.id=ga.geofence_id AND g.active=true
      WHERE d.active=true`,
  );
  return rows.map((row) => String(row.device_id));
}

export async function getGeofenceState(assignmentId: number) {
  const { rows } = await pool.query("SELECT * FROM geofence_states WHERE assignment_id=$1", [assignmentId]);
  return rows[0] || null;
}

export async function saveGeofenceState(input: any) {
  await pool.query(
    `INSERT INTO geofence_states
       (assignment_id, is_outside, outside_count, last_lat, last_lon, last_observed_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (assignment_id) DO UPDATE SET
       is_outside=EXCLUDED.is_outside,
       outside_count=EXCLUDED.outside_count,
       last_lat=EXCLUDED.last_lat,
       last_lon=EXCLUDED.last_lon,
       last_observed_at=EXCLUDED.last_observed_at,
       updated_at=NOW()`,
    [
      input.assignment_id,
      input.is_outside,
      input.outside_count,
      input.last_lat,
      input.last_lon,
      input.last_observed_at,
    ],
  );
}

export async function createBreachAlert(fence: any, position: any, distanceOutsideM: number) {
  const registry =
    position.asset_type === "radio"
      ? await pool.query("SELECT name, organization_id, unit_id FROM devices WHERE device_id=$1", [position.asset_id])
      : await pool.query("SELECT name, organization_id, unit_id FROM drones WHERE sysid=$1", [Number(position.asset_id)]);
  const asset = registry.rows[0];
  if (!asset?.organization_id || Number(asset.organization_id) !== Number(fence.organization_id)) return null;

  const { rows } = await pool.query(
    `INSERT INTO operational_alerts
       (organization_id, unit_id, asset_type, asset_id, asset_name, geofence_id,
        geofence_name, triggered_at, location_lat, location_lon, distance_outside_m, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
     ON CONFLICT (geofence_id, asset_type, asset_id)
       WHERE status < 2 AND returned_at IS NULL
     DO NOTHING
     RETURNING *`,
    [
      fence.organization_id,
      asset.unit_id || fence.unit_id || null,
      position.asset_type,
      position.asset_id,
      asset.name || null,
      fence.id,
      fence.name,
      position.observed_at,
      position.lat,
      position.lon,
      distanceOutsideM,
      JSON.stringify({ source: position.source || position.asset_type }),
    ],
  );
  const alert = rows[0];
  if (!alert) return null;
  await pool.query(
    `INSERT INTO operational_alert_events (alert_id, event_type, metadata)
     VALUES ($1,'breach',$2::jsonb)`,
    [alert.id, JSON.stringify({ distance_outside_m: distanceOutsideM })],
  );
  return alert;
}

export async function markAssetReturned(fence: any, position: any) {
  const { rows } = await pool.query(
    `UPDATE operational_alerts SET
       returned_at=$4, updated_at=NOW()
     WHERE geofence_id=$1 AND asset_type=$2 AND asset_id=$3
       AND status < 2 AND returned_at IS NULL
     RETURNING *`,
    [fence.id, position.asset_type, position.asset_id, position.observed_at],
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
