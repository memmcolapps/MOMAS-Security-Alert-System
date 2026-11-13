import assert from "node:assert/strict";
import { test } from "node:test";
import { createSharedEventSource } from "./shared-event-source.js";

function fakeSources() {
  const made = [];
  const makeSource = (url) => {
    const listeners = {};
    const source = {
      url,
      closed: false,
      addEventListener: (name, fn) => (listeners[name] ||= []).push(fn),
      close() {
        this.closed = true;
      },
      emit: (name, data) => (listeners[name] || []).forEach((fn) => fn({ data })),
    };
    made.push(source);
    return source;
  };
  return { made, makeSource };
}

test("all subscribers share one connection, closed with the last one", () => {
  const { made, makeSource } = fakeSources();
  const stream = createSharedEventSource({ getUrl: () => "/a", events: ["alert_new"], makeSource });
  const heardA = [];
  const heardB = [];
  const offA = stream.subscribe({ onEvent: (name, e) => heardA.push([name, e.data]) });
  const offB = stream.subscribe({ onEvent: (name, e) => heardB.push([name, e.data]) });
  assert.equal(made.length, 1);

  made[0].emit("alert_new", "x");
  assert.deepEqual(heardA, [["alert_new", "x"]]);
  assert.deepEqual(heardB, [["alert_new", "x"]]);

  offA();
  assert.equal(made[0].closed, false);
  offB();
  assert.equal(made[0].closed, true);
});

test("a late subscriber is told the feed is already up", () => {
  const { made, makeSource } = fakeSources();
  const stream = createSharedEventSource({ getUrl: () => "/a", events: [], makeSource });
  stream.subscribe({});
  made[0].emit("open");
  let opened = false;
  stream.subscribe({ onOpen: () => (opened = true) });
  assert.equal(opened, true);
});

test("a new sign-in or organisation reopens the feed on its own URL", () => {
  const { made, makeSource } = fakeSources();
  let url = "/a?org=1";
  const stream = createSharedEventSource({ getUrl: () => url, events: ["alert_new"], makeSource });
  const heard = [];
  stream.subscribe({ onEvent: (_, e) => heard.push(e.data) });
  url = "/a?org=2";
  stream.subscribe({});
  assert.equal(made.length, 2);
  assert.equal(made[0].closed, true);
  assert.equal(made[1].url, "/a?org=2");

  // The first subscriber keeps hearing events on the new connection,
  // and nothing arrives from the old one.
  made[0].emit("alert_new", "old");
  made[1].emit("alert_new", "new");
  assert.deepEqual(heard, ["new"]);
});

test("a listener that throws does not stop the others", () => {
  const { made, makeSource } = fakeSources();
  const stream = createSharedEventSource({ getUrl: () => "/a", events: ["alert_new"], makeSource });
  let heard = false;
  stream.subscribe({ onEvent: () => { throw new Error("boom"); } });
  stream.subscribe({ onEvent: () => (heard = true) });
  made[0].emit("alert_new", "x");
  assert.equal(heard, true);
});
