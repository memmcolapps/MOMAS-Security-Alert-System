"use strict";

const axios = require("axios");
const Parser = require("rss-parser");
const { classify } = require("../classifier");
const { geocode, extractState } = require("../geocoder");
const db = require("../db");

const parser = new Parser({
  customFields: { item: ["media:content", "content:encoded"] },
});

const FEEDS = [
  { name: "Punch Nigeria", url: "https://punchng.com/feed/" },
  { name: "Vanguard Nigeria", url: "https://www.vanguardngr.com/feed/" },
  { name: "Daily Trust", url: "https://dailytrust.com/feed" },
  { name: "Sahara Reporters", url: "https://saharareporters.com/rss.xml" },
  { name: "Channels TV", url: "https://www.channelstv.com/feed/" },
  { name: "PM News Nigeria", url: "https://pmnewsnigeria.com/feed/" },
  { name: "Tribune Online", url: "https://tribuneonlineng.com/feed/" },
  { name: "Blueprint", url: "https://blueprint.ng/feed/" },
  { name: "Arise News", url: "https://www.arise.tv/feed/" },
  { name: "Leadership", url: "https://leadership.ng/feed/" },
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
];

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept:
    "application/rss+xml, application/xml, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5",
  "Accept-Language": "en-NG,en;q=0.9",
};

function normalizeText(value) {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Must appear in the TITLE for an article to count as a security incident
const STRONG_TITLE_SECURITY_KEYWORDS = [
  "massacre",
  "slaughter",
  "attack",
  "attacked",
  "ambush",
  "raid",
  "raided",
  "invade",
  "invaded",
  "bomb",
  "bombing",
  "explosion",
  "explode",
  "blast",
  "ied",
  "kidnap",
  "kidnapped",
  "abduct",
  "abducted",
  "hostage",
  "ransom",
  "bandit",
  "bandits",
  "herdsmen",
  "herder",
  "gunmen",
  "gunman",
  "boko haram",
  "iswap",
  "insurgent",
  "terrorist",
  "terrorism",
  "shoot",
  "shooting",
  "shot dead",
  "open fire",
  "fired on",
  "ransack",
  "loot",
  "looted",
  "village attack",
  "soldiers killed",
  "troops killed",
  "civilians killed",
  "persons killed",
  "people killed",
  "bodies found",
  "corpses found",
];

const AMBIGUOUS_TITLE_SECURITY_KEYWORDS = [
  "kill",
  "killed",
  "dead",
  "death",
  "deaths",
  "casualty",
  "casualties",
  "persons dead",
  "people dead",
];

const VIOLENT_CONTEXT_KEYWORDS = [
  "attack",
  "attacked",
  "ambush",
  "raid",
  "raided",
  "bomb",
  "bombing",
  "blast",
  "kidnap",
  "kidnapped",
  "abduct",
  "abducted",
  "hostage",
  "ransom",
  "bandit",
  "bandits",
  "gunmen",
  "gunman",
  "boko haram",
  "iswap",
  "insurgent",
  "terrorist",
  "terrorism",
  "shoot",
  "shooting",
  "shot",
  "open fire",
  "fired on",
  "troops",
  "soldiers",
  "civilians",
  "village",
  "community",
];

// Strong disqualifiers: headlines matching these are not security incidents.
const EXCLUSION_TITLE_PATTERNS = [
  /\bdebt\b/,
  /\bbudget\b/,
  /\bdeficit\b/,
  /\binflation\b/,
  /\bgdp\b/,
  /\beconom(?:y|ic)\b/,
  /\bnaira\b/,
  /\bforex\b/,
  /\bexchange rate\b/,
  /\binterest rate\b/,
  /\bloan\b/,
  /\bborrowing\b/,
  /\brevenue\b/,
  /\btax\b/,
  /\bvat\b/,
  /\bfaac\b/,
  /\bminimum wage\b/,
  /\bsalary\b/,
  /\bpension\b/,
  /\bpetrol\b/,
  /\bfuel price\b/,
  /\bsubsidy\b/,
  /\belectricity tariff\b/,
  /\bpower sector\b/,
  /\belection\b/,
  /\bgovernorship\b/,
  /\bsenatorial\b/,
  /\bprimary election\b/,
  /\bbye election\b/,
  /\bcourt\b/,
  /\bjudgment\b/,
  /\bverdict\b/,
  /\blawsuit\b/,
  /\blitigation\b/,
  /\binjunction\b/,
  /\bappoint(?:s|ed|ment)?\b/,
  /\bresign(?:s|ed|ation)?\b/,
  /\bsack(?:s|ed)?\b/,
  /\binaugurat(?:e|ed|ion)\b/,
  /\bflood\b/,
  /\berosion\b/,
  /\bdrought\b/,
  /\bcholera\b/,
  /\bmpox\b/,
  /\bebola\b/,
  /\baccident\b/,
  /\bcrash\b/,
  /\bfire outbreak\b/,
  /\bmarket fire\b/,
  /\bfactory fire\b/,
  /\beach nigerian owes\b/,
  /\bdebt burden\b/,
  /\bpublic debt\b/,
  /\bhow nigeria\b/,
  /\bearly warning signs\b/,
  /\banalysis\b/,
  /\bopinion\b/,
  /\beditorial\b/,
  /\bsuspends activities\b/,
  /\bpupil s death\b/,
  /\bstudent s death\b/,
];

// If ANY of these appear as the PRIMARY topic of the title, skip it —
// these are non-security beats even if they share a word with security
const EXCLUSION_TITLE_KEYWORDS = [
  "debt",
  "budget",
  "deficit",
  "inflation",
  "gdp",
  "economic",
  "economy",
  "recession",
  "naira",
  "forex",
  "exchange rate",
  "interest rate",
  "loan",
  "borrowing",
  "revenue",
  "election",
  "governorship",
  "senatorial",
  "tribunal",
  "court rules",
  "court orders",
  "court awards",
  "supreme court",
  "appeals court",
  "high court",
  "judgment",
  "verdict",
  "lawsuit",
  "litigation",
  "injunction",
  "arraign",
  "charge to court",
  "fuel price",
  "petrol",
  "petroleum subsidy",
  "electricity tariff",
  "power outage",
  "nerc",
  "nnpc",
  "firs",
  "efcc",
  "icpc indicts",
  "probe panel",
  "corruption trial",
  "money laundering",
  "fraud trial",
  "resign",
  "sack",
  "appoint",
  "appoints",
  "inaugurat",
  "swear in",
  "swear-in",
  "promotion",
  "demotion",
  "transfer",
  "redeploy",
  "flood",
  "erosion",
  "drought",
  "disease outbreak",
  "cholera",
  "mpox",
  "ebola",
  "accident",
  "crash",
  "road accident",
  "train accident",
  "fire outbreak",
  "market fire",
  "factory fire",
  "church fire",
  "mosque fire",
  // Corporate / workplace / legal framing that misuses security words
  "prosecution over",
  "threatens prosecution",
  "threatens legal",
  "threatens to sue",
  "attacks on workers",
  "attacks on staff",
  "attacks on employees",
  "attacks on officials",
  "attacks on customers",
  "attacks on members",
  "rising attacks on",
  "sexual assault",
  "sexual harassment",
  "domestic violence",
  "over allegations",
  "files suit",
  "wins award",
  "court sentences",
];

const EXCLUSION_CONTENT_KEYWORDS = [
  "debt burden",
  "public debt",
  "fiscal deficit",
  "gross domestic product",
  "monetary policy",
  "exchange rate",
  "budget implementation",
  "tax reform",
  "fuel subsidy",
  "electricity tariff",
];

const NIGERIA_KEYWORDS = [
  "nigeria",
  "nigerian",
  // States
  "abia",
  "adamawa",
  "akwa ibom",
  "anambra",
  "bauchi",
  "bayelsa",
  "benue",
  "borno",
  "cross river",
  "delta",
  "ebonyi",
  "edo",
  "ekiti",
  "enugu",
  "gombe",
  "imo",
  "jigawa",
  "kaduna",
  "kano",
  "katsina",
  "kebbi",
  "kogi",
  "kwara",
  "lagos",
  "nasarawa",
  "niger state",
  "ogun",
  "ondo",
  "osun",
  "oyo",
  "plateau",
  "rivers",
  "sokoto",
  "taraba",
  "yobe",
  "zamfara",
  "abuja",
  "fct",
  // Major cities / flashpoints
  "maiduguri",
  "zaria",
  "jos",
  "makurdi",
  "lafia",
  "minna",
  "birnin kebbi",
  "dutse",
  "gusau",
  "damaturu",
  "jalingo",
  "lokoja",
  "ilorin",
  "bauchi city",
  "gombe city",
  "owerri",
  "awka",
  "enugu city",
  "abeokuta",
  "ado ekiti",
  "asaba",
  "umuahia",
  "uyo",
  "yenagoa",
  "benin city",
  "warri",
  "port harcourt",
  "nnewi",
  "onitsha",
  "sokoto city",
  "kano city",
  "ibadan",
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasKeyword(title, keywords) {
  return keywords.some((keyword) => {
    const pattern = keyword.split(/\s+/).map(escapeRegex).join("\\s+");
    return new RegExp(`\\b${pattern}\\b`, "i").test(title);
  });
}

function isSecurityIncident(title, content) {
  const titleLow = normalizeText(title);
  const fullText = normalizeText(`${title} ${content}`);

  // Must mention Nigeria or a Nigerian state somewhere
  if (!NIGERIA_KEYWORDS.some((k) => fullText.includes(k))) return false;

  // Reject if the TITLE is clearly about a non-security topic
  if (EXCLUSION_TITLE_KEYWORDS.some((k) => titleLow.includes(k))) return false;
  if (EXCLUSION_TITLE_PATTERNS.some((re) => re.test(titleLow))) return false;
  if (EXCLUSION_CONTENT_KEYWORDS.some((k) => fullText.includes(k)))
    return false;

  // The TITLE must contain at least one concrete security keyword
  // (prevents body-only matches like "killing the economy")
  if (hasKeyword(titleLow, STRONG_TITLE_SECURITY_KEYWORDS)) return true;

  return (
    hasKeyword(titleLow, AMBIGUOUS_TITLE_SECURITY_KEYWORDS) &&
    hasKeyword(titleLow, VIOLENT_CONTEXT_KEYWORDS)
  );
}

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
    return { found: 0, added: 0, error: err.message };
  }

  const items = feedData.items || [];
  let added = 0;

  for (const item of items) {
    const title = stripHtml(item.title || "");
    const rawContent =
      item["content:encoded"] || item.content || item.contentSnippet || "";
    const description = stripHtml(rawContent).slice(0, 1000);

    if (!isSecurityIncident(title, description)) continue;

    const { type, fatalities, victims, severity } = classify(
      title,
      description,
    );
    const fullText = `${title} ${description}`;
    const geo = geocode(fullText) || geocode(title);
    const state = geo?.state || extractState(fullText) || null;

    const inserted = await db.insertIncident({
      external_id: buildId(feed.name, item),
      title: title.slice(0, 500),
      description: description.slice(0, 2000),
      date: parseDate(item.isoDate, item.pubDate),
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

  return { found: items.length, added, error: null };
}

async function scrapeAll() {
  console.log("[RSS] Starting scrape of", FEEDS.length, "feeds…");
  const results = [];

  for (const feed of FEEDS) {
    const result = await scrapeFeed(feed);
    results.push({ feed: feed.name, ...result });

    await db.logScrape({
      source: `rss:${feed.name}`,
      status: result.error ? "error" : "ok",
      items_found: result.found,
      items_added: result.added,
      error: result.error || null,
    });

    console.log(
      `[RSS] ${feed.name}: found=${result.found} added=${result.added}${result.error ? " ERR=" + result.error : ""}`,
    );
    await new Promise((r) => setTimeout(r, 800));
  }

  const totalAdded = results.reduce((s, r) => s + r.added, 0);
  console.log(`[RSS] Done. Total new: ${totalAdded}`);
  return results;
}

module.exports = { scrapeAll, isSecurityIncident };
