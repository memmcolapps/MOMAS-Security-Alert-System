// Handset heartbeats, pushed from the bridge on the POCSTARS host.
//
// Every online handset reports its battery and signal about every 15 seconds,
// for every company on the install. It needs no login and no channel
// membership, so it sees radios the tk4849 presence watchers cannot - those of
// companies MOMAS does not operate, or whose watcher has been switched off. A
// fresh heartbeat makes a radio online; the sweep below takes it offline again
// once the reports stop, unless the watcher still vouches for it.
//
// It holds its own connection, like the position push, so a problem here can
// never cost an alarm or a trail.
import { env } from "../config";
import * as db from "../db";
import { PocstarsBridgeClient } from "./bridge-client";
import { liveRadioConfigured } from "./live-gateway";

const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 120_000;
const LIVENESS_INTERVAL_MS = 20_000;
const SWEEP_INTERVAL_MS = 15_000;

type Beat = { uid: string; battery: number | null; signal: number | null; at: number };

const state = {
  started: false,
  client: null as PocstarsBridgeClient | null,
  backoffMs: RECONNECT_MIN_MS,
  timer: null as ReturnType<typeof setTimeout> | null,
  liveness: null as ReturnType<typeof setInterval> | null,
  connectedAt: null as number | null,
  lastBeatAt: null as number | null,
  received: 0,
  lastError: null as string | null,
};

export function heartbeatPushStatus() {
  return {
    enabled: state.started,
    connected: Boolean(state.client),
    connectedSince: state.connectedAt ? new Date(state.connectedAt).toISOString() : null,
    lastBeatAt: state.lastBeatAt ? new Date(state.lastBeatAt).toISOString() : null,
    received: state.received,
    lastError: state.lastError,
  };
}

/** True while heartbeats are actually arriving. */
function heartbeatsLive(withinMs = 90_000) {
  return Boolean(state.client && state.lastBeatAt && Date.now() - state.lastBeatAt < withinMs);
}

export function startHeartbeatPush() {
  if (!liveRadioConfigured() || state.started) return;
  state.started = true;
  void connect();
  setInterval(() => void sweep(), SWEEP_INTERVAL_MS).unref?.();
}

// Only while heartbeats are flowing. With the bridge link down every radio's
// last report ages out together, and taking the whole fleet offline because
// our own link dropped is the failure the watchers were built to avoid.
async function sweep() {
  if (!heartbeatsLive()) return;
  try {
    const wentOffline = await db.sweepStaleHeartbeats();
    if (wentOffline.length) console.log(`[Heartbeats] no report, now offline: ${wentOffline.join(" ")}`);
  } catch (error) {
    console.warn("[Heartbeats] offline sweep failed:", error instanceof Error ? error.message : error);
  }
}

function stopLiveness() {
  if (state.liveness) clearInterval(state.liveness);
  state.liveness = null;
}

function scheduleReconnect(reason: string) {
  if (state.timer) return;
  const delay = state.backoffMs;
  state.lastError = reason;
  console.warn(`[Heartbeats] bridge push down (${reason}), retrying in ${Math.round(delay / 1000)}s`);
  state.timer = setTimeout(() => {
    state.timer = null;
    void connect();
  }, delay);
  state.backoffMs = Math.min(state.backoffMs * 2, RECONNECT_MAX_MS);
}

async function connect() {
  const client = new PocstarsBridgeClient({
    url: env.POCSTARS_BRIDGE_URL,
    token: env.POCSTARS_BRIDGE_TOKEN,
    timeoutMs: 15_000,
  });

  const drop = (error: Error) => {
    if (state.client !== client) return;
    state.client = null;
    state.connectedAt = null;
    stopLiveness();
    void client.close().catch(() => {});
    scheduleReconnect(error.message);
  };

  client.on("error", drop);
  client.on("heartbeats", (beats: Beat[]) => {
    if (!beats.length) return;
    state.lastBeatAt = Date.now();
    state.received += beats.length;
    void db.applyHeartbeats(beats)
      .then(({ cameOnline }) => {
        if (cameOnline.length) console.log(`[Heartbeats] reporting, now online: ${cameOnline.join(" ")}`);
      })
      .catch((error) => {
        console.error("[Heartbeats] storing heartbeats failed:", error instanceof Error ? error.message : error);
      });
  });

  try {
    await client.connect();
    state.client = client;
    await client.watchHeartbeats();
    state.connectedAt = Date.now();
    state.backoffMs = RECONNECT_MIN_MS;
    state.lastError = null;
    stopLiveness();
    state.liveness = setInterval(() => {
      if (state.client !== client) return;
      client.ping().catch((error) => drop(error instanceof Error ? error : new Error(String(error))));
    }, LIVENESS_INTERVAL_MS);
    console.log("[Heartbeats] bridge push live");
  } catch (error) {
    if (state.client === client) state.client = null;
    await client.close().catch(() => {});
    scheduleReconnect(error instanceof Error ? error.message : String(error));
  }
}
