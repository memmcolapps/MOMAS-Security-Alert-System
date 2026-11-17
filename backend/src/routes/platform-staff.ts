/**
 * Platform staff administration.
 *
 * Until now the only platform account was the one the VPS bootstrap creates
 * from EPAIL_ADMIN_EMAIL, and there was no way to add a second without a shell
 * on the server. This console adds that, with tiers - see PLATFORM_RANK in
 * auth.ts - so that "can watch every tenant" and "can delete a tenant" stop
 * being the same grant.
 *
 * The whole router is owner-only. Reading the staff list is as sensitive as
 * changing it: it names every account that can see across the tenancy line.
 */
import { Hono } from "hono";
import {
  ASSIGNABLE_PLATFORM_ROLES,
  PLATFORM_ROLE_LABELS,
  normalizePlatformRole,
  platformRank,
  requirePlatform,
} from "../auth";
import * as db from "../db";
import { setPhoneAllowed } from "../security/credentials";
import { getPlatformPolicy, mergePolicies, setPlatformPolicy } from "../security/policy";
import { endOtherSessions, endSession, listDevices, listPendingDevices, listSessions, setDeviceStatus } from "../security/sessions";

const router = new Hono();
router.use("*", requirePlatform("admin"));

function jsonError(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error) };
}

// A 400 is the honest status for "that role does not exist" or "you may not go
// that high"; the request was understood and refused on its contents.
function clientError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const expected = /is not a platform role|already belongs|Enter a temporary password|cannot/i.test(message);
  return { body: { error: message }, status: expected ? 400 : 500 } as const;
}

router.get("/", async (c) => {
  try {
    const [staff, audit] = await Promise.all([
      db.listPlatformStaff(),
      db.listPlatformAuditLogs(50),
    ]);
    return c.json({
      staff,
      audit,
      roles: ASSIGNABLE_PLATFORM_ROLES.map((role) => ({ role, label: PLATFORM_ROLE_LABELS[role] })),
      me: (c as any).get("user")?.id ?? null,
    });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/", async (c) => {
  const actor = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || "").trim();
  if (!email) return c.json({ error: "Enter an email address." }, 400);

  try {
    const role = normalizePlatformRole(body.platform_role);
    // No escalation: nobody may hand out more than they hold. Owners hold the
    // top tier, so in practice this only bites if a lower tier ever reaches
    // this router - but it is the invariant that keeps that safe.
    if (platformRank({ platform_role: role }) > platformRank(actor)) {
      return c.json({ error: "You cannot grant a role above your own." }, 403);
    }
    const user = await db.createPlatformStaff({
      email,
      name: body.name,
      password: body.password,
      platform_role: role,
    });
    await db.createAuditLog({
      organization_id: null,
      actor_user_id: actor?.id,
      action: "platform.staff.create",
      target_type: "user",
      target_id: user.id,
      metadata: { email: user.email, platform_role: role },
    });
    return c.json({ user }, 201);
  } catch (error) {
    const next = clientError(error);
    return c.json(next.body, next.status);
  }
});

// ── Sign-in security ────────────────────────────────────────────────────────
// The platform's rules for phones and new devices - the loosest any
// organization may have - and platform staff members' signed-in devices.
// Registered before the "/:id" routes so "/security" is not taken for an id.

router.get("/security", async (c) => {
  const [policy, pending] = await Promise.all([getPlatformPolicy(), listPendingDevices({ platformStaff: true })]);
  return c.json({ policy: mergePolicies(policy), pending });
});

router.put("/security", async (c) => {
  const actor = (c as any).get("user");
  try {
    const policy = await setPlatformPolicy(await c.req.json().catch(() => ({})), actor.id);
    await db.createAuditLog({
      organization_id: null,
      actor_user_id: actor.id,
      action: "platform.security.rules.update",
      target_type: "platform",
      target_id: null,
      metadata: policy,
    });
    return c.json({ policy: mergePolicies(policy) });
  } catch (error) {
    return c.json(jsonError(error), 400);
  }
});

async function managedStaff(c: any) {
  const actor = c.get("user");
  const userId = Number(c.req.param("id"));
  if (!Number.isInteger(userId)) return { error: c.json({ error: "Invalid person." }, 400) };
  if (userId === Number(actor.id)) {
    return { error: c.json({ error: "Manage your own devices on your Security page." }, 400) };
  }
  const user = await db.getUserById(userId);
  if (!user || user.platform_role === "none") return { error: c.json({ error: "That person is not platform staff." }, 404) };
  return { userId, user };
}

async function staffAudit(c: any, userId: number, action: string, metadata: Record<string, unknown> = {}) {
  await db.createAuditLog({
    organization_id: null,
    actor_user_id: c.get("user")?.id ?? null,
    action: `platform.security.${action}`,
    target_type: "user",
    target_id: userId,
    metadata,
  });
}

router.get("/:id/security", async (c) => {
  const staff = await managedStaff(c);
  if (staff.error) return staff.error;
  const [sessions, devices] = await Promise.all([listSessions(staff.userId), listDevices(staff.userId)]);
  return c.json({ sessions, devices, phone_allowed: staff.user.phone_allowed !== false });
});

router.post("/:id/sessions/:session_id/end", async (c) => {
  const staff = await managedStaff(c);
  if (staff.error) return staff.error;
  const ended = await endSession(staff.userId, c.req.param("session_id"), "signed out by an admin", (c as any).get("user").id);
  if (!ended) return c.json({ error: "That sign-in has already ended." }, 404);
  await staffAudit(c, staff.userId, "session.end");
  return c.json({ ok: true });
});

router.post("/:id/sign-out-everywhere", async (c) => {
  const staff = await managedStaff(c);
  if (staff.error) return staff.error;
  const ended = await endOtherSessions(staff.userId, null, "signed out by an admin", (c as any).get("user").id);
  await staffAudit(c, staff.userId, "session.end_all", { ended });
  return c.json({ ok: true, ended });
});

router.post("/:id/devices/:device_id/:decision", async (c) => {
  const staff = await managedStaff(c);
  if (staff.error) return staff.error;
  const decision = c.req.param("decision");
  const deviceId = Number(c.req.param("device_id"));
  if (!["approve", "block"].includes(decision) || !Number.isInteger(deviceId)) return c.json({ error: "Unknown action." }, 400);
  const device = await setDeviceStatus(staff.userId, deviceId, decision === "approve" ? "approved" : "blocked", (c as any).get("user").id);
  if (!device) return c.json({ error: "That device was not found." }, 404);
  await staffAudit(c, staff.userId, `device.${decision}`, { device: device.label });
  return c.json({ device });
});

router.put("/:id/phone", async (c) => {
  const staff = await managedStaff(c);
  if (staff.error) return staff.error;
  const allowed = Boolean((await c.req.json().catch(() => ({}))).allowed);
  await setPhoneAllowed(staff.userId, allowed);
  if (!allowed) {
    const phones = (await listSessions(staff.userId)).filter((session: any) => session.is_phone);
    for (const session of phones) await endSession(staff.userId, session.id, "phone sign-in turned off", (c as any).get("user").id);
  }
  await staffAudit(c, staff.userId, allowed ? "phone.allow" : "phone.block");
  return c.json({ ok: true, allowed });
});

router.put("/:id", async (c) => {
  const actor = (c as any).get("user");
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));

  // Changing your own tier is how an owner locks themselves out mid-edit, and
  // it is never necessary: another owner can do it.
  if (id === Number(actor?.id)) {
    return c.json({ error: "You cannot change your own role." }, 400);
  }

  try {
    const role = normalizePlatformRole(body.platform_role);
    if (platformRank({ platform_role: role }) > platformRank(actor)) {
      return c.json({ error: "You cannot grant a role above your own." }, 403);
    }
    const existing = (await db.listPlatformStaff()).find((row: any) => Number(row.id) === id);
    if (!existing) return c.json({ error: "That platform user could not be found." }, 404);

    // Demoting the last owner would leave an install nobody can administer, and
    // the VPS bootstrap will not undo it: it skips an email that already exists.
    if (existing.platform_role === "admin" && role !== "admin" && (await db.countPlatformOwners(id)) === 0) {
      return c.json({ error: "This is the last platform owner. Promote somebody else first." }, 409);
    }

    const user = await db.updatePlatformStaffRole(id, role);
    if (!user) return c.json({ error: "That platform user could not be found." }, 404);
    await db.createAuditLog({
      organization_id: null,
      actor_user_id: actor?.id,
      action: "platform.staff.role",
      target_type: "user",
      target_id: id,
      metadata: { email: user.email, from: existing.platform_role, to: role },
    });
    return c.json({ user });
  } catch (error) {
    const next = clientError(error);
    return c.json(next.body, next.status);
  }
});

router.delete("/:id", async (c) => {
  const actor = (c as any).get("user");
  const id = Number(c.req.param("id"));
  if (id === Number(actor?.id)) {
    return c.json({ error: "You cannot remove your own account." }, 400);
  }

  try {
    const existing = (await db.listPlatformStaff()).find((row: any) => Number(row.id) === id);
    if (!existing) return c.json({ error: "That platform user could not be found." }, 404);
    if (existing.platform_role === "admin" && (await db.countPlatformOwners(id)) === 0) {
      return c.json({ error: "This is the last platform owner and cannot be removed." }, 409);
    }

    const user = await db.deletePlatformStaff(id);
    if (!user) return c.json({ error: "That platform user could not be found." }, 404);
    // audit_logs.actor_user_id is ON DELETE SET NULL, so the address is recorded
    // in the metadata here or the trail loses who this row was ever about.
    await db.createAuditLog({
      organization_id: null,
      actor_user_id: actor?.id,
      action: "platform.staff.remove",
      target_type: "user",
      target_id: id,
      metadata: { email: user.email, platform_role: user.platform_role },
    });
    return c.json({ ok: true, user });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

export default router;
