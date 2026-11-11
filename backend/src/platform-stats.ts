// Everything the platform stats page shows, gathered in one go.
//
// Two kinds of numbers live here. Some come from records the app has always
// kept (alarms, alarm events, scrape logs) and so reach back months. The rest
// come from counters added with this page (metrics.ts) and start at zero on
// the day it was deployed; `counting_since` tells the page which is which.
import { getClassifierHealth } from "./classifier";
import { env } from "./config";
import { pool } from "./db";
import { flushMetrics } from "./metrics";
import { heartbeatPushStatus } from "./pocstars/heartbeat-push";
import { positionPushStatus } from "./pocstars/position-push";
import { sosPushStatus } from "./pocstars/sos-push";

export type StatsRange = "24h" | "7d" | "30d";

const RANGES: Record<StatsRange, { hours: number; unit: "hour" | "day" }> = {
  "24h": { hours: 24, unit: "hour" },
  "7d": { hours: 7 * 24, unit: "day" },
  "30d": { hours: 30 * 24, unit: "day" },
};

// Days are cut where the operators' day is cut, not at UTC midnight.
const ZONE = "Africa/Lagos";
// An alarm on a console within this many seconds of the button press counts as
// on time. The bridge path normally lands in one to four.
const ON_TIME_SECONDS = 10;

export function normalizeRange(value: unknown): StatsRange {
  return value === "24h" || value === "30d" ? value : "7d";
}

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

type Line = {
  id: string;
  name: string;
  detail: string;
  good: number;
  bad: number;
  // "up" / "down" for a link that is connected or not right now; null when
  // there is no such thing as "right now" for this line.
  live: "up" | "down" | "off" | null;
  note: string | null;
};

function linkLine(
  id: string,
  name: string,
  detail: string,
  counters: Map<string, { count: number; totalMs: number }>,
  status: { enabled: boolean; connected: boolean; lastError: string | null },
): Line {
  const samples = counters.get(`push.${id}.sample`)?.count || 0;
  const up = counters.get(`push.${id}.up`)?.count || 0;
  const drops = counters.get(`push.${id}.drop`)?.count || 0;
  return {
    id: `push.${id}`,
    name,
    detail,
    good: up,
    bad: samples - up,
    live: !status.enabled ? "off" : status.connected ? "up" : "down",
    note: !status.enabled
      ? "Not set up on this server"
      : status.lastError || (drops ? `Dropped ${drops} time${drops === 1 ? "" : "s"}` : null),
  };
}

function postureChecks(users: any) {
  const secretLength = env.AUTH_JWT_SECRET.length;
  const bridgeOn = Boolean(env.POCSTARS_BRIDGE_URL);
  const plainRadioLinks = [env.POCSTARS_SOS_BASE, env.POCSTARS_LOC_BASE].some((url) => url.startsWith("http://"));
  const owners = Number(users.owners || 0);
  const tempPasswords = Number(users.temp_passwords || 0);

  const checks: Array<{ id: string; label: string; state: "ok" | "warn" | "bad"; detail: string }> = [
    {
      id: "login_limit",
      label: "Limit on sign-in attempts",
      state: "bad",
      detail: "There is none. Someone can keep guessing a password for as long as they like.",
    },
    {
      id: "secret",
      label: "Session signing key",
      state: secretLength >= 32 ? "ok" : "warn",
      detail:
        secretLength >= 32
          ? `${secretLength} characters.`
          : `${secretLength} characters. 32 or more is the usual minimum.`,
    },
    {
      id: "session_length",
      label: "Session length",
      state: "warn",
      detail: "A sign-in lasts 7 days. A stolen session can only be cut short by disabling the account.",
    },
    {
      id: "temp_passwords",
      label: "Temporary passwords",
      state: tempPasswords ? "warn" : "ok",
      detail: tempPasswords
        ? `${tempPasswords} account${tempPasswords === 1 ? " is" : "s are"} still on the password an admin typed for them.`
        : "Every account has set its own password.",
    },
    {
      id: "owners",
      label: "Platform owners",
      state: owners === 1 ? "warn" : "ok",
      detail:
        owners === 1
          ? "Only one. If that account is lost, nobody can manage platform staff."
          : `${owners} accounts hold the top role.`,
    },
    {
      id: "radio_links",
      label: "Links to the radio server",
      state: plainRadioLinks ? "warn" : "ok",
      detail: plainRadioLinks
        ? "Alarm and location requests travel unencrypted (http)."
        : "Alarm and location requests are encrypted.",
    },
    {
      id: "recordings_password",
      label: "Recording server password",
      state: process.env.POCSTARS_RECORDINGS_PASSWORD ? "ok" : "warn",
      detail: process.env.POCSTARS_RECORDINGS_PASSWORD
        ? "Set on this server."
        : "Not set on this server, so the default written in the code is in use.",
    },
  ];
  if (bridgeOn) {
    const tokenLength = env.POCSTARS_BRIDGE_TOKEN.length;
    checks.push({
      id: "bridge_token",
      label: "Radio bridge key",
      state: tokenLength >= 24 ? "ok" : "bad",
      detail: tokenLength >= 24 ? `${tokenLength} characters.` : tokenLength ? "Shorter than 24 characters." : "No key is set.",
    });
  }
  return checks;
}

async function buildStats(range: StatsRange, sosPoll: { lastOkAt: string | null; lastError: string | null }) {
  const { hours, unit } = RANGES[range];
  const since = new Date(Date.now() - hours * 3_600_000);
  const step = unit === "hour" ? "1 hour" : "1 day";

  // Counts still in memory go out first, so the page is never 30 s behind.
  await flushMetrics();

  // Independent reads, so they all go at once.
  const [
    sosSummary,
    sosNow,
    sosSeries,
    sosActions,
    counterRows,
    securitySeries,
    topIps,
    targetedEmails,
    recentEvents,
    scrape,
    classification,
    users,
    radios,
    countingSince,
  ] = await Promise.all([
    pool.query(
      `WITH a AS (
         SELECT *, GREATEST(0, EXTRACT(EPOCH FROM created_at - triggered_at)) AS delay_s
           FROM sos_alerts WHERE created_at >= $1
       )
       SELECT COUNT(*)::int AS total,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY delay_s) AS delay_p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY delay_s) AS delay_p95,
              MAX(delay_s) AS delay_max,
              COUNT(*) FILTER (WHERE delay_s <= $2)::int AS on_time,
              COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL OR status >= 1)::int AS answered,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM acknowledged_at - created_at))
                FILTER (WHERE acknowledged_at IS NOT NULL) AS answer_p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM acknowledged_at - created_at))
                FILTER (WHERE acknowledged_at IS NOT NULL) AS answer_p95,
              COUNT(*) FILTER (WHERE status = 2)::int AS resolved,
              COUNT(*) FILTER (WHERE received_via = 'push')::int AS via_push,
              COUNT(*) FILTER (WHERE received_via = 'poll')::int AS via_poll,
              COUNT(*) FILTER (WHERE consoles_at_receipt IS NOT NULL)::int AS consoles_known,
              COUNT(*) FILTER (WHERE consoles_at_receipt = 0)::int AS nobody_watching,
              COUNT(*) FILTER (WHERE location_lat IS NULL)::int AS no_location,
              COUNT(*) FILTER (WHERE organization_id IS NULL)::int AS no_company
         FROM a`,
      [since, ON_TIME_SECONDS],
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 0)::int AS open,
              MIN(created_at) FILTER (WHERE status = 0) AS oldest_open_at,
              COUNT(*) FILTER (WHERE sync_status = 'failed')::int AS sync_failed
         FROM sos_alerts`,
    ),
    pool.query(
      `SELECT to_char(g, 'YYYY-MM-DD"T"HH24:MI') AS t,
              COUNT(a.id)::int AS total,
              COUNT(a.id) FILTER (WHERE EXTRACT(EPOCH FROM a.created_at - a.triggered_at) > $3)::int AS late
         FROM generate_series(
                date_trunc($2, $1::timestamptz AT TIME ZONE '${ZONE}'),
                date_trunc($2, NOW() AT TIME ZONE '${ZONE}'),
                $4::interval
              ) AS g
         LEFT JOIN sos_alerts a
           ON a.created_at >= $1
          AND date_trunc($2, a.created_at AT TIME ZONE '${ZONE}') = g
        GROUP BY g ORDER BY g`,
      [since, unit, ON_TIME_SECONDS, step],
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE event_type = 'sync_failed')::int AS failed,
              COUNT(*) FILTER (WHERE event_type IN ('response_started', 'resolved', 'reopened'))::int AS ok
         FROM sos_alert_events WHERE created_at >= $1`,
      [since],
    ),
    pool.query(
      `SELECT key, SUM(count)::bigint AS count, SUM(total_ms)::bigint AS total_ms
         FROM platform_metrics WHERE bucket >= date_trunc('hour', $1::timestamptz)
        GROUP BY key`,
      [since],
    ),
    pool.query(
      `SELECT to_char(g, 'YYYY-MM-DD"T"HH24:MI') AS t,
              COALESCE(SUM(m.count) FILTER (WHERE m.key = 'security.login_failed'), 0)::int AS login_failed,
              COALESCE(SUM(m.count) FILTER (WHERE m.key = 'security.bad_token'), 0)::int AS bad_token,
              COALESCE(SUM(m.count) FILTER (WHERE m.key = 'security.forbidden'), 0)::int AS forbidden,
              COALESCE(SUM(m.count) FILTER (WHERE m.key = 'security.probe'), 0)::int AS probe
         FROM generate_series(
                date_trunc($2, $1::timestamptz AT TIME ZONE '${ZONE}'),
                date_trunc($2, NOW() AT TIME ZONE '${ZONE}'),
                $3::interval
              ) AS g
         LEFT JOIN platform_metrics m
           ON m.bucket >= date_trunc('hour', $1::timestamptz)
          AND m.key LIKE 'security.%'
          AND date_trunc($2, m.bucket AT TIME ZONE '${ZONE}') = g
        GROUP BY g ORDER BY g`,
      [since, unit, step],
    ),
    pool.query(
      `SELECT ip, COUNT(*)::int AS count, array_agg(DISTINCT type) AS types, MAX(created_at) AS last_at
         FROM security_events
        WHERE created_at >= $1 AND ip IS NOT NULL
        GROUP BY ip ORDER BY count DESC, last_at DESC LIMIT 8`,
      [since],
    ),
    pool.query(
      `SELECT e.email, COUNT(*)::int AS count, MAX(e.created_at) AS last_at,
              EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(e.email)) AS real_account
         FROM security_events e
        WHERE e.created_at >= $1 AND e.type = 'login_failed' AND e.email IS NOT NULL
        GROUP BY e.email ORDER BY count DESC, last_at DESC LIMIT 8`,
      [since],
    ),
    pool.query(
      `SELECT id, type, ip, email, path, created_at
         FROM security_events WHERE created_at >= $1
        ORDER BY created_at DESC LIMIT 12`,
      [since],
    ),
    pool.query(
      `SELECT split_part(source, ':', 1) AS source,
              COUNT(*) FILTER (WHERE status = 'ok')::int AS ok,
              COUNT(*) FILTER (WHERE status = 'error')::int AS failed,
              MAX(created_at) FILTER (WHERE status = 'ok') AS last_ok_at
         FROM scrape_logs WHERE created_at >= $1
        GROUP BY 1 ORDER BY failed DESC, ok DESC LIMIT 12`,
      [since],
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE created_at >= $1)::int AS collected,
              COUNT(*) FILTER (WHERE status = 'classification_failed' AND updated_at >= $1)::int AS failed
         FROM source_items WHERE created_at >= $1 OR updated_at >= $1`,
      [since],
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active,
              COUNT(*) FILTER (WHERE status <> 'active')::int AS disabled,
              COUNT(*) FILTER (WHERE status = 'active' AND platform_role = 'admin')::int AS owners,
              COUNT(*) FILTER (WHERE status = 'active' AND platform_role <> 'none')::int AS staff,
              COUNT(*) FILTER (WHERE status = 'active' AND must_change_password)::int AS temp_passwords
         FROM users`,
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE active)::int AS total,
              COUNT(*) FILTER (WHERE active AND pocstars_online)::int AS online,
              COUNT(*) FILTER (WHERE active AND pocstars_last_seen_at >= NOW() - INTERVAL '24 hours')::int AS seen_24h
         FROM devices`,
    ),
    pool.query(`SELECT MIN(bucket) AS since FROM platform_metrics`),
  ]);

  const counters = new Map<string, { count: number; totalMs: number }>();
  for (const row of counterRows.rows) {
    counters.set(row.key, { count: Number(row.count), totalMs: Number(row.total_ms) });
  }
  const c = (key: string) => counters.get(key)?.count || 0;

  // Requests and server errors, per part of the app.
  const areas: Array<{ area: string; requests: number; errors: number; avg_ms: number }> = [];
  let requests = 0;
  let errors = 0;
  let requestMs = 0;
  for (const [key, value] of counters) {
    if (!key.startsWith("http.req:")) continue;
    const area = key.slice("http.req:".length);
    const areaErrors = c(`http.err:${area}`);
    requests += value.count;
    errors += areaErrors;
    requestMs += value.totalMs;
    areas.push({
      area,
      requests: value.count,
      errors: areaErrors,
      avg_ms: value.count ? Math.round(value.totalMs / value.count) : 0,
    });
  }
  areas.sort((a, b) => b.errors - a.errors || b.requests - a.requests);

  const scrapeOk = scrape.rows.reduce((sum, row) => sum + row.ok, 0);
  const scrapeFailed = scrape.rows.reduce((sum, row) => sum + row.failed, 0);
  const pollOk = counters.get("sos.poll.ok");
  const classifier = getClassifierHealth() as any;
  const worstFeed = scrape.rows.find((row) => row.failed > 0);

  const lines: Line[] = [
    {
      id: "sos.poll",
      name: "Alarm check",
      detail: `Asks the radio server for new alarms every ${env.POCSTARS_SOS_POLL_SEC} s`,
      good: c("sos.poll.ok"),
      bad: c("sos.poll.fail"),
      live: null,
      note:
        sosPoll.lastError ||
        (pollOk?.count ? `Answers in ${Math.round(pollOk.totalMs / pollOk.count)} ms on average` : null),
    },
    linkLine("sos", "Alarm fast link", "The bridge pushes each alarm the second it is raised", counters, sosPushStatus()),
    linkLine("position", "Radio position link", "Live GPS points from every radio", counters, positionPushStatus()),
    linkLine("heartbeat", "Radio battery and signal link", "Online status, battery and signal", counters, heartbeatPushStatus()),
    {
      id: "sos.reconcile",
      name: "Alarm status sync",
      detail: "Picks up alarms answered on the radio network itself",
      good: c("sos.reconcile.ok"),
      bad: c("sos.reconcile.fail"),
      live: null,
      note: null,
    },
    {
      id: "sos.actions",
      name: "Answering and closing alarms",
      detail: "An operator's action reaching the radio network",
      good: sosActions.rows[0].ok,
      bad: sosActions.rows[0].failed,
      live: null,
      note: sosNow.rows[0].sync_failed ? `${sosNow.rows[0].sync_failed} alarm(s) currently stuck` : null,
    },
    {
      id: "http",
      name: "App requests",
      detail: "Every request the consoles make to this server",
      good: requests - errors,
      bad: errors,
      live: null,
      note: requests ? `${Math.round(requestMs / requests)} ms on average` : null,
    },
    {
      id: "scrape",
      name: "News collection",
      detail: "Runs against news feeds and public sources",
      good: scrapeOk,
      bad: scrapeFailed,
      live: null,
      note: worstFeed ? `Most failures: ${worstFeed.source}` : null,
    },
    {
      id: "classify",
      name: "News sorting",
      detail: "Collected items read and classified",
      good: Math.max(0, classification.rows[0].collected - classification.rows[0].failed),
      bad: classification.rows[0].failed,
      live: classifier.model_available === false ? "down" : null,
      note: classifier.last_error || null,
    },
  ];

  const summary = sosSummary.rows[0];
  const security = {
    login_failed: c("security.login_failed"),
    bad_token: c("security.bad_token"),
    forbidden: c("security.forbidden"),
    probe: c("security.probe"),
  };

  return {
    range,
    unit,
    generated_at: new Date().toISOString(),
    counting_since: countingSince.rows[0]?.since || null,
    on_time_seconds: ON_TIME_SECONDS,
    sos: {
      total: summary.total,
      on_time: summary.on_time,
      delay_p50: num(summary.delay_p50),
      delay_p95: num(summary.delay_p95),
      delay_max: num(summary.delay_max),
      answered: summary.answered,
      answer_p50: num(summary.answer_p50),
      answer_p95: num(summary.answer_p95),
      resolved: summary.resolved,
      via_push: summary.via_push,
      via_poll: summary.via_poll,
      consoles_known: summary.consoles_known,
      nobody_watching: summary.nobody_watching,
      no_location: summary.no_location,
      no_company: summary.no_company,
      open_now: sosNow.rows[0].open,
      oldest_open_at: sosNow.rows[0].oldest_open_at,
      last_poll_ok_at: sosPoll.lastOkAt,
      series: sosSeries.rows,
    },
    lines,
    areas: areas.filter((area) => area.errors > 0).slice(0, 6),
    feeds: scrape.rows.filter((row) => row.failed > 0).slice(0, 6),
    radios: radios.rows[0],
    security: {
      ...security,
      turned_away: security.login_failed + security.bad_token + security.forbidden + security.probe,
      login_ok: c("auth.login_ok"),
      expired_sessions: c("auth.token_expired"),
      series: securitySeries.rows,
      top_ips: topIps.rows,
      targeted: targetedEmails.rows,
      recent: recentEvents.rows,
      checks: postureChecks(users.rows[0]),
      users: users.rows[0],
    },
  };
}

// Held briefly and shared, so two owners with the page open (or one page
// refetching) cost one set of queries.
const CACHE_MS = 15_000;
const cache = new Map<StatsRange, { at: number; value: Promise<any> }>();

export function getPlatformStats(range: StatsRange, sosPoll: { lastOkAt: string | null; lastError: string | null }) {
  const hit = cache.get(range);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = buildStats(range, sosPoll);
  const entry = { at: Date.now(), value };
  cache.set(range, entry);
  value.catch(() => {
    if (cache.get(range) === entry) cache.delete(range);
  });
  return value;
}
