import { describe, expect, test } from "bun:test";
import { PositionWatch, type PositionDoc, type PositionStore, collectionFor, toPoint } from "./position-watch";

// Ids that sort like ObjectIds: fixed-width hex, seconds first.
const idAt = (ms: number, seq = 0) =>
  Math.floor(ms / 1000).toString(16).padStart(8, "0") + seq.toString(16).padStart(16, "0");

const NOW = Date.parse("2026-10-29T08:30:00Z");

function doc(uid: number, savedMs: number, takenMs: number, seq = 0, lat = 6.78, lon = 3.42): PositionDoc {
  return { _id: idAt(savedMs, seq), Uid: uid, Wgs84: { Lat: lat, Lon: lon }, Rtimestamp: takenMs, Stimestamp: savedMs };
}

function fakeStore(byCollection: Record<string, PositionDoc[]>): PositionStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    idFromTime: (ms) => idAt(ms, 0),
    find: async (collection, afterId, limit) => {
      reads.push(collection);
      return (byCollection[collection] || []).filter((d) => String(d._id) > String(afterId)).slice(0, limit);
    },
  };
}

describe("position watch", () => {
  test("names the day's collection the way the location service does", () => {
    expect(collectionFor(NOW)).toBe("gpshistorydata20261029");
  });

  test("reads only what was stored after it started, then each new batch once", async () => {
    const today = collectionFor(NOW);
    const docs = { [today]: [doc(348, NOW - 60_000, NOW - 70_000)] };
    let now = NOW;
    const watch = new PositionWatch({ store: fakeStore(docs), now: () => now });
    const got: number[][] = [];
    await watch.subscribe((points) => got.push(points.map((p) => p.t)));
    watch.stop();

    expect(await watch.pollOnce()).toEqual([]);

    now += 20_000;
    docs[today].push(doc(348, now - 1000, now - 16_000, 1), doc(348, now - 1000, now - 11_000, 2), doc(348, now - 1000, now - 6_000, 3));
    const batch = await watch.pollOnce();
    expect(batch.map((p) => p.t)).toEqual([now - 16_000, now - 11_000, now - 6_000]);
    expect(await watch.pollOnce()).toEqual([]);
    expect(got).toEqual([[now - 16_000, now - 11_000, now - 6_000]]);
  });

  test("a subscriber catching up gets the gap, and nothing twice", async () => {
    const today = collectionFor(NOW);
    const docs = { [today]: [doc(348, NOW - 120_000, NOW - 125_000), doc(348, NOW - 30_000, NOW - 35_000, 1)] };
    const watch = new PositionWatch({ store: fakeStore(docs), now: () => NOW });
    const got: number[] = [];
    await watch.subscribe((points) => got.push(...points.map((p) => p.t)), NOW - 180_000);
    watch.stop();
    expect(got).toEqual([NOW - 125_000, NOW - 35_000]);
    await watch.pollOnce();
    expect(got).toEqual([NOW - 125_000, NOW - 35_000]);
  });

  test("a batch saved just after midnight is still read", async () => {
    const lateNight = Date.parse("2026-10-29T23:59:58Z");
    let now = lateNight;
    const store = fakeStore({});
    const watch = new PositionWatch({ store, now: () => now });
    await watch.subscribe(() => {});
    watch.stop();
    now = lateNight + 5000;
    const tomorrow = collectionFor(now);
    (store as any).find = async (collection: string, afterId: any) =>
      collection === tomorrow ? [doc(1, now - 1000, now - 2000)].filter((d) => String(d._id) > String(afterId)) : [];
    expect((await watch.pollOnce()).length).toBe(1);
  });

  test("drops points with no usable position", () => {
    expect(toPoint({ _id: "a", Uid: 1, Wgs84: { Lat: 0, Lon: 0 }, Rtimestamp: 1, Stimestamp: 1 })).toBeNull();
    expect(toPoint({ _id: "a", Wgs84: { Lat: 6, Lon: 3 }, Rtimestamp: 1, Stimestamp: 1 })).toBeNull();
    expect(toPoint({ _id: "a", Uid: 7, Wgs84: { Lat: 6, Lon: 3 }, Rtimestamp: { toNumber: () => 5 }, Stimestamp: 9 })).toEqual({
      uid: "7",
      lat: 6,
      lon: 3,
      t: 5,
      s: 9,
    });
  });
});
