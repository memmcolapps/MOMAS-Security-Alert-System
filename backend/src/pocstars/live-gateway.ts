import type { Context } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { primaryOrganization } from "../auth";
import { env } from "../config";
import * as db from "../db";
import { PocstarsLiveClient } from "./live-client";

type ActiveSession = {
  ws: WSContext;
  client: PocstarsLiveClient;
  device: any;
  user: any;
  pttHeld: boolean;
  microphoneGranted: boolean;
  pttTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
};

let activeSession: ActiveSession | null = null;

export function liveRadioConfigured() {
  return Boolean(
    env.POCSTARS_PTT_CONTROL_HOST
      && env.POCSTARS_PTT_ACCOUNT
      && env.POCSTARS_PTT_PASSWORD,
  );
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
  await audit(session, "radio.live.end", { reason });
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
  if (activeSession && !activeSession.closed) {
    send(ws, {
      type: "error",
      code: "radio_console_busy",
      message: "Another operator is using the live radio console.",
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

  const client = new PocstarsLiveClient({
    host: env.POCSTARS_PTT_CONTROL_HOST,
    port: env.POCSTARS_PTT_CONTROL_PORT,
    audioHost: env.POCSTARS_PTT_AUDIO_HOST || env.POCSTARS_PTT_CONTROL_HOST,
    account: env.POCSTARS_PTT_ACCOUNT,
    password: env.POCSTARS_PTT_PASSWORD,
    timeoutMs: env.POCSTARS_PTT_TIMEOUT_MS,
  });
  const session: ActiveSession = {
    ws,
    client,
    device,
    user,
    pttHeld: false,
    microphoneGranted: false,
    pttTimer: null,
    closed: false,
  };
  activeSession = session;
  client.on("audio", (audio: Buffer, info: any) => {
    send(ws, { type: "speaker", uid: info.uid, speaking: true });
    if (ws.readyState === 1) ws.send(Uint8Array.from(audio));
  });
  client.on("speaker", (state) => send(ws, { type: "speaker", ...state }));
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
        busy: Boolean(activeSession && !activeSession.closed),
      });
    },
    onMessage: async (event, ws) => {
      if (typeof event.data !== "string") {
        if (session?.microphoneGranted) {
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
      } else if (message.type === "ptt.start" && session && !session.closed) {
        await beginPtt(session);
      } else if (message.type === "ptt.stop" && session && !session.closed) {
        await endPtt(session);
      } else if (message.type === "call.end" && session) {
        await cleanup(session);
        session = null;
        send(ws, { type: "call.state", state: "idle" });
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
