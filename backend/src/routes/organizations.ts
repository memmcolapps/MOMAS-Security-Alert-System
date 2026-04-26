import { Hono } from "hono";
import { requirePlatformAdmin } from "../auth";
import * as db from "../db";

const router = new Hono();

function jsonError(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error) };
}

function clientError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("platform admin") || message.includes("duplicate key")) {
    return {
      status: 400 as const,
      body: { error: message.includes("duplicate key") ? "A record with these details already exists." : message },
    };
  }
  return { status: 500 as const, body: { error: message } };
}

router.use("*", requirePlatformAdmin);

router.get("/", async (c) => {
  try {
    return c.json({ organizations: await db.listOrganizations() });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.name) return c.json({ error: "Enter an organization name." }, 400);
  try {
    const organization = await db.createOrganization({
      name: body.name,
      slug: body.slug,
      all_states: body.all_states,
      states: body.states || [],
      status: body.status || "active",
    });
    return c.json({ organization }, 201);
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const organization = await db.getOrganization(id);
  if (!organization) return c.json({ error: "That organization could not be found." }, 404);
  const [devices, users] = await Promise.all([
    db.listDevices({ organizationId: id }),
    db.listOrganizationUsers(id),
  ]);
  const [units, audit] = await Promise.all([
    db.listOrganizationUnits(id),
    db.listAuditLogs(id, 50),
  ]);
  return c.json({ organization, devices, users, units, audit });
});

router.put("/:id/access", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const organization = await db.updateOrganizationAccess(id, {
    name: body.name,
    status: body.status,
    all_states: body.all_states,
    states: body.states || [],
  });
  if (!organization) return c.json({ error: "That organization could not be found." }, 404);
  return c.json({ organization });
});

router.post("/:id/users", async (c) => {
  const organization_id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  if (!body.email || !body.password) {
    return c.json({ error: "Enter the user's email address and a temporary password." }, 400);
  }
  try {
    const user = await db.addOrganizationUser({
      organization_id,
      email: body.email,
      name: body.name,
      password: body.password,
      role: body.role || "org_admin",
    });
    await db.createAuditLog({
      organization_id,
      actor_user_id: (c as any).get("user")?.id,
      action: "user.upsert",
      target_type: "user",
      target_id: user.id,
      metadata: { email: body.email, role: body.role || "org_admin" },
    });
    return c.json({ user }, 201);
  } catch (error) {
    const next = clientError(error);
    return c.json(next.body, next.status);
  }
});

router.delete("/:id/users/:user_id", async (c) => {
  const organizationId = Number(c.req.param("id"));
  const userId = Number(c.req.param("user_id"));
  const removed = await db.removeOrganizationUser(organizationId, userId);
  if (!removed) return c.json({ error: "That user is not a member of this organization." }, 404);
  return c.json({ ok: true });
});

router.post("/:id/devices/:device_id", async (c) => {
  const organizationId = Number(c.req.param("id"));
  const device = await db.assignDeviceToOrganization(c.req.param("device_id"), organizationId);
  if (!device) return c.json({ error: "That device could not be found." }, 404);
  return c.json({ device });
});

router.delete("/:id/devices/:device_id", async (c) => {
  const device = await db.assignDeviceToOrganization(c.req.param("device_id"), null);
  if (!device) return c.json({ error: "That device could not be found." }, 404);
  return c.json({ device });
});

export default router;
