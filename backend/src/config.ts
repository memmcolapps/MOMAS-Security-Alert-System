import { z } from "zod";

const intFromEnv = (fallback: number) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return fallback;
    return Number(value);
  }, z.number().int().positive());

const boolFromEnv = (fallback: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return fallback;
    return String(value) !== "false";
  }, z.boolean());

const envSchema = z.object({
  PORT: intFromEnv(3000),
  START_SCRAPE_JOBS: boolFromEnv(true),
  SCRAPE_HOT_SEC: intFromEnv(90),
  SCRAPE_WARM_SEC: intFromEnv(300),
  SCRAPE_COLD_MIN: intFromEnv(30),
  FRONTEND_API_BASE: z.string().optional().default(""),
  FRONTEND_REFRESH_MS: intFromEnv(1_800_000),
  FRONTEND_MAX_MARKERS: intFromEnv(500),
  POCSTARS_LOC_BASE: z.string().url().default("http://143.105.173.49:9275"),
  POCSTARS_SOS_BASE: z.string().url().default("http://143.105.173.49:6891"),
  POCSTARS_MEDIA_BASE: z
    .string()
    .url()
    .default("http://143.105.173.49:6871/slmedia"),
  POCSTARS_RECORDINGS_BASE: z
    .string()
    .url()
    .default("http://recordfile.epailnigeria.com"),
  POCSTARS_RECORDINGS_USERNAME: z.string().default("aud"),
  POCSTARS_RECORDINGS_PASSWORD: z.string().default("l231sItal"),
  POCSTARS_TARGET_UID: z.string().default("583"),
  // POCSTARS dispatcher/recipient account used to claim and close SOS alarms.
  POCSTARS_DISPATCHER_UID: z.string().default("583"),
  // Dedicated POCSTARS dispatcher identity for live private calls. Keep host
  // empty to leave the feature disabled.
  POCSTARS_BRIDGE_URL: z.string().optional().default(""),
  POCSTARS_BRIDGE_TOKEN: z.string().optional().default(""),
  POCSTARS_PTT_TIMEOUT_MS: intFromEnv(10_000),
  POCSTARS_PTT_MAX_SECONDS: intFromEnv(60),
  // Drone tracking — raw MAVLink TCP listener (Mission Planner forwards here).
  MAVLINK_ENABLE: boolFromEnv(true),
  MAVLINK_TCP_HOST: z.string().default("0.0.0.0"),
  MAVLINK_TCP_PORT: intFromEnv(5760),
  DRONE_STALE_SEC: intFromEnv(30),
  DRONE_FORGET_SEC: intFromEnv(3600),
  // How often live drone telemetry is flushed to the DB so a last-seen
  // position survives restarts.
  DRONE_PERSIST_SEC: intFromEnv(15),
  // Monitoring-only geofencing. This never sends commands to a radio,
  // Mission Planner, or an autopilot.
  GEOFENCE_ENABLE: boolFromEnv(true),
  GEOFENCE_RADIO_POLL_SEC: intFromEnv(15),
  GEOFENCE_DEFAULT_BUFFER_M: intFromEnv(30),
  GEOFENCE_CONFIRMATIONS: intFromEnv(3),
  // No default, deliberately. This used to fall back to a fixed string that is
  // in the repository's history, while `environment` below defaults to
  // "production" - so a missing or mistyped value on the server would boot
  // normally and sign every session with a publicly known secret, letting
  // anyone mint a platform-owner token. Refusing to start is the safe failure.
  // The minimum stays at 16, the value it has always validated against.
  // Raising it here would refuse to start on any server whose existing secret
  // is shorter - a config change disguised as a security fix. Rotate to a
  // longer secret deliberately; it invalidates every live session.
  AUTH_JWT_SECRET: z
    .string({ error: "AUTH_JWT_SECRET is not set. Generate one with: openssl rand -hex 48" })
    .min(16, "AUTH_JWT_SECRET must be at least 16 characters. Generate one with: openssl rand -hex 48"),
  EPAIL_ADMIN_EMAIL: z.string().email().optional(),
  EPAIL_ADMIN_PASSWORD: z.string().min(8).optional(),
  environment: z.enum(["local", "production"]).default("production"),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (parsed.success) return parsed.data;
  // A raw ZodError dump in journald is how a five-second fix becomes an
  // afternoon. Name the variables and stop.
  const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
  console.error(`[Config] Refusing to start - invalid environment:\n${lines.join("\n")}`);
  process.exit(1);
}

export const env = loadEnv();
