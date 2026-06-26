const SOURCE_TYPE_WEIGHT: Record<string, number> = {
  hapi: 26,
  reliefweb: 24,
  gdelt: 20,
  guardian: 18,
  newsapi: 16,
  telegram: 12,
  rss: 12,
};

const HIGH_RELIABILITY_SOURCES = [
  "HAPI",
  "ReliefWeb",
  "Guardian",
  "GDELT",
  "ACLED",
  "IOM",
];

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function daysOld(value: any) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (Date.now() - ms) / 86400000);
}

function sourceWeight(item: any) {
  const sourceType = String(item?.source_type || "").toLowerCase();
  const source = String(item?.source || "");
  const base = SOURCE_TYPE_WEIGHT[sourceType] ?? 10;
  const reliable = HIGH_RELIABILITY_SOURCES.some((name) =>
    source.toLowerCase().includes(name.toLowerCase()),
  );
  return reliable ? Math.max(base, 22) : base;
}

function scoreEvidenceItem(item: any) {
  const reasons = [];
  let score = sourceWeight(item);

  if (item?.source_url) {
    score += 10;
    reasons.push("has source URL");
  }
  if (String(item?.content_text || "").length >= 600) {
    score += 14;
    reasons.push("full text captured");
  } else if (String(item?.description || "").length >= 180) {
    score += 8;
    reasons.push("usable description captured");
  }
  if (item?.incident_id) {
    score += 8;
    reasons.push("linked to incident");
  }
  if (["incident", "merged", "linked"].includes(item?.status)) {
    score += 8;
    reasons.push(`analyst/system status: ${item.status}`);
  }
  if (item?.reviewed_at) {
    score += 8;
    reasons.push("analyst reviewed");
  }

  const age = daysOld(item?.published_at || item?.created_at);
  if (age !== null && age <= 2) {
    score += 10;
    reasons.push("fresh report");
  } else if (age !== null && age <= 14) {
    score += 5;
    reasons.push("recent report");
  }

  const finalScore = clamp(score);
  return {
    score: finalScore,
    reason: reasons.length ? reasons.join("; ") : "limited source context",
  };
}

function independentSourceCount(evidence: any[]) {
  const keys = new Set(
    evidence.map((item) =>
      [item.source_type || "unknown", item.source || "unknown"].join(":").toLowerCase(),
    ),
  );
  return keys.size;
}

function scoreIncident(incident: any, evidence: any[] = []) {
  const reasons = [];
  const evidenceScores = evidence.map((item) =>
    Number(item.confidence_score) > 0
      ? Number(item.confidence_score)
      : scoreEvidenceItem(item).score,
  );

  let score = 25;
  const independent = independentSourceCount(evidence);

  if (evidence.length) {
    score += Math.min(evidence.length * 8, 24);
    reasons.push(`${evidence.length} evidence item${evidence.length === 1 ? "" : "s"}`);
  }
  if (independent > 1) {
    score += Math.min((independent - 1) * 10, 24);
    reasons.push(`${independent} independent sources`);
  }
  if (evidenceScores.length) {
    const avg = evidenceScores.reduce((sum, value) => sum + value, 0) / evidenceScores.length;
    score += avg * 0.25;
    reasons.push(`average evidence score ${Math.round(avg)}`);
  }
  if (incident?.lat != null && incident?.lon != null) {
    score += 12;
    reasons.push("mapped coordinates");
  } else if (incident?.state || incident?.location) {
    score += 6;
    reasons.push("location identified");
  }
  if (Number(incident?.report_count || 0) > 1) {
    score += Math.min(Number(incident.report_count) * 3, 12);
    reasons.push(`${incident.report_count} reports clustered`);
  }
  if (Number(incident?.verified) > 0) {
    score += 10;
    reasons.push("verified flag set");
  }

  const finalScore = clamp(score);
  return {
    score: finalScore,
    reason: reasons.length ? reasons.join("; ") : "single uncorroborated report",
  };
}

export { scoreEvidenceItem, scoreIncident };
