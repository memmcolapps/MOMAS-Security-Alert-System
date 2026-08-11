// Real-time radio presence.
//
// The vendor database records no online state anywhere, so presence can only
// come from the voice plane. Polling it was the first approach and it was wrong
// for dispatch: a radio could drop the moment after a refresh and the console
// would offer it as callable until the next one. echat instead pushes
// ptt.push.UsersChanged as radios come and go, so this holds one long-lived
// session and writes each change through as it arrives.
//
// The session signs in on a reserved seat that the bridge never leases for
// audio. That matters: echat allows one login per account and evicts the older
// session, so a shared account would have operators and this watcher killing
// each other's connections in a loop.
import { env } from "../config";
import * as db from "../db";
import { PocstarsBridgeClient } from "./bridge-client";
import { liveRadioConfigured } from "./live-gateway";

const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;

type Watcher = {
  companyId: number;
  client: PocstarsBridgeClient | null;
  backoffMs: number;
  stopped: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

const watchers = new Map<number, Watcher>();

export function presenceWatcherStatus() {
  return [...watchers.values()].map((watcher) => ({
    companyId: watcher.companyId,
    connected: Boolean(watcher.client),
    retryInMs: watcher.client ? null : watcher.backoffMs,
  }));
}

export function startPresenceWatcher(companyId: number) {
  if (!liveRadioConfigured() || watchers.has(companyId)) return;
  const watcher: Watcher = {
    companyId, client: null, backoffMs: RECONNECT_MIN_MS, stopped: false, timer: null,
  };
  watchers.set(companyId, watcher);
  void connect(watcher);
}

export async function stopPresenceWatchers() {
  for (const watcher of watchers.values()) {
    watcher.stopped = true;
    if (watcher.timer) clearTimeout(watcher.timer);
    await watcher.client?.close().catch(() => {});
    watcher.client = null;
  }
  watchers.clear();
}

function scheduleReconnect(watcher: Watcher, reason?: string) {
  if (watcher.stopped || watcher.timer) return;
  const delay = watcher.backoffMs;
  // Presence is only as trustworthy as this session. Losing it silently is the
  // failure mode that showed the whole fleet offline for a day, so say so.
  console.warn(
    `[Radio] presence watcher for company ${watcher.companyId} `
    + `${reason || "down"}, retrying in ${Math.round(delay / 1000)}s`,
  );
  watcher.timer = setTimeout(() => {
    watcher.timer = null;
    void connect(watcher);
  }, delay);
  watcher.backoffMs = Math.min(watcher.backoffMs * 2, RECONNECT_MAX_MS);
}

async function connect(watcher: Watcher) {
  if (watcher.stopped) return;
  const client = new PocstarsBridgeClient({
    url: env.POCSTARS_BRIDGE_URL,
    token: env.POCSTARS_BRIDGE_TOKEN,
    timeoutMs: env.POCSTARS_PTT_TIMEOUT_MS,
  });

  const drop = (error: Error) => {
    if (watcher.client !== client) return;
    watcher.client = null;
    void client.close().catch(() => {});
    console.warn(`[Radio] presence watcher error: ${error.message}`);
    scheduleReconnect(watcher);
  };

  client.on("error", drop);
  client.on("presence", (users: any[]) => {
    void applyDelta(watcher, users);
  });

  try {
    await client.connect();
    const baseline = await client.watchPresence(watcher.companyId);

    // An organization that exists but has no channels yet. Nothing to watch,
    // and nothing wrong - so close quietly and look again later rather than
    // treating it as a failure and retrying in a tightening loop.
    if (baseline.idle) {
      await client.close().catch(() => {});
      if (watcher.client === client) watcher.client = null;
      watcher.backoffMs = RECONNECT_MAX_MS;
      scheduleReconnect(watcher, `company ${watcher.companyId} has no channels yet`);
      return;
    }

    watcher.client = client;
    watcher.backoffMs = RECONNECT_MIN_MS;

    // The baseline is a full picture; deltas after it are single radios. Skip
    // dispatcher consoles, which appear in group membership but are not devices.
    const entries = baseline.radios
      .filter((radio: any) => Number(radio.role) !== 3)
      .map((radio: any) => ({ uid: Number(radio.uid), online: Boolean(radio.online) }));
    const updated = await db.applyPocstarsPresence(entries);
    console.log(
      `[Radio] presence watcher live on ${baseline.seat} (company ${watcher.companyId}): `
      + `${entries.length} radios, ${updated} corrected`,
    );
  } catch (error) {
    await client.close().catch(() => {});
    if (watcher.client === client) watcher.client = null;
    console.warn(
      `[Radio] presence watcher for company ${watcher.companyId} could not start:`,
      error instanceof Error ? error.message : error,
    );
    scheduleReconnect(watcher);
  }
}

async function applyDelta(watcher: Watcher, users: any[]) {
  const entries = users
    .map((user) => ({ uid: Number(user?.uid || 0), online: Boolean(user?.online) }))
    .filter((entry) => Number.isSafeInteger(entry.uid) && entry.uid > 0);
  if (!entries.length) return;
  try {
    const updated = await db.applyPocstarsPresence(entries);
    // Logged whether or not a row moved. A delta that changes nothing is not
    // the same event as no delta at all, and only logging the former makes a
    // dead watcher indistinguishable from a quiet network.
    console.log(
      `[Radio] presence: ${entries.map((e) => `${e.uid}=${e.online ? "on" : "off"}`).join(" ")}`
      + ` (${updated} row${updated === 1 ? "" : "s"} changed)`,
    );
  } catch (error) {
    console.warn(
      "[Radio] could not apply a presence change:",
      error instanceof Error ? error.message : error,
    );
  }
}
