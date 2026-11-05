import { Hono } from "hono";
import {
  canManageOrganization,
  canManageUnit,
  isPlatformOperator,
  isPlatformStaff,
  primaryOrganization,
  requireAuth,
} from "../auth";
import { env } from "../config";
import * as db from "../db";
import { breachedCounts, judgeRule, membersOf, rulesChanged } from "../geofencing/engine";
import { fenceMetrics, ringSelfIntersects, validatePolygonGeometry } from "../geofencing/geometry";
import { assetKey, currentAssetPositions } from "../geofencing/positions";
import { LEVELS, TARGET_TYPES, TRIGGERS, unitAndDescendants, zoneBounds } from "../geofencing/rules";
import { placeBorder, suggestPlaces } from "../geofencing/borders";
import * as store from "../geofencing/store";
import { reverseGeocode, searchPlaces } from "../geocoder";

const router = new Hono();
router.use("*", requireAuth);

function scope(c: any) {
  const user = c.get("user");
  if (isPlatformStaff(user)) return {};
  const membership = primaryOrganization(user);
  return membership
    ? {
        organizationId: membership.organization_id,
        unitId: membership.scope_level === "unit" ? membership.unit_id : null,
      }
    : { organizationId: -1 };
}

function canManage(c: any, unitId?: number | null) {
  const user = c.get("user");
  if (isPlatformStaff(user)) return isPlatformOperator(user);
  const membership = primaryOrganization(user);
  return canManageOrganization(membership) || canManageUnit(membership, unitId || membership?.unit_id);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** The organization a request acts on: the caller's own, or the one staff name. */
function organizationFor(c: any, requested: any) {
  const user = c.get("user");
  if (isPlatformStaff(user)) return Number(requested) || null;
  return Number(primaryOrganization(user)?.organization_id) || null;
}

function callerUnit(c: any) {
  const membership = primaryOrganization(c.get("user"));
  return membership?.scope_level === "unit" ? Number(membership.unit_id) : null;
}

/** A unit-scoped admin may point rules only at their own unit and those below it. */
async function allowedUnits(organizationId: number, unitId: number | null) {
  if (!unitId) return null;
  const units = await db.listOrganizationUnits(organizationId);
  const children = new Map<string, string[]>();
  for (const unit of units) {
    if (unit.parent_unit_id == null) continue;
    const list = children.get(String(unit.parent_unit_id)) || [];
    list.push(String(unit.id));
    children.set(String(unit.parent_unit_id), list);
  }
  return [...unitAndDescendants(String(unitId), children)].map(Number);
}

function validateZone(body: any) {
  const name = String(body.name || "").trim();
  const shapeType = body.shape_type;
  if (!name) throw new Error("Give the zone a name.");
  if (!["circle", "polygon"].includes(shapeType)) throw new Error("A zone is a circle or a polygon.");
  if (shapeType === "polygon") {
    if (ringSelfIntersects(body.geometry?.coordinates?.[0])) {
      throw new Error("This zone crosses over itself. Drag the corners so they go round the area in order.");
    }
    if (!validatePolygonGeometry(body.geometry)) throw new Error("A polygon needs at least three corners.");
  }
  if (
    shapeType === "circle" &&
    (!Number.isFinite(Number(body.center_lat)) ||
      !Number.isFinite(Number(body.center_lon)) ||
      !Number.isFinite(Number(body.radius_m)) ||
      Number(body.radius_m) <= 0)
  ) throw new Error("A circle needs a centre and a radius.");

  return {
    name,
    shape_type: shapeType,
    geometry: shapeType === "polygon" ? body.geometry : null,
    center_lat: shapeType === "circle" ? Number(body.center_lat) : null,
    center_lon: shapeType === "circle" ? Number(body.center_lon) : null,
    radius_m: shapeType === "circle" ? Number(body.radius_m) : null,
  };
}

async function loadTarget(targetType: string, targetId: string, organizationId: number) {
  if (targetType === "radio") return db.getDevice(targetId);
  if (targetType === "drone") return db.getDrone(Number(targetId));
  if (targetType === "channel") return db.getChannel(Number(targetId));
  const unit = await db.getOrganizationUnit(organizationId, Number(targetId));
  return unit ? { ...unit, unit_id: unit.id } : null;
}

// How far out (or in) the furthest alarm step may sit from the zone's edge.
const MAX_STEP_M = 20_000;

/**
 * Checks each rule's target belongs to the organization (and the caller's
 * units). A zone may watch dozens of radios, so the lookups run together.
 */
async function validateRules(rules: any[], organizationId: number, units: number[] | null) {
  const list = Array.isArray(rules) ? rules : [];
  const seen = new Set<string>();
  for (const raw of list) {
    const targetId = String(raw?.target_id ?? "").trim();
    if (!TARGET_TYPES.includes(raw?.target_type) || !targetId) throw new Error("Each rule needs a radio to watch.");
    if (!TRIGGERS.includes(raw.trigger)) throw new Error("Each rule must say leave or enter.");
    if (!LEVELS.includes(raw.level)) throw new Error("Each rule needs an alarm level.");
    const key = `${raw.target_type}:${targetId}:${raw.trigger}`;
    if (seen.has(key)) throw new Error("The same radio is listed twice for the same direction.");
    seen.add(key);
  }

  const found = await Promise.all(list.map((raw) => loadTarget(raw.target_type, String(raw.target_id).trim(), organizationId)));
  return list.map((raw, i) => {
    const target: any = found[i];
    if (!target || Number(target.organization_id) !== Number(organizationId)) {
      throw new Error(`That ${raw.target_type} is not part of this organization.`);
    }
    if (units && !units.includes(Number(target.unit_id))) throw new Error(`That ${raw.target_type} is outside your unit.`);
    return {
      id: raw.id ? Number(raw.id) : null,
      target_type: raw.target_type,
      target_id: String(raw.target_id).trim(),
      trigger: raw.trigger,
      level: raw.level,
      buffer_m: Math.min(MAX_STEP_M, Math.max(0, Number(raw.buffer_m ?? env.GEOFENCE_DEFAULT_BUFFER_M) || 0)),
      confirmations_required: Math.min(10, Math.max(1, Number(raw.confirmations_required) || env.GEOFENCE_CONFIRMATIONS)),
      active: raw.active !== false,
    };
  });
}

/**
 * Where everyone a draft rule watches stands against a draft zone, right now.
 *
 * Judged by the same function the engine runs, so the editor's "2 already
 * outside" can never disagree with what the monitor will do once saved.
 */
async function describe(zone: any, rules: any[]) {
  const membersByRule = rules.map((rule) => membersOf(rule));
  const allMembers = [...new Map(membersByRule.flat().map((m) => [assetKey(m.asset_type, m.asset_id), m])).values()];
  const positions = await currentAssetPositions(allMembers);

  const verdicts = rules.map((rule, index) => {
    const draft = { ...zone, ...rule, bounds: zoneBounds(zone, (Number(rule.buffer_m) || 0) + 5) };
    const members = membersByRule[index].map((member) => {
      const position = positions.get(assetKey(member.asset_type, member.asset_id));
      if (!position) return { ...member, state: "unknown" };
      const verdict = judgeRule(draft, position.lat, position.lon);
      return {
        ...member,
        state: verdict.side === "violating" ? "breach" : "ok",
        lat: position.lat,
        lon: position.lon,
        distance_m: Math.round(verdict.distanceM),
      };
    });
    return {
      members,
      summary: {
        total: members.length,
        ok: members.filter((m) => m.state === "ok").length,
        breach: members.filter((m) => m.state === "breach").length,
        unknown: members.filter((m) => m.state === "unknown").length,
      },
    };
  });

  const metrics = fenceMetrics(zone);
  return {
    rules: verdicts,
    metrics,
    place: metrics?.centre ? reverseGeocode(metrics.centre.lat, metrics.centre.lon) : null,
  };
}

function withBreaches(zone: any) {
  const counts = breachedCounts();
  return {
    ...zone,
    rules: (zone.rules || []).map((rule: any) => ({ ...rule, in_breach: counts.get(Number(rule.id)) || 0 })),
  };
}

router.get("/", async (c) => {
  try {
    const zones = await store.listZones(scope(c));
    return c.json({ zones: zones.map(withBreaches) });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500);
  }
});

/** Units, channels, radios and drones a rule can watch, in one request. */
router.get("/targets", async (c) => {
  const organizationId = organizationFor(c, c.req.query("organization_id"));
  if (!organizationId) return c.json({ units: [], channels: [], radios: [], drones: [] });
  try {
    const units = await allowedUnits(organizationId, callerUnit(c));
    const targets = await store.listTargets(organizationId, units);
    const members = (target_type: string, target_id: any) =>
      membersOf({ target_type, target_id: String(target_id) }).map((m) => `${m.asset_type}:${m.asset_id}`);
    return c.json({
      // Member keys travel with each group, so the editor can light them up
      // on the map and draw around them before any zone exists.
      units: targets.units.map((unit: any) => ({ ...unit, members: members("unit", unit.id) })),
      channels: targets.channels.map((channel: any) => ({ ...channel, members: members("channel", channel.id) })),
      radios: targets.radios,
      drones: targets.drones,
    });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500);
  }
});

/** Type-ahead place search, so a zone can be found by name instead of by eye. */
/** OpenStreetMap places as you type; `osm` marks one with an outline. */
router.get("/places/suggest", async (c) => {
  try {
    return c.json({ places: await suggestPlaces(c.req.query("q") || "") });
  } catch (error) {
    return c.json({ places: [], error: errorMessage(error) }, 502);
  }
});

/** The picked place's real outline, ready to use as a zone. */
router.get("/places/border", async (c) => {
  try {
    return c.json({ points: await placeBorder(c.req.query("osm") || "") });
  } catch (error) {
    return c.json({ points: null, error: errorMessage(error) }, 502);
  }
});

router.get("/places", (c) => {
  return c.json({ places: searchPlaces(c.req.query("q"), Number(c.req.query("limit")) || 8) });
});

/** Dry run: who each draft rule would see on the wrong side right now. */
router.post("/preview", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const organizationId = organizationFor(c, body.organization_id);
    if (!organizationId) return c.json({ error: "Choose an organization first." }, 400);
    const zone = validateZone({ ...body, name: body.name || "Preview" });
    const rules = await validateRules(body.rules || [], organizationId, await allowedUnits(organizationId, callerUnit(c)));
    return c.json(await describe(zone, rules));
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
});

async function saveZoneAndRules(c: any, existing: any | null) {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const organizationId = existing ? Number(existing.organization_id) : organizationFor(c, body.organization_id);
  if (!organizationId) return c.json({ error: "Choose an organization first." }, 400);
  const unitId = existing ? existing.unit_id : callerUnit(c);
  if (!canManage(c, unitId)) return c.json({ error: "forbidden" }, 403);

  try {
    const zoneInput = validateZone(body);
    const rules = await validateRules(body.rules || [], organizationId, await allowedUnits(organizationId, callerUnit(c)));
    const { zone, fresh, removed } = await store.transaction(async (client) => {
      const zone = await store.saveZone(client, {
        ...zoneInput,
        id: existing?.id,
        organization_id: organizationId,
        unit_id: unitId,
        created_by: existing?.created_by ?? user.id,
      });
      if (!zone) throw new Error("Zone not found.");
      const synced = await store.syncRules(client, zone.id, organizationId, rules, user.id);
      return { zone, ...synced };
    });
    // Quiet by default: nobody already on the wrong side alarms the moment
    // the zone is saved. The editor says how many that is before saving.
    const quieted = await rulesChanged(fresh, removed, body.quiet !== false);
    await db.createAuditLog({
      organization_id: organizationId,
      actor_user_id: user.id,
      action: existing ? "geofence.update" : "geofence.create",
      target_type: "geofence",
      target_id: String(zone.id),
      metadata: { rule_count: rules.length, quieted_existing: quieted },
    });
    return c.json({ zone: withBreaches(await store.getZone(zone.id, { organizationId })), quieted });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
}

router.post("/", (c) => saveZoneAndRules(c, null));

router.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Invalid zone id." }, 400);
  const existing = await store.getZone(id, scope(c));
  if (!existing) return c.json({ error: "Zone not found." }, 404);
  return saveZoneAndRules(c, existing);
});

router.delete("/:id", async (c) => {
  const user: any = (c as any).get("user");
  const id = Number(c.req.param("id"));
  const existing = await store.getZone(id, scope(c));
  if (!existing) return c.json({ error: "Zone not found." }, 404);
  if (!canManage(c, existing.unit_id)) return c.json({ error: "forbidden" }, 403);
  try {
    await store.deleteZone(id, existing.organization_id);
    await rulesChanged([], (existing.rules || []).map((rule: any) => Number(rule.id)), false);
    await db.createAuditLog({
      organization_id: existing.organization_id,
      actor_user_id: user.id,
      action: "geofence.delete",
      target_type: "geofence",
      target_id: String(id),
      metadata: {},
    });
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500);
  }
});

export default router;
