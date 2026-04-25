import { Hono } from "hono";
import { requireAuth, signToken } from "../auth";
import * as db from "../db";

const router = new Hono();

router.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) return c.json({ error: "email and password are required" }, 400);

  const user = await db.getUserByEmail(email);
  if (!user || user.status !== "active") return c.json({ error: "invalid credentials" }, 401);
  const ok = await (Bun as any).password.verify(password, user.password_hash);
  if (!ok) return c.json({ error: "invalid credentials" }, 401);

  const memberships = await db.getMembershipsForUser(user.id);
  const safeUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    platform_role: user.platform_role,
    memberships,
  };
  const token = signToken({
    sub: user.id,
    email: user.email,
    platform_role: user.platform_role,
  });
  return c.json({ token, user: safeUser });
});

router.get("/me", requireAuth, async (c) => {
  return c.json({ user: (c as any).get("user") });
});

export default router;
