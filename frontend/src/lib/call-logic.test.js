import assert from "node:assert/strict";
import { test } from "node:test";
import { callQuality, endNotice, failNotice, formatDuration } from "./call-logic.js";

test("signal bars follow loss and delay since the last check", () => {
  const start = { packetsReceived: 1000, packetsLost: 0, roundTripTime: 0.1 };
  assert.equal(callQuality(start, { packetsReceived: 1100, packetsLost: 0, roundTripTime: 0.1 }), "good");
  assert.equal(callQuality(start, { packetsReceived: 1100, packetsLost: 5, roundTripTime: 0.1 }), "fair");
  assert.equal(callQuality(start, { packetsReceived: 1100, packetsLost: 20, roundTripTime: 0.1 }), "poor");
  assert.equal(callQuality(start, { packetsReceived: 1100, packetsLost: 0, roundTripTime: 0.8 }), "poor");
  // Nothing arrived at all since the last check.
  assert.equal(callQuality(start, { packetsReceived: 1000, packetsLost: 0, roundTripTime: 0.1 }), "poor");
});

test("an old bad patch does not keep the bars low", () => {
  const before = { packetsReceived: 1000, packetsLost: 300, roundTripTime: 0.1 };
  assert.equal(callQuality(before, { packetsReceived: 1100, packetsLost: 300, roundTripTime: 0.1 }), "good");
});

test("notices name what happened, and stay quiet when another tab answered", () => {
  assert.equal(endNotice("declined", "caller", "Grace").text, "Grace declined the call");
  assert.deepEqual(endNotice("cancelled", "callee", "Tunde"), { text: "Missed call from Tunde", missed: true });
  assert.equal(endNotice("answered_elsewhere", "callee", "Tunde"), null);
  assert.equal(failNotice("busy", "Grace"), "Grace is in another call");
});

test("call timer", () => {
  assert.equal(formatDuration(5), "0:05");
  assert.equal(formatDuration(125), "2:05");
  assert.equal(formatDuration(3725), "1:02:05");
});
