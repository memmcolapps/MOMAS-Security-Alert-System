// Handset heartbeats, read from the vendor terminal service's log.
//
// Every online handset reports its battery, signal and IMEI about every 15
// seconds. echat forwards these to the vendor's terminal service over ZeroMQ,
// and that service logs each one. It is the only record of them that keeps
// pace: tb_terminal_status is written only when a value changes. So the bridge
// reads the log as it grows, the way `tail -f` does, and never writes to it.
//
// The log lives at <dir>/<YYYY-MM-DD>/terminal.<YYYY-MM-DD>.<N>.log in the
// host's local time, and rolls to the next N at about 10 MB (roughly every 40
// minutes), so the newest file is found by modification time on every poll.

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Heartbeat = {
  uid: string;
  battery: number | null;
  signal: number | null;
  // When the terminal service logged it, epoch ms.
  at: number;
};

export type HeartbeatListener = (beats: Heartbeat[]) => void;

/** The slice of the file system this needs, so tests can fake it. */
export type LogFiles = {
  list(dir: string): string[];
  size(path: string): number | null;
  modified(path: string): number;
  read(path: string, from: number, length: number): Buffer;
};

export const nodeLogFiles: LogFiles = {
  list(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  size(path) {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  },
  modified(path) {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  },
  read(path, from, length) {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      const got = readSync(fd, buffer, 0, length, from);
      return buffer.subarray(0, got);
    } finally {
      closeSync(fd);
    }
  },
};

const LINE =
  /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d),(\d{3}) .*end parseMsg\. msg=TerminalMsg \[userId=(\d+), battery=(-?\d+), signal=(-?\d+)/;

// The log is written in the host's local time with no zone, and the bridge runs
// on that host, so local time is the right reading.
export function parseHeartbeatLine(line: string): Heartbeat | null {
  const match = LINE.exec(line);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms, uid, battery, signal] = match;
  const at = new Date(+y, +mo - 1, +d, +h, +mi, +s, +ms).getTime();
  if (!Number.isFinite(at) || uid === "0") return null;
  const level = (value: string) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  return { uid, battery: level(battery), signal: level(signal), at };
}

function localDay(ms: number) {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

type HeartbeatWatchOptions = {
  dir: string;
  files?: LogFiles;
  intervalMs?: number;
  // How much of the newest file to read on start, so the first batch already
  // covers every radio that is online rather than only the next to report.
  backfillBytes?: number;
  now?: () => number;
};

// A single poll never reads more than this, so a log that has grown a lot while
// the bridge was busy is caught up over a few polls instead of in one big read.
const MAX_READ_BYTES = 4 * 1024 * 1024;

export class HeartbeatWatch {
  private dir: string;
  private files: LogFiles;
  private intervalMs: number;
  private backfillBytes: number;
  private now: () => number;
  private listeners = new Set<HeartbeatListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private file: string | null = null;
  private offset = 0;
  private partial = "";
  // The latest heartbeat from each radio, so a new subscriber gets the current
  // picture at once instead of waiting a full reporting cycle.
  private latest = new Map<string, Heartbeat>();

  lastOkAt: number | null = null;
  lastError: string | null = null;
  delivered = 0;

  constructor(options: HeartbeatWatchOptions) {
    this.dir = options.dir;
    this.files = options.files || nodeLogFiles;
    this.intervalMs = options.intervalMs ?? 2_000;
    this.backfillBytes = options.backfillBytes ?? 1024 * 1024;
    this.now = options.now || Date.now;
  }

  subscribe(listener: HeartbeatListener) {
    this.listeners.add(listener);
    if (this.latest.size) listener([...this.latest.values()]);
    if (!this.timer) this.schedule(0);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    };
  }

  status() {
    return {
      subscribers: this.listeners.size,
      file: this.file,
      radios: this.latest.size,
      lastOkAt: this.lastOkAt ? new Date(this.lastOkAt).toISOString() : null,
      lastError: this.lastError,
      delivered: this.delivered,
    };
  }

  private schedule(delayMs: number) {
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.poll();
        this.lastOkAt = this.now();
        this.lastError = null;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      if (this.listeners.size) this.schedule(this.intervalMs);
    }, delayMs);
  }

  // The newest log file, checking yesterday's folder too so the minutes either
  // side of midnight are not lost.
  newestFile() {
    const today = this.now();
    let best: { path: string; modified: number } | null = null;
    for (const day of new Set([localDay(today - 3_600_000), localDay(today)])) {
      const folder = join(this.dir, day);
      for (const name of this.files.list(folder)) {
        if (!name.endsWith(".log")) continue;
        const path = join(folder, name);
        const modified = this.files.modified(path);
        if (!best || modified > best.modified) best = { path, modified };
      }
    }
    return best?.path || null;
  }

  poll() {
    const newest = this.newestFile();
    if (!newest) throw new Error(`No terminal service log found under ${this.dir}.`);

    const beats: Heartbeat[] = [];
    if (this.file === null) {
      // First look: start near the end rather than replaying the whole file.
      const size = this.files.size(newest) || 0;
      this.file = newest;
      this.offset = Math.max(0, size - this.backfillBytes);
      this.partial = "";
      this.readFrom(this.file, beats, this.offset > 0);
    } else if (newest !== this.file) {
      // The log rolled. Finish the old file, then read the new one from the top.
      this.readFrom(this.file, beats, false);
      this.file = newest;
      this.offset = 0;
      this.partial = "";
      this.readFrom(this.file, beats, false);
    } else {
      this.readFrom(this.file, beats, false);
    }

    if (!beats.length) return;
    // Several reports from one radio in a single poll collapse to the newest.
    const byRadio = new Map<string, Heartbeat>();
    for (const beat of beats) {
      const known = byRadio.get(beat.uid);
      if (!known || beat.at >= known.at) byRadio.set(beat.uid, beat);
    }
    const batch = [...byRadio.values()];
    for (const beat of batch) this.latest.set(beat.uid, beat);
    this.delivered += batch.length;
    for (const listener of this.listeners) listener(batch);
  }

  private readFrom(path: string, beats: Heartbeat[], skipFirstLine: boolean) {
    const size = this.files.size(path);
    if (size === null) return;
    // Truncated or replaced in place: start again from the top.
    if (size < this.offset) {
      this.offset = 0;
      this.partial = "";
    }
    if (size === this.offset) return;
    const length = Math.min(size - this.offset, MAX_READ_BYTES);
    const chunk = this.files.read(path, this.offset, length);
    this.offset += chunk.length;
    const text = this.partial + chunk.toString("utf8");
    const lines = text.split("\n");
    // The last piece may be a line still being written.
    this.partial = lines.pop() || "";
    // Starting mid-file lands mid-line; that first piece is not a whole line.
    if (skipFirstLine) lines.shift();
    for (const line of lines) {
      const beat = parseHeartbeatLine(line);
      if (beat) beats.push(beat);
    }
  }
}
