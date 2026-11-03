import assert from "node:assert/strict";
import test from "node:test";
import { TRACK_COLOURS, capacity, defaultTileSize, fitsTogether, gridFor, nextColour } from "./track-grid.js";

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

test("wall screens start on the large tile size", () => {
  assert.equal(defaultTileSize(1440), "compact");
  assert.equal(defaultTileSize(3840), "wall");
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

function pick(grid) {
  return [grid.cols, grid.rows];
}
