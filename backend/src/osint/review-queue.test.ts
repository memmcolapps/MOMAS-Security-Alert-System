import { describe, expect, test } from "bun:test";
import { groupIntoEvents, plainBlockers } from "./review-queue";

const NOW = Date.parse("2026-10-29T12:00:00Z");

const report = (id: number, extra: any) => ({
  id,
  event_type: "massacre",
  event_state: "Taraba",
  event_date: "2026-10-27",
  created_at: "2026-10-28T09:00:00Z",
  confidence_score: 60,
  confidence_breakdown: { hard_caps: ["independent corroboration required"] },
  ...extra,
});

const binnari = (id: number, url: string, score: number) =>
  report(id, {
    source_url: url,
    confidence_score: score,
    event_location: "Binnari community, Karim-Lamido LGA, Taraba State",
    title: "Bandits kill 48 in Binnari market day attack",
    description: "Bandits struck Binnari community on market day; Victor Mshelizah confirmed.",
  });

describe("review queue events", () => {
  test("reports of one event from several outlets become one card, led by the strongest", () => {
    const events = groupIntoEvents(
      [
        binnari(1, "https://t.me/peoplesgazette/1", 61),
        binnari(2, "https://dailytrust.com/x", 56),
        binnari(3, "https://t.me/peoplesgazette/2", 64),
        report(4, {
          event_state: "Katsina",
          event_location: "Katsina",
          source_url: "https://punchng.com/y",
          title: "Katsina cleric killing: wife recounts attack",
          description: "Islamic cleric Sheikh Masussuka was killed.",
        }),
      ],
      NOW,
    );
    expect(events.length).toBe(2);
    const taraba = events.find((event) => event.state === "Taraba")!;
    expect(taraba.reports.map((r) => r.id)).toEqual([3, 1, 2]);
    expect(taraba.id).toBe(3);
    expect(taraba.outlets).toBe(2);
    // Two outlets: the "only one outlet" blocker no longer applies.
    expect(taraba.blockers).toEqual([]);
  });

  test("events reported by more outlets come first, old events last", () => {
    const events = groupIntoEvents(
      [
        report(10, { event_state: "Kano", event_location: "Kano", event_date: "2026-10-10", title: "Old attack", source_url: "https://a.ng/1" }),
        binnari(1, "https://t.me/peoplesgazette/1", 50),
        binnari(2, "https://dailytrust.com/x", 50),
        report(11, { event_state: "Oyo", event_location: "Oyo", title: "Fresh single report", source_url: "https://b.ng/1", confidence_score: 66 }),
      ],
      NOW,
    );
    expect(events[0].state).toBe("Taraba");
    expect(events.at(-1)!.stale).toBe(true);
  });

  test("blockers are said the way a reviewer would act on them", () => {
    expect(plainBlockers(["independent corroboration required", "exact location unresolved"])).toEqual([
      "Only one outlet has reported it",
      "Exact place not found",
    ]);
  });
});
