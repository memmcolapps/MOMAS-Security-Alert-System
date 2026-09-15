import { classifyMany } from "../src/classifier";
import { looksLikeSecurityIncident } from "../src/classifier/prefilter";
import * as db from "../src/db";
import { persistIncident } from "../src/scrapers/ingest";

function option(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const apply = process.argv.includes("--apply");
const since = option("--since", "2026-08-16");
const limit = Math.max(1, Math.min(100, Number(option("--limit", "50")) || 50));

if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  throw new Error("--since must use YYYY-MM-DD");
}

const { rows } = await db.pool.query(
  `SELECT external_id, source_type, source, title, description, content_text,
          source_url, published_at, created_at
     FROM source_items
    WHERE created_at >= $1::date
      AND (
        (status = 'non_incident' AND classification_attempted_at IS NULL)
        OR status = 'classification_failed'
      )
    ORDER BY created_at DESC
    LIMIT 10000`,
  [since],
);

const candidates = rows
  .filter((item) => looksLikeSecurityIncident(item.title, item.content_text || item.description))
  .slice(0, limit);

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  since,
  scanned: rows.length,
  candidates: candidates.length,
  limit,
}, null, 2));

if (!apply) {
  console.log("Dry run only. Add --apply to classify this batch.");
  await db.pool.end();
  process.exit(0);
}

const results = await classifyMany(candidates.map((item) => ({
  title: item.title,
  description: item.content_text || item.description,
  publishedAt: item.published_at,
})));

const summary = { incidents: 0, merged: 0, rejected: 0, failed: 0 };

for (let index = 0; index < candidates.length; index++) {
  const item = candidates[index];
  const result = results[index];

  if (!result) {
    summary.failed++;
    await db.markSourceItemClassificationFailed(
      item.external_id,
      "Backfill classifier returned no result",
      item.content_text,
    );
    continue;
  }

  if (!result.is_security_incident) {
    summary.rejected++;
    await db.markSourceItemProcessed(item.external_id, {
      status: "non_incident",
      content_text: item.content_text,
    });
    continue;
  }

  const publishedDate = new Date(item.published_at || item.created_at || Date.now())
    .toISOString()
    .slice(0, 10);
  const persisted = await persistIncident({
    result,
    title: item.title || "OSINT report",
    description: result.summary || item.content_text || item.description || item.title,
    date: result.date || publishedDate,
    external_id: item.external_id,
    source: item.source,
    source_url: item.source_url,
    source_type: item.source_type,
  });

  if (!persisted.incidentId) {
    summary.failed++;
    await db.markSourceItemClassificationFailed(
      item.external_id,
      `Backfill persistence returned ${persisted.status}`,
      item.content_text,
    );
    continue;
  }

  const status = persisted.status === "merged" ? "merged" : "incident";
  if (status === "merged") summary.merged++;
  else summary.incidents++;
  await db.markSourceItemProcessed(item.external_id, {
    status,
    incident_id: persisted.incidentId,
    content_text: item.content_text,
  });
}

console.log(JSON.stringify(summary, null, 2));
await db.pool.end();
