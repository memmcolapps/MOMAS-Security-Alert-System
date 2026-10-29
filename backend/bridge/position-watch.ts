// Every GPS point a handset sends, read from the vendor's own store.
//
// Handsets sample every few seconds but upload in batches every 15-30s, and the
// vendor's LastLocation API only ever returns the newest point of a batch. The
// location service writes every point to MongoDB on this host (one collection
// per day, gpshistorydata<YYYYMMDD>), so the bridge reads them from there and
// hands each new batch to MOMAS over the tunnel it already holds open.
//
// Documents are read in _id order. The service creates the ObjectId when it
// saves a batch, so "everything after the last _id" is both indexed and gap
// free - unlike Rtimestamp, whose index is declared as rTimestamp and unused.

export type PositionPoint = {
  uid: string;
  lat: number;
  lon: number;
  // Handset GPS time and vendor save time, both epoch ms.
  t: number;
  s: number;
};

export type PositionDoc = {
  _id: any;
  Uid?: number | string;
  Wgs84?: { Lat?: number; Lon?: number };
  Rtimestamp?: number | { toNumber(): number };
  Stimestamp?: number | { toNumber(): number };
};

/** The slice of a MongoDB database this needs, so tests can fake it. */
export type PositionStore = {
  find(collection: string, afterId: any, limit: number): Promise<PositionDoc[]>;
  idFromTime(ms: number): any;
};

export type PositionListener = (points: PositionPoint[]) => void;

type PositionWatchOptions = {
  store: PositionStore;
  intervalMs?: number;
  batchLimit?: number;
  now?: () => number;
};

const DAY_MS = 86_400_000;

function asNumber(value: unknown) {
  if (value && typeof value === "object" && "toNumber" in (value as any)) return (value as any).toNumber();
  return Number(value);
}

export function collectionFor(ms: number) {
  return `gpshistorydata${new Date(ms).toISOString().slice(0, 10).replace(/-/g, "")}`;
}

export function toPoint(doc: PositionDoc): PositionPoint | null {
  const lat = Number(doc.Wgs84?.Lat);
  const lon = Number(doc.Wgs84?.Lon);
  const t = asNumber(doc.Rtimestamp);
  const s = asNumber(doc.Stimestamp);
  const uid = doc.Uid === undefined || doc.Uid === null ? "" : String(doc.Uid);
  if (!uid || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  if (!Number.isFinite(t)) return null;
  return { uid, lat, lon, t, s: Number.isFinite(s) ? s : t };
}

export class PositionWatch {
  private store: PositionStore;
  private intervalMs: number;
  private batchLimit: number;
  private now: () => number;
  private listeners = new Set<PositionListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private cursor: any = null;

  lastOkAt: number | null = null;
  lastError: string | null = null;
  delivered = 0;

  constructor(options: PositionWatchOptions) {
    this.store = options.store;
    this.intervalMs = options.intervalMs ?? 2000;
    this.batchLimit = options.batchLimit ?? 5000;
    this.now = options.now ?? Date.now;
  }

  get subscriberCount() {
    return this.listeners.size;
  }

  // The collection is named by UTC date. Near midnight a batch can land in
  // either day's collection, so the neighbours are read too; with the _id
  // cursor that costs one indexed lookup each.
  private collections() {
    const now = this.now();
    return [...new Set([collectionFor(now - DAY_MS), collectionFor(now), collectionFor(now + DAY_MS)])];
  }

  private async readAfter(afterId: any) {
    const docs: PositionDoc[] = [];
    for (const name of this.collections()) docs.push(...(await this.store.find(name, afterId, this.batchLimit)));
    docs.sort((a, b) => (String(a._id) < String(b._id) ? -1 : String(a._id) > String(b._id) ? 1 : 0));
    return docs;
  }

  /**
   * Adds a listener. With sinceMs it is first sent what was stored since then,
   * which is how a backend that lost the tunnel catches up on the gap.
   */
  async subscribe(listener: PositionListener, sinceMs?: number) {
    this.listeners.add(listener);
    if (this.cursor === null) this.cursor = this.store.idFromTime(this.now());
    if (sinceMs && Number.isFinite(sinceMs)) {
      const floor = Math.max(sinceMs, this.now() - 10 * 60_000);
      try {
        const docs = await this.readAfter(this.store.idFromTime(floor));
        const points = docs.filter((doc) => String(doc._id) <= String(this.cursor)).map(toPoint).filter(Boolean) as PositionPoint[];
        if (points.length) listener(points);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!this.timer && !this.polling) this.schedule(0);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One read. Public so tests can drive it without timers. */
  async pollOnce() {
    if (this.cursor === null) this.cursor = this.store.idFromTime(this.now());
    const docs = await this.readAfter(this.cursor);
    this.lastOkAt = this.now();
    this.lastError = null;
    if (!docs.length) return [];
    this.cursor = docs[docs.length - 1]._id;
    const points = docs.map(toPoint).filter(Boolean) as PositionPoint[];
    if (points.length) {
      this.delivered += points.length;
      for (const listener of this.listeners) listener(points);
    }
    return points;
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
      if (this.listeners.size) this.schedule(this.intervalMs);
    }
  }
}

/** The real store, over the vendor's MongoDB on this host. */
export async function mongoPositionStore(uri: string): Promise<PositionStore> {
  const { MongoClient, ObjectId } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000, maxPoolSize: 2 });
  await client.connect();
  const db = client.db();
  return {
    find: (collection, afterId, limit) =>
      db
        .collection(collection)
        .find({ _id: { $gt: afterId } }, { projection: { Uid: 1, Wgs84: 1, Rtimestamp: 1, Stimestamp: 1 } })
        .sort({ _id: 1 })
        .limit(limit)
        .toArray() as Promise<PositionDoc[]>,
    idFromTime: (ms) => ObjectId.createFromTime(Math.floor(ms / 1000)),
  };
}
