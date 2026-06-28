// Watchlist matching, shared between the analyst routes (manual extract/review)
// and the scrape ingest path so alerts fire automatically as items land.
//
// On ingest there is no request/org context, so matching runs against every
// enabled watchlist (each carries its own organization_id). Newly created
// alerts are emitted on the bus as "osint:alert" for SSE subscribers; we never
// emit on re-matches, so a steady scrape cycle won't spam the same alert.

import { bus } from "../events";
import * as db from "../db";
import { extractEntitiesFromText } from "./entities";

function sourceText(item: any) {
  return [item.description, item.content_text].filter(Boolean).join("\n\n").trim();
}

function itemSearchText(item: any, entities: any[] = []) {
  return [
    item.title,
    item.description,
    item.content_text,
    item.source,
    item.source_type,
    ...entities.map((entity) => entity.value),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function watchlistTerms(queryText: string) {
  return String(queryText || "")
    .split(/[,\n]+|\s+\+\s+/)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

function watchlistMatches(watchlist: any, haystack: string, item: any) {
  const terms = watchlistTerms(watchlist.query_text);
  if (!terms.length) return null;
  const sourceConfidence = Number(item.confidence_score || 0);
  if (sourceConfidence < Number(watchlist.min_confidence || 0)) return null;

  const hits = terms.filter((term) => haystack.includes(term));
  const ruleType = watchlist.rule_type || "all_terms";
  const matched =
    ruleType === "any_term" ? hits.length > 0 :
    ruleType === "source" ? haystack.includes(String(item.source || "").toLowerCase()) && hits.length > 0 :
    hits.length === terms.length;
  if (!matched) return null;

  const score = Math.min(100, Math.round((hits.length / terms.length) * 60 + Math.min(sourceConfidence, 100) * 0.4));
  return { terms, hits, score };
}

/**
 * Extract entities for one source item, match it against watchlists, and
 * upsert alerts. Pass `watchlists` to reuse a preloaded set (batch ingest);
 * otherwise they are loaded for `organizationId` (null = all orgs).
 */
async function runWatchlistMatch(
  item: any,
  { organizationId = null, watchlists = null }: { organizationId?: number | null; watchlists?: any[] | null } = {},
) {
  const text = sourceText(item) || item.title || "";
  const extracted = extractEntitiesFromText(`${item.title || ""}\n${text}`);
  const entities = await db.upsertOsintEntities(item.id, extracted);
  const candidates = watchlists ?? (await db.listWatchlists({ organizationId }));
  const haystack = itemSearchText(item, entities.length ? entities : extracted);
  const alerts = [];

  for (const watchlist of candidates.filter((w: any) => w.enabled)) {
    const match = watchlistMatches(watchlist, haystack, item);
    if (!match) continue;
    const alert = await db.upsertOsintAlert({
      watchlist_id: watchlist.id,
      source_item_id: item.id,
      title: item.title,
      reason: `Matched ${watchlist.rule_type || "all_terms"}: ${match.hits.join(", ")}`,
      score: match.score,
    });
    if (alert?.created) {
      bus.emit("osint:alert", {
        ...alert,
        organization_id: watchlist.organization_id ?? null,
        watchlist_name: watchlist.name,
        watchlist_severity: watchlist.severity,
        source: item.source,
        source_type: item.source_type,
        source_url: item.source_url,
        published_at: item.published_at,
      });
    }
    alerts.push(alert);
  }

  return { entities: entities.length ? entities : extracted, alerts };
}

/**
 * Persist scraped source items, then run watchlist matching on the ones that
 * were newly inserted (skipping re-upserts of items we already matched).
 * Drop-in replacement for db.upsertSourceItems — returns the same rows.
 */
async function ingestAndMatch(items: any[]) {
  const rows = await db.upsertSourceItems(items);
  const fresh = rows.filter((row: any) => row && row._inserted !== false);
  if (!fresh.length) return rows;

  let active: any[] = [];
  try {
    const watchlists = await db.listWatchlists({ organizationId: null });
    active = watchlists.filter((w: any) => w.enabled);
  } catch (error) {
    console.error("[OSINT] watchlist load failed during ingest:", error instanceof Error ? error.message : error);
    return rows;
  }
  if (!active.length) return rows;

  for (const row of fresh) {
    try {
      await runWatchlistMatch(row, { watchlists: active });
    } catch (error) {
      console.error("[OSINT] watchlist match failed:", error instanceof Error ? error.message : error);
    }
  }
  return rows;
}

export { sourceText, itemSearchText, watchlistTerms, watchlistMatches, runWatchlistMatch, ingestAndMatch };
