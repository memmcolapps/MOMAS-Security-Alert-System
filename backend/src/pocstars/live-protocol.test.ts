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
        users: [{ uid: 348, timestamp: 0, name: "POLICE", online: true }],
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
