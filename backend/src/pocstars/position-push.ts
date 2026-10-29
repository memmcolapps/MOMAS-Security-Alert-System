// Every GPS point each radio sends, pushed from the bridge on the POCSTARS host.
//
// Handsets upload a batch of points every 15-30s, and the vendor API we poll
// only returns the newest one. The bridge reads every point from the vendor's
// own store and sends each batch down the reverse tunnel; this holds that
// subscription. It uses its own connection rather than sharing the SOS one, so
// a problem reading positions can never cost an alarm.
//
// On reconnect it asks for everything since the last point it received, so a
// dropped tunnel leaves no hole in a radio's trail.
import { env } from "../config";
import { PocstarsBridgeClient } from "./bridge-client";
import { liveRadioConfigured } from "./live-gateway";

const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 120_000;
const LIVENESS_INTERVAL_MS = 20_000;
const CATCH_UP_MS = 10 * 60_000;

export type PushedPoint = { uid: string; lat: number; lon: number; t: number; s: number };
type PositionHandler = (points: PushedPoint[]) => Promise<void>;

const state = {
  client: null as PocstarsBridgeClient | null,
  handler: null as PositionHandler | null,
  backoffMs: RECONNECT_MIN_MS,
  timer: null as ReturnType<typeof setTimeout> | null,
  liveness: null as ReturnType<typeof setInterval> | null,
  connectedAt: null as number | null,
  lastPointAt: null as number | null,
  // Vendor save time of the newest point received, the catch-up mark.
  lastSavedMs: null as number | null,
  received: 0,
  lastError: null as string | null,
};

export function positionPushStatus() {
  return {
    enabled: Boolean(state.handler),
    connected: Boolean(state.client),
    connectedSince: state.connectedAt ? new Date(state.connectedAt).toISOString() : null,
    lastPointAt: state.lastPointAt ? new Date(state.lastPointAt).toISOString() : null,
    received: state.received,
    lastError: state.lastError,
  };
}

/** True while points are actually arriving, so the slower poll can stand aside. */
export function positionPushLive(withinMs = 90_000) {
  return Boolean(state.client && state.lastPointAt && Date.now() - state.lastPointAt < withinMs);
}

export function startPositionPush(handler: PositionHandler) {
  if (!liveRadioConfigured() || state.handler) return;
  state.handler = handler;
  void connect();
}

function stopLiveness() {
  if (state.liveness) clearInterval(state.liveness);
  state.liveness = null;
}

function scheduleReconnect(reason: string) {
  if (state.timer) return;
  const delay = state.backoffMs;
  state.lastError = reason;
  console.warn(`[Positions] bridge push down (${reason}), retrying in ${Math.round(delay / 1000)}s`);
  state.timer = setTimeout(() => {
    state.timer = null;
    void connect();
  }, delay);
  state.backoffMs = Math.min(state.backoffMs * 2, RECONNECT_MAX_MS);
}

async function connect() {
  if (!state.handler) return;
  const handler = state.handler;
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
  client.on("positions", (points: PushedPoint[]) => {
    if (!points.length) return;
    state.lastPointAt = Date.now();
    state.received += points.length;
    for (const point of points) {
      if (!state.lastSavedMs || point.s > state.lastSavedMs) state.lastSavedMs = point.s;
    }
    void handler(points).catch((error) => {
      console.error("[Positions] storing pushed points failed:", error instanceof Error ? error.message : error);
    });
  });

  try {
    await client.connect();
    state.client = client;
    const since = state.lastSavedMs ? state.lastSavedMs + 1 : Date.now() - CATCH_UP_MS;
    await client.watchPositions(since);
    state.connectedAt = Date.now();
    state.backoffMs = RECONNECT_MIN_MS;
    state.lastError = null;
    stopLiveness();
    state.liveness = setInterval(() => {
      if (state.client !== client) return;
      client.ping().catch((error) => drop(error instanceof Error ? error : new Error(String(error))));
    }, LIVENESS_INTERVAL_MS);
    console.log("[Positions] bridge push live");
  } catch (error) {
    if (state.client === client) state.client = null;
    await client.close().catch(() => {});
    scheduleReconnect(error instanceof Error ? error.message : String(error));
  }
}
