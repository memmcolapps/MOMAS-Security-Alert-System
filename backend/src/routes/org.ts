import { Hono } from "hono";
import { canManageOrganization, canManageUnit, primaryOrganization, requireOrgManager } from "../auth";
import * as db from "../db";

const router = new Hono();

router.use("*", requireOrgManager);

function jsonError(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error) };
}

function organizationIdFor(c: any) {
  const user = c.get("user");
  if (user?.platform_role === "admin") return Number(c.req.query("organization_id") || 0);
  return primaryOrganization(user)?.organization_id;
}

function actor(c: any) {
  return c.get("user")?.id || null;
}

function isPlatformAdmin(c: any) {
  return c.get("user")?.platform_role === "admin";
}

function membership(c: any) {
  return c.get("membership");
}

function unitScoped(c: any) {
  const current = membership(c);
  return !isPlatformAdmin(c) && current?.scope_level === "unit" && current?.unit_id ? Number(current.unit_id) : null;
}

router.get("/", async (c) => {
  const organizationId = organizationIdFor(c);
  if (!organizationId) return c.json({ error: "organization required" }, 400);
  const scopedUnitId = unitScoped(c);
  const [organization, allUsers, allUnits, devices, audit] = await Promise.all([
    db.getOrganization(organizationId),
    db.listOrganizationUsers(organizationId),
    db.listOrganizationUnits(organizationId),
    db.listDevices({ organizationId, unitId: scopedUnitId }),
    db.listAuditLogs(organizationId, 100),
  ]);
  if (!organization) return c.json({ error: "organization not found" }, 404);
  const users = scopedUnitId ? allUsers.filter((user) => Number(user.unit_id) === scopedUnitId) : allUsers;
  const units = scopedUnitId ? allUnits.filter((unit) => Number(unit.id) === scopedUnitId || Number(unit.parent_unit_id) === scopedUnitId) : allUnits;
  return c.json({ organization, users, units, devices, audit });
});

router.get("/users", async (c) => {
  const organizationId = organizationIdFor(c);
  const users = await db.listOrganizationUsers(organizationId);
  const scopedUnitId = unitScoped(c);
  return c.json({ users: scopedUnitId ? users.filter((user) => Number(user.unit_id) === scopedUnitId) : users });
});

router.post("/users", async (c) => {
  const organizationId = organizationIdFor(c);
  const body = await c.req.json().catch(() => ({}));
  if (!body.email) return c.json({ error: "email is required" }, 400);
  if (!canManageUnit(membership(c), body.unit_id ? Number(body.unit_id) : null) && !isPlatformAdmin(c)) {
    return c.json({ error: "forbidden" }, 403);
  }
  try {
    const user = await db.upsertOrganizationUser({
      organization_id: organizationId,
      email: body.email,
      name: body.name,
      password: body.password,
      role: body.role || "viewer",
      unit_id: body.unit_id || null,
      scope_level: body.scope_level || (body.unit_id ? "unit" : "organization"),
    });
    await db.createAuditLog({
      organization_id: organizationId,
      actor_user_id: actor(c),
      action: "user.upsert",
      target_type: "user",
      target_id: user.id,
      metadata: { email: body.email, role: body.role || "viewer", unit_id: body.unit_id || null },
    });
    return c.json({ user }, 201);
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.delete("/users/:user_id", async (c) => {
  const organizationId = organizationIdFor(c);
  const userId = Number(c.req.param("user_id"));
  const removed = await db.removeOrganizationUser(organizationId, userId);
  if (!removed) return c.json({ error: "membership not found" }, 404);
  await db.createAuditLog({
    organization_id: organizationId,
    actor_user_id: actor(c),
    action: "user.remove",
    target_type: "user",
    target_id: userId,
  });
  return c.json({ ok: true });
});

router.get("/units", async (c) => {
  const organizationId = organizationIdFor(c);
  const units = await db.listOrganizationUnits(organizationId);
  const scopedUnitId = unitScoped(c);
  return c.json({ units: scopedUnitId ? units.filter((unit) => Number(unit.id) === scopedUnitId || Number(unit.parent_unit_id) === scopedUnitId) : units });
});

router.post("/units", async (c) => {
  const organizationId = organizationIdFor(c);
  const body = await c.req.json().catch(() => ({}));
  if (!body.name) return c.json({ error: "name is required" }, 400);
  if (!isPlatformAdmin(c) && !canManageOrganization(membership(c))) return c.json({ error: "forbidden" }, 403);
  try {
    const unit = await db.createOrganizationUnit({
      organization_id: organizationId,
      parent_unit_id: body.parent_unit_id || null,
      name: body.name,
      type: body.type || "station",
      state: body.state,
      lga: body.lga,
      location: body.location,
    });
    await db.createAuditLog({
      organization_id: organizationId,
      actor_user_id: actor(c),
      action: "unit.create",
      target_type: "unit",
      target_id: unit.id,
      metadata: { name: unit.name, type: unit.type, state: unit.state },
    });
    return c.json({ unit }, 201);
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.put("/units/:unit_id", async (c) => {
  const organizationId = organizationIdFor(c);
  const unitId = Number(c.req.param("unit_id"));
  if (!canManageUnit(membership(c), unitId) && !isPlatformAdmin(c)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const unit = await db.updateOrganizationUnit(organizationId, unitId, body);
  if (!unit) return c.json({ error: "unit not found" }, 404);
  await db.createAuditLog({
    organization_id: organizationId,
    actor_user_id: actor(c),
    action: "unit.update",
    target_type: "unit",
    target_id: unitId,
    metadata: body,
  });
  return c.json({ unit });
});

router.delete("/units/:unit_id", async (c) => {
  const organizationId = organizationIdFor(c);
  const unitId = Number(c.req.param("unit_id"));
  if (!canManageUnit(membership(c), unitId) && !isPlatformAdmin(c)) return c.json({ error: "forbidden" }, 403);
  const removed = await db.deleteOrganizationUnit(organizationId, unitId);
  if (!removed) return c.json({ error: "unit not found" }, 404);
  await db.createAuditLog({
    organization_id: organizationId,
    actor_user_id: actor(c),
    action: "unit.delete",
    target_type: "unit",
    target_id: unitId,
  });
  return c.json({ ok: true });
});

router.post("/devices/:device_id/unit", async (c) => {
  const organizationId = organizationIdFor(c);
  const body = await c.req.json().catch(() => ({}));
  const unitId = body.unit_id ? Number(body.unit_id) : null;
  if (!canManageUnit(membership(c), unitId) && !isPlatformAdmin(c)) return c.json({ error: "forbidden" }, 403);
  const device = await db.assignDeviceToUnit(c.req.param("device_id"), organizationId, unitId);
  if (!device) return c.json({ error: "device not found" }, 404);
  await db.createAuditLog({
    organization_id: organizationId,
    actor_user_id: actor(c),
    action: "device.assign_unit",
    target_type: "device",
    target_id: c.req.param("device_id"),
    metadata: { unit_id: unitId },
  });
  return c.json({ device });
});

router.get("/audit", async (c) => {
  const organizationId = organizationIdFor(c);
  return c.json({ audit: await db.listAuditLogs(organizationId, Number(c.req.query("limit") || 100)) });
});

export default router;
