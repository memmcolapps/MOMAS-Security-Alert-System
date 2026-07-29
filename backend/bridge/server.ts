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

function tokenMatches(candidate: string) {
  const expected = Buffer.from(token);
  const supplied = Buffer.from(candidate);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function send(ws: ServerWebSocket<BridgeSession>, value: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

async function closeSession(ws: ServerWebSocket<BridgeSession>) {
  if (ws.data.closing) return;
  ws.data.closing = true;
  if (ws.data.pttTimer) clearTimeout(ws.data.pttTimer);
  ws.data.pttTimer = null;
  const client = ws.data.client;
  ws.data.client = null;
  await client?.close().catch(() => {});
  if (activeSocket === ws) activeSocket = null;
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
    open(ws) {
      activeSocket = ws;
      send(ws, { type: "ready", configured: true });
    },
    async message(ws, incoming) {
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
            message: error instanceof Error ? error.message : "POCSTARS inventory query failed.",
          });
        } finally {
          await closeSession(ws);
        }
      } else if (message.type === "call.start") {
        if (ws.data.client) return;
        const deviceId = Number(message.deviceId);
        if (!Number.isSafeInteger(deviceId) || deviceId <= 0) {
          send(ws, { type: "error", code: "invalid_radio_uid", message: "Invalid POCSTARS radio ID." });
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
            message: error instanceof Error ? error.message : "POCSTARS call failed.",
          });
          await closeSession(ws);
        }
      } else if (message.type === "monitor.start") {
        if (ws.data.client) return;
        const groupId = Number(message.groupId);
        if (!Number.isSafeInteger(groupId) || groupId <= 0) {
          send(ws, { type: "error", code: "invalid_group_id", message: "Invalid POCSTARS group ID." });
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
            message: error instanceof Error ? error.message : "POCSTARS group monitoring failed.",
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
            message: error instanceof Error ? error.message : "POCSTARS did not grant the microphone.",
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
    close(ws) {
      void closeSession(ws);
    },
  },
});

console.log(`POCSTARS bridge listening on http://${server.hostname}:${server.port}`);
