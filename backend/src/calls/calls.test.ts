import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createCallHub, type CallLogEntry, type HubConnection } from "./hub";
import { iceServersFor } from "./ice";
import { canCall, type CallIdentity } from "./rules";

const orgUser = (userId: number, org: number, mayStart = true): CallIdentity => ({
  userId,
  platformStaff: false,
  activeOrganizationId: org,
  organizationIds: [org],
  mayStart,
});
const staff = (userId: number): CallIdentity => ({
  userId,
  platformStaff: true,
  activeOrganizationId: null,
  organizationIds: [],
  mayStart: true,
});

describe("who may call whom", () => {
  test("people in an organization call each other", () => {
    expect(canCall(orgUser(1, 10), orgUser(2, 10))).toBe(true);
  });

  test("an organization can never call another organization", () => {
    expect(canCall(orgUser(1, 10), orgUser(2, 20))).toBe(false);
  });

  test("an organization can never call platform staff", () => {
    expect(canCall(orgUser(1, 10), staff(9))).toBe(false);
  });

  test("platform staff can call anyone in any organization", () => {
    expect(canCall(staff(9), orgUser(1, 10))).toBe(true);
    expect(canCall(staff(9), orgUser(2, 20))).toBe(true);
  });

  test("viewers can be called but cannot call", () => {
    expect(canCall(orgUser(1, 10, false), orgUser(2, 10))).toBe(false);
    expect(canCall(orgUser(2, 10), orgUser(1, 10, false))).toBe(true);
  });

  test("calls follow the organization the console is working in", () => {
    // Member of both 10 and 20, working in 20 right now.
    const multi = { ...orgUser(1, 20), organizationIds: [10, 20] };
    expect(canCall(multi, orgUser(2, 10))).toBe(false);
    expect(canCall(multi, orgUser(3, 20))).toBe(true);
    // And reachable from either organization.
    expect(canCall(orgUser(2, 10), multi)).toBe(true);
  });

  test("nobody calls themselves", () => {
    expect(canCall(staff(9), staff(9))).toBe(false);
  });
});

// ── the hub, with fake consoles ────────────────────────────────────────

function setup(options: { ringMs?: number; graceMs?: number } = {}) {
  const log: CallLogEntry[] = [];
  let seq = 0;
  const hub = createCallHub({
    presenceDebounceMs: 0,
    ringMs: options.ringMs ?? 60_000,
    graceMs: options.graceMs ?? 60_000,
    onCallEnded: (entry) => log.push(entry),
    newId: () => `call-${++seq}`,
  });
  let connSeq = 0;
  const open = (identity: CallIdentity, name = `User ${identity.userId}`) => {
    const inbox: any[] = [];
    const conn: HubConnection = {
      id: `conn-${++connSeq}`,
      identity,
      card: { userId: identity.userId, name, detail: "", platformStaff: identity.platformStaff, organizations: identity.organizationIds.map((id) => ({ id, name: `Org ${id}` })) },
      onRadio: false,
      send: (message) => inbox.push(message),
    };
    hub.connect(conn);
    const last = (type: string) => [...inbox].reverse().find((message) => message.type === type);
    return { conn, inbox, last, say: (message: any) => hub.handle(conn, message) };
  };
  return { hub, log, open };
}

describe("call hub", () => {
  test("presence only lists people the console could reach", () => {
    const { open } = setup();
    const a = open(orgUser(1, 10));
    open(orgUser(2, 10));
    open(orgUser(3, 20));
    open(staff(9));
    const people = a.last("presence").people.map((person: any) => person.userId);
    expect(people).toEqual([2]);
  });

  test("organizations never learn which other organizations a person belongs to", () => {
    const { open } = setup();
    const a = open(orgUser(1, 10));
    open({ ...orgUser(2, 10), organizationIds: [10, 20] });
    expect(a.last("presence").people[0].organizations).toEqual([]);
  });

  test("platform staff see everyone, with their organizations", () => {
    const { open } = setup();
    const boss = open(staff(9));
    open(orgUser(1, 10));
    open(orgUser(2, 20));
    const people = boss.last("presence").people;
    expect(people.map((person: any) => person.userId).sort()).toEqual([1, 2]);
    expect(people[0].organizations.length).toBe(1);
  });

  test("a call rings every open tab of the person, and the first answer wins", () => {
    const { open, log } = setup();
    const caller = open(orgUser(1, 10));
    const tab1 = open(orgUser(2, 10));
    const tab2 = open(orgUser(2, 10));
    caller.say({ type: "call.invite", to: 2 });
    const callId = caller.last("call.outgoing").callId;
    expect(tab1.last("call.incoming").callId).toBe(callId);
    expect(tab2.last("call.incoming").callId).toBe(callId);

    tab2.say({ type: "call.accept", callId });
    expect(caller.last("call.accepted").role).toBe("caller");
    expect(tab2.last("call.accepted").role).toBe("callee");
    expect(tab1.last("call.ended").reason).toBe("answered_elsewhere");

    // Connection details go only between the caller and the tab that answered.
    caller.say({ type: "call.signal", callId, data: { description: { type: "offer", sdp: "x" } } });
    expect(tab2.last("call.signal").data.description.sdp).toBe("x");
    expect(tab1.last("call.signal")).toBeUndefined();

    tab2.say({ type: "call.end", callId });
    expect(caller.last("call.ended").reason).toBe("hung_up");
    expect(log[0]).toMatchObject({ outcome: "completed", callerUserId: 1, calleeUserId: 2, organizationId: 10 });
  });

  test("the server refuses a call the rules forbid, whatever the browser sends", () => {
    const { open, log } = setup();
    const a = open(orgUser(1, 10));
    const other = open(orgUser(2, 20));
    const boss = open(staff(9));
    a.say({ type: "call.invite", to: 2 });
    expect(a.last("call.failed").reason).toBe("not_allowed");
    a.say({ type: "call.invite", to: 9 });
    expect(a.last("call.failed").reason).toBe("not_allowed");
    expect(other.last("call.incoming")).toBeUndefined();
    expect(boss.last("call.incoming")).toBeUndefined();
    expect(log).toEqual([]);
  });

  test("a stranger cannot answer, end or listen in on someone else's call", () => {
    const { open } = setup();
    const caller = open(orgUser(1, 10));
    const callee = open(orgUser(2, 10));
    const intruder = open(orgUser(3, 10));
    caller.say({ type: "call.invite", to: 2 });
    const callId = caller.last("call.outgoing").callId;
    intruder.say({ type: "call.accept", callId });
    expect(caller.last("call.accepted")).toBeUndefined();
    callee.say({ type: "call.accept", callId });
    intruder.say({ type: "call.signal", callId, data: { candidate: "evil" } });
    intruder.say({ type: "call.end", callId });
    expect(caller.last("call.signal")).toBeUndefined();
    expect(caller.last("call.ended")).toBeUndefined();
  });

  test("someone already in a call shows busy", () => {
    const { open } = setup();
    const a = open(orgUser(1, 10));
    const b = open(orgUser(2, 10));
    const c = open(orgUser(3, 10));
    a.say({ type: "call.invite", to: 2 });
    b.say({ type: "call.accept", callId: a.last("call.outgoing").callId });
    c.say({ type: "call.invite", to: 2 });
    expect(c.last("call.failed").reason).toBe("busy");
    expect(c.last("presence").people.find((person: any) => person.userId === 2).status).toBe("busy");
  });

  test("decline and cancel end the call for both sides and are logged", () => {
    const { open, log } = setup();
    const a = open(orgUser(1, 10));
    const b = open(orgUser(2, 10));
    a.say({ type: "call.invite", to: 2 });
    b.say({ type: "call.decline", callId: a.last("call.outgoing").callId });
    expect(a.last("call.ended").reason).toBe("declined");
    a.say({ type: "call.invite", to: 2 });
    a.say({ type: "call.cancel", callId: a.last("call.outgoing").callId });
    expect(b.last("call.ended").reason).toBe("cancelled");
    expect(log.map((entry) => entry.outcome)).toEqual(["declined", "cancelled"]);
  });

  test("an unanswered call stops ringing and is logged as missed", async () => {
    const { open, log } = setup({ ringMs: 20 });
    const a = open(orgUser(1, 10));
    const b = open(orgUser(2, 10));
    a.say({ type: "call.invite", to: 2 });
    await Bun.sleep(40);
    expect(a.last("call.ended").reason).toBe("no_answer");
    expect(b.last("call.ended").reason).toBe("missed");
    expect(log[0].outcome).toBe("missed");
  });

  test("a dropped connection gets time to come back before the call ends", async () => {
    const { hub, open, log } = setup({ graceMs: 60 });
    const a = open(orgUser(1, 10));
    const b = open(orgUser(2, 10));
    a.say({ type: "call.invite", to: 2 });
    const callId = a.last("call.outgoing").callId;
    b.say({ type: "call.accept", callId });

    hub.disconnect(b.conn);
    expect(a.last("call.peer_away").callId).toBe(callId);
    const back = open(orgUser(2, 10));
    back.say({ type: "call.resume", callId });
    expect(back.last("call.resumed").role).toBe("callee");
    expect(a.last("call.peer_back").callId).toBe(callId);
    await Bun.sleep(90);
    expect(log).toEqual([]);

    // Gone for good this time.
    hub.disconnect(back.conn);
    await Bun.sleep(90);
    expect(a.last("call.ended").reason).toBe("connection_lost");
    expect(log[0].outcome).toBe("connection_lost");
  });

  test("only a party to the call can resume it", () => {
    const { hub, open } = setup();
    const a = open(orgUser(1, 10));
    const b = open(orgUser(2, 10));
    a.say({ type: "call.invite", to: 2 });
    const callId = a.last("call.outgoing").callId;
    b.say({ type: "call.accept", callId });
    hub.disconnect(b.conn);
    const intruder = open(orgUser(3, 10));
    intruder.say({ type: "call.resume", callId });
    expect(intruder.last("call.ended").reason).toBe("gone");
    expect(a.last("call.peer_back")).toBeUndefined();
  });

  test("platform staff calling into an organization is logged against that organization", () => {
    const { open, log } = setup();
    const boss = open(staff(9));
    const b = open(orgUser(2, 10));
    boss.say({ type: "call.invite", to: 2 });
    b.say({ type: "call.decline", callId: boss.last("call.outgoing").callId });
    expect(log[0]).toMatchObject({ organizationId: 10, callerUserId: 9 });
  });
});

describe("relay passwords", () => {
  test("follow coturn's shared-secret scheme and expire", () => {
    const servers = iceServersFor(42, {
      stunUrls: "stun:stun.example.org:3478",
      turnUrls: "turn:turn.example.org:3478, turns:turn.example.org:443",
      turnSecret: "s3cret",
      turnTtlSec: 3600,
    }, 1_000_000);
    expect(servers[0]).toEqual({ urls: ["stun:stun.example.org:3478"] });
    const turn = servers[1];
    expect(turn.urls).toEqual(["turn:turn.example.org:3478", "turns:turn.example.org:443"]);
    expect(turn.username).toBe("1003600:42");
    expect(turn.credential).toBe(createHmac("sha1", "s3cret").update("1003600:42").digest("base64"));
  });

  test("no relay is offered without a secret", () => {
    const servers = iceServersFor(42, { stunUrls: "", turnUrls: "turn:turn.example.org:3478", turnSecret: "", turnTtlSec: 60 });
    expect(servers).toEqual([]);
  });
});
