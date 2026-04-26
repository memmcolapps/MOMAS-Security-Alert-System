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
    must_change_password: user.must_change_password,
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

router.post("/change-password", requireAuth, async (c) => {
  const currentUser = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  const currentPassword = String(body.current_password || "");
  const newPassword = String(body.new_password || "");
  if (!currentPassword || !newPassword) {
    return c.json({ error: "Enter your current password and a new password." }, 400);
  }
  if (newPassword.length < 8) {
    return c.json({ error: "Your new password must be at least 8 characters." }, 400);
  }
  if (currentPassword === newPassword) {
    return c.json({ error: "Choose a new password that is different from your temporary password." }, 400);
  }
  const user = await db.getUserByEmail(currentUser.email);
  const ok = user ? await (Bun as any).password.verify(currentPassword, user.password_hash) : false;
  if (!ok) return c.json({ error: "Your current password is incorrect." }, 400);

  const updated = await db.updateUserPassword(currentUser.id, newPassword);
  const memberships = await db.getMembershipsForUser(currentUser.id);
  return c.json({
    user: {
      ...updated,
      memberships,
      active_organization_id: currentUser.active_organization_id,
      active_membership: currentUser.active_membership,
    },
  });
});

export default router;
