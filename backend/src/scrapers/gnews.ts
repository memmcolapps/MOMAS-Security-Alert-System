// Resolve news.google.com RSS article links to the real publisher URL.
//
// Google News RSS items link to a redirect page, not the article, so the
// full-text enricher can't read them. Two decode strategies:
//   1. Old-format article ids (pre mid-2024) are base64 protobufs with the
//      URL embedded — decode locally, no network.
//   2. New-format ids need Google's internal batchexecute endpoint: fetch the
//      article page for a signature + timestamp, then POST to get the URL.
// Both are keyless and free. Failures cache as null so a bad id is only
// attempted once per process.

import axios from "axios";

const BATCH_EXECUTE_URL =
  "https://news.google.com/_/DotsSplashUi/data/batchexecute";
const GNEWS_TIMEOUT_MS = parseInt(process.env.GNEWS_TIMEOUT_MS || "15000", 10);
const CACHE_MAX = 5000;

const _cache = new Map<string, string | null>();

function cacheSet(key: string, val: string | null) {
  if (_cache.has(key)) _cache.delete(key);
  _cache.set(key, val);
  if (_cache.size > CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

function isGoogleNewsUrl(url) {
  try {
    return (
      new URL(url).hostname.replace(/^www\./, "") === "news.google.com"
    );
  } catch {
    return false;
  }
}

function articleIdFromUrl(url) {
  const m = String(url || "").match(/\/(?:rss\/)?articles\/([^/?#]+)/);
  return m ? m[1] : null;
}

function isPlausibleArticleUrl(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const host = new URL(url).hostname;
    return host.includes(".") && !host.endsWith("google.com");
  } catch {
    return false;
  }
}

// Strategy 1: the id is URL-safe base64; old-format payloads contain the
// article URL as a length-prefixed string. Just scan for a printable run.
function decodeFromBase64(id) {
  try {
    const bytes = Buffer.from(id, "base64").toString("latin1");
    const m = bytes.match(/https?:\/\/[\x21-\x7e]+/);
    if (m && isPlausibleArticleUrl(m[0])) return m[0];
  } catch {
    // not base64 / no URL inside — fall through to batchexecute
  }
  return null;
}

// Strategy 2: ask Google to decode it for us.
async function decodeViaBatchExecute(id) {
  const page = await axios.get(
    `https://news.google.com/rss/articles/${id}`,
    {
      timeout: GNEWS_TIMEOUT_MS,
      responseType: "text",
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
    },
  );
  const html = String(page.data || "");
  const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sg || !ts) throw new Error("No decode signature on article page");

  const inner = JSON.stringify([
    "garturlreq",
    [
      ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null,
        null, null, null, 0, 1],
      "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0,
    ],
    id,
    Number(ts),
    sg,
  ]);
  const body =
    "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner]]]));

  const resp = await axios.post(BATCH_EXECUTE_URL, body, {
    timeout: GNEWS_TIMEOUT_MS,
    responseType: "text",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "User-Agent": "Mozilla/5.0",
    },
  });

  // Response is `)]}'` junk followed by JSON; the URL sits in a
  // double-encoded payload at [0][2] -> JSON.parse -> [1].
  const text = String(resp.data || "");
  const start = text.indexOf("[[");
  if (start === -1) throw new Error("Unexpected batchexecute response");
  const envelope = JSON.parse(text.slice(start));
  const payload = envelope?.[0]?.[2];
  if (typeof payload !== "string")
    throw new Error("Missing batchexecute payload");
  const url = JSON.parse(payload)?.[1];
  if (typeof url !== "string" || !isPlausibleArticleUrl(url))
    throw new Error("Decoded value is not an article URL");
  return url;
}

/**
 * Resolve a news.google.com link to the publisher URL.
 * Returns null when the input isn't a Google News link or decoding fails.
 */
async function resolveGoogleNewsUrl(url) {
  if (!isGoogleNewsUrl(url)) return null;
  const id = articleIdFromUrl(url);
  if (!id) return null;

  if (_cache.has(id)) return _cache.get(id);

  let resolved = decodeFromBase64(id);
  if (!resolved) {
    try {
      resolved = await decodeViaBatchExecute(id);
    } catch (err) {
      console.warn(`[GNews] Decode failed for ${id.slice(0, 24)}…: ${err.message}`);
      resolved = null;
    }
  }

  cacheSet(id, resolved);
  return resolved;
}

export { isGoogleNewsUrl, resolveGoogleNewsUrl };
