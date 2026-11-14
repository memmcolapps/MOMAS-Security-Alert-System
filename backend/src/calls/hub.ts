// Console-to-console calls: who is online, ringing, and passing the browsers'
// connection details to each other. The voice itself never comes through
// here - it goes browser to browser (WebRTC), encrypted end to end, through
// the TURN relay only when the two networks cannot reach each other directly.
//
// Everything is in memory. A restart drops calls in setup, while calls already
// connected keep talking (their audio does not pass through this server) and
// simply cannot be hung up from the other side until both reconnect.

import { callOrganizationId, canCall, canReach, type CallIdentity } from "./rules";

export type PersonCard = {
  userId: number;
  name: string;
  detail: string;
  platformStaff: boolean;
  organizations: { id: number; name: string }[];
};

export type HubConnection = {
  id: string;
  identity: CallIdentity;
  card: PersonCard;
  onRadio: boolean;
  send: (message: Record<string, unknown>) => void;
  lastPresence?: string;
};

export type CallOutcome =
  | "completed"
  | "missed"
  | "declined"
  | "cancelled"
  | "unreachable"
  | "connection_lost";

export type CallLogEntry = {
  callId: string;
  organizationId: number | null;
  callerUserId: number;
  calleeUserId: number;
  outcome: CallOutcome;
  durationSec: number;
};

type Party = {
  userId: number;
  identity: CallIdentity;
  card: PersonCard;
  conn: HubConnection | null;
  awayTimer: ReturnType<typeof setTimeout> | null;
};

type Call = {
  id: string;
  state: "ringing" | "active";
  caller: Party;
  callee: Party;
  answeredAt: number | null;
  ringTimer: ReturnType<typeof setTimeout> | null;
};

type HubOptions = {
  ringMs?: number;
  graceMs?: number;
  presenceDebounceMs?: number;
  onCallEnded?: (entry: CallLogEntry) => void;
  now?: () => number;
  newId?: () => string;
};

const MAX_SIGNAL_BYTES = 32 * 1024;

export function createCallHub({
  ringMs = 45_000,
  graceMs = 30_000,
  presenceDebounceMs = 250,
  onCallEnded = () => {},
  now = () => Date.now(),
  newId = () => crypto.randomUUID(),
}: HubOptions = {}) {
  const conns = new Map<string, HubConnection>();
  const calls = new Map<string, Call>();
  let presenceTimer: ReturnType<typeof setTimeout> | null = null;

  const connsOf = (userId: number) =>
    [...conns.values()].filter((conn) => conn.identity.userId === userId);

  const callOf = (userId: number) =>
    [...calls.values()].find((call) => call.caller.userId === userId || call.callee.userId === userId) || null;

  const peerCard = (card: PersonCard, viewer: CallIdentity) =>
    // Which organizations someone belongs to is only platform staff's business.
    viewer.platformStaff ? card : { ...card, organizations: [] };

  function statusOf(userId: number) {
    if (callOf(userId)) return "busy";
    return connsOf(userId).some((conn) => conn.onRadio) ? "on_radio" : "online";
  }

  function presenceFor(viewer: HubConnection) {
    const people = new Map<number, Record<string, unknown>>();
    for (const other of conns.values()) {
      const userId = other.identity.userId;
      if (people.has(userId) || !canReach(viewer.identity, other.identity)) continue;
      people.set(userId, {
        ...peerCard(other.card, viewer.identity),
        status: statusOf(userId),
        callable: canCall(viewer.identity, other.identity),
      });
    }
    return [...people.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  function sendPresence() {
    presenceTimer = null;
    for (const conn of conns.values()) {
      const people = presenceFor(conn);
      const body = JSON.stringify(people);
      if (body === conn.lastPresence) continue;
      conn.lastPresence = body;
      conn.send({ type: "presence", people });
    }
  }

  function schedulePresence() {
    if (presenceDebounceMs <= 0) return sendPresence();
    if (presenceTimer) return;
    presenceTimer = setTimeout(sendPresence, presenceDebounceMs);
  }

  function clearTimers(call: Call) {
    if (call.ringTimer) clearTimeout(call.ringTimer);
    if (call.caller.awayTimer) clearTimeout(call.caller.awayTimer);
    if (call.callee.awayTimer) clearTimeout(call.callee.awayTimer);
    call.ringTimer = call.caller.awayTimer = call.callee.awayTimer = null;
  }

  /** Every console that should hear about the callee's side of this call. */
  function calleeConns(call: Call) {
    if (call.state === "active") return call.callee.conn ? [call.callee.conn] : [];
    return connsOf(call.callee.userId);
  }

  function end(call: Call, outcome: CallOutcome, callerReason: string | null, calleeReason: string | null) {
    if (!calls.has(call.id)) return;
    calls.delete(call.id);
    clearTimers(call);
    if (callerReason) call.caller.conn?.send({ type: "call.ended", callId: call.id, reason: callerReason });
    if (calleeReason) {
      for (const conn of calleeConns(call)) conn.send({ type: "call.ended", callId: call.id, reason: calleeReason });
    }
    onCallEnded({
      callId: call.id,
      organizationId: callOrganizationId(call.caller.identity, call.callee.identity),
      callerUserId: call.caller.userId,
      calleeUserId: call.callee.userId,
      outcome,
      durationSec: call.answeredAt ? Math.round((now() - call.answeredAt) / 1000) : 0,
    });
    schedulePresence();
  }

  const partyOf = (call: Call, conn: HubConnection) =>
    call.caller.conn === conn ? call.caller : call.callee.conn === conn ? call.callee : null;
  const otherParty = (call: Call, party: Party) => (party === call.caller ? call.callee : call.caller);

  function invite(conn: HubConnection, to: number) {
    const fail = (reason: string) => conn.send({ type: "call.failed", to, reason });
    if (callOf(conn.identity.userId)) return fail("already_in_call");
    const targets = connsOf(to);
    if (!targets.length) return fail("offline");
    const calleeIdentity = targets[0].identity;
    if (!canCall(conn.identity, calleeIdentity)) return fail("not_allowed");
    if (callOf(to)) return fail("busy");

    const call: Call = {
      id: newId(),
      state: "ringing",
      caller: { userId: conn.identity.userId, identity: conn.identity, card: conn.card, conn, awayTimer: null },
      callee: { userId: to, identity: calleeIdentity, card: targets[0].card, conn: null, awayTimer: null },
      answeredAt: null,
      ringTimer: null,
    };
    calls.set(call.id, call);
    call.ringTimer = setTimeout(() => end(call, "missed", "no_answer", "missed"), ringMs);
    conn.send({ type: "call.outgoing", callId: call.id, peer: peerCard(call.callee.card, conn.identity) });
    for (const target of targets) {
      target.send({ type: "call.incoming", callId: call.id, peer: peerCard(conn.card, target.identity) });
    }
    schedulePresence();
  }

  function accept(conn: HubConnection, call: Call) {
    if (call.state !== "ringing" || conn.identity.userId !== call.callee.userId) return;
    if (call.ringTimer) clearTimeout(call.ringTimer);
    call.ringTimer = null;
    const otherTabs = connsOf(call.callee.userId).filter((tab) => tab !== conn);
    call.state = "active";
    call.callee.conn = conn;
    call.answeredAt = now();
    conn.send({ type: "call.accepted", callId: call.id, role: "callee" });
    call.caller.conn?.send({ type: "call.accepted", callId: call.id, role: "caller" });
    for (const tab of otherTabs) tab.send({ type: "call.ended", callId: call.id, reason: "answered_elsewhere" });
    schedulePresence();
  }

  function decline(conn: HubConnection, call: Call) {
    if (call.state !== "ringing" || conn.identity.userId !== call.callee.userId) return;
    end(call, "declined", "declined", "declined");
  }

  function resume(conn: HubConnection, callId: string) {
    const call = calls.get(callId);
    const party = call && call.state === "active"
      ? [call.caller, call.callee].find((entry) => entry.userId === conn.identity.userId)
      : null;
    if (!call || !party) {
      conn.send({ type: "call.ended", callId, reason: "gone" });
      return;
    }
    if (party.awayTimer) clearTimeout(party.awayTimer);
    party.awayTimer = null;
    party.conn = conn;
    const other = otherParty(call, party);
    conn.send({
      type: "call.resumed",
      callId,
      role: party === call.caller ? "caller" : "callee",
      peer: peerCard(other.card, conn.identity),
      answeredAt: call.answeredAt,
    });
    other.conn?.send({ type: "call.peer_back", callId });
  }

  function handle(conn: HubConnection, message: any) {
    if (!message || typeof message.type !== "string") return;
    const call = typeof message.callId === "string" ? calls.get(message.callId) || null : null;
    switch (message.type) {
      case "ping":
        conn.send({ type: "pong" });
        return;
      case "status":
        conn.onRadio = Boolean(message.onRadio);
        schedulePresence();
        return;
      case "call.invite":
        invite(conn, Number(message.to));
        return;
      case "call.accept":
        if (call) accept(conn, call);
        return;
      case "call.decline":
        if (call) decline(conn, call);
        return;
      case "call.cancel":
        if (call && call.state === "ringing" && call.caller.conn === conn) end(call, "cancelled", null, "cancelled");
        return;
      case "call.end": {
        if (!call) return;
        const party = partyOf(call, conn);
        if (!party) return;
        if (call.state === "ringing") end(call, "cancelled", null, "cancelled");
        else if (party === call.caller) end(call, "completed", null, "hung_up");
        else end(call, "completed", "hung_up", null);
        return;
      }
      case "call.signal": {
        if (!call || call.state !== "active") return;
        const party = partyOf(call, conn);
        if (!party) return;
        if (JSON.stringify(message.data ?? null).length > MAX_SIGNAL_BYTES) return;
        otherParty(call, party).conn?.send({ type: "call.signal", callId: call.id, data: message.data });
        return;
      }
      case "call.resume":
        if (typeof message.callId === "string") resume(conn, message.callId);
        return;
    }
  }

  function connect(conn: HubConnection) {
    conns.set(conn.id, conn);
    schedulePresence();
  }

  function disconnect(conn: HubConnection) {
    if (!conns.delete(conn.id)) return;
    for (const call of [...calls.values()]) {
      if (call.state === "ringing") {
        if (call.caller.conn === conn) end(call, "cancelled", null, "cancelled");
        else if (conn.identity.userId === call.callee.userId && !connsOf(call.callee.userId).length) {
          end(call, "unreachable", "unreachable", null);
        }
        continue;
      }
      const party = partyOf(call, conn);
      if (!party) continue;
      // The voice runs browser to browser, so a dropped control connection
      // (switching Wi-Fi to a hotspot, say) does not mean the call is gone.
      // Hold it while the console reconnects.
      party.conn = null;
      otherParty(call, party).conn?.send({ type: "call.peer_away", callId: call.id });
      party.awayTimer = setTimeout(() => end(call, "connection_lost", "connection_lost", "connection_lost"), graceMs);
    }
    schedulePresence();
  }

  return {
    connect,
    disconnect,
    handle,
    /** For tests and the stats page. */
    activeCallCount: () => calls.size,
    onlineCount: () => new Set([...conns.values()].map((conn) => conn.identity.userId)).size,
  };
}
