import axios from "axios";
import { isGoogleNewsUrl, resolveGoogleNewsUrl } from "./gnews";

const JINA_READER_BASE = process.env.JINA_READER_BASE || "https://r.jina.ai";
const FULLTEXT_TIMEOUT_MS = parseInt(
  process.env.FULLTEXT_TIMEOUT_MS || "15000",
  10,
);
const FULLTEXT_MAX_CHARS = parseInt(
  process.env.FULLTEXT_MAX_CHARS || "4000",
  10,
);
const FULLTEXT_MIN_CHARS = parseInt(
  process.env.FULLTEXT_MIN_CHARS || "240",
  10,
);

const cache = new Map();

function isFullTextEnabled() {
  return process.env.FULLTEXT_ENABLED !== "false";
}

function cleanText(text) {
  return (text || "")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// Jina returns the whole page as markdown: header block, nav, "READ ALSO"
// inserts, related-story links, share buttons. Off-article headlines carry
// place names that hijack the geocoder (a Kogi campus killing got mapped to
// Kano via a "fire razes market in Kano" sidebar link), so strip everything
// that isn't prose before it reaches the classifier or the description.
const JUNK_LINE_RE = new RegExp(
  [
    "^(read|see)\\s+also\\b",
    "^related(\\s+(news|stories|posts|articles))?\\s*:?\\s*$",
    "^(share|follow)\\s+(this|us)\\b",
    "^advertisement\\b",
    "^sponsored\\b",
    "^subscribe\\b",
    "^sign\\s+up\\b",
    "^copyright\\b",
    "all\\s+rights\\s+reserved",
    "^tags?\\s*:",
    "^more\\s+(stories|news)\\b",
    "^trending\\b",
    "^(home|news|politics|sports|entertainment)(\\s*[|>»]\\s*\\w+)+$",
  ].join("|"),
  "i",
);

function stripReaderJunk(text) {
  let body = String(text || "");

  // Drop Jina's metadata header ("Title: …\nURL Source: …\nMarkdown Content:")
  const marker = body.indexOf("Markdown Content:");
  if (marker !== -1) body = body.slice(marker + "Markdown Content:".length);

  const kept = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) {
      kept.push(line);
      continue;
    }
    if (JUNK_LINE_RE.test(t)) continue;
    // Link-only / image-only lines are nav or related-story widgets
    if (/^\!?\[[^\]]*\]\([^)]*\)$/.test(t)) continue;
    if (/^(\*|-|\d+\.)\s*\!?\[[^\]]*\]\([^)]*\)\s*$/.test(t)) continue;
    kept.push(line);
  }

  return (
    kept
      .join("\n")
      // unwrap remaining inline markdown links/images to their text
      .replace(/\!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  );
}

/**
 * Cut text to at most `max` chars, preferring a sentence boundary so
 * descriptions don't end mid-word.
 */
function truncateAtSentence(text, max) {
  const t = (text || "").trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  const cut = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf(".\n"),
  );
  return cut > max * 0.5 ? slice.slice(0, cut + 1).trim() : slice;
}

function isLikelyAggregatorUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "news.google.com";
  } catch {
    return false;
  }
}

function readerUrl(url) {
  return `${JINA_READER_BASE.replace(/\/$/, "")}/${url}`;
}

async function fetchFullText(url) {
  if (!url || !isFullTextEnabled()) return "";
  if (isLikelyAggregatorUrl(url)) return "";

  const key = url;
  if (cache.has(key)) return cache.get(key);

  try {
    const resp = await axios.get(readerUrl(url), {
      timeout: FULLTEXT_TIMEOUT_MS,
      responseType: "text",
      headers: {
        Accept: "text/plain, text/markdown, */*",
        "User-Agent": "momas-security-alert/0.2",
      },
      maxRedirects: 5,
    });
    const text = cleanText(stripReaderJunk(String(resp.data || "")));
    const usable = text.length >= FULLTEXT_MIN_CHARS ? text.slice(0, FULLTEXT_MAX_CHARS) : "";
    cache.set(key, usable);
    return usable;
  } catch (err) {
    console.warn(`[Enrich] Full-text fetch failed for ${url}: ${err.message}`);
    cache.set(key, "");
    return "";
  }
}

function bestDescription({ description = "", contentText = "" }) {
  const cleanedContent = cleanText(contentText);
  const cleanedDescription = cleanText(description);
  if (cleanedContent.length > cleanedDescription.length + 120) return cleanedContent;
  return cleanedDescription;
}

async function enrichCandidate(candidate) {
  const rawUrl = candidate.source_url || candidate.url || candidate.item?.link;
  // Google News RSS links point at a redirect page; resolve to the publisher
  // URL so the full-text fetch (and the stored incident link) are usable.
  const resolvedUrl = isGoogleNewsUrl(rawUrl)
    ? await resolveGoogleNewsUrl(rawUrl)
    : null;
  const contentText =
    candidate.contentText || (await fetchFullText(resolvedUrl || rawUrl));
  return {
    ...candidate,
    resolvedUrl,
    contentText,
    description: bestDescription({
      description: candidate.description,
      contentText,
    }).slice(0, FULLTEXT_MAX_CHARS),
  };
}

async function enrichCandidates(candidates, concurrency = 3) {
  const results = new Array(candidates.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= candidates.length) return;
      results[i] = await enrichCandidate(candidates[i]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, () =>
      worker(),
    ),
  );

  return results;
}

export { enrichCandidate, enrichCandidates, fetchFullText, truncateAtSentence };
