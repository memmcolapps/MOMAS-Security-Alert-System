// SOS alarms, watched from the POCSTARS host itself.
//
// MOMAS used to learn about an SOS only by polling the vendor's SOS service
// from the VPS, across the public internet. On a poor link that poll times out
// often enough that alarms reached the console minutes late. The bridge sits on
// the same host as that service, so it can ask over loopback every second, and
// hand each new alarm to the VPS once over the tunnel it already holds open.
//
// The VPS keeps polling as well. Both paths land in the same idempotent insert,
// so an alarm is stored once whichever path delivers it first.

export type SosRow = Record<string, any> & { sosMsgId: number | string };

export type SosFetch = (url: string, init: { signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

type SosWatchOptions = {
  baseUrl: string;
  targetUid: string;
  intervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: SosFetch;
};

export type SosListener = {
  /** Every alarm open upstream right now; sent once when the listener joins. */
  onSnapshot: (rows: SosRow[]) => void;
  /** Alarms that appeared since the previous poll. */
  onNew: (rows: SosRow[]) => void;
};

export class SosWatch {
  private options: Required<Omit<SosWatchOptions, "fetchImpl">> & { fetchImpl: SosFetch };
  private listeners = new Set<SosListener>();
  // Joined before the first page arrived, so still owed their snapshot.
  private awaitingSnapshot = new Set<SosListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  // Every alarm currently unanswered upstream, by id. A subscriber that joins
  // (or rejoins after the tunnel dropped) is sent all of these at once, which
  // is how an alarm raised while the VPS was cut off still arrives.
  private open = new Map<string, SosRow>();
  private primed = false;

  lastOkAt: number | null = null;
  lastError: string | null = null;

  constructor(options: SosWatchOptions) {
    this.options = {
      intervalMs: 1000,
      timeoutMs: 3000,
      fetchImpl: fetch as unknown as SosFetch,
      ...options,
      baseUrl: options.baseUrl.replace(/\/$/, ""),
    };
  }

  get subscriberCount() {
    return this.listeners.size;
  }

  /** Current open alarms, for a subscriber that has just joined. */
  snapshot() {
    return [...this.open.values()];
  }

  /** Adds a listener; polling runs only while somebody is listening. */
  subscribe(listener: SosListener) {
    this.listeners.add(listener);
    if (this.primed) listener.onSnapshot(this.snapshot());
    else this.awaitingSnapshot.add(listener);
    if (!this.timer && !this.polling) this.schedule(0);
    return () => {
      this.listeners.delete(listener);
      this.awaitingSnapshot.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One poll. Public so tests can drive it without timers. */
  async pollOnce() {
    const url = new URL(`${this.options.baseUrl}/sos/mg/records`);
    url.searchParams.set("targetUid", this.options.targetUid);
    url.searchParams.set("status", "0");
    url.searchParams.set("pageNum", "1");
    url.searchParams.set("pageSize", "50");
    const response = await this.options.fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw new Error(`SOS service answered HTTP ${response.status}`);
    const body = await response.json();
    const rows: SosRow[] = Array.isArray(body?.data?.rows) ? body.data.rows : [];
    this.lastOkAt = Date.now();
    this.lastError = null;
    return this.absorb(rows);
  }

  /** Folds one page into the open set and returns the rows that are new. */
  absorb(rows: SosRow[]) {
    const current = new Map<string, SosRow>();
    for (const row of rows) {
      if (row?.sosMsgId === undefined || row?.sosMsgId === null) continue;
      current.set(String(row.sosMsgId), row);
    }
    const fresh = this.primed
      ? [...current.entries()].filter(([id]) => !this.open.has(id)).map(([, row]) => row)
      : [];
    this.open = current;
    // The first page is a baseline, not news: whatever was already open goes
    // out in each subscriber's snapshot instead of as a burst of "new" alarms.
    this.primed = true;
    const owed = [...this.awaitingSnapshot];
    this.awaitingSnapshot.clear();
    for (const listener of owed) listener.onSnapshot(this.snapshot());
    if (fresh.length) {
      for (const listener of this.listeners) {
        if (!owed.includes(listener)) listener.onNew(fresh);
      }
    }
    return fresh;
  }

  private schedule(delay: number) {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
  }

  private async tick() {
    if (!this.listeners.size) return;
    this.polling = true;
    try {
      await this.pollOnce();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.polling = false;
      if (this.listeners.size) this.schedule(this.options.intervalMs);
    }
  }
}
