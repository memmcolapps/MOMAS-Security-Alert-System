import { timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { PocstarsLiveClient } from "../src/pocstars/live-client";

type BridgeSession = {
  client: PocstarsLiveClient | null;
  mode: "private" | "monitor" | null;
  closing: boolean;
  pttTimer: ReturnType<typeof setTimeout> | null;
};

const host = process.env.BRIDGE_HOST || "127.0.0.1";
const port = Number(process.env.BRIDGE_PORT || 16892);
const token = process.env.BRIDGE_TOKEN || "";
const controlHost = process.env.BRIDGE_POCSTARS_CONTROL_HOST || "192.168.1.65";
const controlPort = Number(process.env.BRIDGE_POCSTARS_CONTROL_PORT || 22055);
const audioHost = process.env.BRIDGE_POCSTARS_AUDIO_HOST || controlHost;
const account = process.env.BRIDGE_POCSTARS_ACCOUNT || "";
const password = process.env.BRIDGE_POCSTARS_PASSWORD || "";
const timeoutMs = Number(process.env.POCSTARS_PTT_TIMEOUT_MS || 10_000);
const maxPttSeconds = Number(process.env.POCSTARS_PTT_MAX_SECONDS || 60);

if (token.length < 32) {
  throw new Error("BRIDGE_TOKEN must contain at least 32 characters.");
}
if (!account || !password) {
  throw new Error(
    "BRIDGE_POCSTARS_ACCOUNT and BRIDGE_POCSTARS_PASSWORD are required.",
  );
}

let activeSocket: ServerWebSocket<BridgeSession> | null = null;
let activeSince: number | null = null;
let lastClientMessageAt: number | null = null;

// The MOMAS backend reaches this bridge through a reverse SSH tunnel. When a
// client dies without a clean close (browser tab killed, laptop asleep, backend
// restart), the tunnel can hold the connection half-open: the bridge never gets
// a close event, so the console slot is never released and every later session
// is refused until the service restarts.
//
// Liveness is proven with protocol-level pings rather than application
// messages: every WebSocket implementation answers a ping automatically, so a
// silent-but-healthy monitoring session stays up regardless of which MOMAS
// build is on the other end, while a dead peer stops answering and is reaped.
const CLIENT_IDLE_LIMIT_MS = 90_000;
const PING_INTERVAL_MS = 20_000;

setInterval(() => {
  const ws = activeSocket;
  if (!ws) return;
  const idleFor = Date.now() - (lastClientMessageAt || Date.now());
  if (idleFor >= CLIENT_IDLE_LIMIT_MS) {
    console.warn(`Reaping stale bridge session: no client response for ${Math.round(idleFor / 1000)}s`);
    void closeSession(ws);
    try {
      ws.close(1001, "Idle bridge session reaped");
    } catch {
      // Already gone; closeSession has freed the slot.
    }
    return;
  }
  try {
    ws.ping();
  } catch {
    // Ping failed outright: the peer is unreachable, so free the slot now.
    void closeSession(ws);
  }
}, PING_INTERVAL_MS);

function tokenMatches(candidate: string) {
  const expected = Buffer.from(token);
  const supplied = Buffer.from(candidate);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function send(ws: ServerWebSocket<BridgeSession>, value: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

async function closeSession(ws: ServerWebSocket<BridgeSession>) {
  // Release the console slot first and unconditionally. A re-entrant call used
  // to hit the `closing` guard and return before this line, which left the
  // bridge permanently "busy" and refusing every later session.
  if (activeSocket === ws) activeSocket = null;
  if (ws.data.closing) return;
  ws.data.closing = true;
  if (ws.data.pttTimer) clearTimeout(ws.data.pttTimer);
  ws.data.pttTimer = null;
  const client = ws.data.client;
  ws.data.client = null;
  await client?.close().catch(() => {});
}

function attachClientEvents(
  ws: ServerWebSocket<BridgeSession>,
  client: PocstarsLiveClient,
) {
  client.on("audio", (audio: Buffer, info: any) => {
    send(ws, { type: "speaker", uid: info.uid, speaking: true });
    if (ws.readyState === WebSocket.OPEN) ws.send(Uint8Array.from(audio));
  });
  client.on("speaker", (state) => send(ws, { type: "speaker", ...state }));
  client.on("mic", (state: any) => {
    send(ws, {
      type: "ptt.state",
      state: state.speaking ? "granted" : "idle",
      reason: state.reason,
    });
  });
  client.on("error", (error: Error) => {
    send(ws, {
      type: "error",
      code: "pocstars_voice_error",
      message: error.message,
    });
  });
}

const server = Bun.serve<BridgeSession>({
  hostname: host,
  port,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        configured: Boolean(account && password),
        active: Boolean(activeSocket),
        activeSince: activeSince ? new Date(activeSince).toISOString() : null,
        lastSeenSecondsAgo: activeSocket && lastClientMessageAt
          ? Math.round((Date.now() - lastClientMessageAt) / 1000)
          : null,
      });
    }
    if (url.pathname !== "/radio/live") {
      return new Response("Not found", { status: 404 });
    }
    if (!tokenMatches(url.searchParams.get("token") || "")) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (activeSocket) {
      return new Response("Radio bridge busy", { status: 409 });
    }
    const upgraded = server.upgrade(request, {
      data: { client: null, mode: null, closing: false, pttTimer: null },
    });
    return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 });
  },
  websocket: {
    // Backstop for the half-open tunnel case: Bun drops the socket when no
    // frame arrives within the window. The MOMAS client pings well inside it.
    idleTimeout: 120,
    open(ws) {
      activeSocket = ws;
      activeSince = Date.now();
      lastClientMessageAt = Date.now();
      send(ws, { type: "ready", configured: true });
    },
    async message(ws, incoming) {
      if (activeSocket === ws) lastClientMessageAt = Date.now();
      if (typeof incoming !== "string") {
        if (ws.data.client?.speaking) {
          const bytes = incoming instanceof ArrayBuffer
            ? new Uint8Array(incoming)
            : new Uint8Array(incoming.buffer, incoming.byteOffset, incoming.byteLength);
          if (bytes.byteLength <= 16 * 1024) ws.data.client.sendAmr(bytes);
        }
        return;
      }

      let message: any;
      try {
        message = JSON.parse(incoming);
      } catch {
        send(ws, { type: "error", code: "invalid_message", message: "Invalid bridge command." });
        return;
      }

      if (message.type === "ping") {
        send(ws, { type: "pong" });
        return;
      }

      if (message.type === "inventory.query") {
        if (ws.data.client) return;
        const client = new PocstarsLiveClient({
          host: controlHost,
          port: controlPort,
          audioHost,
          account,
          password,
          timeoutMs,
        });
        ws.data.client = client;
        attachClientEvents(ws, client);
        try {
          await client.connect();
          const inventory = await client.queryInventory();
          send(ws, { type: "inventory.result", inventory });
        } catch (error) {
          send(ws, {
            type: "error",
            code: "pocstars_inventory_failed",
            message: error instanceof Error ? error.message : "The radio network inventory query failed.",
          });
        } finally {
          await closeSession(ws);
        }
      } else if (message.type === "call.start") {
        if (ws.data.client) return;
        const deviceId = Number(message.deviceId);
        if (!Number.isSafeInteger(deviceId) || deviceId <= 0) {
          send(ws, { type: "error", code: "invalid_radio_uid", message: "Invalid radio ID." });
          return;
        }
        const client = new PocstarsLiveClient({
          host: controlHost,
          port: controlPort,
          audioHost,
          account,
          password,
          timeoutMs,
        });
        ws.data.client = client;
        ws.data.mode = "private";
        attachClientEvents(ws, client);
        try {
          send(ws, { type: "call.state", state: "connecting", deviceId });
          await client.connect();
          const group = await client.startSingleCall(deviceId);
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
            message: error instanceof Error ? error.message : "The call failed.",
          });
          await closeSession(ws);
        }
      } else if (message.type === "monitor.start") {
        if (ws.data.client) return;
        const groupId = Number(message.groupId);
        if (!Number.isSafeInteger(groupId) || groupId <= 0) {
          send(ws, { type: "error", code: "invalid_group_id", message: "Invalid channel ID." });
          return;
        }
        const client = new PocstarsLiveClient({
          host: controlHost,
          port: controlPort,
          audioHost,
          account,
          password,
          timeoutMs,
        });
        ws.data.client = client;
        ws.data.mode = "monitor";
        attachClientEvents(ws, client);
        try {
          send(ws, { type: "monitor.state", state: "connecting", groupId });
          await client.connect();
          const group = await client.startWatchGroup(groupId);
          send(ws, {
            type: "monitor.state",
            state: "connected",
            group: { id: group.gid, name: group.name },
          });
        } catch (error) {
          send(ws, {
            type: "error",
            code: "pocstars_monitor_failed",
            message: error instanceof Error ? error.message : "Channel monitoring failed.",
          });
          await closeSession(ws);
        }
      } else if (message.type === "ptt.start" && ws.data.client && ws.data.mode === "private") {
        try {
          send(ws, { type: "ptt.state", state: "requesting" });
          await ws.data.client.requestMic();
          if (ws.data.pttTimer) clearTimeout(ws.data.pttTimer);
          ws.data.pttTimer = setTimeout(() => {
            void ws.data.client?.releaseMic();
            send(ws, {
              type: "error",
              code: "ptt_time_limit",
              message: "Push-to-talk stopped at the safety time limit.",
            });
          }, maxPttSeconds * 1000);
        } catch (error) {
          send(ws, {
            type: "error",
            code: "microphone_not_granted",
            message: error instanceof Error ? error.message : "The radio network did not grant the microphone.",
          });
          send(ws, { type: "ptt.state", state: "idle" });
        }
      } else if (message.type === "ptt.stop" && ws.data.client && ws.data.mode === "private") {
        if (ws.data.pttTimer) clearTimeout(ws.data.pttTimer);
        ws.data.pttTimer = null;
        await ws.data.client.releaseMic().catch(() => {});
        send(ws, { type: "ptt.state", state: "idle" });
      } else if (message.type === "call.end") {
        await closeSession(ws);
        send(ws, { type: "call.state", state: "idle" });
      } else if (message.type === "monitor.end") {
        await closeSession(ws);
        send(ws, { type: "monitor.state", state: "idle" });
      }
    },
    pong(ws) {
      if (activeSocket === ws) lastClientMessageAt = Date.now();
    },
    close(ws) {
      void closeSession(ws);
    },
  },
});

console.log(`POCSTARS bridge listening on http://${server.hostname}:${server.port}`);
