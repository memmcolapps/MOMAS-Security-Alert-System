import { afterEach, describe, expect, test } from "bun:test";
import { SosWatch, type SosFetch, type SosRow } from "./sos-watch";

// A fake SOS service: whatever `page` holds is what the next request returns.
function fakeService() {
  const service = {
    page: [] as SosRow[],
    fail: false,
    urls: [] as string[],
    fetch: (async (url: string) => {
      service.urls.push(url);
      if (service.fail) throw new Error("connect ECONNREFUSED 127.0.0.1:6891");
      return { ok: true, status: 200, json: async () => ({ code: 200, data: { rows: service.page } }) };
    }) as SosFetch,
  };
  return service;
}

const alarm = (id: number) => ({ sosMsgId: id, sosFromId: 348, sosStamp: 1761500000000 + id });

function recorder() {
  const seen = { snapshots: [] as number[][], fresh: [] as number[][] };
  const listener = {
    onSnapshot: (rows: SosRow[]) => seen.snapshots.push(rows.map((row) => Number(row.sosMsgId))),
    onNew: (rows: SosRow[]) => seen.fresh.push(rows.map((row) => Number(row.sosMsgId))),
  };
  return { seen, listener };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function watchWith(service: ReturnType<typeof fakeService>) {
  // A long interval keeps the background loop from polling mid-test; the test
  // drives each poll itself.
  const watch = new SosWatch({
    baseUrl: "http://127.0.0.1:6891/",
    targetUid: "39",
    intervalMs: 60_000,
    fetchImpl: service.fetch,
  });
  cleanups.push(() => watch.stop());
  return watch;
}

describe("SosWatch", () => {
  test("asks the local service for open alarms addressed to the recipient", async () => {
    const service = fakeService();
    await watchWith(service).pollOnce();
    const url = new URL(service.urls[0]);
    expect(url.origin + url.pathname).toBe("http://127.0.0.1:6891/sos/mg/records");
    expect(url.searchParams.get("targetUid")).toBe("39");
    expect(url.searchParams.get("status")).toBe("0");
  });

  test("treats the first page as a baseline, not as new alarms", async () => {
    const service = fakeService();
    service.page = [alarm(1), alarm(2)];
    const watch = watchWith(service);
    expect(await watch.pollOnce()).toEqual([]);
    expect(watch.snapshot().map((row) => row.sosMsgId)).toEqual([1, 2]);
  });

  test("reports each alarm once, as it appears", async () => {
    const service = fakeService();
    service.page = [alarm(1)];
    const watch = watchWith(service);
    await watch.pollOnce();
    service.page = [alarm(1), alarm(2)];
    expect((await watch.pollOnce()).map((row) => row.sosMsgId)).toEqual([2]);
    expect(await watch.pollOnce()).toEqual([]);
  });

  test("drops alarms that are no longer open upstream", async () => {
    const service = fakeService();
    service.page = [alarm(1), alarm(2)];
    const watch = watchWith(service);
    await watch.pollOnce();
    service.page = [alarm(2), alarm(3)];
    expect((await watch.pollOnce()).map((row) => row.sosMsgId)).toEqual([3]);
    expect(watch.snapshot().map((row) => row.sosMsgId)).toEqual([2, 3]);
  });

  test("a listener that joins before the first page gets the open alarms as its snapshot", async () => {
    const service = fakeService();
    service.page = [alarm(7)];
    const watch = watchWith(service);
    const { seen, listener } = recorder();
    cleanups.push(watch.subscribe(listener));
    await watch.pollOnce();
    expect(seen.snapshots).toEqual([[7]]);
    expect(seen.fresh).toEqual([]);
  });

  test("a listener that joins later gets the snapshot at once, then only new alarms", async () => {
    const service = fakeService();
    service.page = [alarm(1)];
    const watch = watchWith(service);
    await watch.pollOnce();
    const { seen, listener } = recorder();
    cleanups.push(watch.subscribe(listener));
    expect(seen.snapshots).toEqual([[1]]);
    service.page = [alarm(1), alarm(2)];
    await watch.pollOnce();
    expect(seen.fresh).toEqual([[2]]);
  });

  test("a failed poll keeps what is known and reports the error", async () => {
    const service = fakeService();
    service.page = [alarm(1)];
    const watch = watchWith(service);
    await watch.pollOnce();
    service.fail = true;
    await expect(watch.pollOnce()).rejects.toThrow("ECONNREFUSED");
    expect(watch.snapshot().map((row) => row.sosMsgId)).toEqual([1]);
    // An alarm raised during the outage is still news once the service is back.
    service.fail = false;
    service.page = [alarm(1), alarm(2)];
    expect((await watch.pollOnce()).map((row) => row.sosMsgId)).toEqual([2]);
  });

  test("stops polling when the last listener leaves", () => {
    const watch = watchWith(fakeService());
    const unsubscribe = watch.subscribe(recorder().listener);
    expect(watch.subscriberCount).toBe(1);
    unsubscribe();
    expect(watch.subscriberCount).toBe(0);
    expect((watch as any).timer).toBeNull();
  });
});
