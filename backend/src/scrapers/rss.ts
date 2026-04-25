import axios from "axios";
import Parser from "rss-parser";
import { classifyMany } from "../classifier";
import { geocode, extractState } from "../geocoder";
import {
  buildFingerprint,
  fingerprintsMatch,
} from "../classifier/fingerprint";
import * as db from "../db";

const parser = new Parser({
  customFields: { item: ["media:content", "content:encoded"] },
});

const FEEDS = [
  { name: "Sahara Reporters", url: "https://saharareporters.com/rss.xml" },
  { name: "Channels TV", url: "https://www.channelstv.com/feed/" },
  { name: "Punch", url: "https://punchng.com/feed/" },
  { name: "Vanguard", url: "https://www.vanguardngr.com/feed/" },
  { name: "Premium Times", url: "https://www.premiumtimesng.com/feed/" },
  { name: "TheCable", url: "https://www.thecable.ng/feed/" },
  { name: "Guardian Nigeria", url: "https://guardian.ng/feed/" },
  { name: "Daily Trust", url: "https://dailytrust.com/feed/" },
  {
    name: "Google News — NG Security",
    url: "https://news.google.com/rss/search?q=nigeria+attack+killed+bomb+kidnap&hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "Google News — Borno",
    url: "https://news.google.com/rss/search?q=borno+boko+haram+iswap+attack&hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "Google News — Bandits",
    url: "https://news.google.com/rss/search?q=nigeria+bandits+kidnap+zamfara+kaduna+katsina&hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "Google News — Breaking Security",
    url: "https://news.google.com/rss/search?q=nigeria+breaking+attack+killed+bomb+shooting&hl=en-NG&gl=NG&ceid=NG:en&tbs=qdr:d",
  },
  {
    name: "Google News — Middle Belt",
    url: "https://news.google.com/rss/search?q=benue+plateau+nasarawa+kogi+attack+killed+herdsmen+gunmen&hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "Google News — South-East Security",
    url: "https://news.google.com/rss/search?q=anambra+imo+enugu+ebonyi+abia+gunmen+attack+killed+IPOB&hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "Google News — Delta/Rivers",
    url: "https://news.google.com/rss/search?q=delta+rivers+bayelsa+cult+attack+killing+pipeline&hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "Google News — North-West Raids",
    url: "https://news.google.com/rss/search?q=zamfara+sokoto+kebbi+niger+raid+bandits+village+attack&hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "Google News — Kaduna Axis",
    url: "https://news.google.com/rss/search?q=kaduna+birnin+gwari+chikun+kajuru+attack+kidnap+gunmen&hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "Google News — Plateau/Benue Fresh Attacks",
    url: "https://news.google.com/rss/search?q=plateau+benue+fresh+attack+village+killed+gunmen&hl=en-NG&gl=NG&ceid=NG:en&tbs=qdr:d",
  },
  {
    name: "Google News — North-East Ambush",
    url: "https://news.google.com/rss/search?q=borno+yobe+adamawa+ambush+soldiers+terrorists+attack&hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "Google News — Kidnap Watch",
    url: "https://news.google.com/rss/search?q=nigeria+school+kidnap+abducted+hostages+released+ransom&hl=en-NG&gl=NG&ceid=NG:en&tbs=qdr:d",
  },
  {
    name: "Google News — Herder/Farmer Clashes",
    url: "https://news.google.com/rss/search?q=nigeria+herdsmen+farmers+clash+killed+village&hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "Google News — South-South Security",
    url: "https://news.google.com/rss/search?q=rivers+bayelsa+delta+akwa+ibom+pipeline+cult+attack+security&hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "Google News — South-West Security",
    url: "https://news.google.com/rss/search?q=lagos+ogun+oyo+ondo+osun+ekiti+kidnap+attack+gunmen&hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "Google News — FCT/Nasarawa/Niger",
    url: "https://news.google.com/rss/search?q=abuja+fct+nasarawa+niger+kidnap+attack+security&hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "Google News — Communal Violence",
    url: "https://news.google.com/rss/search?q=nigeria+communal+clash+violence+village+killed&hl=en-NG&gl=NG&ceid=NG:en",
  },
  {
    name: "Google News — Bomb/IED Watch",
    url: "https://news.google.com/rss/search?q=nigeria+ied+blast+explosion+bomb+market+attack&hl=en-NG&gl=NG&ceid=NG:en&tbs=qdr:d",
  },
];

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept:
    "application/rss+xml, application/xml, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5",
  "Accept-Language": "en-NG,en;q=0.9",
};

function stripHtml(str) {
  return (str || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(isoDate, pubDate) {
  const raw = isoDate || pubDate;
  if (!raw) return new Date().toISOString().slice(0, 10);
  try {
    return new Date(raw).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function buildId(source, item) {
  const base = item.link || item.guid || item.title || "";
  return `rss:${source}:${Buffer.from(base).toString("base64").slice(0, 40)}`;
}

function sanitizeXml(xml) {
  return xml.replace(/&(?!(?:[a-zA-Z]+|#\d+|#x[a-fA-F0-9]+);)/g, "&amp;");
}

function detectBlockedFeedPage(body) {
  const text = body.slice(0, 2000).toLowerCase();
  if (!text.startsWith("<html")) return null;
  if (text.includes("just a moment")) return "Blocked by anti-bot protection";
  if (
    text.includes("/aes.js") ||
    text.includes("document.cookie") ||
    text.includes("tztc=")
  )
    return "Blocked by JavaScript cookie challenge";
  return "Returned HTML instead of RSS XML";
}

async function fetchFeedXml(feed) {
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await axios.get(feed.url, {
        timeout: 20000,
        responseType: "text",
        maxRedirects: 5,
        headers: REQUEST_HEADERS,
      });

      if (typeof resp.data !== "string" || !resp.data.trim()) {
        throw new Error("Empty feed response");
      }

      const blockedReason = detectBlockedFeedPage(resp.data.trim());
      if (blockedReason) {
        throw new Error(blockedReason);
      }

      return resp.data;
    } catch (err) {
      lastError = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
    }
  }

  throw lastError;
}

async function scrapeFeed(feed) {
  let feedData;
  try {
    const xml = await fetchFeedXml(feed);
    try {
      feedData = await parser.parseString(xml);
    } catch (err) {
      if (!/Invalid character in entity name/i.test(err.message || ""))
        throw err;
      feedData = await parser.parseString(sanitizeXml(xml));
    }
  } catch (err) {
    console.warn(`[RSS] Failed to fetch ${feed.name}: ${err.message}`);
    return { found: 0, added: 0, skipped: 0, error: err.message };
  }

  const items = feedData.items || [];

  // Build external_ids first, then skip items already in the DB
  const classifyItems = items.map((item) => {
    const title = stripHtml(item.title || "");
    const rawContent =
      item["content:encoded"] || item.content || item.contentSnippet || "";
    const description = stripHtml(rawContent).slice(0, 1000);
    const external_id = buildId(feed.name, item);
    return { title, description, item, external_id };
  });

  const knownIds = await db.existingExternalIds(
    classifyItems.map((ci) => ci.external_id),
  );
  const newItems = classifyItems.filter((ci) => !knownIds.has(ci.external_id));

  console.log(
    `[RSS] ${feed.name}: fetched ${items.length} items, ${knownIds.size} already known, classifying ${newItems.length} new…`,
  );

  if (!newItems.length)
    return {
      found: items.length,
      added: 0,
      skipped: items.length,
      error: null,
    };

  const results = await classifyMany(
    newItems.map((ci) => ({ title: ci.title, description: ci.description })),
  );

  let added = 0;
  let skipped = knownIds.size;

  for (let i = 0; i < newItems.length; i++) {
    const { title, description, item, external_id } = newItems[i];
    const result = results[i];

    if (!result || !result.is_security_incident) {
      skipped++;
      continue;
    }

    const { type, fatalities, victims, severity } = result;
    const fullText = `${title} ${description}`;
    const geo = geocode(fullText) || geocode(title);
    const state = geo?.state || extractState(fullText) || null;
    const date = parseDate(item.isoDate, item.pubDate);

    // Check for existing incident with matching fingerprint
    const fp = buildFingerprint({ date, state, type, title, description });
    const matches = await db.findMatchingIncidents({ date, state, type });

    let merged = false;
    for (const existing of matches) {
      const existingFp = buildFingerprint({
        date: existing.date.toISOString().slice(0, 10),
        state: existing.state,
        type: existing.type,
        title: existing.title,
        description: existing.description,
      });
      if (fingerprintsMatch(fp, existingFp)) {
        merged = await db.mergeIntoIncident(existing.id, {
          source: feed.name,
          source_url: item.link,
          fatalities,
          victims,
        });
        if (merged) {
          console.log(
            `[RSS] Merged into existing incident #${existing.id}: ${title.slice(0, 60)}…`,
          );
        }
        break;
      }
    }

    if (!merged) {
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
        source: feed.name,
        source_url: item.link || null,
        source_type: "rss",
        verified: 0,
      });

      if (inserted) added++;
    }
  }

  return { found: items.length, added, skipped, error: null };
}

const FEED_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.RSS_FEED_CONCURRENCY || "8", 10),
);

async function scrapeAll() {
  console.log(
    `[RSS] Starting scrape of ${FEEDS.length} feeds (concurrency=${FEED_CONCURRENCY})…`,
  );
  const results = new Array(FEEDS.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= FEEDS.length) return;
      const feed = FEEDS[i];
      const result = await scrapeFeed(feed);
      results[i] = { feed: feed.name, ...result };

      await db.logScrape({
        source: `rss:${feed.name}`,
        status: result.error ? "error" : "ok",
        items_found: result.found,
        items_added: result.added,
        error: result.error || null,
      });

      console.log(
        `[RSS] ${feed.name}: found=${result.found} added=${result.added} skipped=${result.skipped}${result.error ? " ERR=" + result.error : ""}`,
      );
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(FEED_CONCURRENCY, FEEDS.length) }, () =>
      worker(),
    ),
  );

  const totalAdded = results.reduce((s, r) => s + (r?.added || 0), 0);
  console.log(`[RSS] Done. Total new: ${totalAdded}`);
  return results;
}

export { scrapeAll };
