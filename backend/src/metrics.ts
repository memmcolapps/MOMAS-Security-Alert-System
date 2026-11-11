// Counts of things that can fail, kept for the platform stats page.
//
// Nothing here touches the database on the hot path. A count is one Map
// update; every 30 seconds the lot goes out as a single upsert into hourly
// buckets. A restart loses at most that last half minute of counts, which is
// the trade for never slowing a request down to measure it.
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";

const FLUSH_MS = 30_000;
const HOUR_MS = 3_600_000;
// Detail rows (who, from where) are capped per flush. A flood is still counted
// in full above; it just cannot fill the table.
const MAX_EVENTS_PER_FLUSH = 200;
const EVENT_RETENTION_DAYS = 90;
const COUNTER_RETENTION_DAYS = 400;

type Counter = { count: number; totalMs: number };
type SecurityEvent = {
  type: "login_failed" | "bad_token" | "forbidden" | "probe";
  ip: string | null;
  email: string | null;
  path: string | null;
  at: Date;
};

const counters = new Map<string, Counter>();
let events: SecurityEvent[] = [];
const probes = new Map<string, () => boolean | null>();
let timer: ReturnType<typeof setInterval> | null = null;
let lastPruneAt = 0;

function bucketOf(time: number) {
  return new Date(Math.floor(time / HOUR_MS) * HOUR_MS).toISOString();
}

/** Adds to a named count. `ms` is summed so an average duration can be shown. */
export function count(key: string, n = 1, ms = 0) {
  const id = `${bucketOf(Date.now())}|${key}`;
  const current = counters.get(id);
  if (current) {
    current.count += n;
    current.totalMs += ms;
  } else {
    counters.set(id, { count: n, totalMs: ms });
  }
}

/**
 * A link that is either up or down. It is sampled on every flush, so uptime is
 * "samples up / samples taken". Return null while the link is not configured
 * and nothing is recorded.
 */
export function watchLink(key: string, isUp: () => boolean | null) {
  probes.set(key, isUp);
}

/**
 * The visitor's address. Behind the reverse proxy the socket is always
 * loopback, so the proxy's headers are read first. The last X-Forwarded-For
 * entry is the one the proxy itself wrote; earlier ones are whatever the
 * caller sent and cannot be trusted.
 */
export function clientIp(c: Context): string | null {
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const last = forwarded.split(",").pop()?.trim();
    if (last) return last.slice(0, 64);
  }
  try {
    return getConnInfo(c).remote.address?.slice(0, 64) || null;
  } catch {
    return null;
  }
}

/** Counts a rejected request and keeps who it came from. */
export function securityEvent(
  type: SecurityEvent["type"],
  detail: { ip?: string | null; email?: string | null; path?: string | null } = {},
) {
  count(`security.${type}`);
  if (events.length >= MAX_EVENTS_PER_FLUSH) return;
  events.push({
    type,
    ip: detail.ip || null,
    email: detail.email ? String(detail.email).slice(0, 200) : null,
    path: detail.path ? String(detail.path).slice(0, 200) : null,
    at: new Date(),
  });
}

// Paths only a scanner asks for. The app has no PHP, no dotfiles and no admin
// panels at these names, so a request for one is somebody looking for a way in.
const PROBE_PATH =
  /\.(php\d?|aspx?|jsp|cgi|env|sql|bak|ini|ya?ml)(\?|$|\/)|^\/(wp-|cgi-bin|phpmyadmin|actuator|boaform|vendor\/|\.(?!well-known))/i;

export function isProbePath(path: string) {
  return PROBE_PATH.test(path);
}

// Fixed list, so a caller cannot invent path names and grow the key space.
const API_AREAS = new Set([
  "incidents", "pocstars", "drones", "auth", "organizations", "platform",
  "org", "osint", "geofences", "alerts", "config", "health",
]);

/** Called once per finished request from server.ts. */
export function observeRequest(c: Context, ms: number) {
  const path = c.req.path;
  if (!path.startsWith("/api/")) {
    if (isProbePath(path)) securityEvent("probe", { ip: clientIp(c), path });
    return;
  }
  const segment = path.split("/")[2] || "";
  const area = API_AREAS.has(segment) ? segment : "other";
  const status = c.res.status;
  count(`http.req:${area}`, 1, ms);
  if (status >= 500) count(`http.err:${area}`);
  if (status === 403) {
    const user = (c as any).get("user");
    securityEvent("forbidden", { ip: clientIp(c), email: user?.email, path });
  }
}

export async function flushMetrics() {
  for (const [key, isUp] of probes) {
    let up: boolean | null = null;
    try {
      up = isUp();
    } catch {
      up = false;
    }
    if (up === null) continue;
    count(`${key}.sample`);
    if (up) count(`${key}.up`);
  }

  const rows = [...counters.entries()];
  const batch = events;
  counters.clear();
  events = [];

  // Imported here, not at the top: auth.ts counts through this module and its
  // tests replace ./db with a stub that has no pool.
  const { pool } = await import("./db");

  try {
    if (rows.length) {
      await pool.query(
        `INSERT INTO platform_metrics (bucket, key, count, total_ms)
         SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::bigint[], $4::bigint[])
         ON CONFLICT (bucket, key) DO UPDATE
           SET count = platform_metrics.count + EXCLUDED.count,
               total_ms = platform_metrics.total_ms + EXCLUDED.total_ms`,
        [
          rows.map(([id]) => id.slice(0, id.indexOf("|"))),
          rows.map(([id]) => id.slice(id.indexOf("|") + 1)),
          rows.map(([, value]) => value.count),
          rows.map(([, value]) => Math.round(value.totalMs)),
        ],
      );
    }
    if (batch.length) {
      await pool.query(
        `INSERT INTO security_events (type, ip, email, path, created_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[])`,
        [
          batch.map((event) => event.type),
          batch.map((event) => event.ip),
          batch.map((event) => event.email),
          batch.map((event) => event.path),
          batch.map((event) => event.at),
        ],
      );
    }
  } catch (error) {
    // Put the counts back so one failed write does not lose them. Detail rows
    // are dropped: they are a sample, and holding them risks unbounded growth.
    for (const [id, value] of rows) {
      const current = counters.get(id);
      if (current) {
        current.count += value.count;
        current.totalMs += value.totalMs;
      } else {
        counters.set(id, value);
      }
    }
    console.warn("[Metrics] flush failed:", error instanceof Error ? error.message : error);
    return;
  }

  if (Date.now() - lastPruneAt > 24 * HOUR_MS) {
    lastPruneAt = Date.now();
    await Promise.all([
      pool.query(`DELETE FROM security_events WHERE created_at < NOW() - make_interval(days => $1)`, [EVENT_RETENTION_DAYS]),
      pool.query(`DELETE FROM platform_metrics WHERE bucket < NOW() - make_interval(days => $1)`, [COUNTER_RETENTION_DAYS]),
    ]).catch((error) => console.warn("[Metrics] prune failed:", error?.message || error));
  }
}

export function startMetrics() {
  if (timer) return;
  timer = setInterval(() => void flushMetrics(), FLUSH_MS);
}
