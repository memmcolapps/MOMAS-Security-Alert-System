import { Hono } from "hono";
import { requireAuth, requirePlatform, scopeForUser } from "../auth";
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

function evidenceLine(item: any) {
  const source = [item.source_type, item.source].filter(Boolean).join(" / ") || "Unknown source";
  const date = item.published_at ? new Date(item.published_at).toISOString().slice(0, 10) : "undated";
  return `- ${source} (${date}) - ${item.title || "Untitled"}${item.source_url ? `\n  ${item.source_url}` : ""}`;
}

async function incidentReportMarkdown(incident: any) {
  const evidence = await db.getIncidentEvidence(incident.id);
  const refreshed = await db.refreshIncidentConfidence(incident.id);
  const row = refreshed || incident;
  return [
    `# Incident Intelligence Report #${row.id}`,
    "",
    `**Title:** ${row.title}`,
    `**Date:** ${row.date ? new Date(row.date).toISOString().slice(0, 10) : "Unknown"}`,
    `**Location:** ${[row.location, row.state].filter(Boolean).join(", ") || "Nigeria"}`,
    `**Type:** ${row.type || "Unknown"}`,
    `**Severity:** ${row.severity || "Unknown"}`,
    `**Impact:** ${row.fatalities || 0} killed; ${row.victims || 0} abducted/victims`,
    `**Confidence:** ${row.confidence_score || 0}%`,
    row.confidence_reason ? `**Confidence rationale:** ${row.confidence_reason}` : null,
    "",
    "## Summary",
    row.summary || row.description || "No summary available.",
    "",
    "## Evidence",
    evidence.length ? evidence.map(evidenceLine).join("\n") : "No linked evidence.",
    "",
    "## Source Notes",
    evidence
      .filter((item: any) => item.analyst_note)
      .map((item: any) => `- ${item.analyst_note}`)
      .join("\n") || "No analyst notes recorded.",
  ].filter(Boolean).join("\n");
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

// A manual scrape fans out to seven collectors, several of them metered. The
// route used to fire it with `void` and no guard, so repeated clicks stacked
// overlapping runs against the same quotas - the background tiers have had an
// equivalent guard since they were written (see `running` in server.ts).
let manualScrapeRunning = false;

async function runManualScrape(daysBack: number) {
  manualScrapeRunning = true;
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
  } finally {
    manualScrapeRunning = false;
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

// The three reads below resolve the incident through the caller's scope. A 404
// rather than a 403 on an out-of-scope id, so the response cannot be used to
// confirm that an incident exists in a state the caller may not see.
async function incidentInScope(c: any) {
  const scope = await scopeForUser(c.get("user"));
  return db.getIncidentInScope(c.req.param("id"), scope);
}

router.get("/:id/evidence", async (c) => {
  try {
    const incident = await incidentInScope(c);
    if (!incident) return c.json({ error: "Not found" }, 404);
    const evidence = await db.getIncidentEvidence(incident.id);
    const refreshed = await db.refreshIncidentConfidence(incident.id);
    return c.json({
      incident: refreshed || incident,
      evidence,
      count: evidence.length,
    });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/:id/report", async (c) => {
  try {
    const incident = await incidentInScope(c);
    if (!incident) return c.json({ error: "Not found" }, 404);
    return c.json({ markdown: await incidentReportMarkdown(incident) });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/:id", async (c) => {
  try {
    const row = await incidentInScope(c);
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

// Collection is platform-wide, not per tenant: one manual run refreshes the
// corpus every organization reads, and spends shared API quota doing it. It is
// operator work, and it was previously open to any signed-in account.
router.post("/scrape", requirePlatform("ops"), async (c) => {
  if (manualScrapeRunning) {
    return c.json({ error: "A manual scrape is already running. Wait for it to finish." }, 409);
  }
  const body = await c.req.json().catch(() => ({}));
  const requested = parseInt(String(body?.days_back ?? "7"), 10);
  const daysBack = Math.min(30, Math.max(1, Number.isFinite(requested) ? requested : 7));
  void runManualScrape(daysBack);
  return c.json({ message: "Scrape started", days_back: daysBack, timestamp: new Date().toISOString() });
});

// Destroys the entire incident corpus and its scrape history for every tenant,
// with no way back. It was reachable by any signed-in account, including a
// viewer in a customer organization. Owner-only, and the name has to be typed -
// the same shape as deleting a company.
router.delete("/", requirePlatform("admin"), async (c) => {
  const user = (c as any).get("user");
  const confirm = String(c.req.query("confirm") ?? "").trim();
  if (confirm !== "DELETE ALL INCIDENTS") {
    return c.json({
      error: 'Type DELETE ALL INCIDENTS in the confirm parameter to erase every incident and scrape log.',
    }, 400);
  }
  try {
    const counts = await db.countAllIncidents();
    await db.clearAll();
    await db.createAuditLog({
      organization_id: null,
      actor_user_id: user?.id,
      action: "platform.incidents.purge",
      target_type: "incidents",
      target_id: null,
      metadata: { email: user?.email, ...counts },
    });
    return c.json({ message: "All incidents and scrape logs cleared", ...counts });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

export default router;
