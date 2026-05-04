import axios from "axios";

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
    const text = cleanText(String(resp.data || ""));
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
  const contentText = candidate.contentText || (await fetchFullText(candidate.source_url || candidate.url));
  return {
    ...candidate,
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

export { enrichCandidate, enrichCandidates, fetchFullText };
