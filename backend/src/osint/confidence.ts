const AUTO_APPROVAL_THRESHOLD = 70;

const DEFAULT_SOURCE_RELIABILITY: Record<string, number> = {
  hapi: 95,
  reliefweb: 90,
  guardian: 82,
  gdelt: 65,
  newsapi: 58,
  rss: 55,
  telegram: 35,
};

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function asDate(value: any) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function sourceFamily(item: any) {
  try {
    const host = new URL(item?.source_url || "").hostname
      .toLowerCase()
      .replace(/^www\./, "");
    if (host && !["newsapi.org", "gdeltproject.org", "reliefweb.int"].includes(host)) {
      return host;
    }
  } catch {}
  return String(item?.source || item?.source_type || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim() || "unknown";
}

function sourceReliability(item: any) {
  const configured = Number(item?.source_reliability);
  if (Number.isFinite(configured) && configured >= 0) return clamp(configured);
  return DEFAULT_SOURCE_RELIABILITY[String(item?.source_type || "").toLowerCase()] ?? 45;
}

function contentTokens(item: any) {
  return new Set(
    `${item?.title || ""} ${item?.description || item?.content_text || ""}`
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );
}

function looksSyndicated(a: any, b: any) {
  const left = contentTokens(a);
  const right = contentTokens(b);
  if (left.size < 20 || right.size < 20) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  const union = new Set([...left, ...right]).size;
  return union > 0 && shared / union >= 0.82;
}

function locationAgreement(a: any, b: any) {
  const lat1 = Number(a?.lat ?? a?.event_lat);
  const lon1 = Number(a?.lon ?? a?.event_lon);
  const lat2 = Number(b?.lat ?? b?.event_lat);
  const lon2 = Number(b?.lon ?? b?.event_lon);
  if ([lat1, lon1, lat2, lon2].every(Number.isFinite)) {
    const radians = (value: number) => value * Math.PI / 180;
    const dLat = radians(lat2 - lat1);
    const dLon = radians(lon2 - lon1);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) <= 50;
  }
  const normalize = (value: any) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const left = normalize(a?.claimed_location || a?.event_location || a?.location);
  const right = normalize(b?.claimed_location || b?.event_location || b?.location);
  return Boolean(left && right && (left.includes(right) || right.includes(left)));
}

function freshnessScore(eventDate: any, publishedAt: any, now = new Date()) {
  const event = asDate(eventDate);
  const published = asDate(publishedAt);
  if (!event) return { score: 0, reason: "event date missing", isFresh: false };
  const ageDays = (now.getTime() - event.getTime()) / 86400000;
  const publicationLag = published ? (published.getTime() - event.getTime()) / 86400000 : ageDays;
  if (ageDays < -1 || publicationLag < -1) {
    return { score: 0, reason: "event date is inconsistent", isFresh: false };
  }
  if (ageDays <= 1 && publicationLag <= 1) {
    return { score: 15, reason: "event occurred within 24 hours", isFresh: true };
  }
  if (ageDays <= 3 && publicationLag <= 3) {
    return { score: 12, reason: "event occurred within 72 hours", isFresh: true };
  }
  if (ageDays <= 7 && publicationLag <= 7) {
    return { score: 5, reason: "event is up to seven days old", isFresh: false };
  }
  return { score: 0, reason: "event is stale", isFresh: false };
}

function assessIncidentCandidate(candidate: any, corroborators: any[] = [], now = new Date()) {
  const verification = String(candidate?.verification_status || "unavailable");
  const relevanceScore = verification === "confirmed" || verification === "structured" ? 25 : 16;
  const relevanceReason = verification === "confirmed"
    ? "two-model security classification confirmed"
    : verification === "structured"
      ? "structured security dataset"
      : "security classification not independently verified";
  const reliability = sourceReliability(candidate);
  const reliabilityScore = Math.round(reliability * 0.2);
  const claimedLocation = String(candidate?.claimed_location || candidate?.event_location || candidate?.location || "")
    .toLowerCase()
    .replace(/\bstate\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const stateName = String(candidate?.state || candidate?.event_state || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const placeIsSpecific = Boolean(claimedLocation && claimedLocation !== stateName && claimedLocation !== "nigeria");
  const locationScore = candidate?.lat != null && candidate?.lon != null && placeIsSpecific ? 15 : stateName ? 8 : 0;
  const locationReason = locationScore === 15
    ? "claimed place resolved to coordinates"
    : locationScore === 8
      ? "state identified but exact place unresolved"
      : "claimed place unresolved";
  const freshness = freshnessScore(
    candidate?.date || candidate?.event_date,
    candidate?.published_at || candidate?.created_at,
    now,
  );
  const independentReports: any[] = [];
  for (const report of [candidate, ...corroborators]) {
    if (independentReports.some((existing) => sourceFamily(existing) === sourceFamily(report) || looksSyndicated(existing, report))) continue;
    independentReports.push(report);
  }
  const families = new Set(independentReports.map(sourceFamily));
  const independentSources = independentReports.length;
  const corroborationScore = independentSources >= 3 ? 25 : independentSources === 2 ? 18 : 0;
  const corroborationReason = independentSources > 1
    ? `${independentSources} independent source families corroborate the event`
    : "single-source report";
  const components = {
    security_relevance: { score: relevanceScore, max: 25, reason: relevanceReason },
    corroboration: { score: corroborationScore, max: 25, reason: corroborationReason },
    source_reliability: { score: reliabilityScore, max: 20, reason: `source reliability ${reliability}%` },
    location: { score: locationScore, max: 15, reason: locationReason },
    freshness: { score: freshness.score, max: 15, reason: freshness.reason },
  };
  const rawScore = Object.values(components).reduce((sum, part) => sum + part.score, 0);
  const hardCaps: string[] = [];
  if ((!candidate?.date && !candidate?.event_date) || candidate?.event_date_confirmed === false) {
    hardCaps.push("event date missing or inferred from publication time");
  }
  if (locationScore < 15) hardCaps.push("exact location unresolved");
  if (!freshness.isFresh) hardCaps.push("event is not confirmed within 72 hours");
  if (verification !== "confirmed" && verification !== "structured") {
    hardCaps.push("second classifier unavailable or not confirmed");
  }
  if (independentSources < 2) hardCaps.push("independent corroboration required");
  const score = clamp(hardCaps.length ? Math.min(rawScore, 69) : rawScore);
  const requiresHumanApproval = score < AUTO_APPROVAL_THRESHOLD;
  return {
    score,
    reason: requiresHumanApproval
      ? `${score}% — ${hardCaps[0] || "insufficient evidence"}; human approval required`
      : `${score}% — recent, located, independently corroborated security event`,
    breakdown: {
      ...components,
      raw_score: rawScore,
      final_score: score,
      threshold: AUTO_APPROVAL_THRESHOLD,
      independent_sources: independentSources,
      source_families: Array.from(families),
      hard_caps: hardCaps,
      requires_human_approval: requiresHumanApproval,
    },
    requiresHumanApproval,
    sourceFamily: sourceFamily(candidate),
  };
}

function scoreEvidenceItem(item: any) {
  if (item?.confidence_breakdown?.final_score != null) {
    return {
      score: clamp(Number(item.confidence_breakdown.final_score)),
      reason: item.confidence_reason || "Evidence assessment available",
      breakdown: item.confidence_breakdown,
    };
  }
  return assessIncidentCandidate({
    ...item,
    date: item?.event_date,
    state: item?.event_state,
    lat: item?.event_lat,
    lon: item?.event_lon,
    verification_status: item?.verification_status,
  });
}

function scoreIncident(incident: any, evidence: any[] = []) {
  const assessed = evidence
    .filter((item) => Number(item?.confidence_score) >= 0)
    .sort((a, b) => Number(b.confidence_score || 0) - Number(a.confidence_score || 0));
  const best = assessed[0];
  const score = clamp(Number(best?.confidence_score || incident?.confidence_score || 0));
  return {
    score,
    reason: best?.confidence_reason || incident?.confidence_reason || "No assessed evidence",
    breakdown: best?.confidence_breakdown || incident?.confidence_breakdown || {},
  };
}

export {
  AUTO_APPROVAL_THRESHOLD,
  assessIncidentCandidate,
  scoreEvidenceItem,
  scoreIncident,
  sourceFamily,
  sourceReliability,
  locationAgreement,
};
