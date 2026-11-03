import assert from "node:assert/strict";
import test from "node:test";
import { TRACK_COLOURS, capacity, fitsTogether, gridFor, nextColour, placeSosRadio } from "./track-grid.js";

test("the screen decides how many tiles fit, with no fixed limit", () => {
  assert.equal(capacity(1000, 600, "compact").max, 4);
  assert.equal(capacity(1550, 940, "compact").max, 12);
  // A 4K wall at Wall size still holds far more than any fixed cap would.
  assert.equal(capacity(3800, 2000, "wall").max, 20);
  assert.equal(capacity(3800, 2000, "compact").max, 70);
});

test("a tiny area still shows one tile", () => {
  assert.deepEqual(capacity(200, 150, "wall"), { cols: 1, rows: 1, max: 1 });
});

test("layouts follow the screen's shape", () => {
  const wide = { w: 1600, h: 900 };
  assert.deepEqual(pick(gridFor(2, wide.w, wide.h, "compact")), [2, 1]);
  assert.deepEqual(pick(gridFor(4, wide.w, wide.h, "compact")), [2, 2]);
  assert.deepEqual(pick(gridFor(6, wide.w, wide.h, "compact")), [3, 2]);
  // A tall area stacks rather than squeezing side by side.
  assert.deepEqual(pick(gridFor(2, 700, 1200, "compact")), [1, 2]);
});

test("more radios than fit are capped to what fits, not squeezed", () => {
  const grid = gridFor(10, 1000, 600, "compact");
  assert.equal(grid.max, 4);
  assert.equal(grid.shown, 4);
  assert.ok(grid.cols * grid.rows >= grid.shown);
  assert.ok(grid.cols <= 2 && grid.rows <= 2);
});

test("a TV reporting 1920 pixels gets far more tiles at Compact than at Wall", () => {
  // 1920 x 1080 less the radio list, margins and top bar.
  assert.equal(capacity(1500, 920, "wall").max, 2);
  assert.equal(capacity(1500, 920, "compact").max, 12);
});

test("radios a few hundred metres apart share one map; cities apart do not", () => {
  const compound = [
    { lat: 6.6731, lon: 3.4512 },
    { lat: 6.6748, lon: 3.4531 },
  ];
  assert.equal(fitsTogether(compound, 1400, 800), true);
  const lagosAbuja = [
    { lat: 6.5244, lon: 3.3792 },
    { lat: 9.0765, lon: 7.3986 },
  ];
  assert.equal(fitsTogether(lagosAbuja, 1400, 800), false);
});

test("each new radio gets a colour nobody is using", () => {
  assert.equal(nextColour([]), TRACK_COLOURS[0]);
  assert.equal(nextColour([TRACK_COLOURS[0], TRACK_COLOURS[2]]), TRACK_COLOURS[1]);
  assert.ok(TRACK_COLOURS.includes(nextColour(TRACK_COLOURS)));
});

const radios = (...ids) => ids.map((deviceId, index) => ({ deviceId, colour: TRACK_COLOURS[index], paused: false, recentreKey: 0 }));
const order = (result) => result.tracked.map((item) => item.deviceId);
const none = { isSos: () => false, statusOf: () => "moving" };

test("an SOS already on screen moves nothing", () => {
  const tracked = radios("a", "b", "c");
  const result = placeSosRadio(tracked, "b", 4, none);
  assert.equal(result.tracked, tracked);
  assert.equal(result.displaced, null);
});

test("an SOS is added when there is room", () => {
  assert.deepEqual(order(placeSosRadio(radios("a", "b"), "x", 4, none)), ["a", "b", "x"]);
});

test("a full screen gives up its least important tile, in place, and keeps that radio tracked", () => {
  const statuses = { a: "moving", b: "offline", c: "online", d: "moving" };
  const result = placeSosRadio(radios("a", "b", "c", "d"), "x", 4, { isSos: () => false, statusOf: (uid) => statuses[uid] });
  assert.deepEqual(order(result), ["a", "x", "c", "d", "b"]);
  assert.equal(result.displaced, "b");
});

test("another SOS is never pushed off screen", () => {
  const sos = new Set(["c", "d"]);
  const statuses = { a: "moving", b: "moving", c: "offline", d: "offline" };
  const result = placeSosRadio(radios("a", "b", "c", "d"), "x", 4, { isSos: (uid) => sos.has(uid), statusOf: (uid) => statuses[uid] });
  assert.equal(result.displaced, "b");
  assert.deepEqual(order(result), ["a", "x", "c", "d", "b"]);
});

test("a tracked radio waiting off screen comes back on when it raises an SOS", () => {
  const result = placeSosRadio(radios("a", "b", "c", "d", "e"), "e", 4, none);
  assert.deepEqual(order(result), ["a", "b", "c", "e", "d"]);
});

test("when every tile on screen is an SOS the new one waits off screen", () => {
  const result = placeSosRadio(radios("a", "b"), "x", 2, { isSos: () => true, statusOf: () => "moving" });
  assert.deepEqual(order(result), ["a", "b", "x"]);
  assert.equal(result.displaced, null);
});

function pick(grid) {
  return [grid.cols, grid.rows];
}
