// Real-time Telegram listener over MTProto (GramJS, user session).
//
// Unlike the t.me/s/ web-preview scraper (telegram.ts), this receives pushed
// NewMessage events from ANY public channel — including the ones with web
// preview disabled (HumAngle, Premium Times, …) — with zero polling delay.
// It is entirely free: api_id/api_hash come from https://my.telegram.org and
// the session belongs to a normal user account.
//
// Setup (one-time, local):
//   1. Get api_id + api_hash at https://my.telegram.org → "API development tools"
//   2. bun run scripts/telegram-login.ts   → prints TELEGRAM_SESSION=…
//   3. Set TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION in the env.
//      Optionally TELEGRAM_MTPROTO_CHANNELS=handle1,handle2 (no @).
//
// External ids use the same `telegram:<channel>:<msgId>` format as the web
// scraper, so both paths dedupe against each other.

import { classify, classifyMany } from "../classifier";
import * as db from "../db";
import { persistIncident } from "./ingest";

// With MTProto the "preview enabled" restriction is gone — any public channel
// handle works. Extend via TELEGRAM_MTPROTO_CHANNELS once handles are
// verified (open t.me/<handle> in a browser to confirm).
const DEFAULT_CHANNELS = [
  "PeoplesGazette",
  "thecableng",
  "channelsforum",
  "zagazolamakama",
  "naijanewsroom",
  "naijabreakingnews",
];

const BACKFILL_LIMIT = parseInt(
  process.env.TELEGRAM_MTPROTO_BACKFILL || "20",
  10,
);

function getConfig() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID || "0", 10);
  const apiHash = (process.env.TELEGRAM_API_HASH || "").trim();
  const session = (process.env.TELEGRAM_SESSION || "").trim();
  const channels = (process.env.TELEGRAM_MTPROTO_CHANNELS || "")
    .split(",")
    .map((s) => s.trim().replace(/^@/, ""))
    .filter(Boolean);
  return {
    apiId,
    apiHash,
    session,
    channels: channels.length ? channels : DEFAULT_CHANNELS,
  };
}

function isTelegramMtprotoEnabled() {
  const { apiId, apiHash, session } = getConfig();
  return Boolean(apiId && apiHash && session);
}

function buildExternalId(channel, msgId) {
  return `telegram:${channel}:${msgId}`;
}

function toItem(channel, msgId, text, ts) {
  return {
    title: text.slice(0, 200),
    description: text.slice(0, 1000),
    external_id: buildExternalId(channel, msgId),
    publishedAt: ts.toISOString(),
    url: `https://t.me/${channel}/${msgId}`,
    ts,
  };
}

async function persistIfIncident(channel, item, result) {
  if (!result || !result.is_security_incident) return null;

  const outcome = await persistIncident({
    result,
    title: item.title,
    description: item.description,
    date: item.ts.toISOString().slice(0, 10),
    external_id: item.external_id,
    source: `Telegram @${channel}`,
    source_url: item.url,
    source_type: "telegram",
  });

  if (outcome.status !== "skipped") {
    console.log(
      `[TG-MTProto] @${channel} ${outcome.status} incident #${outcome.incidentId}: ${item.title.slice(0, 60)}…`,
    );
  }
  return outcome;
}

// Catch up on the most recent messages per channel so a restart doesn't
// miss whatever was posted while the process was down.
async function backfillChannel(client, channel) {
  try {
    const messages = await client.getMessages(channel, {
      limit: BACKFILL_LIMIT,
    });
    const items = messages
      .filter((m) => m?.message && m.message.length >= 20)
      .map((m) =>
        toItem(channel, m.id, m.message, new Date((m.date || 0) * 1000)),
      );
    if (!items.length) return;

    const knownIds = await db.existingExternalIds(
      items.map((i) => i.external_id),
    );
    const fresh = items.filter((i) => !knownIds.has(i.external_id));
    if (!fresh.length) return;

    console.log(
      `[TG-MTProto] @${channel}: backfilling ${fresh.length} message(s)…`,
    );
    const results = await classifyMany(
      fresh.map((i) => ({
        title: i.title,
        description: i.description,
        publishedAt: i.publishedAt,
      })),
    );

    let added = 0;
    for (let i = 0; i < fresh.length; i++) {
      const outcome = await persistIfIncident(channel, fresh[i], results[i]);
      if (outcome?.status === "inserted") added++;
    }

    await db.logScrape({
      source: `mtproto:${channel}`,
      status: "ok",
      items_found: fresh.length,
      items_added: added,
      error: null,
    });
  } catch (err) {
    console.warn(
      `[TG-MTProto] Backfill failed for @${channel}: ${err.message}`,
    );
  }
}

async function handleNewMessage(channel, event) {
  try {
    const message = event.message;
    const text = message?.message || "";
    if (text.length < 20) return;

    const item = toItem(
      channel,
      message.id,
      text,
      new Date((message.date || Date.now() / 1000) * 1000),
    );

    const known = await db.existingExternalIds([item.external_id]);
    if (known.has(item.external_id)) return;

    const result = await classify(item.title, item.description);
    await persistIfIncident(channel, item, result);
  } catch (err) {
    console.warn(`[TG-MTProto] Message handling failed: ${err.message}`);
  }
}

async function startTelegramMtproto() {
  if (!isTelegramMtprotoEnabled()) {
    console.log(
      "[TG-MTProto] Disabled — set TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION to enable",
    );
    return null;
  }

  // Lazy import: GramJS is heavy and only needed when configured.
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");
  const { NewMessage } = await import("telegram/events/index.js");

  const { apiId, apiHash, session, channels } = getConfig();
  const client = new TelegramClient(
    new StringSession(session),
    apiId,
    apiHash,
    { connectionRetries: Number.MAX_SAFE_INTEGER, autoReconnect: true },
  );

  try {
    await client.connect();
    if (!(await client.isUserAuthorized())) {
      console.error(
        "[TG-MTProto] Session is not authorized — regenerate it with scripts/telegram-login.ts",
      );
      await client.disconnect();
      return null;
    }
  } catch (err) {
    console.error(`[TG-MTProto] Connect failed: ${err.message}`);
    return null;
  }

  // Resolve handles up-front so bad ones are visible in the logs, and so the
  // event filter can match on channel ids.
  const resolved = [];
  for (const channel of channels) {
    try {
      const entity = await client.getEntity(channel);
      const username = (entity as any).username || channel;
      resolved.push({ channel: username, entity });
      console.log(`[TG-MTProto] Listening to @${username}`);
    } catch (err) {
      console.warn(
        `[TG-MTProto] Cannot resolve @${channel}: ${err.message} — skipping`,
      );
    }
  }

  if (!resolved.length) {
    console.error("[TG-MTProto] No resolvable channels; disconnecting");
    await client.disconnect();
    return null;
  }

  for (const { channel, entity } of resolved) {
    client.addEventHandler(
      (event) => handleNewMessage(channel, event),
      new NewMessage({ chats: [entity.id] }),
    );
  }

  console.log(
    `[TG-MTProto] Live on ${resolved.length}/${channels.length} channel(s)`,
  );

  // Backfill in the background — don't block startup.
  void (async () => {
    for (const { channel } of resolved) {
      await backfillChannel(client, channel);
    }
  })();

  return client;
}

export { isTelegramMtprotoEnabled, startTelegramMtproto };
