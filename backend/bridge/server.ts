import { timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { PocstarsLiveClient } from "../src/pocstars/live-client";
import { PocstarsProvisioning } from "./provisioning";

type BridgeSession = {
  client: PocstarsLiveClient | null;
  mode: "private" | "monitor" | null;
  closing: boolean;
  pttTimer: ReturnType<typeof setTimeout> | null;
  seatUid: number | null;
  seatAccount: string | null;
  companyId: number | null;
  openedAt: number;
  lastSeenAt: number;
  // A presence watcher signs in on a reserved seat that is never leased for
  // audio, so it is deliberately not counted as console capacity.
  presenceWatch: boolean;
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

// Provisioning is optional: leave BRIDGE_DB_PASSWORD unset and the bridge keeps
// working as a pure voice adapter, refusing provisioning commands.
const provisioning = process.env.BRIDGE_DB_PASSWORD
  ? new PocstarsProvisioning({
      host: process.env.BRIDGE_DB_HOST || "127.0.0.1",
      port: Number(process.env.BRIDGE_DB_PORT || 3306),
      user: process.env.BRIDGE_DB_USER || "italkpro",
      password: process.env.BRIDGE_DB_PASSWORD,
      database: process.env.BRIDGE_DB_NAME || "Poc_star_en",
    })
  : null;

if (token.length < 32) {
  throw new Error("BRIDGE_TOKEN must contain at least 32 characters.");
}
if (!account || !password) {
  throw new Error(
    "BRIDGE_POCSTARS_ACCOUNT and BRIDGE_POCSTARS_PASSWORD are required.",
  );
}

// Every live session holds one dispatcher seat. Seats belong to a company and
// are interchangeable within it, so a session is served by whichever seat is
// free. Leases are tracked here rather than in the database: they are process
// state, and a bridge restart releases them all, which is correct.
const sessions = new Set<ServerWebSocket<BridgeSession>>();
const leasedSeatUids = new Set<number>();

// Seat pool for the single-account deployments that predate leasing. When no
// company is supplied the bridge falls back to the configured account, which
// keeps a plain voice-only bridge working exactly as before.
const FALLBACK_SEAT_UID = -1;

// The configured account is usually also a leasable seat of its company. If the
// fallback path keyed it as -1 while a leased session keyed it by its real uid,
// both could hold the SAME vendor account at once - and the radio network kicks
// the older session. Resolve the real uid so the two paths contend properly.
let fallbackSeatUid: number | null = null;
async function fallbackSeatKey() {
  if (!provisioning) return FALLBACK_SEAT_UID;
  if (fallbackSeatUid !== null) return fallbackSeatUid;
  fallbackSeatUid = (await provisioning.uidForAccount(account).catch(() => null)) ?? FALLBACK_SEAT_UID;
  return fallbackSeatUid;
}

async function leaseSeat(companyId: number | null) {
  if (!companyId || !provisioning) {
    const key = await fallbackSeatKey();
    if (leasedSeatUids.has(key)) {
      throw new Error("The radio console is already in use.");
    }
    leasedSeatUids.add(key);
    return { uid: key, account, password };
  }
  const seats = await provisioning.listSeats(companyId);
  if (!seats.length) {
    throw new Error("This organization has no usable dispatcher seats on the radio network.");
  }
  const free = seats.find((seat) => !leasedSeatUids.has(Number(seat.uid)));
  if (!free) {
    throw new Error(`All ${seats.length} radio consoles for this organization are in use.`);
  }
  leasedSeatUids.add(Number(free.uid));
  return { uid: Number(free.uid), account: free.account, password: free.password };
}

function releaseSeat(ws: ServerWebSocket<BridgeSession>) {
  if (ws.data.seatUid !== null) leasedSeatUids.delete(ws.data.seatUid);
  ws.data.seatUid = null;
  ws.data.seatAccount = null;
}

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
  for (const ws of [...sessions]) {
    const idleFor = Date.now() - (ws.data.lastSeenAt || Date.now());
    if (idleFor >= CLIENT_IDLE_LIMIT_MS) {
      console.warn(
        `Reaping stale bridge session (seat ${ws.data.seatAccount || "fallback"}): `
        + `no client response for ${Math.round(idleFor / 1000)}s`,
      );
      void closeSession(ws);
      try {
        ws.close(1001, "Idle bridge session reaped");
      } catch {
        // Already gone; closeSession has freed the seat.
      }
      continue;
    }
    try {
      ws.ping();
    } catch {
      // Ping failed outright: the peer is unreachable, so free the seat now.
      void closeSession(ws);
    }
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
  // Release the seat first and unconditionally. A re-entrant call used to hit
  // the `closing` guard and return before this line, which leaked the lease and
  // left the bridge refusing later sessions.
  releaseSeat(ws);
  sessions.delete(ws);
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

// Lease a seat for this session and build a voice client bound to it. The seat
// password comes straight from the vendor database, so no credential for a
// provisioned organization ever needs to be configured anywhere.
async function openLeasedClient(ws: ServerWebSocket<BridgeSession>, companyId: number | null) {
  const seat = await leaseSeat(companyId);
  ws.data.seatUid = seat.uid;
  ws.data.seatAccount = seat.account;
  ws.data.companyId = companyId;
  const client = new PocstarsLiveClient({
    host: controlHost,
    port: controlPort,
    audioHost,
    account: seat.account,
    password: seat.password,
    timeoutMs,
  });
  ws.data.client = client;
  attachClientEvents(ws, client);
  return client;
}

// Provisioning commands are request/response and carry a caller-supplied id so
// the MOMAS backend can correlate replies. They never touch the voice session.
async function handleProvisioning(ws: ServerWebSocket<BridgeSession>, message: any) {
  const requestId = message.requestId ?? null;
  const fail = (error: string) =>
    send(ws, { type: "provision.result", requestId, ok: false, error });
  if (!provisioning) {
    return fail("Provisioning is not enabled on this bridge.");
  }
  const companyId = Number(message.companyId);
  try {
    switch (message.type) {
      case "provision.ping": {
        return send(ws, { type: "provision.result", requestId, ok: true, result: { ok: await provisioning.ping() } });
      }
      case "provision.seats": {
        const seats = await provisioning.listSeats(companyId);
        // Never hand the password hashes to the MOMAS backend; the bridge is
        // the only component that needs them.
        return send(ws, {
          type: "provision.result", requestId, ok: true,
          result: seats.map((seat) => ({ uid: seat.uid, account: seat.account, serviceEndsAt: seat.serviceEndsAt })),
        });
      }
      case "provision.company.create": {
        const name = String(message.name || "").trim();
        const slug = String(message.slug || "").trim();
        if (!name || !slug) return fail("A company name and slug are required.");
        return send(ws, {
          type: "provision.result", requestId, ok: true,
          result: await provisioning.createCompany({
            name, slug,
            seats: Number(message.seats || 3),
            serviceEndsAt: String(message.serviceEndsAt || "2035-01-01 00:00:00"),
          }),
        });
      }
      case "provision.company.forGroup": {
        return send(ws, {
          type: "provision.result", requestId, ok: true,
          result: { companyId: await provisioning.companyForGroup(Number(message.groupId)) },
        });
      }
      case "provision.radio.create": {
        return send(ws, {
          type: "provision.result", requestId, ok: true,
          result: await provisioning.createRadio({
            companyId,
            imei: String(message.imei || "").trim(),
            name: String(message.name || "").trim(),
            channelIds: Array.isArray(message.channelIds) ? message.channelIds.map(Number) : [],
            defaultChannelId: message.defaultChannelId ? Number(message.defaultChannelId) : null,
            serviceEndsAt: String(message.serviceEndsAt || "2030-01-01 00:00:00"),
            gpsEnabled: message.gpsEnabled !== false,
            gpsFrequency: Number(message.gpsFrequency || 30),
          }),
        });
      }
      case "provision.radios": {
        return send(ws, {
          type: "provision.result", requestId, ok: true,
          result: await provisioning.listRadios(companyId),
        });
      }
      case "provision.groups": {
        return send(ws, { type: "provision.result", requestId, ok: true, result: await provisioning.listGroups(companyId) });
      }
      case "provision.channel.create": {
        const name = String(message.name || "").trim();
        if (!name) return fail("A channel name is required.");
        return send(ws, {
          type: "provision.result", requestId, ok: true,
          result: await provisioning.createChannel({ companyId, name }),
        });
      }
      case "provision.channel.rename": {
        return send(ws, {
          type: "provision.result", requestId, ok: true,
          result: await provisioning.renameChannel({
            groupId: Number(message.groupId), companyId, name: String(message.name || "").trim(),
          }),
        });
      }
      case "provision.channel.retire": {
        return send(ws, {
          type: "provision.result", requestId, ok: true,
          result: await provisioning.retireChannel({ groupId: Number(message.groupId), companyId }),
        });
      }
      case "provision.radio.channel": {
        return send(ws, {
          type: "provision.result", requestId, ok: true,
          result: await provisioning.setRadioOnChannel({
            companyId,
            groupId: Number(message.groupId),
            radioUid: Number(message.radioUid),
            member: Boolean(message.member),
          }),
        });
      }
      case "provision.seat.renew": {
        return send(ws, {
          type: "provision.result", requestId, ok: true,
          result: await provisioning.renewSeat({ uid: Number(message.uid), until: String(message.until) }),
        });
      }
      default:
        return fail(`Unknown provisioning command ${message.type}.`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
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
        provisioning: Boolean(provisioning),
        // Only seat-holding sessions are real capacity. A socket that connected
        // but was refused a seat (or has not started one yet) is just an idle
        // connection and must not be reported as a leased console.
        active: leasedSeatUids.size > 0,
        seatsInUse: leasedSeatUids.size,
        presenceWatchers: [...sessions].filter((ws) => ws.data.presenceWatch).length,
        idleConnections: [...sessions].filter((ws) => ws.data.seatUid === null && !ws.data.presenceWatch).length,
        sessions: [...sessions]
          .filter((ws) => ws.data.seatUid !== null)
          .map((ws) => ({
            seat: ws.data.seatAccount,
            companyId: ws.data.companyId,
            mode: ws.data.mode,
            sinceSeconds: Math.round((Date.now() - ws.data.openedAt) / 1000),
            lastSeenSecondsAgo: Math.round((Date.now() - ws.data.lastSeenAt) / 1000),
          })),
      });
    }
    if (url.pathname !== "/radio/live") {
      return new Response("Not found", { status: 404 });
    }
    if (!tokenMatches(url.searchParams.get("token") || "")) {
      return new Response("Unauthorized", { status: 401 });
    }
    // Capacity is no longer decided here: a connection is cheap, and the real
    // limit is how many dispatcher seats the organization has. That is applied
    // when the session asks to start and a seat is leased.
    const upgraded = server.upgrade(request, {
      data: {
        client: null, mode: null, closing: false, pttTimer: null,
        seatUid: null, seatAccount: null, companyId: null,
        openedAt: Date.now(), lastSeenAt: Date.now(), presenceWatch: false,
      },
    });
    return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 });
  },
  websocket: {
    // Backstop for the half-open tunnel case: Bun drops the socket when no
    // frame arrives within the window. The MOMAS client pings well inside it.
    idleTimeout: 120,
    open(ws) {
      sessions.add(ws);
      ws.data.openedAt = Date.now();
      ws.data.lastSeenAt = Date.now();
      send(ws, { type: "ready", configured: true });
    },
    async message(ws, incoming) {
      ws.data.lastSeenAt = Date.now();
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

      if (typeof message.type === "string" && message.type.startsWith("provision.")) {
        await handleProvisioning(ws, message);
        return;
      }

      // A long-lived session that reports who is on the network as it changes.
      // It signs in on a reserved seat rather than leasing one, so it neither
      // consumes console capacity nor risks being evicted by an operator taking
      // the same account.
      if (message.type === "presence.watch") {
        if (ws.data.client) return;
        if (!provisioning) {
          send(ws, {
            type: "error", code: "provisioning_disabled",
            message: "This bridge has no database plane, so it cannot reserve a presence seat.",
          });
          return;
        }
        const watchCompanyId = Number(message.companyId);
        if (!Number.isSafeInteger(watchCompanyId) || watchCompanyId <= 0) {
          send(ws, { type: "error", code: "invalid_company_id", message: "Invalid company ID." });
          return;
        }
        try {
          const seat = await provisioning.ensurePresenceSeat(watchCompanyId);
          const client = new PocstarsLiveClient({
            host: controlHost,
            port: controlPort,
            audioHost,
            account: seat.account,
            password: seat.password,
            timeoutMs,
          });
          ws.data.client = client;
          ws.data.presenceWatch = true;
          ws.data.companyId = watchCompanyId;
          client.on("presence", (users: any) => send(ws, { type: "presence.delta", users }));
          client.on("error", (error: Error) => {
            send(ws, { type: "error", code: "pocstars_voice_error", message: error.message });
          });
          await client.connect();
          // Deltas are meaningless without a starting point, so the watcher
          // opens with the full picture and streams changes from there.
          const inventory = await client.queryInventory();
          send(ws, {
            type: "presence.baseline",
            seat: seat.account,
            radios: inventory.radios.map((radio: any) => ({
              uid: Number(radio.id), online: Boolean(radio.online), role: Number(radio.role || 0),
            })),
          });
        } catch (error) {
          send(ws, {
            type: "error",
            code: "presence_watch_failed",
            message: error instanceof Error ? error.message : "The presence watcher could not start.",
          });
          await closeSession(ws);
        }
        return;
      }

      if (message.type === "inventory.query") {
        if (ws.data.client) return;
        let client: PocstarsLiveClient;
        try {
          client = await openLeasedClient(ws, message.companyId ? Number(message.companyId) : null);
        } catch (error) {
          send(ws, {
            type: "error", code: "radio_console_busy",
            message: error instanceof Error ? error.message : "No radio console is free.",
          });
          return;
        }
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
        let client: PocstarsLiveClient;
        try {
          client = await openLeasedClient(ws, message.companyId ? Number(message.companyId) : null);
        } catch (error) {
          send(ws, {
            type: "error", code: "radio_console_busy",
            message: error instanceof Error ? error.message : "No radio console is free.",
          });
          return;
        }
        ws.data.mode = "private";
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
        let client: PocstarsLiveClient;
        try {
          client = await openLeasedClient(ws, message.companyId ? Number(message.companyId) : null);
        } catch (error) {
          send(ws, {
            type: "error", code: "radio_console_busy",
            message: error instanceof Error ? error.message : "No radio console is free.",
          });
          return;
        }
        ws.data.mode = "monitor";
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
      ws.data.lastSeenAt = Date.now();
    },
    close(ws) {
      void closeSession(ws);
    },
  },
});

console.log(`POCSTARS bridge listening on http://${server.hostname}:${server.port}`);
