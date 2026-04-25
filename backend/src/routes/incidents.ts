import { Hono } from "hono";
import { requireAuth, scopeForUser } from "../auth";
import * as db from "../db";
import { bus } from "../events";
import { reverseGeocode } from "../geocoder";
import { fetchHAPI } from "../scrapers/hapi";
import { scrapeGDELT } from "../scrapers/gdelt";
import { scrapeGuardian } from "../scrapers/guardian";
import { scrapeNewsAPI } from "../scrapers/newsapi";
import { scrapeReliefWeb } from "../scrapers/reliefweb";
import { scrapeAll } from "../scrapers/rss";
import { scrapeTelegram } from "../scrapers/telegram";

type SseClient = {
  write: (chunk: string) => Promise<void>;
  close: () => Promise<void>;
};

const router = new Hono();
const sseClients = new Set<SseClient>();
const encoder = new TextEncoder();

function jsonError(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error) };
}

function sseResponse(signal: AbortSignal, clients: Set<SseClient>) {
  const stream = new TransformStream<Uint8Array>();
  const writer = stream.writable.getWriter();
  const client: SseClient = {
    write: (chunk) => writer.write(encoder.encode(chunk)),
    close: () => writer.close(),
  };
  clients.add(client);
  void client.write(":ok\n\n");

  const heartbeat = setInterval(() => {
    void client.write(":heartbeat\n\n").catch(() => {});
  }, 25_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(client);
    void client.close().catch(() => {});
  };

  signal.addEventListener("abort", cleanup, { once: true });

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

bus.on("incident:new", (row) => {
  const message = `event: incident_new\ndata: ${JSON.stringify(row)}\n\n`;
  for (const client of sseClients) {
    void client.write(message).catch(() => {
      sseClients.delete(client);
    });
  }
});

const cache = new Map<string, { ts: number; data: unknown }>();
const CACHE_TTL_MS = 2 * 60 * 1000;

router.use("*", requireAuth);

function getCached(key: string) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function setCache(key: string, data: unknown) {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > 100) cache.delete([...cache.keys()][0]);
}

function clearCache() {
  cache.clear();
}

async function runManualScrape(daysBack: number) {
  try {
    await Promise.all([
      scrapeAll(),
      scrapeTelegram(),
      fetchHAPI(daysBack),
      scrapeReliefWeb(daysBack),
      scrapeGDELT(daysBack),
      scrapeNewsAPI(Math.min(daysBack, 2)),
      scrapeGuardian(Math.min(daysBack, 2)),
    ]);
    clearCache();
  } catch (error) {
    console.error("[Scrape] Manual scrape error:", error instanceof Error ? error.message : error);
  }
}

router.get("/events", (c) => sseResponse(c.req.raw.signal, sseClients));

router.get("/", async (c) => {
  try {
    const query = c.req.query();
    const { state, type, severity, from, to } = query;
    const user = (c as any).get("user");
    const scope = await scopeForUser(user);
    const limit = query.limit ?? "100";
    const offset = query.offset ?? "0";
    const key = JSON.stringify({ state, type, severity, from, to, limit, offset, scope });
    const cached = getCached(key);
    if (cached) return c.json(cached);

    const [incidents, agg] = await Promise.all([
      db.getIncidents({ state, type, severity, from, to, limit: Number(limit), offset: Number(offset), ...scope }),
      db.countIncidents({ state, type, severity, from, to, ...scope }),
    ]);
    const payload = {
      total: agg.total,
      sum_fatalities: agg.sum_fatalities,
      sum_victims: agg.sum_victims,
      count: incidents.length,
      incidents,
    };
    setCache(key, payload);
    return c.json(payload);
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/stats", async (c) => {
  try {
    const user = (c as any).get("user");
    const scope = await scopeForUser(user);
    return c.json(await db.getStats(scope));
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/recent", async (c) => {
  try {
    const { limit = "50", severity } = c.req.query();
    const user = (c as any).get("user");
    const scope = await scopeForUser(user);
    const incidents = await db.getIncidents({ severity, limit: Number(limit), ...scope });
    return c.json({ count: incidents.length, incidents });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/reverse-geocode", (c) => {
  const { lat, lon } = c.req.query();
  const result = reverseGeocode(lat, lon);
  if (!result) return c.json({ error: "valid lat and lon are required" }, 400);
  return c.json(result);
});

router.get("/:id", async (c) => {
  try {
    const row = await db.getById(c.req.param("id"));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/scrape", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const daysBack = parseInt(String(body?.days_back || "7"), 10) || 7;
  void runManualScrape(daysBack);
  return c.json({ message: "Scrape started", timestamp: new Date().toISOString() });
});

router.delete("/", async (c) => {
  try {
    await db.clearAll();
    return c.json({ message: "All incidents and scrape logs cleared" });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

export default router;
