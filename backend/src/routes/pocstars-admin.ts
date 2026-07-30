import { Hono } from "hono";
import { requirePlatformAdmin } from "../auth";
import * as db from "../db";
import { liveRadioConfigured, queryPocstarsInventory } from "../pocstars/live-gateway";

const router = new Hono();

function jsonError(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error) };
}

router.use("*", requirePlatformAdmin);

router.get("/registry", async (c) => {
  try {
    const registry = await db.listPocstarsRegistry();
    return c.json({ ...registry, configured: liveRadioConfigured() });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/sync", async (c) => {
  const user = (c as any).get("user");
  try {
    const inventory = await queryPocstarsInventory();
    const summary = await db.syncPocstarsPlatformInventory(inventory);
    await db.createAuditLog({
      organization_id: null,
      actor_user_id: user?.id || null,
      action: "pocstars.inventory.sync",
      target_type: "pocstars_dispatcher",
      target_id: inventory?.dispatcher?.id ?? null,
      metadata: summary,
    });
    return c.json({ summary });
  } catch (error) {
    return c.json(jsonError(error), 409);
  }
});

// Allocation is a platform-admin act: a handset is physical and belongs to
// exactly one organization. Orgs arrange their allocated radios themselves.
router.post("/devices/:device_id/allocate", async (c) => {
  const user = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  const organizationId = body.organization_id === null ? null : Number(body.organization_id);
  if (organizationId !== null && (!Number.isSafeInteger(organizationId) || organizationId <= 0)) {
    return c.json({ error: "Choose the organization this radio belongs to." }, 400);
  }
  try {
    const device = await db.allocateDeviceToOrganization(c.req.param("device_id"), organizationId);
    await db.createAuditLog({
      organization_id: organizationId,
      actor_user_id: user?.id || null,
      action: organizationId ? "radio.allocate" : "radio.deallocate",
      target_type: "device",
      target_id: device.device_id,
      metadata: { organization_id: organizationId },
    });
    return c.json({ device });
  } catch (error) {
    return c.json(jsonError(error), 409);
  }
});

router.post("/groups/:group_id/assign", async (c) => {
  const user = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  const organizationId = Number(body.organization_id);
  if (!Number.isSafeInteger(organizationId) || organizationId <= 0) {
    return c.json({ error: "Choose the organization this POCSTARS group belongs to." }, 400);
  }
  try {
    const result = await db.assignPocstarsGroupToOrganization({
      group_id: c.req.param("group_id"),
      organization_id: organizationId,
      unit_name: body.unit_name ? String(body.unit_name) : undefined,
    });
    await db.createAuditLog({
      organization_id: organizationId,
      actor_user_id: user?.id || null,
      action: "pocstars.group.assign",
      target_type: "pocstars_group",
      target_id: result.group_id,
      metadata: result,
    });
    return c.json({ result });
  } catch (error) {
    return c.json(jsonError(error), 409);
  }
});

export default router;
