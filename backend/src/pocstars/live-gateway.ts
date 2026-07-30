import type { Context } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { canManageOrganization, primaryOrganization } from "../auth";
import { env } from "../config";
import * as db from "../db";
import { PocstarsBridgeClient } from "./bridge-client";

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
};

let activeSession: ActiveSession | null = null;

// A browser socket that dies behind the Java gateway may never deliver a close
// event, which would otherwise leave the console permanently "busy". Treat a
// session whose socket is no longer open as finished.
function sessionIsBusy() {
  if (!activeSession || activeSession.closed) return false;
  if (activeSession.ws.readyState === 1) return true;
  void cleanup(activeSession, "socket_dead");
  return false;
}

function busyBy() {
  if (!activeSession || activeSession.closed) return null;
  return {
    operator: activeSession.user?.name || activeSession.user?.email || "another operator",
    mode: activeSession.mode,
    division: activeSession.divisionName,
  };
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

export async function queryPocstarsInventory() {
  if (!liveRadioConfigured()) {
    throw new Error("The POCSTARS bridge is not configured on this MOMAS server.");
  }
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

async function visibleDevice(user: any, deviceId: string) {
  const devices = await db.listDevices(operatorScope(user));
  return devices.find((device: any) =>
    String(device.device_id) === deviceId && Boolean(device.active));
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
  if (activeSession === session) activeSession = null;
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
  if (sessionIsBusy()) {
    send(ws, {
      type: "error",
      code: "radio_console_busy",
      message: "Another operator is using the live radio console.",
      busyBy: busyBy(),
    });
    return;
  }
  const device = await visibleDevice(user, deviceId);
  if (!device) {
    send(ws, {
      type: "error",
      code: "forbidden",
      message: "That radio is inactive or outside your operational scope.",
    });
    return;
  }
  const targetUid = Number(device.device_id);
  if (!Number.isSafeInteger(targetUid) || targetUid <= 0) {
    send(ws, {
      type: "error",
      code: "invalid_radio_uid",
      message: "This device does not have a valid POCSTARS user ID.",
    });
    return;
  }

  const client = createLiveClient();
  const session: ActiveSession = {
    ws,
    client,
    device,
    user,
    mode: "private",
    divisionName: device.name ? `call with ${device.name}` : null,
    speakerNames: new Map(),
    pttHeld: false,
    microphoneGranted: false,
    pttTimer: null,
    closed: false,
  };
  activeSession = session;
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
    const group = await client.startSingleCall(targetUid);
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
      message: error instanceof Error ? error.message : "The POCSTARS call could not be started.",
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
  if (sessionIsBusy()) {
    send(ws, {
      type: "error",
      code: "radio_console_busy",
      message: "Another operator is using the live radio console.",
      busyBy: busyBy(),
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
    mode: "monitor",
    divisionName: channel.name,
    speakerNames: new Map(),
    pttHeld: false,
    microphoneGranted: false,
    pttTimer: null,
    closed: false,
  };
  activeSession = session;
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
    const group = await client.startWatchGroup(groupId);
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
      message: error instanceof Error ? error.message : "The POCSTARS group could not be monitored.",
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
      message: error instanceof Error ? error.message : "POCSTARS did not grant the microphone.",
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
      send(ws, {
        type: "ready",
        configured: liveRadioConfigured(),
        busy: sessionIsBusy(),
        busyBy: busyBy(),
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
        if (activeSession?.ws === ws) session = activeSession;
      } else if (message.type === "monitor.start") {
        if (session) return;
        await startMonitor(ws, user, message);
        if (activeSession?.ws === ws) session = activeSession;
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
