// SOS alarms pushed from the bridge on the POCSTARS host.
//
// The VPS polls the vendor SOS service across the internet every few seconds,
// and on the site's link those requests time out often enough that alarms
// arrived minutes late. The bridge runs next to that service, checks it over
// loopback every second, and sends each new alarm down the reverse tunnel it
// already keeps open. This holds that subscription.
//
// The poll in routes/pocstars.ts stays as the backstop: both paths feed the
// same idempotent insert, so whichever lands first wins and the other is a
// no-op. Losing this session therefore costs speed, never alarms.
import { env } from "../config";
import { PocstarsBridgeClient } from "./bridge-client";
import { liveRadioConfigured } from "./live-gateway";

const RECONNECT_MIN_MS = 2_000;
// Kept short on purpose: this is the fast path for alarms, and the cost of a
// failed attempt is one small request over the tunnel.
const RECONNECT_MAX_MS = 30_000;
const LIVENESS_INTERVAL_MS = 20_000;

type SosHandler = (rows: any[]) => Promise<void>;

const state = {
  client: null as PocstarsBridgeClient | null,
  handler: null as SosHandler | null,
  backoffMs: RECONNECT_MIN_MS,
  timer: null as ReturnType<typeof setTimeout> | null,
  liveness: null as ReturnType<typeof setInterval> | null,
  connectedAt: null as number | null,
  lastAlarmAt: null as number | null,
  lastError: null as string | null,
  stopped: false,
};

export function sosPushStatus() {
  return {
    enabled: Boolean(state.handler),
    connected: Boolean(state.client),
    connectedSince: state.connectedAt ? new Date(state.connectedAt).toISOString() : null,
    lastAlarmAt: state.lastAlarmAt ? new Date(state.lastAlarmAt).toISOString() : null,
    lastError: state.lastError,
    retryInMs: state.client || !state.handler ? null : state.backoffMs,
  };
}

export function startSosPush(handler: SosHandler) {
  if (!liveRadioConfigured() || state.handler) return;
  state.handler = handler;
  state.stopped = false;
  void connect();
}

export async function stopSosPush() {
  state.stopped = true;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  stopLiveness();
  const client = state.client;
  state.client = null;
  await client?.close().catch(() => {});
}

function stopLiveness() {
  if (state.liveness) clearInterval(state.liveness);
  state.liveness = null;
}

function scheduleReconnect(reason: string) {
  if (state.stopped || state.timer) return;
  const delay = state.backoffMs;
  state.lastError = reason;
  console.warn(`[SOS] bridge push down (${reason}), retrying in ${Math.round(delay / 1000)}s`);
  state.timer = setTimeout(() => {
    state.timer = null;
    void connect();
  }, delay);
  state.backoffMs = Math.min(state.backoffMs * 2, RECONNECT_MAX_MS);
}

async function connect() {
  if (state.stopped || !state.handler) return;
  const handler = state.handler;
  const client = new PocstarsBridgeClient({
    url: env.POCSTARS_BRIDGE_URL,
    token: env.POCSTARS_BRIDGE_TOKEN,
    timeoutMs: 10_000,
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
  client.on("sos", (rows: any[]) => {
    if (!rows.length) return;
    state.lastAlarmAt = Date.now();
    void handler(rows).catch((error) => {
      console.error("[SOS] storing pushed alarms failed:", error instanceof Error ? error.message : error);
    });
  });

  try {
    await client.connect();
    // Set before subscribing: the bridge's snapshot can arrive right behind
    // its acknowledgement, and the handler is wired either way.
    state.client = client;
    await client.watchSos(env.POCSTARS_TARGET_UID);
    state.connectedAt = Date.now();
    state.backoffMs = RECONNECT_MIN_MS;
    state.lastError = null;
    // A reverse SSH tunnel can stay "open" with nothing getting through. The
    // round trip is what proves the path, and a missed one reconnects.
    stopLiveness();
    state.liveness = setInterval(() => {
      if (state.client !== client) return;
      client.ping().catch((error) => drop(error instanceof Error ? error : new Error(String(error))));
    }, LIVENESS_INTERVAL_MS);
    console.log(`[SOS] bridge push live for alarm recipient ${env.POCSTARS_TARGET_UID}`);
  } catch (error) {
    if (state.client === client) state.client = null;
    await client.close().catch(() => {});
    scheduleReconnect(error instanceof Error ? error.message : String(error));
  }
}
