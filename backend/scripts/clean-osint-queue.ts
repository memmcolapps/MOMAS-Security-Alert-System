import * as db from "../src/db";
import { looksLikeSecurityIncident } from "../src/classifier/prefilter";

const apply = process.argv.includes("--apply");
const ageIndex = process.argv.indexOf("--older-than-days");
const olderThanDays = Math.max(
  1,
  Math.min(365, Number(ageIndex >= 0 ? process.argv[ageIndex + 1] : "7") || 7),
);

const { rows } = await db.pool.query(
  `SELECT id, title, description, content_text, source, source_type, created_at
     FROM source_items
    WHERE status = 'pending'
      AND classification_attempted_at IS NULL
      AND created_at < NOW() - ($1::text || ' days')::interval
    ORDER BY created_at DESC`,
  [olderThanDays],
);

const securityLike = rows.filter((item) =>
  looksLikeSecurityIncident(item.title, item.content_text || item.description),
);
const obviousNoise = rows.filter((item) => !securityLike.includes(item));

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  older_than_days: olderThanDays,
  stale_pending: rows.length,
  obvious_noise: obviousNoise.length,
  security_like_but_expired: securityLike.length,
  sample_noise: obviousNoise.slice(0, 8).map((item) => item.title),
  sample_security_like: securityLike.slice(0, 8).map((item) => item.title),
}, null, 2));

if (!apply || !rows.length) {
  console.log(apply ? "Nothing to archive." : "Dry run only. Add --apply to archive these rows.");
  await db.pool.end();
  process.exit(0);
}

const ids = rows.map((item) => item.id);
const result = await db.pool.query(
  `UPDATE source_items
      SET status = 'expired',
          processed_at = NOW(),
          confidence_score = 0,
          confidence_reason = 'Expired before classification; retained as raw evidence',
          updated_at = NOW()
    WHERE id = ANY($1::int[])
      AND status = 'pending'
      AND classification_attempted_at IS NULL
    RETURNING id`,
  [ids],
);

console.log(JSON.stringify({ archived: result.rowCount }, null, 2));
await db.pool.end();
