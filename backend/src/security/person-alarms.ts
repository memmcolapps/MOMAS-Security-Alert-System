// Alarms about a person rather than a radio: a panic sign-in, a phone reported
// lost, a sign-in from somewhere unusual. They join the same alarm list and
// siren as radio alarms, so the control room needs nothing new to watch.

import * as db from "../db";
import { bus } from "../events";

export type PersonAlarmType = "duress" | "device_lost" | "unusual_sign_in";

const LEVEL: Record<PersonAlarmType, "red" | "amber"> = {
  duress: "red",
  device_lost: "amber",
  unusual_sign_in: "amber",
};

export async function raisePersonAlarm(input: {
  type: PersonAlarmType;
  user: { id: number; name?: string | null; email: string };
  memberships: any[];
  lat?: number | null;
  lon?: number | null;
  detail?: Record<string, unknown>;
}) {
  const membership = input.memberships[0];
  const organizationId = Number(membership?.organization_id) || null;
  const unitId = membership?.scope_level === "unit" ? Number(membership.unit_id) || null : null;
  // One open panic alarm per person: signing in under duress twice must not
  // bury the first alarm under a second.
  if (input.type === "duress") {
    const open = await openDuressAlarm(input.user.id);
    if (open) return open;
  }
  const { rows } = await db.pool.query(
    `INSERT INTO operational_alerts
       (organization_id, unit_id, alert_type, asset_type, asset_id, asset_name, level, triggered_at,
        location_lat, location_lon, metadata)
     VALUES ($1, $2, $3, 'user', $4, $5, $6, NOW(), $7, $8, $9::jsonb)
     RETURNING *`,
    [
      organizationId,
      unitId,
      input.type,
      String(input.user.id),
      input.user.name || input.user.email,
      LEVEL[input.type],
      input.lat ?? null,
      input.lon ?? null,
      JSON.stringify({ email: input.user.email, ...input.detail }),
    ],
  );
  const alert = rows[0];
  await db.pool.query(
    `INSERT INTO operational_alert_events (alert_id, event_type, metadata) VALUES ($1, 'triggered', $2::jsonb)`,
    [alert.id, JSON.stringify({ type: input.type, ...input.detail })],
  );
  bus.emit("operational-alert:new", alert);
  return alert;
}

/** The person's panic alarm that nobody has closed yet, if any. */
export async function openDuressAlarm(userId: number) {
  const { rows } = await db.pool.query(
    `SELECT * FROM operational_alerts
      WHERE asset_type = 'user' AND asset_id = $1 AND alert_type = 'duress' AND status < 2
      ORDER BY triggered_at DESC LIMIT 1`,
    [String(userId)],
  );
  return rows[0] ?? null;
}

// ── Unusual place ───────────────────────────────────────────────────────────

const EARTH_KM = 6371;

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

export const UNUSUAL_KM = 50;
export const PLACES_NEEDED = 3;

/**
 * Far from every place this person has signed in before. Until they have
 * signed in from a few places, nothing counts as unusual: there is nothing to
 * compare with yet.
 */
export function isUnusualPlace(here: { lat: number; lon: number }, before: Array<{ lat: number; lon: number }>) {
  if (before.length < PLACES_NEEDED) return false;
  return before.every((place) => distanceKm(here, place) > UNUSUAL_KM);
}
