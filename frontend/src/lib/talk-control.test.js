import assert from "node:assert/strict";
import { test } from "node:test";
import { createTalkControl } from "./talk-control.js";

function setup() {
  let clock = 0;
  const timers = [];
  const calls = [];
  const control = createTalkControl({
    start: (kind) => calls.push(`start:${kind}`),
    stop: () => calls.push("stop"),
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, at: clock + ms, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.done = true;
    },
  });
  const advance = (ms) => {
    clock += ms;
    for (const timer of timers) {
      if (!timer.done && timer.at <= clock) {
        timer.done = true;
        timer.fn();
      }
    }
  };
  return { control, calls, advance };
}

test("holding talks while held and stops on release", () => {
  const { control, calls, advance } = setup();
  control.press();
  advance(2_000);
  control.release();
  assert.deepEqual(calls, ["start:start", "stop"]);
  assert.equal(control.state, "idle");
});

test("a quick tap keeps talking until the next tap", () => {
  const { control, calls, advance } = setup();
  control.press();
  advance(120);
  control.release();
  assert.equal(control.state, "latched");
  assert.deepEqual(calls, ["start:start"]);
  advance(10_000);
  control.press(); // tap again
  advance(100);
  control.release();
  assert.deepEqual(calls, ["start:start", "stop"]);
  assert.equal(control.state, "idle");
});

test("a tapped-on talk stops itself after 45 seconds", () => {
  const { control, calls, advance } = setup();
  control.press();
  advance(100);
  control.release();
  advance(44_000);
  assert.equal(control.state, "latched");
  advance(1_000);
  assert.equal(control.state, "idle");
  assert.deepEqual(calls, ["start:start", "stop"]);
});

test("a held talk (or stuck pedal) also stops after 45 seconds", () => {
  const { control, calls, advance } = setup();
  control.press();
  advance(45_000);
  assert.equal(control.state, "idle");
  control.release(); // finger finally lifts: nothing more is sent
  assert.deepEqual(calls, ["start:start", "stop"]);
});

test("a second talk gets its own full 45 seconds", () => {
  const { control, advance } = setup();
  control.press();
  advance(30_000);
  control.release();
  control.press();
  advance(30_000);
  assert.equal(control.state, "holding");
});

test("when the network ends the talk, the control resets without sending", () => {
  const { control, calls, advance } = setup();
  control.press();
  advance(100);
  control.release(); // latched
  control.reset("taken_over");
  assert.equal(control.state, "idle");
  assert.deepEqual(calls, ["start:start"]);
  advance(60_000); // the old 45 s timer must not fire a stray stop
  assert.deepEqual(calls, ["start:start"]);
});

test("cut in passes through as a takeover", () => {
  const { control, calls } = setup();
  control.press("takeover");
  assert.deepEqual(calls, ["start:takeover"]);
});
