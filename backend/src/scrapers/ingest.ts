// Shared incident persistence: fingerprint-merge into an existing incident
// when one matches, otherwise insert a new row. Extracted so new sources
// (e.g. the MTProto Telegram listener) don't re-implement the dedup dance
// that rss.ts and telegram.ts carry inline.

import {
  buildFingerprint,
  fingerprintsMatch,
} from "../classifier/fingerprint";
import { extractState, geocode, locateReport } from "../geocoder";
import * as db from "../db";

/**
 * Persist one classified incident.
 * `result` is a positive classifier output (is_security_incident === true).
 * Returns { status: "merged" | "inserted" | "skipped", incidentId }.
 */
async function persistIncident({
  result,
  title,
  description,
  date,
  external_id,
  source,
  source_url,
  source_type,
  published_at = null,
  approval_status = null,
  approved_by = null,
  // Backfills only: judge the report as of this moment instead of now.
  assessed_at = null,
}) {
  const { type, fatalities, victims, severity } = result;
  const fullText = `${title} ${description}`;

  // Prefer the classifier's extracted location; body text can contain
  // off-article place names that hijack first-match geocoding.
  const locText = result.location_text || "";
  const { geo, state } = locateReport({ locationText: locText, fullText, title });

  const fp = buildFingerprint({ date, state, type, title, description });
  const matches = await db.findMatchingIncidents({ date, state, type });

  for (const existing of matches) {
    const existingFp = buildFingerprint({
      date: existing.date.toISOString().slice(0, 10),
      state: existing.state,
      type: existing.type,
      title: existing.title,
      description: existing.description,
    });
    if (fingerprintsMatch(fp, existingFp)) {
      const merged = await db.mergeIntoIncident(existing.id, {
        source,
        source_url,
        fatalities,
        victims,
        verification_status: approval_status === "human_approved" ? "human_approved" : result.verification_status,
      });
      if (merged) return { status: "merged", incidentId: existing.id };
      break;
    }
  }

  const inserted = await db.insertIncident({
    external_id,
    title: title.slice(0, 500),
    description: description.slice(0, 2000),
    date,
    location: geo
      ? geo.matched.charAt(0).toUpperCase() + geo.matched.slice(1)
      : state || "Nigeria",
    state,
    lat: geo?.lat ?? null,
    lon: geo?.lon ?? null,
    type,
    severity,
    fatalities,
    victims,
    source,
    source_url,
    source_type,
    verified: 0,
    claimed_location: result.location_text || null,
    event_date_confirmed: Boolean(result.date),
    verification_status: result.verification_status || "unavailable",
    published_at: published_at || date,
    source_item_external_id: external_id.replace(/^osint:/, ""),
    approval_status,
    approved_by,
    assessed_at,
  });

  if (!inserted) {
    return { status: "needs_review", incidentId: null };
  }
  // Another outlet's report of this event was already an incident; this one
  // was attached to it as more evidence.
  if (inserted.linked) return { status: "merged", incidentId: inserted.id };
  return inserted
    ? { status: "inserted", incidentId: inserted.id }
    : { status: "skipped", incidentId: null };
}

export { persistIncident };
