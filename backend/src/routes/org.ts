import { Hono } from "hono";
import {
  canManageOrganization,
  canManageUnit,
  isPlatformStaff,
  normalizeOrgRole,
  primaryOrganization,
  requireOrgManager,
} from "../auth";
import * as db from "../db";
import { provisionOnNetwork } from "../pocstars/live-gateway";

const router = new Hono();

router.use("*", requireOrgManager);

function jsonError(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error) };
}

function clientError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("platform admin") ||
    message.includes("temporary password") ||
    message.includes("duplicate key") ||
    message.includes("is not a role")
  ) {
    return { status: 400 as const, body: { error: message.includes("duplicate key") ? "A record with these details already exists." : message } };
  }
  return { status: 500 as const, body: { error: message } };
}

function organizationIdFor(c: any) {
  const user = c.get("user");
  if (isPlatformStaff(user)) return Number(c.req.query("organization_id") || 0);
  return primaryOrganization(user)?.organization_id;
}

function actor(c: any) {
  return c.get("user")?.id || null;
}

// Platform staff acting inside an organization console. Support never reaches
// the write paths that consult this - requireOrgManager refuses its non-GET
// requests before the handler runs.
function isPlatformAdmin(c: any) {
  return isPlatformStaff(c.get("user"));
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
  if (!organizationId) return c.json({ error: "Select an organization before opening the admin console." }, 400);
  const scopedUnitId = unitScoped(c);
  const [organization, allUsers, allUnits, devices, audit] = await Promise.all([
    db.getOrganization(organizationId),
    db.listOrganizationUsers(organizationId),
    db.listOrganizationUnits(organizationId),
    db.listDevices({ organizationId, unitId: scopedUnitId }),
    db.listAuditLogs(organizationId, 100),
  ]);
  if (!organization) return c.json({ error: "The selected organization could not be found." }, 404);
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
  if (!body.email) return c.json({ error: "Enter the user's email address." }, 400);
  if (!canManageUnit(membership(c), body.unit_id ? Number(body.unit_id) : null) && !isPlatformAdmin(c)) {
    return c.json({ error: "You can only add users to units you are allowed to manage." }, 403);
  }
  try {
    const role = normalizeOrgRole(body.role, "viewer");
    const user = await db.upsertOrganizationUser({
      organization_id: organizationId,
      email: body.email,
      name: body.name,
      password: body.password,
      role,
      unit_id: body.unit_id || null,
      scope_level: body.scope_level || (body.unit_id ? "unit" : "organization"),
      allowCrossOrganization: isPlatformAdmin(c),
    });
    await db.createAuditLog({
      organization_id: organizationId,
      actor_user_id: actor(c),
      action: "user.upsert",
      target_type: "user",
      target_id: user.id,
      metadata: { email: body.email, role, unit_id: body.unit_id || null },
    });
    return c.json({ user }, 201);
  } catch (error) {
    const next = clientError(error);
    return c.json(next.body, next.status);
  }
});

router.delete("/users/:user_id", async (c) => {
  const organizationId = organizationIdFor(c);
  const userId = Number(c.req.param("user_id"));
  const removed = await db.removeOrganizationUser(organizationId, userId);
  if (!removed) return c.json({ error: "That user is not a member of this organization." }, 404);
  await db.createAuditLog({
    organization_id: organizationId,
    actor_user_id: actor(c),
    action: "user.remove",
    target_type: "user",
    target_id: userId,
  });
  return c.json({ ok: true });
});

// Channels are arranged by the organization itself. Every handler re-checks
// that the channel belongs to the caller's organization, so a tenant can never
// touch another tenant's channel even by guessing an id.
// Resolve (and cache) the organization's vendor company id. Without it we
// cannot create anything on the radio network for that tenant.
async function companyIdFor(organizationId: number) {
  const cached = await db.getOrganizationCompanyId(organizationId);
  if (cached) return cached;
  const groupId = await db.anyClaimedGroupId(organizationId);
  if (!groupId) return null;
  const resolved = await provisionOnNetwork("provision.company.forGroup", { groupId });
  const companyId = Number(resolved?.companyId || 0);
  if (!companyId) return null;
  // Refuse to provision into a vendor company another tenant already owns:
  // seats are shared per company, so that tenant's dispatchers would see
  // everything created here.
  const shared = await db.organizationsSharingCompanyId(companyId, organizationId);
  if (shared.length) {
    throw new Error(
      `This organization shares a radio-network company with ${shared[0].name}. `
      + "A platform admin must give it its own company before channels can be created.",
    );
  }
  await db.setOrganizationCompanyId(organizationId, companyId);
  return companyId;
}

// Membership only means anything once it exists on the radio network: without
// this the radio would appear on the channel in MOMAS and hear nothing.
async function mirrorMembership(c: any, channelId: number, deviceId: string, member: boolean) {
  const channel = await db.getChannel(channelId);
  if (!channel?.pocstars_group_id) return;
  const radioUid = Number(deviceId);
  if (!Number.isSafeInteger(radioUid) || radioUid <= 0) return;
  const companyId = await companyIdFor(Number(channel.organization_id));
  if (!companyId) return;
  await provisionOnNetwork("provision.radio.channel", {
    companyId,
    groupId: Number(channel.pocstars_group_id),
    radioUid,
    member,
  });
}

async function ownedChannel(c: any, channelId: number) {
  const organizationId = organizationIdFor(c);
  const channel = await db.getChannel(channelId);
  if (!channel || Number(channel.organization_id) !== Number(organizationId)) return null;
  return channel;
}

router.get("/channels", async (c) => {
  const organizationId = organizationIdFor(c);
  if (!organizationId) return c.json({ channels: [] });
  const channels = await db.listChannels(organizationId);
  const scopedUnitId = unitScoped(c);
  return c.json({
    channels: scopedUnitId
      ? channels.filter((channel: any) => !channel.unit_id || Number(channel.unit_id) === scopedUnitId)
      : channels,
  });
});

router.post("/channels", async (c) => {
  const organizationId = organizationIdFor(c);
  const body = await c.req.json().catch(() => ({}));
  if (!body.name?.trim()) return c.json({ error: "Enter a channel name." }, 400);
  if (!isPlatformAdmin(c) && !canManageOrganization(membership(c))) {
    return c.json({ error: "Only organization admins can create channels." }, 403);
  }
  try {
    const channel = await db.createChannel({
      organization_id: organizationId,
      name: String(body.name).trim(),
      unit_id: body.unit_id ? Number(body.unit_id) : null,
    });
    // Create the matching talk group on the radio network. The channel stays
    // 'pending' if this fails, so it is visibly not live rather than silently
    // broken, and the operator can retry.
    const companyId = await companyIdFor(organizationId);
    if (!companyId) {
      // Nothing to create the group against. Say so rather than leaving a
      // channel that is silently pending with no explanation.
      return c.json({
        channel,
        warning: "This organization has no company on the radio network yet, so the channel is not live. A platform admin must set it up.",
      }, 201);
    }
    {
      try {
        const created = await provisionOnNetwork("provision.channel.create", {
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
    }
    await db.createAuditLog({
      organization_id: organizationId,
      actor_user_id: actor(c),
      action: "channel.create",
      target_type: "channel",
      target_id: channel.id,
      metadata: { name: channel.name },
    });
    return c.json({ channel }, 201);
  } catch (error) {
    const next = clientError(error);
    return c.json(next.body, next.status);
  }
});

router.put("/channels/:channel_id", async (c) => {
  const channelId = Number(c.req.param("channel_id"));
  const body = await c.req.json().catch(() => ({}));
  if (!isPlatformAdmin(c) && !canManageOrganization(membership(c))) {
    return c.json({ error: "Only organization admins can change channels." }, 403);
  }
  if (!(await ownedChannel(c, channelId))) {
    return c.json({ error: "That channel could not be found." }, 404);
  }
  const existing = await db.getChannel(channelId);
  // A channel's identity is its vendor group id, not its name - renaming only
  // changes the label, and the group survives it. But the radio network owns
  // that label: the inventory sync copies the vendor's name back onto the
  // channel every cycle. So a rename that fails there has to fail here too.
  // Swallowing it wrote a local name that reverted itself minutes later, with
  // nothing shown to the person who typed it.
  let renamed: string | null = null;
  if (body.name?.trim() && body.name.trim() !== existing?.name) {
    if (existing?.pocstars_group_id) {
      const companyId = await companyIdFor(organizationIdFor(c));
      if (companyId) {
        try {
          await provisionOnNetwork("provision.channel.rename", {
            companyId, groupId: Number(existing.pocstars_group_id), name: body.name.trim(),
          });
        } catch (error) {
          return c.json({
            error: error instanceof Error
              ? `The channel could not be renamed on the radio network: ${error.message}`
              : "The channel could not be renamed on the radio network.",
          }, 502);
        }
      }
    }
    renamed = body.name.trim();
  }
  const channel = await db.updateChannel(channelId, {
    name: renamed,
    unit_id: body.unit_id === undefined ? undefined : (body.unit_id ? Number(body.unit_id) : null),
    active: body.active === undefined ? null : Boolean(body.active),
  });
  await db.createAuditLog({
    organization_id: organizationIdFor(c),
    actor_user_id: actor(c),
    action: "channel.update",
    target_type: "channel",
    target_id: channelId,
    metadata: { name: channel?.name },
  });
  return c.json({ channel });
});

router.delete("/channels/:channel_id", async (c) => {
  const channelId = Number(c.req.param("channel_id"));
  if (!isPlatformAdmin(c) && !canManageOrganization(membership(c))) {
    return c.json({ error: "Only organization admins can delete channels." }, 403);
  }
  const channel = await ownedChannel(c, channelId);
  if (!channel) return c.json({ error: "That channel could not be found." }, 404);
  // A channel that exists on the radio network is still carrying real group
  // audio; retire it in MOMAS rather than silently dropping the vendor group.
  if (channel.pocstars_group_id) {
    await db.updateChannel(channelId, { active: false });
    return c.json({ ok: true, retired: true });
  }
  await db.deleteChannel(channelId);
  await db.createAuditLog({
    organization_id: organizationIdFor(c),
    actor_user_id: actor(c),
    action: "channel.delete",
    target_type: "channel",
    target_id: channelId,
    metadata: { name: channel.name },
  });
  return c.json({ ok: true });
});

router.get("/channels/:channel_id/devices", async (c) => {
  const channelId = Number(c.req.param("channel_id"));
  if (!(await ownedChannel(c, channelId))) {
    return c.json({ error: "That channel could not be found." }, 404);
  }
  return c.json({ devices: await db.listChannelDevices(channelId) });
});

router.post("/channels/:channel_id/devices/:device_id", async (c) => {
  const channelId = Number(c.req.param("channel_id"));
  if (!isPlatformAdmin(c) && !canManageOrganization(membership(c))) {
    return c.json({ error: "Only organization admins can change channel members." }, 403);
  }
  if (!(await ownedChannel(c, channelId))) {
    return c.json({ error: "That channel could not be found." }, 404);
  }
  try {
    const deviceId = c.req.param("device_id");
    await db.setChannelDevice(channelId, deviceId, true);
    await mirrorMembership(c, channelId, deviceId, true);
    return c.json({ ok: true });
  } catch (error) {
    return c.json(jsonError(error), 400);
  }
});

router.delete("/channels/:channel_id/devices/:device_id", async (c) => {
  const channelId = Number(c.req.param("channel_id"));
  if (!isPlatformAdmin(c) && !canManageOrganization(membership(c))) {
    return c.json({ error: "Only organization admins can change channel members." }, 403);
  }
  if (!(await ownedChannel(c, channelId))) {
    return c.json({ error: "That channel could not be found." }, 404);
  }
  try {
    const deviceId = c.req.param("device_id");
    await db.setChannelDevice(channelId, deviceId, false);
    await mirrorMembership(c, channelId, deviceId, false);
    return c.json({ ok: true });
  } catch (error) {
    return c.json(jsonError(error), 400);
  }
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
  if (!body.name) return c.json({ error: "Enter a unit name." }, 400);
  if (!isPlatformAdmin(c) && !canManageOrganization(membership(c))) {
    return c.json({ error: "Only organization admins can create new units." }, 403);
  }
  try {
    const unit = await db.createOrganizationUnit({
      organization_id: organizationId,
      parent_unit_id: body.parent_unit_id || null,
      name: body.name,
      type: body.type || null,
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
      metadata: { name: unit.name, type: unit.type || null, state: unit.state },
    });
    return c.json({ unit }, 201);
  } catch (error) {
    const next = clientError(error);
    return c.json(next.body, next.status);
  }
});

router.put("/units/:unit_id", async (c) => {
  const organizationId = organizationIdFor(c);
  const unitId = Number(c.req.param("unit_id"));
  if (!canManageUnit(membership(c), unitId) && !isPlatformAdmin(c)) return c.json({ error: "You can only update units you are allowed to manage." }, 403);
  const body = await c.req.json().catch(() => ({}));
  try {
    // Whitelist the fields a tenant owns. Radio-network identifiers are never
    // accepted from an organization: a unit carrying a vendor group id is
    // promoted to a channel at startup, so accepting one here would let a
    // tenant claim audio on a group it was never allocated.
    const unit = await db.updateOrganizationUnit(organizationId, unitId, {
      parent_unit_id: body.parent_unit_id ?? null,
      name: body.name,
      type: body.type,
      state: body.state,
      lga: body.lga,
      location: body.location,
    });
    if (!unit) return c.json({ error: "That unit could not be found in this organization." }, 404);
    await db.createAuditLog({
      organization_id: organizationId,
      actor_user_id: actor(c),
      action: "unit.update",
      target_type: "unit",
      target_id: unitId,
      metadata: body,
    });
    return c.json({ unit });
  } catch (error) {
    const next = clientError(error);
    return c.json(next.body, next.status);
  }
});

router.delete("/units/:unit_id", async (c) => {
  const organizationId = organizationIdFor(c);
  const unitId = Number(c.req.param("unit_id"));
  if (!canManageUnit(membership(c), unitId) && !isPlatformAdmin(c)) return c.json({ error: "You can only remove units you are allowed to manage." }, 403);
  const removed = await db.deleteOrganizationUnit(organizationId, unitId);
  if (!removed) return c.json({ error: "That unit could not be found in this organization." }, 404);
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
  if (!canManageUnit(membership(c), unitId) && !isPlatformAdmin(c)) return c.json({ error: "You can only assign devices to units you are allowed to manage." }, 403);
  const device = await db.assignDeviceToUnit(c.req.param("device_id"), organizationId, unitId);
  if (!device) return c.json({ error: "That device is not assigned to this organization." }, 404);
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
