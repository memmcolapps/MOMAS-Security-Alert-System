"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const path = require("path");

const db = require("./db");
const { scrapeAll } = require("./scrapers/rss");
const { fetchHAPI, isHAPIEnabled } = require("./scrapers/hapi");
const { scrapeReliefWeb, isReliefWebEnabled } = require("./scrapers/reliefweb");
const { scrapeGDELT, isGDELTEnabled } = require("./scrapers/gdelt");
const { scrapeNewsAPI, isNewsAPIEnabled } = require("./scrapers/newsapi");
const { scrapeGuardian, isGuardianEnabled } = require("./scrapers/guardian");
const { scrapeTelegram, isTelegramEnabled } = require("./scrapers/telegram");
const incidentsRouter = require("./routes/incidents");
const pocstarsRouter = require("./routes/pocstars");

const app = express();
const PORT = process.env.PORT || 3000;

// Tier intervals (seconds for hot/warm, cron expression for cold)
const HOT_INTERVAL_SEC  = parseInt(process.env.SCRAPE_HOT_SEC)  || 90;          // RSS + Telegram
const WARM_INTERVAL_SEC = parseInt(process.env.SCRAPE_WARM_SEC) || 300;         // GDELT (5 min)
const COLD_INTERVAL_MIN = parseInt(process.env.SCRAPE_COLD_MIN) || 30;          // HAPI/ReliefWeb/NewsAPI/Guardian

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../../frontend")));

app.use("/api/incidents", incidentsRouter);
app.use("/api/pocstars", pocstarsRouter);

app.get("/api/config", (req, res) =>
  res.json({
    apiBase: process.env.FRONTEND_API_BASE || "",
    refreshMs: parseInt(process.env.FRONTEND_REFRESH_MS) || 1_800_000, // 30min fallback (SSE handles real-time)
    maxMarkers: parseInt(process.env.FRONTEND_MAX_MARKERS) || 500,
  }),
);

app.get("/api/health", (req, res) =>
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    tiers: {
      hot_seconds:  HOT_INTERVAL_SEC,
      warm_seconds: WARM_INTERVAL_SEC,
      cold_minutes: COLD_INTERVAL_MIN,
    },
    sources: {
      rss_enabled:      true,
      telegram_enabled: isTelegramEnabled(),
      gdelt_enabled:    isGDELTEnabled(),
      hapi_enabled:     isHAPIEnabled(),
      reliefweb_enabled: isReliefWebEnabled(),
      newsapi_enabled:  isNewsAPIEnabled(),
      guardian_enabled: isGuardianEnabled(),
    },
  }),
);

// Per-tier overlap guards
const _running = { hot: false, warm: false, cold: false };

async function runTier(name, jobs) {
  if (_running[name]) {
    console.log(`[Scrape:${name}] already running — skip`);
    return;
  }
  _running[name] = true;
  const start = Date.now();
  try {
    const outcomes = await Promise.allSettled(jobs.map((j) => j.fn()));
    outcomes.forEach((o, i) => {
      if (o.status === "rejected") {
        console.error(
          `[Scrape:${name}] ${jobs[i].label} failed:`,
          o.reason?.message || o.reason,
        );
      }
    });
    console.log(
      `[Scrape:${name}] cycle done in ${((Date.now() - start) / 1000).toFixed(1)}s`,
    );
  } finally {
    _running[name] = false;
  }
}

const runHot = () =>
  runTier("hot", [
    { label: "RSS",      fn: () => scrapeAll() },
    { label: "Telegram", fn: () => scrapeTelegram() },
  ]);

const runWarm = () =>
  runTier("warm", [
    { label: "GDELT", fn: () => scrapeGDELT(7) },
  ]);

const runCold = () =>
  runTier("cold", [
    { label: "HAPI",      fn: () => fetchHAPI(90) },
    { label: "ReliefWeb", fn: () => scrapeReliefWeb(7) },
    { label: "NewsAPI",   fn: () => scrapeNewsAPI(2) },
    { label: "Guardian",  fn: () => scrapeGuardian(2) },
  ]);

// Initialise DB then start server
db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`
╔══════════════════════════════════════════════╗
║   EPAIL Security Alert System — Backend    ║
╠══════════════════════════════════════════════╣
║  Server  : http://localhost:${PORT}             ║
║  Frontend: http://localhost:${PORT}              ║
╚══════════════════════════════════════════════╝`);

      // Initial run on startup (all tiers)
      runHot();
      runWarm();
      runCold();

      // Hot tier — sub-minute, use setInterval (cron is minute-granularity)
      setInterval(runHot, HOT_INTERVAL_SEC * 1000);
      console.log(`[Cron] HOT  tier (RSS+Telegram) every ${HOT_INTERVAL_SEC}s`);

      // Warm tier — every N seconds via setInterval
      setInterval(runWarm, WARM_INTERVAL_SEC * 1000);
      console.log(`[Cron] WARM tier (GDELT) every ${WARM_INTERVAL_SEC}s`);

      // Cold tier — minute granularity, use cron
      cron.schedule(`*/${COLD_INTERVAL_MIN} * * * *`, runCold);
      console.log(
        `[Cron] COLD tier (HAPI+ReliefWeb+NewsAPI+Guardian) every ${COLD_INTERVAL_MIN} min`,
      );
    });
  })
  .catch((err) => {
    console.error("[DB] Failed to initialise PostgreSQL:", err.message);
    console.error(
      "[DB] Make sure PostgreSQL is running and DATABASE_URL is set in .env",
    );
    process.exit(1);
  });
