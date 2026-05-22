/**
 * Drone tracking API.
 *
 * Live telemetry arrives over raw MAVLink TCP (see drones/mavlink-listener.ts).
 * This route exposes the in-memory live positions plus a drone registry that
 * maps each MAVLink System ID (sysid) to a real airframe / registration.
 *
 * Kept separate from the POCSTARS (radio) integration on purpose — different
 * transport, different identifiers, different lifecycle.
 */
import { Hono } from "hono";
import { canManageOrganization, primaryOrganization, requireAuth } from "../auth";
import * as db from "../db";
import { getDronePositions, getListenerStatus } from "../drones/mavlink-listener";

const router = new Hono();

router.use("*", requireAuth);

function jsonError(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error) };
}

/** Org scope for the current user. Admin → {} (sees everything). */
function orgScope(c: any) {
  const user = c.get("user");
  if (!user || user.platform_role === "admin") return {} as any;
  const org = primaryOrganization(user);
  return org
    ? { organizationId: org.organization_id, unitId: org.scope_level === "unit" ? org.unit_id : null }
    : { organizationId: -1 };
}

function isAdmin(c: any) {
  return c.get("user")?.platform_role === "admin";
}

/**
 * Live drone positions, joined with the registry.
 *
 * STAGE 1 (current): show every drone the server receives — registered or
 * not — to every signed-in user, so the raw MAVLink pipeline can be verified
 * end to end. Org-scoped visibility filtering will be layered on in a later
 * pass once ingestion is proven.
 */
router.get("/positions", async (c) => {
  try {
    const registry = await db.listDrones({}).catch(() => []);
    const regMap = new Map(registry.map((d: any) => [Number(d.sysid), d]));
    const live = getDronePositions();

    const visible = live;
    const drones = visible.map((d) => {
      const reg: any = regMap.get(d.sysid);
      return {
        ...d,
        name: reg?.name || `Drone ${d.sysid}`,
        registration: reg?.registration || null,
        model: reg?.model || null,
        operator: reg?.operator || null,
        organization_id: reg?.organization_id ?? null,
        registered: Boolean(reg),
      };
    });

    return c.json({ drones, registry, listener: getListenerStatus() });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

/** Listener health (TCP port, open connections, drones tracked). */
router.get("/status", (c) => c.json(getListenerStatus()));

/** Drone registry — the sysid → airframe/registration mapping. */
router.get("/registry", async (c) => {
  try {
    const drones = await db.listDrones(orgScope(c));
    return c.json({ drones });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

/** Create or update a registry entry. Admin or org manager only. */
router.post("/registry", async (c) => {
  const user: any = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  const sysid = parseInt(body.sysid, 10);
  if (!Number.isInteger(sysid) || sysid < 1 || sysid > 255) {
    return c.json({ error: "sysid must be an integer between 1 and 255" }, 400);
  }

  const membership = primaryOrganization(user);
  const admin = user?.platform_role === "admin";
  if (!admin && !canManageOrganization(membership)) {
    return c.json({ error: "forbidden" }, 403);
  }

  try {
    if (admin) {
      const drone = await db.upsertDrone({
        sysid,
        name: body.name,
        registration: body.registration,
        model: body.model,
        operator: body.operator,
        notes: body.notes,
        active: body.active ?? true,
        organization_id: body.organization_id || null,
        unit_id: body.unit_id || null,
      });
      await db.createAuditLog({
        organization_id: body.organization_id || null,
        actor_user_id: user?.id,
        action: "drone.upsert",
        target_type: "drone",
        target_id: String(sysid),
        metadata: {},
      });
      return c.json({ drone });
    }

    // Org manager: scoped to their own organization.
    const existing = await db.getDrone(sysid);
    if (existing && existing.organization_id && existing.organization_id !== membership.organization_id) {
      return c.json({ error: "forbidden" }, 403);
    }
    const drone = await db.upsertDrone({
      sysid,
      name: body.name,
      registration: body.registration,
      model: body.model,
      operator: body.operator,
      notes: body.notes,
      active: body.active ?? true,
      organization_id: membership.organization_id,
      unit_id: body.unit_id || (membership?.scope_level === "unit" ? membership.unit_id : null),
    });
    await db.createAuditLog({
      organization_id: membership.organization_id,
      actor_user_id: user?.id,
      action: "drone.upsert",
      target_type: "drone",
      target_id: String(sysid),
      metadata: {},
    });
    return c.json({ drone });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

/** Delete a registry entry. Admin only. */
router.delete("/registry/:sysid", async (c) => {
  if (!isAdmin(c)) return c.json({ error: "forbidden" }, 403);
  const sysid = parseInt(c.req.param("sysid"), 10);
  if (!Number.isInteger(sysid)) return c.json({ error: "invalid sysid" }, 400);
  try {
    const deleted = await db.deleteDrone(sysid);
    if (!deleted) return c.json({ error: "Drone not found" }, 404);
    return c.json({ ok: true });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

export default router;
