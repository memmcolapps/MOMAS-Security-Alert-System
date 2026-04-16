"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const path = require("path");

const db = require("./db");
const { scrapeAll } = require("./scrapers/rss");
const {
  fetchHAPI,
  isHAPIEnabled,
} = require("./scrapers/hapi");
const {
  scrapeReliefWeb,
  isReliefWebEnabled,
} = require("./scrapers/reliefweb");
const incidentsRouter = require("./routes/incidents");

const app = express();
const PORT = process.env.PORT || 3000;
const SCRAPE_INTERVAL = parseInt(process.env.SCRAPE_INTERVAL_MINUTES) || 30;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../../frontend")));

app.use("/api/incidents", incidentsRouter);

app.get("/api/health", (req, res) =>
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    scrape_interval_minutes: SCRAPE_INTERVAL,
    hapi_enabled: isHAPIEnabled(),
    reliefweb_enabled: isReliefWebEnabled(),
  }),
);

async function runScrape() {
  try {
    await scrapeAll();
    await fetchHAPI(7);
    await scrapeReliefWeb(7);
  } catch (err) {
    console.error("[Scrape] Error:", err.message);
  }
}

// Initialise DB then start server
db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`
╔══════════════════════════════════════════════╗
║   MOMAS Security Alert System — Backend    ║
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
