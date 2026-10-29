// Re-scores reports waiting in the review queue with the corroboration matcher
// (src/osint/corroboration.ts), as the pipeline would have scored them had it
// matched other outlets' reports at the time.
//
// Only reports that another outlet appears to corroborate are re-run - the
// rest would score exactly as before - and they go through the normal ingest
// path oldest first, each judged as of when it arrived. A report that now
// clears the bar publishes; one matching a published incident is attached to
// it; the rest stay in the queue with their new score.
//
//   bun --env-file=/etc/momas/momas.env scripts/rescore-osint-backlog.ts            # list what would be re-run
//   bun --env-file=/etc/momas/momas.env scripts/rescore-osint-backlog.ts --apply    # re-run them
import { classifyMany } from "../src/classifier";
import { sourceFamily } from "../src/osint/confidence";
import { describeSameEvent } from "../src/osint/corroboration";
import * as db from "../src/db";
import { persistIncident } from "../src/scrapers/ingest";

function option(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const apply = process.argv.includes("--apply");
const since = option("--since", "2026-09-01");
if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("--since must use YYYY-MM-DD");

const asCandidate = (item: any) => ({
  ...item,
  date: item.event_date?.toISOString?.().slice(0, 10) || item.event_date,
  state: item.event_state,
  lat: item.event_lat,
  lon: item.event_lon,
  claimed_location: item.event_location,
  type: item.event_type,
});

const { rows } = await db.pool.query(
  `SELECT * FROM source_items
    WHERE created_at >= $1::date
      AND status IN ('needs_review', 'incident', 'linked', 'merged')
    ORDER BY created_at ASC`,
  [since],
);
const waiting = rows.filter((item: any) => item.status === "needs_review");

// A waiting report is worth re-running when another outlet's report - waiting
// or already published - describes the same event.
const rerun = waiting.filter((item: any) =>
  rows.some(
    (other: any) =>
      other.id !== item.id &&
      sourceFamily(other) !== sourceFamily(item) &&
      describeSameEvent(asCandidate(item), asCandidate(other)),
  ),
);

console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", since, waiting: waiting.length, rerun: rerun.length }, null, 2));
for (const item of rerun) {
  console.log(`  ${item.id}  ${String(item.event_state || "?").padEnd(10)} ${item.confidence_score}%  ${String(item.title).slice(0, 80)}`);
}

if (!apply) {
  console.log("Dry run only. Add --apply to re-run these through the pipeline.");
  await db.pool.end();
  process.exit(0);
}

const results = await classifyMany(rerun.map((item: any) => ({
  title: item.title,
  description: item.content_text || item.description,
  publishedAt: item.published_at,
})));

const summary = { published: 0, attached: 0, still_waiting: 0, not_an_incident: 0, failed: 0 };
for (let index = 0; index < rerun.length; index++) {
  const item = rerun[index];
  const result = results[index];
  if (!result) {
    summary.failed++;
    continue;
  }
  if (!result.is_security_incident) {
    // The classifier has changed its mind; leave the analyst's queue as it was.
    summary.not_an_incident++;
    continue;
  }
  const publishedDate = new Date(item.published_at || item.created_at).toISOString().slice(0, 10);
  const persisted = await persistIncident({
    result,
    title: item.title || "OSINT report",
    description: result.summary || item.content_text || item.description || item.title,
    date: result.date || publishedDate,
    external_id: item.external_id,
    source: item.source,
    source_url: item.source_url,
    source_type: item.source_type,
    published_at: item.published_at || item.created_at,
    assessed_at: item.created_at,
  });
  if (persisted.status === "inserted") summary.published++;
  else if (persisted.status === "merged") {
    summary.attached++;
    // A duplicate merged into an existing incident leaves its report untouched.
    await db.markSourceItemProcessed(item.external_id, { status: "merged", incident_id: persisted.incidentId });
  } else summary.still_waiting++;
}

// Reports published along the way may also have pulled earlier ones in.
const { rows: after } = await db.pool.query(
  `SELECT status, count(*)::int AS n FROM source_items WHERE id = ANY($1::int[]) GROUP BY 1`,
  [rerun.map((item: any) => item.id)],
);
console.log(JSON.stringify({ summary, statusesNow: after }, null, 2));
await db.pool.end();
