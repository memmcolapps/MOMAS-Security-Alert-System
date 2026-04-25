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
  POCSTARS_LOC_BASE: z.string().url().default("http://102.221.238.124:9275"),
  POCSTARS_SOS_BASE: z.string().url().default("http://102.221.238.124:6891"),
  POCSTARS_TARGET_UID: z.string().default("583"),
});

export const env = envSchema.parse(process.env);
