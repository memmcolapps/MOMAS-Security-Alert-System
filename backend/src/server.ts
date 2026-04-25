import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { env } from "./config";
import * as db from "./db";
import incidentsRouter from "./routes/incidents";
import pocstarsRouter from "./routes/pocstars";
import { isGDELTEnabled, scrapeGDELT } from "./scrapers/gdelt";
import { isGuardianEnabled, scrapeGuardian } from "./scrapers/guardian";
import { fetchHAPI, isHAPIEnabled } from "./scrapers/hapi";
import { isNewsAPIEnabled, scrapeNewsAPI } from "./scrapers/newsapi";
import { isReliefWebEnabled, scrapeReliefWeb } from "./scrapers/reliefweb";
import { scrapeAll } from "./scrapers/rss";
import { isTelegramEnabled, scrapeTelegram } from "./scrapers/telegram";

const app = new Hono();
const PORT = env.PORT;
const HOT_INTERVAL_SEC = env.SCRAPE_HOT_SEC;
const WARM_INTERVAL_SEC = env.SCRAPE_WARM_SEC;
const COLD_INTERVAL_MIN = env.SCRAPE_COLD_MIN;
const START_SCRAPE_JOBS = env.START_SCRAPE_JOBS;

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  }),
);

app.route("/api/incidents", incidentsRouter);
app.route("/api/pocstars", pocstarsRouter);

app.get("/api/config", (c) =>
  c.json({
    apiBase: env.FRONTEND_API_BASE,
    refreshMs: env.FRONTEND_REFRESH_MS,
    maxMarkers: env.FRONTEND_MAX_MARKERS,
  }),
);

app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    runtime: "bun",
    time: new Date().toISOString(),
    tiers: {
      hot_seconds: HOT_INTERVAL_SEC,
      warm_seconds: WARM_INTERVAL_SEC,
      cold_minutes: COLD_INTERVAL_MIN,
    },
    sources: {
      rss_enabled: true,
      telegram_enabled: isTelegramEnabled(),
      gdelt_enabled: isGDELTEnabled(),
      hapi_enabled: isHAPIEnabled(),
      reliefweb_enabled: isReliefWebEnabled(),
      newsapi_enabled: isNewsAPIEnabled(),
      guardian_enabled: isGuardianEnabled(),
    },
  }),
);

app.use("/*", serveStatic({ root: "../frontend/dist" }));
app.get("*", serveStatic({ path: "../frontend/dist/index.html" }));

const running = { hot: false, warm: false, cold: false };

async function runTier(name: keyof typeof running, jobs: Array<{ label: string; fn: () => Promise<unknown> }>) {
  if (running[name]) {
    console.log(`[Scrape:${name}] already running - skip`);
    return;
  }
  running[name] = true;
  const start = Date.now();
  try {
    const outcomes = await Promise.allSettled(jobs.map((job) => job.fn()));
    outcomes.forEach((outcome, index) => {
      if (outcome.status === "rejected") {
        console.error(
          `[Scrape:${name}] ${jobs[index].label} failed:`,
          outcome.reason?.message || outcome.reason,
        );
      }
    });
    console.log(`[Scrape:${name}] cycle done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    running[name] = false;
  }
}

const runHot = () =>
  runTier("hot", [
    { label: "RSS", fn: () => scrapeAll() },
    { label: "Telegram", fn: () => scrapeTelegram() },
  ]);

const runWarm = () =>
  runTier("warm", [{ label: "GDELT", fn: () => scrapeGDELT(7) }]);

const runCold = () =>
  runTier("cold", [
    { label: "HAPI", fn: () => fetchHAPI(90) },
    { label: "ReliefWeb", fn: () => scrapeReliefWeb(7) },
    { label: "NewsAPI", fn: () => scrapeNewsAPI(2) },
    { label: "Guardian", fn: () => scrapeGuardian(2) },
  ]);

try {
  await db.init();

  Bun.serve({
    port: PORT,
    fetch: app.fetch,
  });

  console.log(`
╔══════════════════════════════════════════════╗
║       MOMAS Security Operations API         ║
╠══════════════════════════════════════════════╣
║  Runtime : Bun                              ║
║  Server  : http://localhost:${PORT}             ║
╚══════════════════════════════════════════════╝`);

  if (START_SCRAPE_JOBS) {
    void runHot();
    void runWarm();
    void runCold();

    setInterval(runHot, HOT_INTERVAL_SEC * 1000);
    console.log(`[Jobs] HOT  tier (RSS+Telegram) every ${HOT_INTERVAL_SEC}s`);

    setInterval(runWarm, WARM_INTERVAL_SEC * 1000);
    console.log(`[Jobs] WARM tier (GDELT) every ${WARM_INTERVAL_SEC}s`);

    setInterval(runCold, COLD_INTERVAL_MIN * 60 * 1000);
    console.log(`[Jobs] COLD tier (HAPI+ReliefWeb+NewsAPI+Guardian) every ${COLD_INTERVAL_MIN} min`);
  } else {
    console.log("[Jobs] Scrape jobs disabled by START_SCRAPE_JOBS=false");
  }
} catch (error) {
  console.error("[Startup] Failed to initialise backend:", error instanceof Error ? error.message : error);
  process.exit(1);
}
