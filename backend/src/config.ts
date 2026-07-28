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
  AUTH_JWT_SECRET: z.string().min(16).default("momas-dev-secret-change-me"),
  EPAIL_ADMIN_EMAIL: z.string().email().optional(),
  EPAIL_ADMIN_PASSWORD: z.string().min(8).optional(),
  environment: z.enum(["local", "production"]).default("production"),
});

export const env = envSchema.parse(process.env);
