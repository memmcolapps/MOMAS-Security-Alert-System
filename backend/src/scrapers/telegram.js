"use strict";

// Free Telegram public-channel scraper using the t.me/s/<channel> web preview.
// No API key, no auth. Works for any public channel that allows web preview.
//
// Configure channels via env: TELEGRAM_CHANNELS=zagazola,humangle_media,...
// Each channel name is the public @handle (without the @).

const axios = require("axios");
const { classifyMany } = require("../classifier");
const { geocode, extractState } = require("../geocoder");
const {
  buildFingerprint,
  fingerprintsMatch,
} = require("../classifier/fingerprint");
const db = require("../db");

// NOTE: t.me/s/<handle> only works for channels with "Channel preview" enabled.
// Most major Nigerian outlets (Sahara Reporters, Premium Times, Channels TV,
// HumAngle, Daily Trust, Punch, Vanguard) have it OFF — they're unreachable
// without the official Bot API or MTProto. The list below was probed via
// scripts/probe-telegram.js and only includes handles confirmed to return
// messages. Run that script to test new handles before adding them.
const DEFAULT_CHANNELS = [
  "PeoplesGazette",  // Peoples Gazette — investigative/breaking news
  "thecableng",      // The Cable — Nigerian news
  "channelsforum",   // Channels forum mirror with preview enabled
  "zagazolamakama",  // security-oriented channel with preview enabled
  "naijanewsroom",   // general breaking news
  "naijabreakingnews", // general breaking news
];

function getChannels() {
  const env = (process.env.TELEGRAM_CHANNELS || "").trim();
  if (!env) return DEFAULT_CHANNELS;
  return env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-NG,en;q=0.9",
};

function stripHtml(html) {
  return (html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Parse messages out of the t.me/s/<channel> HTML.
// Each message lives in a <div class="tgme_widget_message ..." data-post="channel/123">
// and has a body in <div class="tgme_widget_message_text"> and a timestamp in <time datetime="...">.
function parseChannelHtml(channel, html) {
  const messages = [];
  const blockRe =
    /<div\s+class="tgme_widget_message[^"]*"[^>]*data-post="([^"]+)"[\s\S]*?(?=<div\s+class="tgme_widget_message[^"]*"[^>]*data-post="|<\/section>|$)/g;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[0];
    const dataPost = m[1]; // e.g. "zagazola/12345"
    const msgId = dataPost.split("/").pop();

    const textMatch = block.match(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    );
    const text = stripHtml(textMatch?.[1] || "");
    if (!text || text.length < 20) continue;

    const dateMatch = block.match(/<time[^>]+datetime="([^"]+)"/);
    const ts = dateMatch ? new Date(dateMatch[1]) : new Date();

    // Optional: pull a permalink target if present
    const linkMatch = block.match(
      /<a class="tgme_widget_message_date"[^>]+href="([^"]+)"/,
    );
    const url = linkMatch?.[1] || `https://t.me/${channel}/${msgId}`;

    messages.push({
      channel,
      msgId,
      text,
      ts,
      url,
    });
  }
  return messages;
}

async function fetchChannel(channel) {
  const url = `https://t.me/s/${channel}`;
  const resp = await axios.get(url, {
    timeout: 15000,
    responseType: "text",
    headers: REQUEST_HEADERS,
    maxRedirects: 3,
  });
  if (
    typeof resp.data !== "string" ||
    !resp.data.includes("tgme_widget_message")
  ) {
    throw new Error("Channel page returned no messages (private/blocked?)");
  }
  return parseChannelHtml(channel, resp.data);
}

function buildExternalId(channel, msgId) {
  return `telegram:${channel}:${msgId}`;
}

async function scrapeChannel(channel) {
  let messages;
  try {
    messages = await fetchChannel(channel);
  } catch (err) {
    console.warn(`[Telegram] ${channel} fetch failed: ${err.message}`);
    return { found: 0, added: 0, skipped: 0, error: err.message };
  }

  if (!messages.length) {
    return { found: 0, added: 0, skipped: 0, error: null };
  }

  const items = messages.map((m) => ({
    title: m.text.slice(0, 200),
    description: m.text.slice(0, 1000),
    external_id: buildExternalId(m.channel, m.msgId),
    msg: m,
  }));

  const knownIds = await db.existingExternalIds(
    items.map((i) => i.external_id),
  );
  const newItems = items.filter((i) => !knownIds.has(i.external_id));

  console.log(
    `[Telegram] @${channel}: ${messages.length} msgs, ${knownIds.size} known, classifying ${newItems.length}…`,
  );

  if (!newItems.length) {
    return {
      found: messages.length,
      added: 0,
      skipped: messages.length,
      error: null,
    };
  }

  const results = await classifyMany(
    newItems.map((i) => ({ title: i.title, description: i.description })),
  );

  let added = 0;
  let skipped = knownIds.size;

  for (let i = 0; i < newItems.length; i++) {
    const { title, description, external_id, msg } = newItems[i];
    const result = results[i];
    if (!result || !result.is_security_incident) {
      skipped++;
      continue;
    }

    const { type, fatalities, victims, severity } = result;
    const fullText = `${title} ${description}`;
    const geo = geocode(fullText) || geocode(title);
    const state = geo?.state || extractState(fullText) || null;
    const date = msg.ts.toISOString().slice(0, 10);

    // Fingerprint dedup against same-day, same-state, same-type
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
          source: `Telegram @${msg.channel}`,
          source_url: msg.url,
          fatalities,
          victims,
        });
        if (merged) {
          console.log(
            `[Telegram] Merged into #${existing.id}: ${title.slice(0, 60)}…`,
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
        source: `Telegram @${msg.channel}`,
        source_url: msg.url,
        source_type: "telegram",
        verified: 0,
      });
      if (inserted) added++;
    }
  }

  return { found: messages.length, added, skipped, error: null };
}

async function scrapeTelegram() {
  const channels = getChannels();
  if (!channels.length) {
    console.log("[Telegram] No channels configured");
    return [];
  }
  console.log(`[Telegram] Scraping ${channels.length} channel(s)…`);

  const results = [];
  for (const channel of channels) {
    const result = await scrapeChannel(channel);
    results.push({ channel, ...result });

    await db.logScrape({
      source: `telegram:${channel}`,
      status: result.error ? "error" : "ok",
      items_found: result.found,
      items_added: result.added,
      error: result.error || null,
    });

    console.log(
      `[Telegram] @${channel}: found=${result.found} added=${result.added} skipped=${result.skipped}${result.error ? " ERR=" + result.error : ""}`,
    );

    // Polite delay between channels
    await new Promise((r) => setTimeout(r, 600));
  }

  const totalAdded = results.reduce((s, r) => s + (r.added || 0), 0);
  console.log(`[Telegram] Done. Total new: ${totalAdded}`);
  return results;
}

function isTelegramEnabled() {
  return getChannels().length > 0;
}

module.exports = { scrapeTelegram, isTelegramEnabled };
