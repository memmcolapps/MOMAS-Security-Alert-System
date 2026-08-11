import { Hono } from "hono";
import { requirePlatformAdmin } from "../auth";
import * as db from "../db";
import { liveRadioConfigured, provisionOnNetwork, queryPocstarsInventory } from "../pocstars/live-gateway";

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

// Onboard a physical handset. The radio network assigns the id, so it is
// created there first and recorded here afterwards - the reverse would invent a
// device_id that no radio answers to, which is how a console ends up listing
// radios that can never be called.
router.post("/radios", async (c) => {
  const user = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  const organizationId = Number(body.organization_id);
  const imei = String(body.imei || "").trim();
  const name = String(body.name || "").trim();

  // No organization is a valid answer: radios are bought before anyone has been
  // given them, and an unallocated radio waits in the pool.
  if (body.organization_id != null && (!Number.isSafeInteger(organizationId) || organizationId <= 0)) {
    return c.json({ error: "Choose the organization this radio belongs to, or leave it unallocated." }, 400);
  }
  if (!/^\d{10,20}$/.test(imei)) {
    return c.json({ error: "Enter the IMEI printed on the handset." }, 400);
  }
  if (!name) return c.json({ error: "Give the radio a name." }, 400);

  const allocated = body.organization_id != null;
  try {
    let companyId: number | null = null;
    if (allocated) {
      const organization = await db.getOrganization(organizationId);
      if (!organization) return c.json({ error: "That organization could not be found." }, 404);
      companyId = Number(organization.pocstars_company_id);
      if (!Number.isSafeInteger(companyId) || companyId <= 0) {
        return c.json({
          error: "That organization has no company on the radio network yet, so a radio cannot be added to it.",
        }, 409);
      }
    }

    // A null company sends the radio to the pool, where it is inventoried but
    // reaches nobody until it is allocated.
    const radio: any = await provisionOnNetwork("provision.radio.create", {
      companyId,
      imei,
      name,
      channelIds: Array.isArray(body.channel_ids) ? body.channel_ids : [],
      defaultChannelId: body.default_channel_id ?? null,
      serviceEndsAt: body.service_ends_at || "2030-01-01 00:00:00",
      gpsEnabled: body.gps_enabled !== false,
      gpsFrequency: Number(body.gps_frequency || 30),
    });

    // The network is the source of truth for identity, so the uid it assigned
    // becomes the device_id here. Marked pocstars_managed so the inventory sync
    // owns it from now on rather than treating it as a hand-entered stray.
    const device = await db.upsertPocstarsDevice({
      device_id: String(radio.uid),
      organization_id: allocated ? organizationId : null,
      unit_id: body.unit_id ? Number(body.unit_id) : null,
      name,
      operator: body.operator || null,
      device_type: body.device_type || "handheld",
      notes: body.notes || null,
    });

    await db.createAuditLog({
      organization_id: allocated ? organizationId : null,
      actor_user_id: user?.id || null,
      action: "radio.onboard",
      target_type: "device",
      target_id: String(radio.uid),
      metadata: { imei, name, channels: radio.channels, defaultChannelId: radio.defaultChannelId },
    });
    return c.json({ device, radio }, 201);
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
  const deviceId = c.req.param("device_id");
  try {
    // Allocation has to happen on the radio network first. Recording it here
    // alone would leave MOMAS asserting an ownership the network disagrees
    // with: the receiving organization's dispatcher seats lease against their
    // own company, so a radio still filed under the old one is invisible to
    // them however confidently this console lists it.
    let network: any = null;
    const existing = await db.getDevice(deviceId);
    if (existing?.pocstars_managed) {
      const companyId = organizationId
        ? Number((await db.getOrganization(organizationId))?.pocstars_company_id)
        : await poolCompanyId();
      if (!Number.isSafeInteger(companyId) || companyId <= 0) {
        return c.json({
          error: "That organization has no company on the radio network yet, so a radio cannot be allocated to it.",
        }, 409);
      }
      network = await provisionOnNetwork("provision.radio.reassign", {
        companyId,
        uid: Number(deviceId),
        channelIds: Array.isArray(body.channel_ids) ? body.channel_ids : [],
        defaultChannelId: body.default_channel_id ?? null,
      });
    }

    const device = await db.allocateDeviceToOrganization(deviceId, organizationId);
    await db.createAuditLog({
      organization_id: organizationId,
      actor_user_id: user?.id || null,
      action: organizationId ? "radio.allocate" : "radio.deallocate",
      target_type: "device",
      target_id: device.device_id,
      metadata: { organization_id: organizationId, network },
    });
    return c.json({ device, network });
  } catch (error) {
    return c.json(jsonError(error), 409);
  }
});

// Deallocation returns a radio to the pool rather than leaving it inside the
// organization that just gave it up.
async function poolCompanyId() {
  const result: any = await provisionOnNetwork("provision.pool", { create: true });
  return Number(result?.companyId);
}

router.post("/groups/:group_id/assign", async (c) => {
  const user = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));

  // A null organization releases the channel. Assignment used to be one-way,
  // which made a mis-assigned channel a database repair job.
  if (body.organization_id === null) {
    try {
      const result = await db.unassignPocstarsGroup(c.req.param("group_id"));
      await db.createAuditLog({
        organization_id: result.organization_id,
        actor_user_id: user?.id || null,
        action: "pocstars.group.unassign",
        target_type: "pocstars_group",
        target_id: result.group_id,
        metadata: result,
      });
      return c.json({ result });
    } catch (error) {
      return c.json(jsonError(error), 409);
    }
  }

  const organizationId = Number(body.organization_id);
  if (!Number.isSafeInteger(organizationId) || organizationId <= 0) {
    return c.json({ error: "Choose the organization this channel belongs to." }, 400);
  }
  try {
    const result = await db.assignPocstarsGroupToOrganization({
      group_id: c.req.param("group_id"),
      organization_id: organizationId,
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
