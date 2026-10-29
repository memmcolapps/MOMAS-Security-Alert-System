/**
 * The review queue as events rather than reports.
 *
 * Several outlets report one attack, and the queue used to list each report
 * on its own - a reviewer read the same story three times and approved it
 * once, by hand, three times. Here reports of the same event (by the
 * corroboration matcher) are one card: the strongest report leads, the rest
 * are its supporting evidence, and one decision covers them all.
 */
import { sourceFamily } from "./confidence";
import { describeSameEvent } from "./corroboration";

// What each scoring cap means, said the way a reviewer would act on it.
const BLOCKERS: Record<string, string> = {
  "independent corroboration required": "Only one outlet has reported it",
  "event is not confirmed within 72 hours": "More than 3 days old",
  "exact location unresolved": "Exact place not found",
  "event date missing or inferred from publication time": "Date guessed from publication",
  "second classifier unavailable or not confirmed": "Second classifier did not confirm",
};

export function plainBlockers(caps: string[] = []) {
  return caps.map((cap) => BLOCKERS[cap] || cap);
}

const DAY = 86_400_000;

function asCandidate(item: any) {
  const date = item.event_date instanceof Date ? item.event_date.toISOString().slice(0, 10) : item.event_date;
  return {
    ...item,
    date,
    state: item.event_state,
    lat: item.event_lat,
    lon: item.event_lon,
    claimed_location: item.event_location,
    type: item.event_type,
  };
}

export type ReviewEvent = {
  id: number;
  title: string;
  type: string | null;
  state: string | null;
  location: string | null;
  date: string | null;
  score: number;
  outlets: number;
  stale: boolean;
  lastSeen: string;
  blockers: string[];
  reports: Array<{
    id: number;
    title: string;
    source: string;
    family: string;
    score: number;
    url: string | null;
    created_at: string;
  }>;
};

/**
 * Groups waiting reports into events: any two that describe the same event
 * are joined, and so are their other matches, so a chain of outlets ends up
 * as one card.
 */
export function groupIntoEvents(items: any[], now = Date.now()): ReviewEvent[] {
  const candidates = items.map(asCandidate);
  const parent = candidates.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  for (let a = 0; a < candidates.length; a += 1) {
    for (let b = a + 1; b < candidates.length; b += 1) {
      if (find(a) === find(b)) continue;
      if (describeSameEvent(candidates[a], candidates[b])) parent[find(b)] = find(a);
    }
  }

  const groups = new Map<number, any[]>();
  candidates.forEach((candidate, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(candidate);
  });

  const events = [...groups.values()].map((reports) => {
    reports.sort(
      (a, b) =>
        Number(b.confidence_score || 0) - Number(a.confidence_score || 0) ||
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    const lead = reports[0];
    const eventTime = new Date(lead.date || lead.created_at).getTime();
    const lastSeen = Math.max(...reports.map((report) => new Date(report.created_at).getTime()));
    const outlets = new Set(reports.map(sourceFamily)).size;
    // The lead's score was worked out before the other outlets' reports were
    // grouped with it; the card should not contradict its own outlet count.
    const caps = (lead.confidence_breakdown?.hard_caps || []).filter(
      (cap: string) => outlets < 2 || cap !== "independent corroboration required",
    );
    return {
      id: Number(lead.id),
      title: String(lead.title || "Untitled report"),
      type: lead.type || null,
      state: lead.state || null,
      location: lead.claimed_location || null,
      date: lead.date || null,
      score: Number(lead.confidence_score || 0),
      outlets,
      stale: Number.isFinite(eventTime) && now - eventTime > 3 * DAY,
      lastSeen: new Date(lastSeen).toISOString(),
      blockers: plainBlockers(caps),
      reports: reports.map((report) => ({
        id: Number(report.id),
        title: String(report.title || "Untitled report"),
        source: String(report.source || report.source_type || "Unknown"),
        family: sourceFamily(report),
        score: Number(report.confidence_score || 0),
        url: report.source_url || null,
        created_at: new Date(report.created_at).toISOString(),
      })),
    };
  });

  // Recent events first - a three-day-old attack is history, not a decision
  // that can still change a response - then the strongest evidence.
  return events.sort(
    (a, b) =>
      Number(a.stale) - Number(b.stale) ||
      b.outlets - a.outlets ||
      b.score - a.score ||
      new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime(),
  );
}
