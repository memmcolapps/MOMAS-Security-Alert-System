/**
 * Platform stats: how reliably alarms get through, what has been failing, and
 * what has been turned away at the door.
 *
 * Owner-only, like the staff console. The page names the addresses and
 * accounts behind failed sign-ins, and lists this install's weak points.
 */
import { Hono } from "hono";
import { requirePlatform } from "../auth";
import { getPlatformStats, normalizeRange } from "../platform-stats";
import { sosPollStatus } from "./pocstars";

const router = new Hono();
router.use("*", requirePlatform("admin"));

router.get("/", async (c) => {
  try {
    return c.json(await getPlatformStats(normalizeRange(c.req.query("range")), sosPollStatus()));
  } catch (error) {
    console.error("[Stats] failed:", error instanceof Error ? error.message : error);
    return c.json({ error: "The stats could not be loaded." }, 500);
  }
});

export default router;
