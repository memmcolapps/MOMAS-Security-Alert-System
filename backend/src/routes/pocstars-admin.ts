import { Hono } from "hono";
import { requirePlatform } from "../auth";
import * as db from "../db";
import { liveRadioConfigured, provisionOnNetwork, queryPocstarsInventory } from "../pocstars/live-gateway";
import { freshRadioProvisioningPayload } from "../pocstars/radio-onboarding";

const router = new Hono();

function jsonError(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error) };
}

// The registry is a read every tier needs; onboarding and moving radios is
// operator work, because each of those writes lands on the vendor network.
router.use("*", requirePlatform("support"));
const requireOps = requirePlatform("ops");

router.get("/registry", async (c) => {
  try {
    const registry = await db.listPocstarsRegistry();
    return c.json({ ...registry, configured: liveRadioConfigured() });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/sync", requireOps, async (c) => {
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
router.post("/radios", requireOps, async (c) => {
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
    // reaches nobody until it is allocated. A newly onboarded radio never has
    // a channel: the organization creates its channels and adds the handset
    // through channel management after the radio exists.
    const radio: any = await provisionOnNetwork(
      "provision.radio.create",
      freshRadioProvisioningPayload({ body, companyId, imei, name }),
    );

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
      imei,
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
// `channel_ids` are MOMAS channel ids from the platform picker (not vendor
// group ids): they are validated against the target organization, resolved to
// vendor groups for the network call, and mirrored into channel_devices after
// the move. Absent means "no channels", which is the historic behavior.
router.post("/devices/:device_id/allocate", requireOps, async (c) => {
  const user = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  const organizationId = body.organization_id === null ? null : Number(body.organization_id);
  if (organizationId !== null && (!Number.isSafeInteger(organizationId) || organizationId <= 0)) {
    return c.json({ error: "Choose the organization this radio belongs to." }, 400);
  }
  const rawChannelIds = body.channel_ids === undefined ? [] : body.channel_ids;
  if (!Array.isArray(rawChannelIds)) {
    return c.json({ error: "Channels must be a list." }, 400);
  }
  const channelIds = [...new Set(rawChannelIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (channelIds.length !== rawChannelIds.length) {
    return c.json({ error: "One of the selected channels is not valid." }, 400);
  }
  if (organizationId === null && channelIds.length) {
    return c.json({ error: "Unallocated radios cannot be on any channel." }, 400);
  }
  const deviceId = c.req.param("device_id");
  try {
    const existing = await db.getDevice(deviceId);
    if (!existing) return c.json({ error: "That radio could not be found." }, 404);
    let picked: Array<{ id: number; name: string; pocstars_group_id: string }> = [];
    if (organizationId !== null) {
      const organization = await db.getOrganization(organizationId);
      if (!organization) return c.json({ error: "That organization could not be found." }, 404);
      try {
        picked = await db.validateOrganizationChannels(channelIds, organizationId);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    const vendorGroupIds = picked.map((row) => Number(row.pocstars_group_id));
    // Allocation has to happen on the radio network first. Recording it here
    // alone would leave MOMAS asserting an ownership the network disagrees
    // with: the receiving organization's dispatcher seats lease against their
    // own company, so a radio still filed under the old one is invisible to
    // them however confidently this console lists it.
    let network: any = null;
    if (existing?.pocstars_managed) {
      const companyId = organizationId
        ? Number((await db.getOrganization(organizationId))?.pocstars_company_id)
        : await poolCompanyId();
      if (!Number.isSafeInteger(companyId) || companyId <= 0) {
        return c.json({
          error: "That organization has no company on the radio network yet, so a radio cannot be allocated to it.",
        }, 409);
      }
      // The move only adds memberships, so channels dropped within the same
      // company are left explicitly first, while the radio is still there to
      // be removed: the bridge refuses the call once the radio has moved.
      // Across companies the move itself deactivates the stale rows below.
      const orgChanged = Number(existing.organization_id) !== Number(organizationId);
      if (!orgChanged && organizationId !== null) {
        const current = await db.getDeviceChannelGroups(deviceId);
        const wanted = new Set(vendorGroupIds);
        const removed = current
          .map((row) => Number(row.pocstars_group_id))
          .filter((groupId) => Number.isSafeInteger(groupId) && groupId > 0 && !wanted.has(groupId));
        for (const groupId of removed) {
          await provisionOnNetwork("provision.radio.channel", {
            companyId,
            groupId,
            radioUid: Number(deviceId),
            member: false,
          });
        }
      }
      network = await provisionOnNetwork("provision.radio.reassign", {
        companyId,
        uid: Number(deviceId),
        channelIds: vendorGroupIds,
        defaultChannelId: null,
      });
    }

    const device = await db.allocateDeviceToOrganization(deviceId, organizationId);
    if (channelIds.length) await db.setDeviceChannels(deviceId, channelIds);
    await db.createAuditLog({
      organization_id: organizationId,
      actor_user_id: user?.id || null,
      action: organizationId ? "radio.allocate" : "radio.deallocate",
      target_type: "device",
      target_id: device.device_id,
      metadata: { organization_id: organizationId, channel_ids: channelIds, network },
    });
    return c.json({ device, network, channels: channelIds });
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

router.post("/channels", requireOps, async (c) => {
  const user = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  const organizationId = Number(body.organization_id);
  const name = String(body.name || "").trim();
  if (!Number.isSafeInteger(organizationId) || organizationId <= 0) {
    return c.json({ error: "Choose the company this channel belongs to." }, 400);
  }
  if (!name) return c.json({ error: "Enter a channel name." }, 400);
  try {
    const organization = await db.getOrganization(organizationId);
    if (!organization) return c.json({ error: "That organization could not be found." }, 404);
    // Platform-created channels are always whole-organization. Unit pinning is
    // left to the org admins in their own console.
    const companyId = Number(organization.pocstars_company_id);
    if (!Number.isSafeInteger(companyId) || companyId <= 0) {
      return c.json({
        error: "That organization has no company on the radio network yet, so a channel cannot be created for it. Set it up on the radio network first.",
      }, 409);
    }
    // Refuse to provision into a vendor company another tenant already owns:
    // seats are shared per company, so that tenant's dispatchers would see
    // everything created here.
    const shared = await db.organizationsSharingCompanyId(companyId, organizationId);
    if (shared.length) {
      return c.json({
        error: `This organization shares a radio-network company with ${shared[0].name}. A platform owner must give it its own company before channels can be created.`,
      }, 409);
    }
    const channel = await db.createChannel({
      organization_id: organizationId,
      name,
      unit_id: null,
    });
    try {
      const created: any = await provisionOnNetwork("provision.channel.create", {
        companyId,
        name: channel.name,
      });
      const groupId = Number(created?.groupId || 0);
      if (groupId) Object.assign(channel, await db.markChannelProvisioned(channel.id, groupId));
    } catch (error) {
      return c.json({
        channel,
        warning: error instanceof Error ? error.message : "The channel is not live on the radio network yet.",
      }, 201);
    }
    await db.createAuditLog({
      organization_id: organizationId,
      actor_user_id: user?.id || null,
      action: "channel.create",
      target_type: "channel",
      target_id: channel.id,
      metadata: { name: channel.name, via: "platform" },
    });
    return c.json({ channel }, 201);
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/groups/:group_id/assign", requireOps, async (c) => {
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
    // Which vendor company owns this talk group. Claiming a channel is how an
    // organization that already has an estate on the network reveals where it
    // actually lives, so the assignment needs to know.
    const groupId = c.req.param("group_id");
    const owner: any = await provisionOnNetwork("provision.company.forGroup", { groupId: Number(groupId) })
      .catch(() => null);

    const result = await db.assignPocstarsGroupToOrganization({
      group_id: groupId,
      organization_id: organizationId,
      group_company_id: owner?.companyId ?? null,
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
