import { Hono } from "hono";
import { isPlatformOwner, normalizeOrgRole, requirePlatform } from "../auth";
import * as db from "../db";
import {
  knownCompanyIds,
  liveRadioConfigured,
  provisionOnNetwork,
  queryPocstarsInventory,
  refreshPresenceOverVoice,
} from "../pocstars/live-gateway";
import { startPresenceWatcher } from "../pocstars/presence-watcher";

const router = new Hono();

function jsonError(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error) };
}

function clientError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("platform admin") || message.includes("duplicate key") || message.includes("is not a role")) {
    return {
      status: 400 as const,
      body: { error: message.includes("duplicate key") ? "A record with these details already exists." : message },
    };
  }
  return { status: 500 as const, body: { error: message } };
}

// Reading the tenant list is open to every platform tier; each write below
// names the tier it needs. Deleting an organization and changing what it pays
// for are the owner's alone.
router.use("*", requirePlatform("support"));
const requireOps = requirePlatform("ops");
const requireOwner = requirePlatform("admin");

router.get("/", async (c) => {
  try {
    return c.json({ organizations: await db.listOrganizations() });
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.post("/", requireOps, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.name) return c.json({ error: "Enter an organization name." }, 400);
  try {
    const tenantSeats = Math.max(1, Number(body.radio_seats) || 2);
    const platformSeats = Math.max(0, Number(body.platform_radio_seats ?? 1));
    const organization = await db.createOrganization({
      name: body.name,
      slug: body.slug,
      all_states: body.all_states,
      states: body.states || [],
      status: body.status || "active",
      pocstars_company_id: body.pocstars_company_id || null,
      pocstars_company_name: body.pocstars_company_name || null,
      radio_seats: tenantSeats,
      platform_radio_seats: platformSeats,
    });

    const { radio, warning } = await provisionCompanyOnNetwork(organization);
    return c.json({ organization, radio, warning }, 201);
  } catch (error) {
    const next = clientError(error);
    return c.json(next.body, next.status);
  }
});

// Give the organization its own company on the radio network, so its dispatcher
// seats and channels are never shared with another tenant. A failure leaves a
// usable MOMAS organization that simply has no radio yet, rather than rolling
// back the whole creation - which is only tolerable because this is retryable;
// see POST /:id/radio/provision.
async function provisionCompanyOnNetwork(organization: any) {
  if (organization.pocstars_company_id) return { radio: null, warning: undefined };
  try {
    const radio = await provisionOnNetwork("provision.company.create", {
      name: organization.name,
      slug: organization.slug,
      seats: Math.max(1, Number(organization.radio_seats) || 2)
        + Math.max(0, Number(organization.platform_radio_seats) || 0),
    });
    if (radio?.companyId) {
      await db.setOrganizationCompanyId(organization.id, Number(radio.companyId));
      organization.pocstars_company_id = String(radio.companyId);
    }
    return { radio, warning: undefined };
  } catch (error) {
    return {
      radio: null,
      warning: error instanceof Error
        ? `The radio network setup failed: ${error.message}`
        : "The radio network setup failed.",
    };
  }
}

// Retry for a company whose radio provisioning failed at creation. Without this
// the only record of the failure was a warning line that disappeared on the
// next create, and the company was stuck with no radio forever.
router.post("/:id/radio/provision", requireOps, async (c) => {
  const id = Number(c.req.param("id"));
  const user = (c as any).get("user");
  const organization = await db.getOrganization(id);
  if (!organization) return c.json({ error: "That organization could not be found." }, 404);
  if (organization.pocstars_company_id) {
    return c.json({
      error: `This company is already on the radio network as company ${organization.pocstars_company_id}.`,
    }, 409);
  }
  const { radio, warning } = await provisionCompanyOnNetwork(organization);
  if (warning) return c.json({ error: warning }, 502);
  await db.createAuditLog({
    organization_id: id,
    actor_user_id: user?.id,
    action: "organization.radio.provision",
    target_type: "organization",
    target_id: id,
    metadata: { pocstars_company_id: organization.pocstars_company_id },
  });
  return c.json({ organization: await db.getOrganization(id), radio });
});

router.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const organization = await db.getOrganization(id);
  if (!organization) return c.json({ error: "That organization could not be found." }, 404);
  const [devices, users] = await Promise.all([
    db.listDevices({ organizationId: id }),
    db.listOrganizationUsers(id),
  ]);
  const [units, audit, channels] = await Promise.all([
    db.listOrganizationUnits(id),
    db.listAuditLogs(id, 50),
    db.listChannels(id),
  ]);
  return c.json({ organization, devices, users, units, audit, channels });
});

router.put("/:id/access", requireOps, async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));

  // Seat counts and the company binding are what this install is billed for and
  // what its radios lease against, so they sit above the tier that edits a
  // name, a status or a state list.
  const billingFields = ["radio_seats", "platform_radio_seats", "pocstars_company_id", "pocstars_company_name"];
  const touchesBilling = billingFields.some((field) => body[field] !== undefined);
  if (touchesBilling && !isPlatformOwner((c as any).get("user"))) {
    return c.json({ error: "Only a platform owner can change seat counts or the radio company." }, 403);
  }

  try {
    const organization = await db.updateOrganizationAccess(id, {
      name: body.name,
      status: body.status,
      all_states: body.all_states,
      states: Array.isArray(body.states) ? body.states : undefined,
      pocstars_company_id: body.pocstars_company_id,
      pocstars_company_name: body.pocstars_company_name,
      radio_seats: body.radio_seats,
      platform_radio_seats: body.platform_radio_seats,
    });
    if (!organization) return c.json({ error: "That organization could not be found." }, 404);
    return c.json({ organization });
  } catch (error) {
    const next = clientError(error);
    return c.json(next.body, next.status);
  }
});

// What a deletion would take with it. The console shows this before offering
// the button, so the decision is made against real numbers rather than a guess.
router.get("/:id/deletion-impact", async (c) => {
  const id = Number(c.req.param("id"));
  try {
    const impact = await db.getOrganizationDeletionImpact(id);
    if (!impact) return c.json({ error: "That organization could not be found." }, 404);
    return c.json(impact);
  } catch (error) {
    return c.json(jsonError(error), 500);
  }
});

router.delete("/:id", requireOwner, async (c) => {
  const id = Number(c.req.param("id"));
  const user = (c as any).get("user");
  const organization = await db.getOrganization(id);
  if (!organization) return c.json({ error: "That organization could not be found." }, 404);

  // Typing the name is the whole safety net: nothing here is recoverable, and
  // a company is an easy thing to open the wrong one of.
  const confirm = String(c.req.query("confirm") ?? "").trim();
  if (confirm !== String(organization.name).trim()) {
    return c.json({ error: `Type the company name exactly - ${organization.name} - to delete it.` }, 400);
  }

  try {
    const deleted = await db.deleteOrganization(id);
    if (!deleted) return c.json({ error: "That organization could not be found." }, 404);
    // Logged against the platform, not the organization: an audit entry filed
    // under a deleted company would cascade away with it.
    await db.createAuditLog({
      organization_id: null,
      actor_user_id: user?.id,
      action: "organization.delete",
      target_type: "organization",
      target_id: id,
      metadata: {
        name: organization.name,
        slug: organization.slug,
        pocstars_company_id: organization.pocstars_company_id,
        ...deleted.counts,
      },
    });
    return c.json({
      ok: true,
      deleted: { id, name: organization.name },
      counts: deleted.counts,
      // The radio-network company outlives the tenant on purpose - the vendor
      // install is shared and holds recordings against its own ids - so the
      // admin is told what is still out there rather than left to assume.
      radio: deleted.radio,
    });
  } catch (error) {
    const next = clientError(error);
    return c.json(next.body, next.status);
  }
});

router.post("/:id/pocstars/sync", requireOps, (c) => c.json({
  error: "Radio sync is now platform-wide. Use POST /api/pocstars/admin/sync and claim channels from the registry.",
}, 410));

router.post("/:id/users", requireOps, async (c) => {
  const organization_id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  if (!body.email || !body.password) {
    return c.json({ error: "Enter the user's email address and a temporary password." }, 400);
  }
  try {
    const role = normalizeOrgRole(body.role, "org_admin");
    const user = await db.addOrganizationUser({
      organization_id,
      email: body.email,
      name: body.name,
      password: body.password,
      role,
    });
    await db.createAuditLog({
      organization_id,
      actor_user_id: (c as any).get("user")?.id,
      action: "user.upsert",
      target_type: "user",
      target_id: user.id,
      metadata: { email: body.email, role },
    });
    return c.json({ user }, 201);
  } catch (error) {
    const next = clientError(error);
    return c.json(next.body, next.status);
  }
});

router.delete("/:id/users/:user_id", requireOps, async (c) => {
  const organizationId = Number(c.req.param("id"));
  const userId = Number(c.req.param("user_id"));
  const removed = await db.removeOrganizationUser(organizationId, userId);
  if (!removed) return c.json({ error: "That user is not a member of this organization." }, 404);
  return c.json({ ok: true });
});

router.post("/:id/devices/:device_id", requireOps, async (c) => {
  const organizationId = Number(c.req.param("id"));
  const device = await db.assignDeviceToOrganization(c.req.param("device_id"), organizationId);
  if (!device) return c.json({ error: "That device could not be found." }, 404);
  return c.json({ device });
});

router.delete("/:id/devices/:device_id", requireOps, async (c) => {
  const device = await db.assignDeviceToOrganization(c.req.param("device_id"), null);
  if (!device) return c.json({ error: "That device could not be found." }, 404);
  return c.json({ device });
});

export default router;

let automaticInventorySyncRunning = false;
setInterval(() => {
  if (!liveRadioConfigured() || automaticInventorySyncRunning) return;
  automaticInventorySyncRunning = true;
  void (async () => {
    try {
      // The first sync is an explicit platform-admin action; only refresh
      // automatically once a dispatcher has been registered by it.
      if (!(await db.hasPocstarsDispatchers())) return;
      const inventory = await queryPocstarsInventory();
      const summary = await db.syncPocstarsPlatformInventory(inventory);
      await db.createAuditLog({
        organization_id: null,
        actor_user_id: null,
        action: "pocstars.inventory.sync.automatic",
        target_type: "pocstars_dispatcher",
        target_id: inventory?.dispatcher?.id ?? null,
        metadata: summary,
      });
      // Presence is watched per vendor company. The database sync is the better
      // source for which companies exist, but it is not the only one: a sync
      // that fell back to the voice plane resolves no companies at all, and
      // relying on it alone meant one transient fallback left presence
      // unwatched until the next restart. Organizations know their own company.
      const watched = new Set<number>([
        ...knownCompanyIds(),
        ...(await db.listOrganizationCompanyIds()),
      ]);
      for (const companyId of watched) startPresenceWatcher(companyId);
    } catch {
      // Live calls take priority. The next five-minute cycle retries safely.
    } finally {
      automaticInventorySyncRunning = false;
    }
  })();
}, 5 * 60 * 1000);

// Presence has to come from the voice plane - the vendor database records no
// online state anywhere - and reading it costs a dispatcher seat. So it runs on
// its own slow cycle: often enough that the console reflects reality, rarely
// enough that it stays out of the way of live audio.
let presenceRefreshRunning = false;
async function refreshPresence(reason: string) {
  if (!liveRadioConfigured() || presenceRefreshRunning) return;
  presenceRefreshRunning = true;
  try {
    if (!(await db.hasPocstarsDispatchers())) return;
    const summary = await refreshPresenceOverVoice();
    await db.createAuditLog({
      organization_id: null,
      actor_user_id: null,
      action: "pocstars.presence.refresh",
      target_type: "pocstars_dispatcher",
      target_id: null,
      metadata: { ...summary, reason },
    });
  } catch (error) {
    // Usually a live session holding the only free seat, and the next cycle
    // retries safely - but a silent catch here once hid a console showing the
    // whole fleet offline for a day, so say so.
    console.warn(
      `[Radio] presence refresh (${reason}) failed, retrying next cycle:`,
      error instanceof Error ? error.message : error,
    );
  } finally {
    presenceRefreshRunning = false;
  }
}

// Presence has to be re-read after a restart. The interval alone would leave the
// console reporting whatever was true before the process died - for a full cycle
// after a deploy, and permanently if restarts come closer together than the
// cycle. Wait a little first so it does not contend with startup.
setTimeout(() => void refreshPresence("startup"), 60 * 1000).unref?.();
setInterval(() => void refreshPresence("cycle"), 30 * 60 * 1000);
