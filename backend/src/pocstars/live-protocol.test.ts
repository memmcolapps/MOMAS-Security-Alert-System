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

  test("splits headerless AMR-NB MR122 frames", () => {
    const frame = Uint8Array.from([0x3c, ...new Array(31).fill(1)]);
    const frames = splitAmrFrames(Uint8Array.from([...frame, ...frame]));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveLength(32);
  });
});

