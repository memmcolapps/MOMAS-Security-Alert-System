// Is each server up, and how long does it take to reach it?
//
// Checked from this backend (on the Contabo server) every 30 seconds, whether
// or not anyone has the health page open, so the page always opens with a
// day of history and never waits on a slow radio server. Results live in
// memory only: a restart starts the history again, and `since` says so.
import { readFileSync } from "node:fs";
import os from "node:os";
import { env } from "./config";
import { pool } from "./db";

const EVERY_MS = 30_000;
const TIMEOUT_MS = 5_000;
const KEEP_MS = 24 * 3_600_000;
const RECENT = 40; // the last 20 minutes, for the small chart
const SLOW_MS = 1_000;

type Sample = { at: number; ms: number | null; error: string | null };
type Check = {
  id: string;
  name: string;
  detail: string;
  configured: () => boolean;
  run: () => Promise<unknown>;
};

const startedAt = Date.now();
const history = new Map<string, Sample[]>();
const extra: { bridgeSeats: number | null } = { bridgeSeats: null };
let timer: ReturnType<typeof setInterval> | null = null;

function bridgeHealthUrl() {
  const url = new URL(env.POCSTARS_BRIDGE_URL);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/health";
  url.search = "";
  return url.toString();
}

const CHECKS: Record<"contabo" | "pocstars", Check[]> = {
  contabo: [
    {
      id: "database",
      name: "Database",
      detail: "One small query to the database on this server",
      configured: () => true,
      run: () => pool.query("SELECT 1"),
    },
  ],
  pocstars: [
    {
      id: "radio_api",
      name: "Radio server",
      detail: "Where alarms and locations are read from",
      configured: () => Boolean(env.POCSTARS_SOS_BASE),
      // Any answer at all means the server is there; only no answer is a failure.
      run: async () => {
        const response = await fetch(env.POCSTARS_SOS_BASE, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        await response.body?.cancel();
      },
    },
    {
      id: "bridge",
      name: "Radio bridge",
      detail: "Live radio, GPS and the alarm fast link, through the tunnel",
      configured: () => Boolean(env.POCSTARS_BRIDGE_URL),
      run: async () => {
        const response = await fetch(bridgeHealthUrl(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) throw new Error(`The bridge answered ${response.status}`);
        const body: any = await response.json().catch(() => null);
        extra.bridgeSeats = typeof body?.seatsInUse === "number" ? body.seatsInUse : null;
      },
    },
  ],
};

function plainError(error: unknown) {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return `No answer within ${TIMEOUT_MS / 1000} s`;
    return error.message;
  }
  return String(error);
}

async function runOne(check: Check) {
  if (!check.configured()) return;
  const started = performance.now();
  let sample: Sample;
  try {
    // A hard limit around every check: a database connect or a half-open
    // socket can otherwise hang with no answer and no error.
    let limit: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      check.run(),
      new Promise((_, reject) => {
        limit = setTimeout(() => reject(new Error(`No answer within ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(limit));
    sample = { at: Date.now(), ms: Math.round(performance.now() - started), error: null };
  } catch (error) {
    sample = { at: Date.now(), ms: null, error: plainError(error) };
  }
  const list = history.get(check.id) || [];
  list.push(sample);
  const cutoff = Date.now() - KEEP_MS;
  while (list.length && list[0].at < cutoff) list.shift();
  history.set(check.id, list);
}

// Every check goes at once, so one slow server never delays the others.
function runAll() {
  return Promise.all(Object.values(CHECKS).flat().map(runOne));
}

export function startServerChecks() {
  if (timer) return;
  void runAll();
  timer = setInterval(() => void runAll(), EVERY_MS);
}

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function summarize(check: Check) {
  if (!check.configured()) {
    return { id: check.id, name: check.name, detail: check.detail, state: "off" as const };
  }
  const list = history.get(check.id) || [];
  const last = list[list.length - 1] || null;
  const times = list.filter((s) => s.ms !== null).map((s) => s.ms as number).sort((a, b) => a - b);
  const state = !last ? "unknown" : last.ms === null ? "down" : last.ms > SLOW_MS ? "slow" : "up";
  return {
    id: check.id,
    name: check.name,
    detail: check.detail,
    state,
    last_ms: last?.ms ?? null,
    last_at: last ? new Date(last.at).toISOString() : null,
    last_error: last?.error ?? null,
    typical_ms: quantile(times, 0.5),
    slow_ms: quantile(times, 0.95),
    up_pct: list.length ? (times.length / list.length) * 100 : null,
    checks: list.length,
    recent: list.slice(-RECENT).map((s) => s.ms),
  };
}

// os.freemem() counts the disk cache as used, so a healthy Linux box looks
// nearly full. MemAvailable is what the kernel says programs can still have.
function memoryUsedPct() {
  const total = os.totalmem();
  if (!total) return null;
  let available = os.freemem();
  try {
    const match = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
    if (match) available = Number(match[1]) * 1024;
  } catch {
    // Not Linux; fall back to free memory.
  }
  return Math.round(((total - available) / total) * 100);
}

function worst(states: string[]) {
  for (const state of ["down", "slow", "unknown", "up"]) if (states.includes(state)) return state;
  return "off";
}

export function getServerStatus(sosPoll: { lastOkAt: string | null }) {
  const contabo = CHECKS.contabo.map(summarize);
  const pocstars = CHECKS.pocstars.map(summarize);
  const [load1] = os.loadavg();
  return {
    generated_at: new Date().toISOString(),
    since: new Date(startedAt).toISOString(),
    every_seconds: EVERY_MS / 1000,
    slow_ms: SLOW_MS,
    servers: [
      {
        id: "contabo",
        name: "Contabo server",
        role: "Runs MOMAS and its database",
        // The page loading at all means this server is up.
        state: worst(["up", ...contabo.map((c) => c.state)]),
        checks: contabo,
        facts: {
          running_seconds: Math.round(process.uptime()),
          cpu_load_pct: Math.round((load1 / Math.max(1, os.cpus().length)) * 100),
          memory_used_pct: memoryUsedPct(),
        },
      },
      {
        id: "pocstars",
        name: "POCSTARS server",
        role: "The radio network",
        state: worst(pocstars.map((c) => c.state)),
        checks: pocstars,
        facts: {
          last_alarm_check_at: sosPoll.lastOkAt,
          bridge_seats: extra.bridgeSeats,
        },
      },
    ],
  };
}
