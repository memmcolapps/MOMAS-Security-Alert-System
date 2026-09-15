import { describe, expect, test } from "bun:test";
import { assessIncidentCandidate, locationAgreement } from "./confidence";

const now = new Date("2026-09-15T12:00:00Z");
const candidate = {
  title: "Gunmen attack village in Kaduna",
  description: "Gunmen attacked residents in Kajuru, Kaduna State.",
  source_type: "rss",
  source: "Daily Report",
  source_url: "https://daily.example/security/attack",
  date: "2026-09-15",
  published_at: "2026-09-15T10:00:00Z",
  state: "Kaduna",
  claimed_location: "Kajuru, Kaduna",
  lat: 10.348,
  lon: 7.688,
  type: "armed_attack",
  verification_status: "confirmed",
};

const corroborator = {
  ...candidate,
  source: "Independent Wire",
  source_url: "https://wire.example/kaduna/attack",
};

describe("OSINT evidence confidence", () => {
  test("holds a strong but single-source report below the approval threshold", () => {
    const result = assessIncidentCandidate(candidate, [], now);
    expect(result.score).toBeLessThan(70);
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.breakdown.hard_caps).toContain("independent corroboration required");
  });

  test("auto-qualifies a fresh, located, verified report with independent corroboration", () => {
    const result = assessIncidentCandidate(candidate, [corroborator], now);
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.requiresHumanApproval).toBe(false);
    expect(result.breakdown.independent_sources).toBe(2);
  });

  test("does not count syndicated copies from the same domain as independent sources", () => {
    const syndicated = {
      ...corroborator,
      source: "A different byline",
      source_url: "https://daily.example/copied/attack",
    };
    const result = assessIncidentCandidate(candidate, [syndicated], now);
    expect(result.breakdown.independent_sources).toBe(1);
    expect(result.requiresHumanApproval).toBe(true);
  });

  test("does not count copied wire text on a different domain as corroboration", () => {
    const description = "Gunmen entered Kajuru village shortly after midnight and opened fire on residents near the market before fleeing toward the forest. Police officers arrived later and confirmed that two residents were killed while three other people received treatment at the district hospital.";
    const original = { ...candidate, description };
    const copied = { ...corroborator, description, source_url: "https://another.example/copied-report" };
    const result = assessIncidentCandidate(original, [copied], now);
    expect(result.breakdown.independent_sources).toBe(1);
    expect(result.requiresHumanApproval).toBe(true);
  });

  test("caps stale reports even when independently corroborated", () => {
    const stale = { ...candidate, date: "2026-09-01", published_at: "2026-09-15T10:00:00Z" };
    const result = assessIncidentCandidate(stale, [{ ...corroborator, date: stale.date }], now);
    expect(result.score).toBeLessThan(70);
    expect(result.breakdown.hard_caps).toContain("event is not confirmed within 72 hours");
  });

  test("caps a report when second-model verification was unavailable", () => {
    const result = assessIncidentCandidate(
      { ...candidate, verification_status: "unavailable" },
      [corroborator],
      now,
    );
    expect(result.score).toBeLessThan(70);
    expect(result.breakdown.hard_caps).toContain("second classifier unavailable or not confirmed");
  });

  test("does not treat a state centroid as a verified incident place", () => {
    const result = assessIncidentCandidate(
      { ...candidate, claimed_location: "Kaduna State" },
      [corroborator],
      now,
    );
    expect(result.score).toBeLessThan(70);
    expect(result.breakdown.hard_caps).toContain("exact location unresolved");
  });

  test("caps a report when its event date was copied from publication time", () => {
    const result = assessIncidentCandidate(
      { ...candidate, event_date_confirmed: false },
      [corroborator],
      now,
    );
    expect(result.score).toBeLessThan(70);
    expect(result.breakdown.hard_caps).toContain("event date missing or inferred from publication time");
  });

  test("does not corroborate reports that name materially different places", () => {
    expect(locationAgreement(candidate, { ...corroborator, lat: 11.833, lon: 13.15 })).toBe(false);
    expect(locationAgreement(candidate, corroborator)).toBe(true);
  });
});
