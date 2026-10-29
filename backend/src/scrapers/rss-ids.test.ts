import { describe, expect, test } from "bun:test";
import { buildId, isRecent } from "./rss";

describe("RSS article ids", () => {
  test("articles sharing a long link prefix get different ids", () => {
    // The old ids kept ~30 characters of the link, so every one of these
    // collapsed into a single id and all but the first were skipped.
    const links = [
      "https://www.premiumtimesng.com/news/headlines/700001-gunmen-kill-five-in-plateau.html",
      "https://www.premiumtimesng.com/news/headlines/700002-troops-rescue-hostages-in-zamfara.html",
      "https://www.channelstv.com/2026/10/29/bandits-attack-katsina-village/",
      "https://www.channelstv.com/2026/10/29/police-confirm-cleric-killing/",
    ];
    const ids = links.map((link) => buildId("Feed", { link }));
    expect(new Set(ids).size).toBe(links.length);
  });

  test("a Google News article has one id whichever search feed carries it", () => {
    const link = "https://news.google.com/rss/articles/CBMilAFBVV95cUxPMlBwMDBVLURBMDF2R1lOckM0RDBmTGEyWjBkeE16";
    expect(buildId("Google News — Borno", { link })).toBe(buildId("Google News — NG Security", { link }));
    expect(buildId("Google News — Borno", { link })).not.toBe(
      buildId("Google News — Borno", { link: `${link}X` }),
    );
  });

  test("ids are stable for the same article", () => {
    const item = { link: "https://punchng.com/katsina-cleric-killing/" };
    expect(buildId("Punch", item)).toBe(buildId("Punch", item));
  });
});

describe("article age", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  test("articles from the last three days are kept, older ones dropped", () => {
    expect(isRecent("2026-10-28T08:00:00Z", now)).toBe(true);
    expect(isRecent("2026-10-20T08:00:00Z", now)).toBe(false);
    expect(isRecent("2025-11-23T08:00:00Z", now)).toBe(false);
  });
  test("an article with no date is kept rather than lost", () => {
    expect(isRecent(null, now)).toBe(true);
  });
});
