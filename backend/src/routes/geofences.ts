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
import { evaluateFence, fenceMetrics, validatePolygonGeometry } from "../geofencing/geometry";
import { assetKey, currentAssetPositions } from "../geofencing/positions";
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

/** Returns each asset's display name alongside it, so callers need not re-fetch. */
async function validateAssignments(assignments: any[], organizationId: number, unitId?: number | null) {
  const clean: Array<{ asset_type: "radio" | "drone"; asset_id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const assignment of assignments || []) {
    const assetType = assignment?.asset_type;
    const assetId = String(assignment?.asset_id || "").trim();
    if (!["radio", "drone"].includes(assetType) || !assetId) throw new Error("Invalid geofence assignment.");
    const asset =
      assetType === "radio"
        ? await db.getDevice(assetId)
        : await db.getDrone(Number(assetId));
    if (!asset || Number(asset.organization_id) !== Number(organizationId)) {
      throw new Error(`${assetType} ${assetId} is not registered to this organization.`);
    }
    if (unitId && Number(asset.unit_id) !== Number(unitId)) {
      throw new Error(`${assetType} ${assetId} is outside the selected unit.`);
    }
    const key = `${assetType}:${assetId}`;
    if (!seen.has(key)) clean.push({ asset_type: assetType, asset_id: assetId, name: asset.name || `${assetType} ${assetId}` });
    seen.add(key);
  }
  return clean;
}

function validateFence(body: any) {
  const name = String(body.name || "").trim();
  const shapeType = body.shape_type;
  if (!name) throw new Error("Fence name is required.");
  if (!["circle", "polygon"].includes(shapeType)) throw new Error("Fence shape must be circle or polygon.");
  if (shapeType === "polygon" && !validatePolygonGeometry(body.geometry)) {
    throw new Error("A polygon requires at least three valid map points.");
  }
  if (
    shapeType === "circle" &&
    (!Number.isFinite(Number(body.center_lat)) ||
      !Number.isFinite(Number(body.center_lon)) ||
      !Number.isFinite(Number(body.radius_m)) ||
      Number(body.radius_m) <= 0)
  ) throw new Error("A circle requires a valid centre and radius.");

  return {
    name,
    shape_type: shapeType,
    geometry: shapeType === "polygon" ? body.geometry : null,
    center_lat: shapeType === "circle" ? Number(body.center_lat) : null,
    center_lon: shapeType === "circle" ? Number(body.center_lon) : null,
    radius_m: shapeType === "circle" ? Number(body.radius_m) : null,
    buffer_m: Math.max(0, Number(body.buffer_m) || env.GEOFENCE_DEFAULT_BUFFER_M),
    confirmations_required: Math.min(10, Math.max(1, Number(body.confirmations_required) || env.GEOFENCE_CONFIRMATIONS)),
    active: body.active !== false,
  };
}

/**
 * Resolves each assigned asset against a candidate shape, using live positions.
 *
 * This is the single source of truth for "who is inside this fence?" — the
 * editor's preview and the save-time arming gate both call it, so the sentence
 * shown to the operator is produced by the same `evaluateFence` the monitor
 * runs. A preview computed separately in the browser would eventually disagree
 * with the engine, which is the one thing it must never do.
 */
async function describeFence(fenceInput: any, assignments: any[]) {
  const positions = await currentAssetPositions(assignments);

  const assets = assignments.map((assignment) => {
    const key = assetKey(assignment.asset_type, assignment.asset_id);
    const position = positions.get(key);
    const base = {
      asset_type: assignment.asset_type,
      asset_id: assignment.asset_id,
      name: assignment.name || `${assignment.asset_type} ${assignment.asset_id}`,
    };
    if (!position) return { ...base, state: "unknown" as const };
    const result = evaluateFence(fenceInput, position.lat, position.lon);
    return {
      ...base,
      state: result.outside ? ("outside" as const) : ("inside" as const),
      lat: position.lat,
      lon: position.lon,
      observed_at: position.observed_at,
      distance_outside_m: Math.round(result.distanceOutsideM),
    };
  });

  const metrics = fenceMetrics(fenceInput);
  const place = metrics?.centre ? reverseGeocode(metrics.centre.lat, metrics.centre.lon) : null;
  return {
    assets,
    place,
    metrics,
    summary: {
      total: assets.length,
      inside: assets.filter((asset) => asset.state === "inside").length,
      outside: assets.filter((asset) => asset.state === "outside").length,
      unknown: assets.filter((asset) => asset.state === "unknown").length,
    },
  };
}

/**
 * Records assets that are already outside as outside, without alarming.
 *
 * Drawing a fence around assets that happen to be elsewhere would otherwise
 * raise one alarm per asset within a couple of polls. The operator opts into
 * this from the save summary, having been told exactly how many it covers.
 */
async function armFence(geofenceId: number, fenceInput: any, assignments: any[], suppress: boolean) {
  if (!suppress || !assignments.length) return 0;
  const positions = await currentAssetPositions(assignments);
  const alreadyOutside = assignments
    .map((assignment) => positions.get(assetKey(assignment.asset_type, assignment.asset_id)))
    .filter((position): position is NonNullable<typeof position> =>
      Boolean(position) && evaluateFence(fenceInput, position!.lat, position!.lon).outside,
    );
  return store.seedOutsideStates(geofenceId, alreadyOutside);
}

router.get("/", async (c) => {
  try {
    return c.json({ geofences: await store.listGeofences(scope(c)) });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500);
  }
});

/** Type-ahead place search, so a fence can be located by name instead of by eye. */
router.get("/places", (c) => {
  return c.json({ places: searchPlaces(c.req.query("q"), Number(c.req.query("limit")) || 8) });
});

/** Dry run of a candidate fence: what it covers, how big it is, and where it is. */
router.post("/preview", async (c) => {
  const user: any = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const membership = primaryOrganization(user);
    const organizationId =
      isPlatformStaff(user) ? Number(body.organization_id) : Number(membership?.organization_id);
    if (!organizationId) return c.json({ error: "organization_id is required." }, 400);
    const unitId = body.unit_id ? Number(body.unit_id) : membership?.scope_level === "unit" ? membership.unit_id : null;
    const fenceInput = validateFence(body);
    const assignments = await validateAssignments(body.assignments || [], organizationId, unitId);
    return c.json(await describeFence(fenceInput, assignments));
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
});

router.post("/", async (c) => {
  const user: any = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const membership = primaryOrganization(user);
    const organizationId =
      isPlatformStaff(user) ? Number(body.organization_id) : Number(membership?.organization_id);
    const unitId = body.unit_id ? Number(body.unit_id) : membership?.scope_level === "unit" ? membership.unit_id : null;
    if (!organizationId) return c.json({ error: "organization_id is required." }, 400);
    if (!canManage(c, unitId)) return c.json({ error: "forbidden" }, 403);
    if (unitId && !(await db.getOrganizationUnit(organizationId, unitId))) {
      return c.json({ error: "The selected unit is outside this organization." }, 400);
    }
    const fenceInput = validateFence(body);
    const assignments = await validateAssignments(body.assignments || [], organizationId, unitId);
    const fence = await store.saveGeofence({
      ...fenceInput,
      organization_id: organizationId,
      unit_id: unitId,
      created_by: user.id,
    });
    await store.replaceAssignments(fence.id, assignments);
    const suppressed = await armFence(fence.id, fenceInput, assignments, body.suppress_existing_breaches === true);
    await db.createAuditLog({
      organization_id: organizationId,
      actor_user_id: user.id,
      action: "geofence.create",
      target_type: "geofence",
      target_id: String(fence.id),
      metadata: { assignment_count: assignments.length, suppressed_existing_breaches: suppressed },
    });
    return c.json({ geofence: await store.getGeofence(fence.id, { organizationId }), suppressed });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
});

router.put("/:id", async (c) => {
  const user: any = (c as any).get("user");
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  if (!Number.isInteger(id)) return c.json({ error: "Invalid geofence id." }, 400);
  try {
    const existing = await store.getGeofence(id, scope(c));
    if (!existing) return c.json({ error: "Geofence not found." }, 404);
    if (!canManage(c, existing.unit_id)) return c.json({ error: "forbidden" }, 403);
    const nextUnitId = body.unit_id ?? existing.unit_id;
    if (nextUnitId && !(await db.getOrganizationUnit(existing.organization_id, nextUnitId))) {
      return c.json({ error: "The selected unit is outside this organization." }, 400);
    }
    const fenceInput = validateFence(body);
    const assignments = await validateAssignments(
      body.assignments || [],
      Number(existing.organization_id),
      nextUnitId,
    );
    await store.saveGeofence({
      ...fenceInput,
      id,
      organization_id: existing.organization_id,
      unit_id: nextUnitId,
      created_by: existing.created_by,
    });
    await store.replaceAssignments(id, assignments);
    const suppressed = await armFence(id, fenceInput, assignments, body.suppress_existing_breaches === true);
    await db.createAuditLog({
      organization_id: existing.organization_id,
      actor_user_id: user.id,
      action: "geofence.update",
      target_type: "geofence",
      target_id: String(id),
      metadata: { assignment_count: assignments.length, suppressed_existing_breaches: suppressed },
    });
    return c.json({ geofence: await store.getGeofence(id, scope(c)), suppressed });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
});

router.delete("/:id", async (c) => {
  const user: any = (c as any).get("user");
  const id = Number(c.req.param("id"));
  const existing = await store.getGeofence(id, scope(c));
  if (!existing) return c.json({ error: "Geofence not found." }, 404);
  if (!canManage(c, existing.unit_id)) return c.json({ error: "forbidden" }, 403);
  try {
    await store.deleteGeofence(id, existing.organization_id);
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
