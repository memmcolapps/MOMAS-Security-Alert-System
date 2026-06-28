import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, scopeForUser } from "../auth";
import { classify } from "../classifier";
import * as db from "../db";
import { bus } from "../events";
import { runWatchlistMatch, sourceText } from "../osint/matcher";
import { persistIncident } from "../scrapers/ingest";

const router = new Hono();

// ── Live alert stream ───────────────────────────────────────────────────────
// Newly created alerts are emitted on the bus by the matcher (ingest + analyst
// paths). Each SSE client only receives alerts for its own org (or global
// watchlists); platform admins see everything.
type AlertSseClient = {
  write: (chunk: string) => Promise<void>;
  close: () => Promise<void>;
  orgId: number | null;
  isAdmin: boolean;
};
const alertClients = new Set<AlertSseClient>();
const alertEncoder = new TextEncoder();

bus.on("osint:alert", (alert: any) => {
  const message = `event: osint_alert\ndata: ${JSON.stringify(alert)}\n\n`;
  for (const client of alertClients) {
    const orgMatch =
      client.isAdmin ||
      alert.organization_id == null ||
      Number(alert.organization_id) === Number(client.orgId);
    if (!orgMatch) continue;
    void client.write(message).catch(() => alertClients.delete(client));
  }
});

router.use("*", requireAuth);

function jsonError(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error) };
}

function currentUser(c: any) {
  return c.get("user") || null;
}

function primaryOrgId(user: any) {
  return user?.active_membership?.organization_id || user?.memberships?.[0]?.organization_id || null;
}

const idSchema = z.coerce.number().int().positive();
const limitSchema = z.coerce.number().int().min(1).max(500);
const hoursSchema = z.coerce.number().int().min(1).max(24 * 365);
const sourceItemStatuses = ["pending", "needs_review", "linked", "incident", "merged", "dismissed", "non_incident", "all"] as const;
const alertStatuses = ["new", "reviewed", "dismissed", "all"] as const;
const managerRoles = new Set(["org_owner", "org_admin", "unit_admin", "admin"]);

function parse<T>(c: any, schema: z.ZodType<T>, value: unknown): T | Response {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  return c.json({ error: "Invalid request", details: z.flattenError(result.error).fieldErrors }, 400);
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

function requireAnalyst(c: any) {
  const user = currentUser(c);
  if (user?.platform_role === "admin" || managerRoles.has(user?.active_membership?.role)) return null;
  return c.json({ error: "Analyst or organization admin access is required." }, 403);
}

function requireOrganization(c: any) {
  const user = currentUser(c);
  if (user?.platform_role === "admin") return null;
  if (primaryOrgId(user)) return null;
  return c.json({ error: "Select an organization to access OSINT data." }, 403);
}

router.use("*", async (c, next) => {
  const denied = requireOrganization(c);
  if (denied) return denied;
  await next();
});

function publishedDate(item: any) {
  const value = item.published_at || item.created_at || new Date().toISOString();
  return new Date(value).toISOString().slice(0, 10);
}

router.get("/events", (c) => {
  const user = currentUser(c);
  const stream = new TransformStream<Uint8Array>();
  const writer = stream.writable.getWriter();
  const client: AlertSseClient = {
    write: (chunk) => writer.write(alertEncoder.encode(chunk)),
    close: () => writer.close(),
    orgId: primaryOrgId(user),
    isAdmin: user?.platform_role === "admin",
  };
  alertClients.add(client);
  void client.write(":ok\n\n");

  const heartbeat = setInterval(() => {
    void client.write(":heartbeat\n\n").catch(() => {});
  }, 25_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    alertClients.delete(client);
    void client.close().catch(() => {});
  };
  c.req.raw.signal.addEventListener("abort", cleanup, { once: true });

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

router.get("/sources", async (c) => {
  try {
    const [sources, discovered] = await Promise.all([
      db.listOsintSources(),
      db.discoveredOsintSources(),
    ]);
    return c.json({ sources, discovered });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/analytics/sources", async (c) => {
  try {
    return c.json(await db.getAdvancedSourceAnalytics());
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/graph", async (c) => {
  try {
    const query = parse(c, z.object({ limit: limitSchema.default(80) }), c.req.query());
    if (isResponse(query)) return query;
    return c.json(await db.getOsintGraph(query));
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/reports/brief", async (c) => {
  try {
    const query = parse(c, z.object({ hours: hoursSchema.default(72) }), c.req.query());
    if (isResponse(query)) return query;
    const hours = query.hours;
    const organizationId = primaryOrgId(currentUser(c));
    const [alerts, entities, analytics] = await Promise.all([
      db.listOsintAlerts({ status: "all", limit: 50, organizationId }),
      db.listOsintEntities({ limit: 25 }),
      db.getAdvancedSourceAnalytics(),
    ]);
    const recentAlerts = alerts.filter((alert: any) => {
      const matched = new Date(alert.matched_at).getTime();
      return Number.isFinite(matched) && Date.now() - matched <= hours * 3600000;
    });
    const markdown = [
      `# OSINT Intelligence Brief`,
      "",
      `Window: last ${hours} hours`,
      `Generated: ${new Date().toISOString()}`,
      "",
      "## Alert Summary",
      recentAlerts.length
        ? recentAlerts.map((alert: any) => `- ${alert.watchlist_name || "Watchlist"} (${alert.score || 0}%): ${alert.title || "Untitled"} - ${alert.reason || ""}`).join("\n")
        : "No watchlist alerts in this window.",
      "",
      "## Top Entities",
      entities.length
        ? entities.map((entity: any) => `- ${entity.value} (${entity.entity_type}) - ${entity.mentions} mention(s)`).join("\n")
        : "No extracted entities.",
      "",
      "## Source Reliability",
      analytics.sources.slice(0, 15).map((source: any) =>
        `- ${source.source} (${source.source_type}): reliability ${source.reliability_index}%, useful ${source.useful_rate}%, rejected ${source.rejection_rate}%`,
      ).join("\n") || "No source analytics available.",
    ].join("\n");
    return c.json({ markdown, alerts: recentAlerts, entities, analytics });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/sources", async (c) => {
  const denied = requireAnalyst(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const input = parse(c, z.object({
    name: z.string().trim().min(1).max(120),
    source_type: z.string().trim().min(1).max(40),
    locator: z.string().trim().min(1).max(1000),
    keywords: z.string().trim().max(2000).default(""),
    reliability_score: z.coerce.number().int().min(0).max(100).default(50),
    cadence_minutes: z.coerce.number().int().min(1).max(525600).default(30),
    enabled: z.boolean().default(true),
    notes: z.string().trim().max(4000).optional(),
  }), body);
  if (isResponse(input)) return input;
  try {
    const source = await db.upsertOsintSource(input);
    return c.json({ source });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.delete("/sources/:id", async (c) => {
  const denied = requireAnalyst(c);
  if (denied) return denied;
  const id = parse(c, idSchema, c.req.param("id"));
  if (isResponse(id)) return id;
  try {
    const ok = await db.deleteOsintSource(id);
    if (!ok) return c.json({ error: "Source not found" }, 404);
    return c.json({ ok: true });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/watchlists", async (c) => {
  try {
    const user = currentUser(c);
    return c.json({ watchlists: await db.listWatchlists({ organizationId: primaryOrgId(user) }) });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/watchlists", async (c) => {
  const denied = requireAnalyst(c);
  if (denied) return denied;
  const user = currentUser(c);
  const body = await c.req.json().catch(() => ({}));
  const input = parse(c, z.object({
    id: idSchema.optional(),
    name: z.string().trim().min(1).max(120),
    query_text: z.string().trim().min(1).max(2000),
    severity: z.enum(["RED", "ORANGE", "YELLOW", "BLUE"]).default("YELLOW"),
    enabled: z.boolean().default(true),
    rule_type: z.enum(["all_terms", "any_term", "source"]).default("all_terms"),
    min_confidence: z.coerce.number().int().min(0).max(100).default(0),
    window_hours: hoursSchema.default(24),
  }), body);
  if (isResponse(input)) return input;
  try {
    const watchlist = await db.upsertWatchlist({
      ...input,
      organization_id: primaryOrgId(user),
      created_by: user?.id || null,
    });
    return c.json({ watchlist });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.delete("/watchlists/:id", async (c) => {
  const denied = requireAnalyst(c);
  if (denied) return denied;
  const id = parse(c, idSchema, c.req.param("id"));
  if (isResponse(id)) return id;
  try {
    const ok = await db.deleteWatchlist(id, primaryOrgId(currentUser(c)));
    if (!ok) return c.json({ error: "Watchlist not found" }, 404);
    return c.json({ ok: true });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/entities", async (c) => {
  try {
    const query = parse(c, z.object({
      q: z.string().trim().max(200).default(""),
      entity_type: z.string().trim().max(40).default("all"),
      limit: limitSchema.default(100),
    }), c.req.query());
    if (isResponse(query)) return query;
    const entities = await db.listOsintEntities({
      ...query,
    });
    return c.json({ entities });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/alerts", async (c) => {
  try {
    const query = parse(c, z.object({
      status: z.enum(alertStatuses).default("new"),
      limit: limitSchema.default(100),
    }), c.req.query());
    if (isResponse(query)) return query;
    const alerts = await db.listOsintAlerts({
      ...query,
      organizationId: primaryOrgId(currentUser(c)),
    });
    return c.json({ alerts });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/alerts/:id/status", async (c) => {
  const denied = requireAnalyst(c);
  if (denied) return denied;
  const id = parse(c, idSchema, c.req.param("id"));
  if (isResponse(id)) return id;
  const body = await c.req.json().catch(() => ({}));
  const input = parse(c, z.object({ status: z.enum(["new", "reviewed", "dismissed"]) }), body);
  if (isResponse(input)) return input;
  try {
    const alert = await db.updateOsintAlertStatus(id, input.status, primaryOrgId(currentUser(c)));
    if (!alert) return c.json({ error: "Alert not found" }, 404);
    return c.json({ alert });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/alerts/evaluate", async (c) => {
  const denied = requireAnalyst(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const input = parse(c, z.object({
    hours: hoursSchema.default(24),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  }), body);
  if (isResponse(input)) return input;
  try {
    const organizationId = primaryOrgId(currentUser(c));
    const watchlists = await db.listWatchlists({ organizationId });
    const maxWindow = watchlists.reduce(
      (max: number, item: any) => Math.max(max, Number(item.window_hours || 24)),
      input.hours,
    );
    const items = await db.recentSourceItems({ hours: maxWindow, limit: input.limit });
    const alerts = [];
    for (const item of items) {
      const result = await runWatchlistMatch(item, { organizationId, watchlists });
      alerts.push(...result.alerts);
    }
    return c.json({
      scanned: items.length,
      alerts_created: alerts.filter((alert: any) => alert.created).length,
      alerts_updated: alerts.filter((alert: any) => !alert.created).length,
      alerts,
    });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/items", async (c) => {
  try {
    const params = parse(c, z.object({
      status: z.enum(sourceItemStatuses).default("pending"),
      source_type: z.string().trim().max(40).default("all"),
      q: z.string().trim().max(200).default(""),
      limit: limitSchema.default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }), c.req.query());
    if (isResponse(params)) return params;
    const scopedParams = { ...params, organizationId: primaryOrgId(currentUser(c)) };
    const [items, aggregate] = await Promise.all([
      db.listSourceItems(scopedParams),
      db.countSourceItems(scopedParams),
    ]);
    return c.json({ items, total: aggregate.total });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/items/:id", async (c) => {
  const id = parse(c, idSchema, c.req.param("id"));
  if (isResponse(id)) return id;
  try {
    const item = await db.getSourceItem(id, primaryOrgId(currentUser(c)));
    if (!item) return c.json({ error: "OSINT item not found" }, 404);
    const scored = Number(item.confidence_score) > 0
      ? item
      : await db.refreshSourceItemConfidence(item.id);
    const entities = await db.listEntitiesForSourceItem(item.id);
    return c.json({ item: scored || item, entities });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/items/:id/extract", async (c) => {
  const denied = requireAnalyst(c);
  if (denied) return denied;
  const id = parse(c, idSchema, c.req.param("id"));
  if (isResponse(id)) return id;
  try {
    const item = await db.getSourceItem(id, primaryOrgId(currentUser(c)));
    if (!item) return c.json({ error: "OSINT item not found" }, 404);
    const result = await runWatchlistMatch(item, { organizationId: primaryOrgId(currentUser(c)) });
    return c.json(result);
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/items/:id/review", async (c) => {
  const denied = requireAnalyst(c);
  if (denied) return denied;
  const id = parse(c, idSchema, c.req.param("id"));
  if (isResponse(id)) return id;
  const user = currentUser(c);
  const body = await c.req.json().catch(() => ({}));
  const input = parse(c, z.object({
    status: z.enum(["pending", "needs_review", "dismissed", "non_incident"]).default("needs_review"),
    analyst_note: z.string().trim().max(4000).nullable().default(null),
    confidence_score: z.number().int().min(0).max(100).nullable().optional(),
    confidence_reason: z.string().trim().max(2000).nullable().optional(),
  }), body);
  if (isResponse(input)) return input;

  try {
    const item = await db.updateSourceItemReview(id, {
      status: input.status,
      analyst_note: input.analyst_note,
      reviewed_by: user?.id || null,
      confidence_score: input.confidence_score ?? null,
      confidence_reason: input.confidence_reason ?? null,
      organization_id: primaryOrgId(user),
    });
    if (!item) return c.json({ error: "OSINT item not found" }, 404);
    await runWatchlistMatch(item, { organizationId: primaryOrgId(user) }).catch(() => null);

    await db.createAuditLog({
      organization_id: primaryOrgId(user),
      actor_user_id: user?.id,
      action: `osint.${input.status}`,
      target_type: "source_item",
      target_id: item.id,
      metadata: { source_type: item.source_type, source: item.source },
    }).catch(() => null);

    return c.json({ item });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/items/:id/link", async (c) => {
  const denied = requireAnalyst(c);
  if (denied) return denied;
  const itemId = parse(c, idSchema, c.req.param("id"));
  if (isResponse(itemId)) return itemId;
  const user = currentUser(c);
  const body = await c.req.json().catch(() => ({}));
  const input = parse(c, z.object({
    incident_id: idSchema,
    analyst_note: z.string().trim().max(4000).nullable().default(null),
  }), body);
  if (isResponse(input)) return input;
  const incidentId = input.incident_id;

  try {
    const incident = await db.getById(incidentId);
    if (!incident) return c.json({ error: "Incident not found" }, 404);
    const scope = await scopeForUser(user);
    if (!scope.allStates && (!incident.state || !scope.allowedStates.includes(incident.state))) {
      return c.json({ error: "Incident is outside your operational scope" }, 403);
    }

    const item = await db.linkSourceItemToIncident(itemId, incidentId, {
      analyst_note: input.analyst_note,
      reviewed_by: user?.id || null,
      organization_id: primaryOrgId(user),
    });
    if (!item) return c.json({ error: "OSINT item not found" }, 404);
    await runWatchlistMatch(item, { organizationId: primaryOrgId(user) }).catch(() => null);

    await db.mergeIntoIncident(incidentId, {
      source: item.source,
      source_url: item.source_url,
      fatalities: 0,
      victims: 0,
    });
    const refreshedIncident = await db.refreshIncidentConfidence(incidentId);

    await db.createAuditLog({
      organization_id: primaryOrgId(user),
      actor_user_id: user?.id,
      action: "osint.link",
      target_type: "incident",
      target_id: incidentId,
      metadata: { source_item_id: item.id },
    }).catch(() => null);

    return c.json({ item, incident: refreshedIncident || incident });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/items/:id/promote", async (c) => {
  const denied = requireAnalyst(c);
  if (denied) return denied;
  const itemId = parse(c, idSchema, c.req.param("id"));
  if (isResponse(itemId)) return itemId;
  const user = currentUser(c);
  const body = await c.req.json().catch(() => ({}));
  const input = parse(c, z.object({
    analyst_note: z.string().trim().max(4000).nullable().default(null),
  }), body);
  if (isResponse(input)) return input;

  try {
    const item = await db.getSourceItem(itemId, primaryOrgId(user));
    if (!item) return c.json({ error: "OSINT item not found" }, 404);

    const title = item.title || "OSINT report";
    const description = sourceText(item) || title;
    const result = await classify(title, description);
    if (!result?.is_security_incident) {
      const reviewed = await db.updateSourceItemReview(item.id, {
        status: "needs_review",
        analyst_note: input.analyst_note || result?.reasoning || "Classifier did not confirm a security incident",
        reviewed_by: user?.id || null,
        confidence_score: 30,
        confidence_reason: result?.reasoning || "Not confirmed by classifier",
        organization_id: primaryOrgId(user),
      });
      return c.json(
        {
          error: "Classifier did not confirm this as a publishable incident",
          item: reviewed,
          classification: result,
        },
        422,
      );
    }

    const date = result.date || publishedDate(item);
    const persisted = await persistIncident({
      result,
      title,
      description: result.summary || description,
      date,
      external_id: `osint:${item.external_id}`,
      source: item.source,
      source_url: item.source_url,
      source_type: item.source_type,
    });

    const status = persisted.status === "inserted" ? "incident" : persisted.status;
    if (persisted.incidentId) {
      await db.linkSourceItemToIncident(item.id, persisted.incidentId, {
        analyst_note: input.analyst_note,
        reviewed_by: user?.id || null,
        organization_id: primaryOrgId(user),
      });
    }
    const reviewed = await db.updateSourceItemReview(item.id, {
      status,
      analyst_note: input.analyst_note,
      reviewed_by: user?.id || null,
      confidence_score: 75,
      confidence_reason: result.reasoning || "Promoted by analyst from OSINT inbox",
      organization_id: primaryOrgId(user),
    });
    await runWatchlistMatch(reviewed, { organizationId: primaryOrgId(user) }).catch(() => null);

    await db.createAuditLog({
      organization_id: primaryOrgId(user),
      actor_user_id: user?.id,
      action: "osint.promote",
      target_type: "source_item",
      target_id: item.id,
      metadata: { incident_id: persisted.incidentId, status: persisted.status },
    }).catch(() => null);

    const incident = persisted.incidentId
      ? await db.refreshIncidentConfidence(persisted.incidentId)
      : null;

    return c.json({ item: reviewed, classification: result, promoted: persisted, incident });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

export default router;
