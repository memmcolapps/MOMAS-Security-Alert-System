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
const incidentsRouter = require("./routes/incidents");
const pocstarsRouter = require("./routes/pocstars");

const app = express();
const PORT = process.env.PORT || 3000;
const SCRAPE_INTERVAL = parseInt(process.env.SCRAPE_INTERVAL_MINUTES) || 30;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../../frontend")));

app.use("/api/incidents", incidentsRouter);
app.use("/api/pocstars", pocstarsRouter);

app.get("/api/config", (req, res) =>
  res.json({
    apiBase: process.env.FRONTEND_API_BASE || "",
    refreshMs: parseInt(process.env.FRONTEND_REFRESH_MS) || 300000,
    maxMarkers: parseInt(process.env.FRONTEND_MAX_MARKERS) || 500,
  }),
);

app.get("/api/health", (req, res) =>
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    scrape_interval_minutes: SCRAPE_INTERVAL,
    hapi_enabled: isHAPIEnabled(),
    reliefweb_enabled: isReliefWebEnabled(),
    gdelt_enabled: isGDELTEnabled(),
    newsapi_enabled: isNewsAPIEnabled(),
    guardian_enabled: isGuardianEnabled(),
  }),
);

let _scraping = false;

async function runScrape() {
  if (_scraping) {
    console.log("[Scrape] Already running — skipping this trigger");
    return;
  }
  _scraping = true;
  const start = Date.now();
  try {
    const outcomes = await Promise.allSettled([
      scrapeAll(),
      fetchHAPI(90),
      scrapeReliefWeb(7),
      scrapeGDELT(7),
      scrapeNewsAPI(2),
      scrapeGuardian(2),
    ]);
    const labels = ["RSS", "HAPI", "ReliefWeb", "GDELT", "NewsAPI", "Guardian"];
    outcomes.forEach((o, i) => {
      if (o.status === "rejected") {
        console.error(
          `[Scrape] ${labels[i]} failed:`,
          o.reason?.message || o.reason,
        );
      }
    });
    console.log(
      `[Scrape] Full cycle done in ${((Date.now() - start) / 1000).toFixed(1)}s`,
    );
  } finally {
    _scraping = false;
  }
}

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

      // Initial scrape on startup
      runScrape();

      // Scheduled scrape
      const expr = `*/${SCRAPE_INTERVAL} * * * *`;
      cron.schedule(expr, () => {
        console.log("[Cron] Triggered scheduled scrape");
        runScrape();
      });
      console.log(`[Cron] Scraping every ${SCRAPE_INTERVAL} minutes`);
    });
  })
  .catch((err) => {
    console.error("[DB] Failed to initialise PostgreSQL:", err.message);
    console.error(
      "[DB] Make sure PostgreSQL is running and DATABASE_URL is set in .env",
    );
    process.exit(1);
  });
