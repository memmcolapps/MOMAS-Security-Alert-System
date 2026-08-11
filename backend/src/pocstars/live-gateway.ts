import type { Context } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { canManageOrganization, primaryOrganization } from "../auth";
import { env } from "../config";
import * as db from "../db";
import { PocstarsBridgeClient } from "./bridge-client";
import { type CompanySnapshot, shapeDatabaseInventory } from "./inventory-snapshot";

type ActiveSession = {
  ws: WSContext;
  client: PocstarsBridgeClient;
  device: any;
  user: any;
  mode: "private" | "monitor";
  divisionName: string | null;
  speakerNames: Map<string, string>;
  pttHeld: boolean;
  microphoneGranted: boolean;
  pttTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  organizationId: number | null;
  isPlatformOperator: boolean;
};

// Live sessions across the whole platform. Each holds one dispatcher seat on
// the radio network; how many an organization may hold at once is its seat
// quota. Platform operators draw on a separate reserve so our monitoring can
// never consume a tenant's own capacity.
const liveSessions = new Set<ActiveSession>();

function reapDeadSessions() {
  for (const session of [...liveSessions]) {
    if (session.closed || session.ws.readyState !== 1) {
      void cleanup(session, "socket_dead");
    }
  }
}

// Only the voice-plane inventory fallback still asks this. That query leases a
// seat, and on a bridge old enough to lack provisioning there is only one, so it
// has to wait for live audio rather than evict it.
function sessionIsBusy() {
  reapDeadSessions();
  return liveSessions.size > 0;
}

function sessionsFor(organizationId: number | null, isPlatform: boolean) {
  return [...liveSessions].filter((session) =>
    Number(session.organizationId) === Number(organizationId)
    && session.isPlatformOperator === isPlatform);
}

async function claimSeatSlot(user: any, organizationId: number | null) {
  reapDeadSessions();
  const isPlatform = user?.platform_role === "admin";
  const organization = organizationId ? await db.getOrganization(organizationId) : null;
  const limit = isPlatform
    ? Number(organization?.platform_radio_seats ?? 1)
    : Number(organization?.radio_seats ?? 2);
  const inUse = sessionsFor(organizationId, isPlatform);
  if (inUse.length >= Math.max(0, limit)) {
    const who = isPlatform ? "platform" : "organization";
    return {
      ok: false as const,
      message: `All ${limit} ${who} radio consoles for this organization are in use.`,
      busyBy: {
        operator: inUse[0]?.user?.name || inUse[0]?.user?.email || "another operator",
        mode: inUse[0]?.mode || null,
        division: inUse[0]?.divisionName || null,
      },
    };
  }
  return { ok: true as const, isPlatform };
}

async function speakerName(session: ActiveSession, uid: unknown) {
  const key = String(uid ?? "");
  if (!key) return null;
  const cached = session.speakerNames.get(key);
  if (cached) return cached;
  const device = await db.getDevice(key).catch(() => null);
  const name = device?.name || `Radio ${key}`;
  session.speakerNames.set(key, name);
  return name;
}

function attachSpeakerEvents(session: ActiveSession) {
  const { ws, client } = session;
  let lastAudioUid: string | null = null;
  client.on("audio", (audio: Buffer, info: any) => {
    const uid = String(info?.uid ?? "");
    if (uid !== lastAudioUid) {
      lastAudioUid = uid;
      void speakerName(session, uid).then((name) => {
        send(ws, { type: "speaker", uid: info?.uid, name, speaking: true });
      });
    }
    if (ws.readyState === 1) ws.send(Uint8Array.from(audio));
  });
  client.on("speaker", (state: any) => {
    if (!state?.speaking) lastAudioUid = null;
    void speakerName(session, state?.uid).then((name) => {
      send(ws, { type: "speaker", ...state, name });
    });
  });
}

export function liveRadioConfigured() {
  return Boolean(
    env.POCSTARS_BRIDGE_URL && env.POCSTARS_BRIDGE_TOKEN,
  );
}

// Inventory has two possible sources and they see different things. The
// database plane lists every handset a company owns and needs no dispatcher
// seat. The voice plane can only enumerate radios through group membership on
// this install - QueryContacts is refused - so handsets in no group are
// invisible to it, and it holds a seat for the length of the query. Prefer the
// database; keep the voice path for a bridge built without provisioning.
export async function queryPocstarsInventory() {
  if (!liveRadioConfigured()) {
    throw new Error("The radio network link is not configured on this MOMAS server.");
  }
  const fromDatabase = await queryInventoryFromDatabase();
  if (fromDatabase) return fromDatabase;
  return await queryInventoryOverVoice();
}

// Presence is the one thing the database plane cannot answer, so it is fetched
// separately and slowly. This leases a dispatcher seat, which is exactly why it
// must not run on the five-minute cycle: it waits for a live session rather than
// competing with one, and the caller retries later.
export async function refreshPresenceOverVoice() {
  if (!liveRadioConfigured()) {
    throw new Error("The radio network link is not configured on this MOMAS server.");
  }
  return await db.refreshPocstarsPresence(await queryInventoryOverVoice());
}

async function queryInventoryOverVoice() {
  if (sessionIsBusy()) {
    throw new Error("The live radio console is currently in use. Try the inventory sync again shortly.");
  }
  const client = createLiveClient();
  try {
    await client.connect();
    return await client.queryInventory();
  } finally {
    await client.close().catch(() => {});
  }
}

// A vendor group belongs to one company for life, so this mapping is resolved
// once per process rather than on every five-minute sync.
const companyIdByGroupId = new Map<number, number>();

// The companies the last database sync actually enumerated. The presence
// watchers follow these rather than resolving the set a second time.
let lastCompanyIds: number[] = [];
export function knownCompanyIds() {
  return [...lastCompanyIds];
}

// Every vendor company MOMAS should enumerate: the ones organizations record
// for themselves, plus whichever company owns a group already in the registry.
// The second half is what finds the platform's original company, which predates
// per-tenant provisioning and is recorded nowhere else.
async function resolveCompanyIds(client: PocstarsBridgeClient) {
  const companyIds = new Set<number>(await db.listOrganizationCompanyIds());
  for (const groupId of await db.listRegistryGroupIds()) {
    if (!companyIdByGroupId.has(groupId)) {
      // Only a successful lookup is remembered. Caching a failure would strand
      // a whole company's radios until the next restart.
      const result = await client.provision("provision.company.forGroup", { groupId })
        .catch(() => null);
      const companyId = Number(result?.companyId);
      if (Number.isSafeInteger(companyId) && companyId > 0) {
        companyIdByGroupId.set(groupId, companyId);
      }
    }
    const cached = companyIdByGroupId.get(groupId);
    if (cached) companyIds.add(cached);
  }

  // The pool holds radios nobody has been allocated yet. It belongs to no
  // organization and owns no channel, so neither branch above can find it -
  // and without it, a radio waiting in the pool is absent from the snapshot
  // and the stale sweep marks it inactive, as though the handset had vanished.
  const pool = await client.provision("provision.pool").catch(() => null);
  const poolCompanyId = Number(pool?.companyId);
  if (Number.isSafeInteger(poolCompanyId) && poolCompanyId > 0) companyIds.add(poolCompanyId);

  return [...companyIds];
}

// Returns null - rather than throwing - when the database plane cannot serve
// this request at all, so the caller can fall back to the voice plane. Once the
// plane is known to be usable, failures are real and propagate.
async function queryInventoryFromDatabase() {
  const client = createLiveClient();
  try {
    // A failure to reach the bridge at all is not a reason to fall back: the
    // voice plane runs over the same link and would fail the same way.
    await client.connect();

    // Provisioning is optional in the bridge, and a bridge built without it
    // refuses every provisioning command. That is the one condition the voice
    // plane can still serve, so probe for it before committing to this plane.
    try {
      await client.provision("provision.ping");
    } catch (error) {
      console.warn(
        "The bridge has no database plane, falling back to the voice inventory:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }

    const companyIds = await resolveCompanyIds(client);
    // Nothing to enumerate yet: a first-ever sync, before any group or
    // organization has given us a company to ask about. The voice plane can
    // still bootstrap the registry from group membership.
    if (!companyIds.length) return null;
    lastCompanyIds = companyIds;

    // Past this point the database plane is known to work, so a failure is a
    // real one and belongs to the caller rather than to a silent fallback.
    return await buildDatabaseInventory(client, companyIds);
  } finally {
    await client.close().catch(() => {});
  }
}

async function buildDatabaseInventory(client: PocstarsBridgeClient, companyIds: number[]) {
  const companySnapshots: CompanySnapshot[] = [];
  for (const companyId of companyIds) {
    const [groups, radios] = await Promise.all([
      client.provision("provision.groups", { companyId }),
      client.provision("provision.radios", { companyId }),
    ]);
    companySnapshots.push({ groups, radios });
  }

  // Keep reporting the configured dispatcher as the source. It is what the
  // registry rows are already tagged with, so switching planes does not orphan
  // them or split the fleet across two scopes.
  const dispatcherUid = String(env.POCSTARS_DISPATCHER_UID);
  return {
    ...shapeDatabaseInventory(companySnapshots),
    dispatcher: {
      id: dispatcherUid,
      name: (await db.getPocstarsDispatcherName(dispatcherUid)) || `Dispatcher ${dispatcherUid}`,
    },
    source: "database",
    presenceKnown: false,
    observedAt: new Date().toISOString(),
  };
}

// Provisioning opens its own short-lived bridge connection. It never leases a
// dispatcher seat - the bridge answers provisioning commands straight from the
// vendor database, without touching the voice session - so it runs alongside
// live audio instead of waiting for it.
export async function provisionOnNetwork(command: string, payload: Record<string, unknown> = {}) {
  if (!liveRadioConfigured()) {
    throw new Error("The radio network link is not configured on this MOMAS server.");
  }
  const client = createLiveClient();
  try {
    await client.connect();
    return await client.provision(command, payload);
  } finally {
    await client.close().catch(() => {});
  }
}

function createLiveClient() {
  return new PocstarsBridgeClient({
    url: env.POCSTARS_BRIDGE_URL,
    token: env.POCSTARS_BRIDGE_TOKEN,
    timeoutMs: env.POCSTARS_PTT_TIMEOUT_MS,
  });
}

function send(ws: WSContext, value: Record<string, unknown>) {
  if (ws.readyState === 1) ws.send(JSON.stringify(value));
}

function operatorScope(user: any) {
  if (user?.platform_role === "admin") return {};
  const membership = primaryOrganization(user);
  if (!membership) return { organizationId: -1 };
  return {
    organizationId: membership.organization_id,
    unitId: membership.scope_level === "unit" ? membership.unit_id : null,
    assignedOnly: !canManageOrganization(membership),
  };
}

// One refusal used to cover three unrelated causes - unregistered, inactive,
// out of scope - and read as "can't find device" for all of them, which is
// undiagnosable from the console. Each is now named, because the operator is
// usually the only person who can tell you which one it was.
async function resolveCallTarget(user: any, deviceId: string) {
  const devices = await db.listDevices(operatorScope(user));
  const inScope = devices.find((device: any) => String(device.device_id) === deviceId);
  if (inScope && inScope.active) return { ok: true as const, device: inScope };
  if (inScope) {
    return {
      ok: false as const,
      code: "device_inactive",
      message: `${inScope.name || `Radio ${deviceId}`} is marked inactive in the device registry.`,
    };
  }

  // Look again without the scope filter, so the message can separate "you may
  // not call this" from "this radio does not exist here".
  const known = await db.getDevice(deviceId).catch(() => null);
  if (!known) {
    return {
      ok: false as const,
      code: "device_unknown",
      message: `No radio with ID ${deviceId} is in the device registry. It may have been removed, or the console may be showing a stale list - reload and try again.`,
    };
  }
  return {
    ok: false as const,
    code: "forbidden",
    message: known.organization_id
      ? "That radio belongs to another organization and is outside your operational scope."
      : "That radio is not allocated to your organization yet.",
  };
}

async function audit(session: ActiveSession, action: string, metadata: Record<string, unknown> = {}) {
  await db.createAuditLog({
    organization_id: session.device.organization_id || null,
    actor_user_id: session.user?.id,
    action,
    target_type: "device",
    target_id: session.device.device_id,
    metadata,
  }).catch(() => {});
}

async function cleanup(session: ActiveSession, reason = "operator") {
  if (session.closed) return;
  session.closed = true;
  if (session.pttTimer) clearTimeout(session.pttTimer);
  session.pttTimer = null;
  await session.client.close().catch(() => {});
  await audit(session, session.mode === "monitor" ? "radio.monitor.end" : "radio.live.end", { reason });
  liveSessions.delete(session);
}

async function startCall(ws: WSContext, user: any, deviceId: string) {
  if (!liveRadioConfigured()) {
    send(ws, {
      type: "error",
      code: "live_radio_not_configured",
      message: "Live radio is not configured on this MOMAS server.",
    });
    return;
  }
  const target = await resolveCallTarget(user, deviceId);
  if (!target.ok) {
    send(ws, { type: "error", code: target.code, message: target.message });
    return;
  }
  const { device } = target;
  const targetUid = Number(device.device_id);
  if (!Number.isSafeInteger(targetUid) || targetUid <= 0) {
    send(ws, {
      type: "error",
      code: "invalid_radio_uid",
      message: "This device does not have a valid radio ID.",
    });
    return;
  }

  const slot = await claimSeatSlot(user, device.organization_id ? Number(device.organization_id) : null);
  if (!slot.ok) {
    send(ws, { type: "error", code: "radio_console_busy", message: slot.message, busyBy: slot.busyBy });
    return;
  }
  const companyId = device.organization_id
    ? await db.getOrganizationCompanyId(Number(device.organization_id))
    : null;

  const client = createLiveClient();
  const session: ActiveSession = {
    ws,
    client,
    device,
    user,
    organizationId: device.organization_id ? Number(device.organization_id) : null,
    isPlatformOperator: slot.isPlatform,
    mode: "private",
    divisionName: device.name ? `call with ${device.name}` : null,
    speakerNames: new Map(),
    pttHeld: false,
    microphoneGranted: false,
    pttTimer: null,
    closed: false,
  };
  liveSessions.add(session);
  attachSpeakerEvents(session);
  client.on("mic", (state: any) => {
    session.microphoneGranted = Boolean(state.speaking);
    send(ws, { type: "ptt.state", state: state.speaking ? "granted" : "idle", reason: state.reason });
  });
  client.on("error", (error: Error) => {
    if (!session.closed) send(ws, { type: "error", code: "pocstars_voice_error", message: error.message });
  });

  try {
    send(ws, { type: "call.state", state: "connecting", deviceId });
    await client.connect();
    const group = await client.startSingleCall(targetUid, companyId);
    await audit(session, "radio.live.start", { pocstars_group_id: group.gid });
    send(ws, {
      type: "call.state",
      state: "connected",
      deviceId,
      group: { id: group.gid, name: group.name },
    });
  } catch (error) {
    send(ws, {
      type: "error",
      code: "pocstars_call_failed",
      message: error instanceof Error ? error.message : "The call could not be started.",
    });
    await cleanup(session, "connect_failed");
  }
}

// A user may monitor a channel when it is inside their scope: platform admins
// any organization's channels, org members their own, unit-scoped members only
// channels pinned to their unit. Channels are never shared across orgs.
async function monitorableChannel(user: any, channelId: number) {
  const scope = operatorScope(user);
  if (scope.organizationId === -1) return null;
  const channels = await db.listMonitorableChannels(scope);
  return channels.find((channel: any) => Number(channel.id) === channelId) || null;
}

async function startMonitor(ws: WSContext, user: any, message: any) {
  if (!liveRadioConfigured()) {
    send(ws, {
      type: "error",
      code: "live_radio_not_configured",
      message: "Live radio is not configured on this MOMAS server.",
    });
    return;
  }
  const channel = message.channelId !== undefined
    ? await monitorableChannel(user, Number(message.channelId))
    : null;
  if (!channel) {
    send(ws, {
      type: "error",
      code: "forbidden",
      message: "That channel is outside your operational scope.",
    });
    return;
  }
  const groupId = Number(channel.pocstars_group_id);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    send(ws, {
      type: "error",
      code: "channel_not_provisioned",
      message: "This channel is not live on the radio network yet.",
    });
    return;
  }

  const slot = await claimSeatSlot(user, Number(channel.organization_id));
  if (!slot.ok) {
    send(ws, { type: "error", code: "radio_console_busy", message: slot.message, busyBy: slot.busyBy });
    return;
  }
  const companyId = await db.getOrganizationCompanyId(Number(channel.organization_id));

  const client = createLiveClient();
  const session: ActiveSession = {
    ws,
    client,
    device: {
      device_id: `channel:${channel.id}`,
      organization_id: channel.organization_id,
      unit_id: channel.unit_id,
      unit_name: channel.name,
    },
    user,
    organizationId: Number(channel.organization_id),
    isPlatformOperator: slot.isPlatform,
    mode: "monitor",
    divisionName: channel.name,
    speakerNames: new Map(),
    pttHeld: false,
    microphoneGranted: false,
    pttTimer: null,
    closed: false,
  };
  liveSessions.add(session);
  attachSpeakerEvents(session);
  client.on("error", (error: Error) => {
    if (!session.closed) send(ws, { type: "error", code: "pocstars_voice_error", message: error.message });
  });

  try {
    send(ws, {
      type: "monitor.state",
      state: "connecting",
      channel: { id: channel.id, name: channel.name },
    });
    await client.connect();
    const group = await client.startWatchGroup(groupId, companyId);
    await audit(session, "radio.monitor.start", {
      channel_id: channel.id,
      pocstars_group_id: group.gid,
    });
    send(ws, {
      type: "monitor.state",
      state: "connected",
      channel: { id: channel.id, name: channel.name },
      group: { id: group.gid, name: group.name },
    });
  } catch (error) {
    send(ws, {
      type: "error",
      code: "pocstars_monitor_failed",
      message: error instanceof Error ? error.message : "That channel could not be monitored.",
    });
    await cleanup(session, "connect_failed");
  }
}

async function beginPtt(session: ActiveSession) {
  if (session.microphoneGranted) return;
  session.pttHeld = true;
  send(session.ws, { type: "ptt.state", state: "requesting" });
  try {
    await session.client.requestMic();
    if (!session.pttHeld) {
      await session.client.releaseMic();
      return;
    }
    session.pttTimer = setTimeout(() => {
      session.pttHeld = false;
      void session.client.releaseMic();
      send(session.ws, {
        type: "error",
        code: "ptt_time_limit",
        message: "Push-to-talk stopped at the safety time limit.",
      });
    }, env.POCSTARS_PTT_MAX_SECONDS * 1000);
    await audit(session, "radio.live.ptt.start");
  } catch (error) {
    session.microphoneGranted = false;
    send(session.ws, {
      type: "error",
      code: "microphone_not_granted",
      message: error instanceof Error ? error.message : "The radio network did not grant the microphone.",
    });
    send(session.ws, { type: "ptt.state", state: "idle" });
  }
}

async function endPtt(session: ActiveSession) {
  session.pttHeld = false;
  if (session.pttTimer) clearTimeout(session.pttTimer);
  session.pttTimer = null;
  await session.client.releaseMic().catch(() => {});
  session.microphoneGranted = false;
  send(session.ws, { type: "ptt.state", state: "idle" });
  await audit(session, "radio.live.ptt.stop");
}

export function liveRadioWebSocket(c: Context): WSEvents {
  const user = c.get("user");
  let session: ActiveSession | null = null;
  return {
    onOpen: (_event, ws) => {
      // Capacity is per organization now, so it is reported when a session is
      // actually requested rather than guessed at connect time.
      send(ws, {
        type: "ready",
        configured: liveRadioConfigured(),
      });
    },
    onMessage: async (event, ws) => {
      if (typeof event.data !== "string") {
        if (session?.mode === "private" && session.microphoneGranted) {
          const bytes = event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : new Uint8Array((event.data as any).buffer);
          if (bytes.byteLength <= 16 * 1024) {
            try {
              session.client.sendAmr(bytes);
            } catch (error) {
              send(ws, { type: "error", code: "invalid_audio", message: "The microphone audio was invalid." });
            }
          }
        }
        return;
      }
      let message: any;
      try {
        message = JSON.parse(event.data);
      } catch {
        send(ws, { type: "error", code: "invalid_message", message: "Invalid live-radio command." });
        return;
      }
      if (message.type === "call.start") {
        if (session) return;
        await startCall(ws, user, String(message.deviceId || ""));
        session = [...liveSessions].find((entry) => entry.ws === ws) || null;
      } else if (message.type === "monitor.start") {
        if (session) return;
        await startMonitor(ws, user, message);
        session = [...liveSessions].find((entry) => entry.ws === ws) || null;
      } else if (message.type === "ptt.start" && session?.mode === "private" && !session.closed) {
        await beginPtt(session);
      } else if (message.type === "ptt.stop" && session?.mode === "private" && !session.closed) {
        await endPtt(session);
      } else if (message.type === "call.end" && session) {
        await cleanup(session);
        session = null;
        send(ws, { type: "call.state", state: "idle" });
      } else if (message.type === "monitor.end" && session) {
        await cleanup(session);
        session = null;
        send(ws, { type: "monitor.state", state: "idle" });
      }
    },
    onClose: () => {
      if (session) void cleanup(session, "socket_closed");
      session = null;
    },
    onError: () => {
      if (session) void cleanup(session, "socket_error");
      session = null;
    },
  };
}
