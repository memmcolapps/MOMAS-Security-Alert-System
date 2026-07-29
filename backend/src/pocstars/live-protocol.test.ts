import { describe, expect, test } from "bun:test";
import {
  packControlFrame,
  packRtp,
  splitAmrFrames,
  unpackControlFrame,
  unpackRtp,
} from "./live-protocol";

describe("POCSTARS live protocol", () => {
  test("round-trips a framed protobuf control message", () => {
    const packet = packControlFrame("ptt.rr.SingleCall", { uid: 583 });
    expect(packet.readUInt32BE(0)).toBe(packet.length - 4);
    expect(unpackControlFrame(packet)).toEqual({
      name: "ptt.rr.SingleCall",
      value: { uid: 583 },
    });
  });

  test("packs and unpacks standard RTP audio", () => {
    const amr = Uint8Array.from([0x3c, ...new Array(31).fill(1)]);
    const packet = packRtp(101, 123, 456, 583, amr);
    const decoded = unpackRtp(packet);
    expect(decoded?.payloadType).toBe(101);
    expect(decoded?.sequence).toBe(123);
    expect(decoded?.timestamp).toBe(456);
    expect(decoded?.ssrc).toBe(583);
    expect(decoded?.payload).toEqual(Buffer.from(amr));
  });

  test("decodes the UsersChanged notification emitted after login", () => {
    const packet = packControlFrame("ptt.push.UsersChanged", {
      users: [{ uid: 348, name: "POLICE", online: true }],
    });
    expect(unpackControlFrame(packet)).toEqual({
      name: "ptt.push.UsersChanged",
      value: {
        users: [{
          uid: 348,
          timestamp: 0,
          name: "POLICE",
          online: true,
          audioEnabled: false,
          sleep: false,
          dnd: false,
          role: 0,
          department: 0,
        }],
      },
    });
  });

  test("round-trips POCSTARS group membership inventory", () => {
    const packet = packControlFrame("ptt.rr.QueryMembersAck", {
      result: 0,
      members: [{
        gid: 44,
        members: [{ uid: 348, name: "POLICE", online: true, audioEnabled: true }],
      }],
    });
    const decoded = unpackControlFrame(packet);
    expect(decoded.name).toBe("ptt.rr.QueryMembersAck");
    expect((decoded.value as any).members[0].gid).toBe(44);
    expect((decoded.value as any).members[0].members[0].uid).toBe(348);
  });

  test("round-trips the vendor group-monitoring request", () => {
    const packet = packControlFrame("ptt.rr.WatchGroup", {
      gid: 44,
      uid: 336,
      expectPt: 101,
      acceptPt: [101],
      store: true,
    });
    expect(unpackControlFrame(packet)).toEqual({
      name: "ptt.rr.WatchGroup",
      value: {
        gid: 44,
        uid: 336,
        expectPt: 101,
        acceptPt: [101],
        store: true,
      },
    });
  });

  test("decodes the group audio channel returned by POCSTARS monitoring", () => {
    const packet = packControlFrame("ptt.rr.WatchGroupAck", {
      result: 0,
      gid: 44,
      group: {
        gid: 44,
        name: "Division A",
        ip: 3232235841,
        port: 30000,
      },
    });
    expect(unpackControlFrame(packet)).toEqual({
      name: "ptt.rr.WatchGroupAck",
      value: {
        result: 0,
        gid: 44,
        group: {
          gid: 44,
          timestamp: 0,
          name: "Division A",
          type: 0,
          ip: 3232235841,
          port: 30000,
        },
      },
    });
  });

  test("ignores unknown future push notifications without dropping the connection", () => {
    const messageName = Buffer.from("ptt.push.FutureNotice\0", "utf8");
    const packet = Buffer.alloc(4 + 2 + messageName.length + 4);
    packet.writeUInt32BE(packet.length - 4, 0);
    packet.writeUInt16BE(messageName.length, 4);
    messageName.copy(packet, 6);

    expect(unpackControlFrame(packet)).toEqual({
      name: "ptt.push.FutureNotice",
      value: {},
      unknown: true,
    });
  });

  test("splits headerless AMR-NB MR122 frames", () => {
    const frame = Uint8Array.from([0x3c, ...new Array(31).fill(1)]);
    const frames = splitAmrFrames(Uint8Array.from([...frame, ...frame]));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveLength(32);
  });
});
