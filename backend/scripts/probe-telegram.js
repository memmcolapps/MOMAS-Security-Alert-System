"use strict";

// Probe Telegram public-preview channels.
// Usage: node scripts/probe-telegram.js [handle1 handle2 ...]
// If no args, probes a curated candidate list.

const axios = require("axios");

const CANDIDATES = [
  // Original defaults (likely broken)
  "zagazola",
  "humangle_media",
  "saharareporters",
  "channelsforum",
  "premiumtimesng",
  "defenceinfong",
  // New guesses
  "zagazolamakama",
  "HumAngle_Media",
  "PoliceNG_",
  "nigeriastories",
  "naijanewsroom",
  "SaharaReporters",
  "PremiumTimesNigeria",
  "channelstv",
  "ChannelsTV",
  "dailytrustnews",
  "punchnewspapers",
  "vanguardngrnews",
  "thecableng",
  "BBCNewsPidgin",
  "NigeriaArmyHQ",
  "DSS_Nigeria",
  "GarShehu",
  "NgrPresident",
  "MobilePoliceNG",
  "naijaalerts",
  "securityreports",
  "nigeriasecurity",
  "northeastsecurity",
  "sahelreporters",
  "naijabreakingnews",
  "BreakingTimesNG",
  "PeoplesGazette",
  "SaharaTV",
  "AriseNewsChannel",
  "TVCNewsNigeria",
];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-NG,en;q=0.9",
};

function countMatches(html, re) {
  let n = 0;
  while (re.exec(html) !== null) n++;
  return n;
}

async function probe(handle) {
  const url = `https://t.me/s/${handle}`;
  try {
    const resp = await axios.get(url, {
      timeout: 12000,
      responseType: "text",
      headers: HEADERS,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (resp.status !== 200) {
      return { handle, ok: false, reason: `HTTP ${resp.status}` };
    }
    const html = typeof resp.data === "string" ? resp.data : "";
    if (!html.includes("tgme_widget_message")) {
      return { handle, ok: false, reason: "no preview / private / not found" };
    }
    const msgs = countMatches(
      html,
      /<div\s+class="tgme_widget_message[^"]*"[^>]*data-post="/g,
    );
    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
    const title = titleMatch?.[1] || "";
    return { handle, ok: msgs > 0, reason: `${msgs} msgs`, title };
  } catch (err) {
    return { handle, ok: false, reason: err.message };
  }
}

(async () => {
  const list = process.argv.slice(2).length
    ? process.argv.slice(2)
    : CANDIDATES;
  console.log(`Probing ${list.length} channel(s)…\n`);

  const ok = [];
  const bad = [];

  for (const handle of list) {
    const r = await probe(handle);
    const tag = r.ok ? "OK " : "XX ";
    console.log(
      `${tag} @${handle.padEnd(24)}  ${r.reason}${r.title ? "  — " + r.title : ""}`,
    );
    (r.ok ? ok : bad).push(r);
    await new Promise((r) => setTimeout(r, 350));
  }

  console.log(`\n=== ${ok.length} working / ${bad.length} failed ===`);
  if (ok.length) {
    console.log(`\nTELEGRAM_CHANNELS=${ok.map((r) => r.handle).join(",")}`);
  }
})();
