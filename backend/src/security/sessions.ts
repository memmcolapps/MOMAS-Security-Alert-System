// Every sign-in is a row here, so it can be listed and ended from anywhere:
// by the person on another device, or by an admin when a phone is lost.
//
// "Use" means someone touching the screen or a key, which the console reports
// as X-Last-Input on each request. Automatic refreshes are not use, so a phone
// left on a table with the map open still counts as unused.

import crypto from "node:crypto";
import * as db from "../db";
import { bus } from "../events";
import type { SecurityPolicy } from "./policy";

export type SessionRow = {
  id: string;
  user_id: number;
  device_id: number | null;
  label: string | null;
  is_phone: boolean;
  ip: string | null;
  lat: number | null;
  lon: number | null;
  duress: boolean;
  created_at: string;
  last_seen_at: string;
  last_active_at: string;
  locked_at: string | null;
  pin_failures: number;
  ended_at: string | null;
  end_reason: string | null;
};

export const hashDeviceKey = (key: string) => crypto.createHash("sha256").update(`momas-device:${key}`).digest("hex");

/** Browser and system in a few words: "iPhone · Safari", "Windows · Chrome". */
export function describeUserAgent(ua: string | null | undefined) {
  const text = String(ua || "");
  const system = /iPhone/.test(text)
    ? "iPhone"
    : /iPad/.test(text)
      ? "iPad"
      : /Android/.test(text)
        ? "Android"
        : /Windows/.test(text)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(text)
            ? "Mac"
            : /Linux/.test(text)
              ? "Linux"
              : "Unknown device";
  const browser = /Edg\//.test(text)
    ? "Edge"
    : /OPR\/|Opera/.test(text)
      ? "Opera"
      : /SamsungBrowser/.test(text)
        ? "Samsung Internet"
        : /CriOS|Chrome\//.test(text)
          ? "Chrome"
          : /FxiOS|Firefox\//.test(text)
            ? "Firefox"
            : /Safari\//.test(text)
              ? "Safari"
              : "browser";
  return `${system} · ${browser}`;
}

/** A phone or tablet, by what the browser says about itself and what the page saw. */
export function looksLikePhone(ua: string | null | undefined, reportedPhone: unknown) {
  return reportedPhone === true || /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(String(ua || ""));
}

// ── Devices ─────────────────────────────────────────────────────────────────

export async function findOrCreateDevice(
  userId: number,
  deviceKey: string,
  { label, isPhone, status }: { label: string; isPhone: boolean; status: "approved" | "pending" },
) {
  const { rows } = await db.pool.query(
    `INSERT INTO user_devices (user_id, device_key_hash, label, is_phone, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, device_key_hash) DO UPDATE
       SET last_seen_at = NOW(), label = EXCLUDED.label, is_phone = user_devices.is_phone OR EXCLUDED.is_phone
     RETURNING *, (xmax = 0) AS created`,
    [userId, hashDeviceKey(deviceKey), label, isPhone, status],
  );
  return rows[0];
}

export async function setDeviceStatus(userId: number, deviceId: number, status: "approved" | "blocked", actorId: number) {
  const { rows } = await db.pool.query(
    `UPDATE user_devices SET status = $3, decided_by = $4, decided_at = NOW()
      WHERE id = $2 AND user_id = $1 RETURNING *`,
    [userId, deviceId, status, actorId],
  );
  if (rows[0] && status === "blocked") await endDeviceSessions(userId, deviceId, "device blocked", actorId);
  return rows[0] ?? null;
}

// ── Sessions ────────────────────────────────────────────────────────────────

export async function createSession(input: {
  userId: number;
  deviceId: number | null;
  label: string;
  isPhone: boolean;
  ip: string | null;
  lat?: number | null;
  lon?: number | null;
  duress?: boolean;
}) {
  const id = crypto.randomUUID();
  const { rows } = await db.pool.query(
    `INSERT INTO user_sessions (id, user_id, device_id, label, is_phone, ip, lat, lon, duress)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [id, input.userId, input.deviceId, input.label, input.isPhone, input.ip, input.lat ?? null, input.lon ?? null, Boolean(input.duress)],
  );
  return rows[0] as SessionRow;
}

const sessionCache = new Map<string, { at: number; value: Promise<SessionRow | null> }>();
const SESSION_CACHE_MS = 10_000;

export function getSession(id: string) {
  const hit = sessionCache.get(id);
  if (hit && Date.now() - hit.at < SESSION_CACHE_MS) return hit.value;
  const value = db.pool
    .query("SELECT * FROM user_sessions WHERE id = $1", [id])
    .then(({ rows }) => (rows[0] as SessionRow) ?? null);
  const entry = { at: Date.now(), value };
  sessionCache.set(id, entry);
  value.catch(() => sessionCache.get(id) === entry && sessionCache.delete(id));
  return value;
}

function forgetSession(id: string) {
  sessionCache.delete(id);
}

/** Ends sessions and tells every open stream and socket that holds one. */
async function endWhere(where: string, values: unknown[], reason: string, actorId: number | null) {
  const { rows } = await db.pool.query(
    `UPDATE user_sessions SET ended_at = NOW(), end_reason = $${values.length + 1}, ended_by = $${values.length + 2}
      WHERE ended_at IS NULL AND ${where} RETURNING id, user_id`,
    [...values, reason, actorId],
  );
  for (const row of rows) {
    forgetSession(row.id);
    activity.delete(row.id);
    for (const close of watchers.get(row.id) || []) {
      try {
        close();
      } catch {}
    }
    watchers.delete(row.id);
    bus.emit("session:ended", { sessionId: row.id, userId: row.user_id });
  }
  return rows.length;
}

// Open streams (alarms, positions, news) by the session that opened them, so
// ending a session closes them at once instead of at their next reconnect.
const watchers = new Map<string, Set<() => void>>();

/** Calls `close` when this session is ended. Returns a function that stops watching. */
export function closeWhenSessionEnds(sessionId: string | null | undefined, close: () => void) {
  if (!sessionId) return () => {};
  const set = watchers.get(sessionId) || new Set();
  set.add(close);
  watchers.set(sessionId, set);
  return () => {
    set.delete(close);
    if (!set.size) watchers.delete(sessionId);
  };
}

export const endSession = (userId: number, sessionId: string, reason: string, actorId: number | null = null) =>
  endWhere("id = $1 AND user_id = $2", [sessionId, userId], reason, actorId);

export const endOtherSessions = (userId: number, keepSessionId: string | null, reason: string, actorId: number | null = null) =>
  endWhere("user_id = $1 AND id IS DISTINCT FROM $2", [userId, keepSessionId], reason, actorId);

export const endDeviceSessions = (userId: number, deviceId: number, reason: string, actorId: number | null = null) =>
  endWhere("user_id = $1 AND device_id = $2", [userId, deviceId], reason, actorId);

/** Sessions still open, newest use first, with their device's approval state. */
export async function listSessions(userId: number) {
  const { rows } = await db.pool.query(
    `SELECT s.id, s.label, s.is_phone, s.ip, s.lat, s.lon, s.duress, s.created_at, s.last_seen_at, s.last_active_at,
            s.locked_at, s.device_id, d.status AS device_status
       FROM user_sessions s
       LEFT JOIN user_devices d ON d.id = s.device_id
      WHERE s.user_id = $1 AND s.ended_at IS NULL
      ORDER BY s.last_seen_at DESC`,
    [userId],
  );
  return rows;
}

export async function listDevices(userId: number) {
  const { rows } = await db.pool.query(
    `SELECT d.id, d.label, d.is_phone, d.status, d.first_seen_at, d.last_seen_at, d.decided_at,
            decider.name AS decided_by_name, decider.email AS decided_by_email
       FROM user_devices d
       LEFT JOIN users decider ON decider.id = d.decided_by
      WHERE d.user_id = $1
      ORDER BY d.last_seen_at DESC`,
    [userId],
  );
  return rows;
}

/** Devices waiting for approval, for the people an admin looks after. */
export async function listPendingDevices({ organizationId, platformStaff }: { organizationId?: number; platformStaff?: boolean }) {
  const { rows } = await db.pool.query(
    `SELECT d.id, d.user_id, d.label, d.is_phone, d.first_seen_at, d.last_seen_at, u.name AS user_name, u.email AS user_email
            ${platformStaff ? "" : ", m.unit_id"}
       FROM user_devices d
       JOIN users u ON u.id = d.user_id
       ${platformStaff ? "" : "JOIN organization_memberships m ON m.user_id = u.id AND m.organization_id = $1"}
      WHERE d.status = 'pending'
        ${platformStaff ? "AND u.platform_role <> 'none'" : ""}
      ORDER BY d.last_seen_at DESC`,
    platformStaff ? [] : [organizationId],
  );
  return rows;
}

/** Where this person has signed in before, for spotting an unusual place. */
export async function previousLocations(userId: number, exceptSessionId: string) {
  const { rows } = await db.pool.query(
    `SELECT lat, lon FROM user_sessions
      WHERE user_id = $1 AND id <> $2 AND lat IS NOT NULL AND lon IS NOT NULL
        AND created_at > NOW() - INTERVAL '180 days'
      ORDER BY created_at DESC LIMIT 50`,
    [userId, exceptSessionId],
  );
  return rows as Array<{ lat: number; lon: number }>;
}

// ── Use, lock and time limits ───────────────────────────────────────────────

// The last use and last request of each session, held here and written to the
// database at most once a minute, so a console refreshing every few seconds
// does not write on every request.
const activity = new Map<string, { activeAt: number; seenAt: number; flushedAt: number }>();
const FLUSH_MS = 60_000;

function knownActivity(session: SessionRow) {
  const held = activity.get(session.id);
  const dbActive = new Date(session.last_active_at).getTime();
  return { activeAt: Math.max(held?.activeAt ?? 0, dbActive), held };
}

/**
 * Records a request on this session. lastInputSeconds is how long ago the
 * person last touched the screen, as the console reports it; without it the
 * request itself counts as use (older consoles, computers).
 */
export function noteActivity(session: SessionRow, lastInputSeconds: number | null) {
  const now = Date.now();
  const { activeAt: known, held } = knownActivity(session);
  const reported = lastInputSeconds === null ? now : now - Math.max(0, lastInputSeconds) * 1000;
  // Never earlier than what is known: a stale header must not age a session.
  const activeAt = Math.min(now, Math.max(known, reported));
  const entry = { activeAt, seenAt: now, flushedAt: held?.flushedAt ?? 0 };
  activity.set(session.id, entry);
  if (now - entry.flushedAt >= FLUSH_MS) {
    entry.flushedAt = now;
    void db.pool
      .query("UPDATE user_sessions SET last_seen_at = to_timestamp($2 / 1000.0), last_active_at = to_timestamp($3 / 1000.0) WHERE id = $1", [
        session.id,
        entry.seenAt,
        entry.activeAt,
      ])
      .catch(() => {});
  }
}

export type SessionVerdict =
  | { ok: true; locked: boolean }
  | { ok: false; reason: string };

/**
 * Whether a session may still be used, under the rules in force. Ends it when
 * a time limit has run out. Rules only bind phones: a control-room computer is
 * left open on purpose.
 */
async function lockSession(session: SessionRow) {
  await db.pool.query("UPDATE user_sessions SET locked_at = NOW() WHERE id = $1 AND locked_at IS NULL", [session.id]);
  forgetSession(session.id);
}

const realSteps = {
  end: (session: SessionRow, reason: string) => endSession(session.user_id, session.id, reason),
  lock: lockSession,
};

export async function judgeSession(
  session: SessionRow,
  policy: SecurityPolicy,
  now = Date.now(),
  steps: { end: (session: SessionRow, reason: string) => Promise<unknown>; lock: (session: SessionRow) => Promise<unknown> } = realSteps,
): Promise<SessionVerdict> {
  if (session.ended_at) return { ok: false, reason: session.end_reason || "ended" };
  if (!session.is_phone) return { ok: true, locked: false };
  const { activeAt } = knownActivity(session);
  const idleMs = now - activeAt;
  if (policy.phone_max_hours && now - new Date(session.created_at).getTime() > policy.phone_max_hours * 3_600_000) {
    await steps.end(session, "time limit");
    return { ok: false, reason: "time limit" };
  }
  if (policy.phone_idle_minutes && idleMs > policy.phone_idle_minutes * 60_000) {
    await steps.end(session, "not used");
    return { ok: false, reason: "not used" };
  }
  if (session.locked_at) return { ok: true, locked: true };
  if (policy.phone_lock_minutes && idleMs > policy.phone_lock_minutes * 60_000) {
    await steps.lock(session);
    return { ok: true, locked: true };
  }
  return { ok: true, locked: false };
}

/** Clears the lock after the right PIN, and counts the session as just used. */
export async function unlockSession(session: SessionRow) {
  const now = Date.now();
  activity.set(session.id, { activeAt: now, seenAt: now, flushedAt: now });
  await db.pool.query(
    "UPDATE user_sessions SET locked_at = NULL, pin_failures = 0, last_active_at = NOW(), last_seen_at = NOW() WHERE id = $1",
    [session.id],
  );
  forgetSession(session.id);
}

/** Counts a wrong PIN; returns how many wrong in a row. */
export async function notePinFailure(session: SessionRow) {
  const { rows } = await db.pool.query(
    "UPDATE user_sessions SET pin_failures = pin_failures + 1 WHERE id = $1 RETURNING pin_failures",
    [session.id],
  );
  forgetSession(session.id);
  return Number(rows[0]?.pin_failures || 0);
}

/** Turns a session into a panic session, after the panic password at the lock screen. */
export async function markDuress(session: SessionRow) {
  await db.pool.query("UPDATE user_sessions SET duress = true WHERE id = $1", [session.id]);
  forgetSession(session.id);
}

export function forgetAllSessions() {
  sessionCache.clear();
}
