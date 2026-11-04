import { describe, expect, test } from "bun:test";
import { HeartbeatWatch, type LogFiles, parseHeartbeatLine } from "./heartbeat-watch";

const line = (time: string, uid: number, battery = 80, signal = 4) =>
  `2026-11-04 ${time},861 INFO (ZMQTerminalStatusMsgHandler.java:229) parseMsg - end parseMsg. `
  + `msg=TerminalMsg [userId=${uid}, battery=${battery}, signal=${signal}, imei=867951075117495]\n`;

const noise = "2026-11-04 12:00:00,001 DEBUG (ZMQTerminalStatusMsgHandler.java:109) executeTask - createTask uid=621\n";

function fakeFiles() {
  const contents = new Map<string, string>();
  const modified = new Map<string, number>();
  let clock = 0;
  const files: LogFiles = {
    list: (dir) =>
      [...contents.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1)),
    size: (path) => (contents.has(path) ? Buffer.byteLength(contents.get(path)!) : null),
    modified: (path) => modified.get(path) || 0,
    read: (path, from, length) => Buffer.from(contents.get(path) || "").subarray(from, from + length),
  };
  const write = (path: string, text: string) => {
    contents.set(path, (contents.get(path) || "") + text);
    modified.set(path, ++clock);
  };
  return { files, write };
}

const DIR = "/logs";
const TODAY = `${DIR}/2026-11-04`;
const now = () => new Date(2026, 10, 4, 12, 0, 30).getTime();

function watcher(files: LogFiles, backfillBytes = 1024 * 1024) {
  const watch = new HeartbeatWatch({ dir: DIR, files, backfillBytes, now });
  const seen: string[][] = [];
  (watch as any).listeners.add((beats: any[]) => seen.push(beats.map((beat) => beat.uid).sort()));
  return { watch, seen };
}

describe("parseHeartbeatLine", () => {
  test("reads radio, battery, signal and local time", () => {
    expect(parseHeartbeatLine(line("12:01:55", 621, 61, 3))).toEqual({
      uid: "621",
      battery: 61,
      signal: 3,
      at: new Date(2026, 10, 4, 12, 1, 55, 861).getTime(),
    });
  });

  test("ignores other log lines", () => {
    expect(parseHeartbeatLine(noise)).toBeNull();
  });
});

describe("HeartbeatWatch", () => {
  test("backfills the newest file, then reads only what is appended", () => {
    const { files, write } = fakeFiles();
    write(`${TODAY}/terminal.2026-11-04.1.log`, line("11:00:00", 1));
    write(`${TODAY}/terminal.2026-11-04.2.log`, noise + line("12:00:00", 348) + line("12:00:05", 523));
    const { watch, seen } = watcher(files);
    watch.poll();
    expect(seen).toEqual([["348", "523"]]);
    write(`${TODAY}/terminal.2026-11-04.2.log`, line("12:00:20", 348));
    watch.poll();
    watch.poll();
    expect(seen).toEqual([["348", "523"], ["348"]]);
  });

  test("a line still being written is read once it is complete", () => {
    const { files, write } = fakeFiles();
    const path = `${TODAY}/terminal.2026-11-04.1.log`;
    write(path, line("12:00:00", 348));
    const { watch, seen } = watcher(files);
    watch.poll();
    const next = line("12:00:15", 452);
    write(path, next.slice(0, 40));
    watch.poll();
    write(path, next.slice(40));
    watch.poll();
    expect(seen).toEqual([["348"], ["452"]]);
  });

  test("finishes the old file when the log rolls over", () => {
    const { files, write } = fakeFiles();
    write(`${TODAY}/terminal.2026-11-04.5.log`, line("12:00:00", 348));
    const { watch, seen } = watcher(files);
    watch.poll();
    write(`${TODAY}/terminal.2026-11-04.5.log`, line("12:00:10", 523));
    write(`${TODAY}/terminal.2026-11-04.6.log`, line("12:00:12", 904));
    watch.poll();
    expect(seen).toEqual([["348"], ["523", "904"]]);
  });

  test("starting mid-file skips the cut line", () => {
    const { files, write } = fakeFiles();
    const second = line("12:00:01", 222);
    write(`${TODAY}/terminal.2026-11-04.1.log`, line("12:00:00", 111) + second);
    // Start ten bytes before the end of the first line.
    const { watch, seen } = watcher(files, Buffer.byteLength(second) + 10);
    watch.poll();
    expect(seen).toEqual([["222"]]);
  });

  test("keeps only the newest report per radio in a batch", () => {
    const { files, write } = fakeFiles();
    write(`${TODAY}/terminal.2026-11-04.1.log`, line("12:00:00", 348, 90) + line("12:00:15", 348, 89));
    const watch = new HeartbeatWatch({ dir: DIR, files, now });
    let battery: number | null = null;
    (watch as any).listeners.add((beats: any[]) => { battery = beats[0].battery; });
    watch.poll();
    expect(battery).toBe(89);
  });
});
