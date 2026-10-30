import assert from "node:assert/strict";
import test from "node:test";
import { activityBins, buildFleetReplay, itinerary, mainCluster, movingSpells, naturalSpeed, nextBusyTime, radioStateAt } from "./fleet-replay.js";

const M = 1 / 111_320;
const BASE = { lat: 6.784, lon: 3.422 };
const FROM = "2026-10-29T09:00:00.000Z";
const T0 = Date.parse(FROM);
// [seconds after FROM, lat, lon], as the server sends them.
const row = (northM, eastM, sec) => [sec, BASE.lat + northM * M, BASE.lon + (eastM * M) / Math.cos((BASE.lat * Math.PI) / 180)];

// 10 min at the office, a 5-minute walk 420 m north, then 4 min at the gate.
function walker() {
  const rows = [];
  for (let sec = 0; sec <= 600; sec += 5) rows.push(row(Math.sin(sec / 7) * 12, Math.cos(sec / 11) * 12, sec));
  for (let sec = 605; sec <= 900; sec += 5) rows.push(row((sec - 600) * 1.4, 0, sec));
  for (let sec = 905; sec <= 1140; sec += 5) rows.push(row(420 + Math.sin(sec) * 5, 0, sec));
  return rows;
}

// Sat at a desk all along, drifting.
function desk() {
  const rows = [];
  for (let sec = 0; sec <= 1140; sec += 5) rows.push(row(Math.sin(sec / 9) * 10, Math.cos(sec / 13) * 10, sec));
  return rows;
}

const response = () => ({
  from: FROM,
  to: "2026-10-29T09:20:00.000Z",
  radios: [
    { uid: 1, fixes: 1, lat: BASE.lat, lon: BASE.lon, firstAt: T0, lastAt: T0, points: null },
    { uid: 2, fixes: 229, points: desk() },
    { uid: 3, fixes: 229, points: walker() },
  ],
});

test("splits the fleet into radios that went somewhere and ones that stayed put", () => {
  const fleet = buildFleetReplay(response());
  assert.deepEqual(fleet.movers.map((radio) => radio.uid), ["3"]);
  assert.deepEqual(fleet.still.map((radio) => radio.uid).sort(), ["1", "2"]);
  assert.ok(fleet.movers[0].colour);
  assert.ok(fleet.distanceM > 350 && fleet.distanceM < 500, `distance ${fleet.distanceM}`);
});

test("finds the one moving spell, and no movement in the drift", () => {
  const [radio] = buildFleetReplay(response()).movers;
  assert.equal(radio.spells.length, 1);
  const [spell] = radio.spells;
  assert.ok(Math.abs(spell.from - (T0 + 600_000)) <= 15_000, "starts when the walk starts");
  assert.ok(Math.abs(spell.to - (T0 + 900_000)) <= 15_000, "ends when the walk ends");
  assert.ok(radio.movingSec > 250 && radio.movingSec < 330);
});

test("says what a radio was doing at a moment", () => {
  const [radio] = buildFleetReplay(response()).movers;
  assert.equal(radioStateAt(radio, T0 - 1000).kind, "before");
  assert.equal(radioStateAt(radio, T0 + 300_000).kind, "stopped");
  assert.equal(radioStateAt(radio, T0 + 700_000).kind, "moving");
  assert.equal(radioStateAt(radio, T0 + 1000_000).kind, "stopped");
  assert.equal(radioStateAt(radio, T0 + 1140_000 + 300_000).kind, "silent");
});

test("activity marks only the slices someone was moving in, and quiet ones are skipped", () => {
  const fleet = buildFleetReplay(response());
  const bins = activityBins(fleet.movers, fleet.from, fleet.to, 20);
  assert.equal(bins[2].moving, 0);
  assert.equal(bins[12].moving, 1);
  const next = nextBusyTime(bins, T0);
  assert.ok(next >= T0 + 540_000 && next <= T0 + 600_000, "jumps to just before the walk");
  assert.equal(nextBusyTime(bins, T0 + 700_000), T0 + 700_000);
  assert.equal(nextBusyTime(bins, T0 + 1100_000), null);
});

test("merges moves separated by a short pause, and a jump is not a move", () => {
  const path = [
    { lat: 0, lon: 0, t: 0 },
    { lat: 0.001, lon: 0, t: 30_000 },
    { lat: 0.001, lon: 0, t: 60_000 },
    { lat: 0.002, lon: 0, t: 80_000 },
    { lat: 0.002, lon: 0, t: 300_000 },
    { lat: 0.003, lon: 0, t: 320_000 },
    { lat: 0.05, lon: 0, t: 900_000, jump: true },
  ];
  assert.deepEqual(movingSpells(path), [
    { from: 0, to: 80_000 },
    { from: 300_000, to: 320_000 },
  ]);
});

test("picks a speed that plays the window in about two minutes", () => {
  const speeds = [10, 30, 60, 120, 300, 600, 1200];
  assert.equal(naturalSpeed(3600_000, speeds), 30);
  assert.equal(naturalSpeed(24 * 3600_000, speeds), 600);
});

test("tells a radio's window as stops and trips, in order", () => {
  const [radio] = buildFleetReplay(response()).movers;
  const story = itinerary(radio).map((entry) => entry.kind);
  assert.deepEqual(story, ["stop", "trip", "stop"]);
  const trip = itinerary(radio).find((entry) => entry.kind === "trip");
  assert.ok(trip.distanceM > 350 && trip.distanceM < 500, `trip ${trip.distanceM}`);
});

test("opens on where most radios were, leaving a far-off one out", () => {
  const at = (lat, lon) => ({ path: [{ lat, lon, t: 0 }, { lat: lat + 0.01, lon, t: 1 }] });
  const lagos = [at(6.5, 3.4), at(6.6, 3.3), at(6.45, 3.5)];
  const abuja = at(9.05, 7.5);
  const { inside, outside } = mainCluster([abuja, ...lagos]);
  assert.equal(inside.length, 3);
  assert.deepEqual(outside, [abuja]);
});

test("a silence where the radio stood still is part of the stop", () => {
  const rows = [];
  for (let sec = 0; sec <= 300; sec += 5) rows.push(row(Math.sin(sec / 7) * 5, 0, sec));
  for (let sec = 800; sec <= 1100; sec += 5) rows.push(row(Math.sin(sec / 7) * 5, 0, sec));
  for (let sec = 1105; sec <= 1400; sec += 5) rows.push(row((sec - 1100) * 1.4, 0, sec));
  const fleet = buildFleetReplay({ from: FROM, to: "2026-10-29T09:30:00.000Z", radios: [{ uid: 9, fixes: rows.length, points: rows }] });
  const story = itinerary(fleet.movers[0]).map((entry) => entry.kind);
  assert.deepEqual(story, ["stop", "trip"]);
});
