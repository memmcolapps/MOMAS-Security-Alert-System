import crypto from "node:crypto";
import type { Context, Next } from "hono";
import { env } from "./config";
import * as db from "./db";

type TokenPayload = {
  sub: number;
  email: string;
  platform_role: string;
  exp: number;
};

const base64url = (value: Buffer | string) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

function signToken(payload: Omit<TokenPayload, "exp">, ttlSeconds = 7 * 24 * 60 * 60) {
  const header = { alg: "HS256", typ: "JWT" };
  const body: TokenPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedBody = base64url(JSON.stringify(body));
  const signature = crypto
    .createHmac("sha256", env.AUTH_JWT_SECRET)
    .update(`${encodedHeader}.${encodedBody}`)
    .digest();
  return `${encodedHeader}.${encodedBody}.${base64url(signature)}`;
}

function verifyToken(token: string): TokenPayload | null {
  const [encodedHeader, encodedBody, signature] = token.split(".");
  if (!encodedHeader || !encodedBody || !signature) return null;
  const expected = base64url(
    crypto
      .createHmac("sha256", env.AUTH_JWT_SECRET)
      .update(`${encodedHeader}.${encodedBody}`)
      .digest(),
  );
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(encodedBody, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function currentUserFromRequest(c: Context) {
  const auth = c.req.header("authorization") || "";
  // EventSource (used by the OSINT live alert stream) cannot set headers, so we
  // accept the token and active org via query params as a fallback for SSE.
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : c.req.query("access_token") || "";
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = await db.getUserById(payload.sub);
  if (!user || user.status !== "active") return null;
  const memberships = await db.getMembershipsForUser(user.id);
  const requestedOrganizationId = Number(c.req.header("x-organization-id") || c.req.query("organization_id") || "");
  const activeMembership =
    memberships.find((membership) => Number(membership.organization_id) === requestedOrganizationId) ||
    memberships[0] ||
    null;
  return {
    ...user,
    memberships,
    active_organization_id: activeMembership?.organization_id || null,
    active_membership: activeMembership,
  };
}

function mustChangePassword(c: Context, user: any) {
  if (!user?.must_change_password) return false;
  return !["/api/auth/me", "/api/auth/change-password"].includes(c.req.path);
}

function passwordChangeRequired(c: Context) {
  return c.json({ error: "You must change your temporary password before continuing.", must_change_password: true }, 403);
}

async function requireAuth(c: Context, next: Next) {
  const user = await currentUserFromRequest(c);
  if (!user) return c.json({ error: "Please sign in to continue." }, 401);
  if (mustChangePassword(c, user)) return passwordChangeRequired(c);
  c.set("user", user);
  await next();
}

// Platform staff are ranked rather than equal. "admin" keeps the meaning it has
// always had - the tier the VPS bootstrap creates, and the only one that may
// spend money, destroy an organization, or change who else is staff - so no
// existing account or check changes meaning. The two tiers below it are new:
// "ops" runs the radio estate day to day, "support" watches every tenant but
// writes nothing.
const PLATFORM_RANK: Record<string, number> = {
  none: 0,
  support: 1,
  ops: 2,
  admin: 3,
};

// Tiers that may be handed out from the console. "none" is absent because
// removing somebody's staff access is a deletion, not a role change.
const ASSIGNABLE_PLATFORM_ROLES = ["support", "ops", "admin"];

const PLATFORM_ROLE_LABELS: Record<string, string> = {
  support: "Support (read-only)",
  ops: "Operations",
  admin: "Platform owner",
};

function platformRank(user: any) {
  return PLATFORM_RANK[String(user?.platform_role || "none")] ?? 0;
}

// Anyone on the platform side of the tenancy line. This is the check that opens
// up cross-organization *reading*: every tier sees the whole estate, and the
// tiers differ only in what they may change.
function isPlatformStaff(user: any) {
  return platformRank(user) > 0;
}

// May change the estate: allocate radios, register drones, edit an org's units.
// Support is deliberately excluded - it reads everything and writes nothing.
function isPlatformOperator(user: any) {
  return platformRank(user) >= PLATFORM_RANK.ops;
}

function isPlatformOwner(user: any) {
  return platformRank(user) >= PLATFORM_RANK.admin;
}

function normalizePlatformRole(role: unknown) {
  const value = String(role || "").trim();
  if (!ASSIGNABLE_PLATFORM_ROLES.includes(value)) {
    throw new Error(
      `${value || "That"} is not a platform role. Choose one of: ${ASSIGNABLE_PLATFORM_ROLES.join(", ")}.`,
    );
  }
  return value;
}

// Guard factory: `requirePlatform("ops")` admits ops and admin, refuses support.
// The message names the tier the caller lacks, because "forbidden" on a console
// somebody was just given access to reads as a broken account.
function requirePlatform(minimum: keyof typeof PLATFORM_RANK | string = "admin") {
  const required = PLATFORM_RANK[String(minimum)] ?? PLATFORM_RANK.admin;
  return async function platformGuard(c: Context, next: Next) {
    const user = await currentUserFromRequest(c);
    if (!user) return c.json({ error: "Please sign in to continue." }, 401);
    if (mustChangePassword(c, user)) return passwordChangeRequired(c);
    const rank = platformRank(user);
    if (rank <= 0) return c.json({ error: "Only platform staff can access this area." }, 403);
    if (rank < required) {
      return c.json({
        error: `This action needs the ${PLATFORM_ROLE_LABELS[String(minimum)] || minimum} role.`,
      }, 403);
    }
    c.set("user", user);
    await next();
  };
}

// Kept as the name the routers already import: the strictest tier.
const requirePlatformAdmin = requirePlatform("admin");

async function optionalAuth(c: Context, next: Next) {
  const user = await currentUserFromRequest(c);
  if (user) c.set("user", user);
  await next();
}

function primaryOrganization(user: any) {
  return user?.active_membership || user?.memberships?.[0] || null;
}

const ORG_MANAGE_ROLES = new Set(["org_owner", "org_admin", "admin"]);
const UNIT_MANAGE_ROLES = new Set(["org_owner", "org_admin", "unit_admin", "admin"]);

// Roles a membership may be created with. "admin" is deliberately absent: it is
// still honoured on existing rows above, but the two admin consoles used to
// offer different vocabularies for the same permissions, so new memberships
// come from one list. Anything unrecognised would silently become a member with
// no access at all, which reads as a broken login rather than a wrong role.
const ASSIGNABLE_ORG_ROLES = new Set(["org_owner", "org_admin", "unit_admin", "operator", "viewer"]);

function normalizeOrgRole(role: unknown, fallback: string) {
  const value = String(role || "").trim();
  if (!value) return fallback;
  if (!ASSIGNABLE_ORG_ROLES.has(value)) {
    throw new Error(`${value} is not a role. Choose one of: ${[...ASSIGNABLE_ORG_ROLES].join(", ")}.`);
  }
  return value;
}

function canManageOrganization(membership: any) {
  return Boolean(membership && ORG_MANAGE_ROLES.has(membership.role));
}

function canManageUnit(membership: any, unitId?: number | null) {
  if (!membership || !UNIT_MANAGE_ROLES.has(membership.role)) return false;
  if (membership.role === "unit_admin") {
    return Boolean(membership.unit_id && unitId && Number(membership.unit_id) === Number(unitId));
  }
  if (membership.scope_level === "unit" && membership.unit_id) {
    return Boolean(unitId && Number(membership.unit_id) === Number(unitId));
  }
  return true;
}

async function scopeForUser(user: any) {
  if (!user || isPlatformStaff(user)) {
    return { allStates: true, allowedStates: [], organizationId: null, unitId: null };
  }
  const org = primaryOrganization(user);
  if (!org) return { allStates: false, allowedStates: [], organizationId: null, unitId: null };
  const organizationScope = await db.getOrganizationScope(org.organization_id);
  if (!organizationScope) return { allStates: false, allowedStates: [], organizationId: null, unitId: null };
  if (org.scope_level === "unit" && org.unit_id) {
    return {
      ...organizationScope,
      allowedStates: org.unit_state ? [org.unit_state] : organizationScope.allowedStates,
      allStates: false,
      unitId: org.unit_id,
    };
  }
  return { ...organizationScope, unitId: null };
}

async function requireOrgManager(c: Context, next: Next) {
  const user = await currentUserFromRequest(c);
  if (!user) return c.json({ error: "Please sign in to continue." }, 401);
  if (mustChangePassword(c, user)) return passwordChangeRequired(c);
  // Support may read an organization console but not act in it, so the tier is
  // filtered out here rather than being handed a null membership that would let
  // every write through.
  if (isPlatformStaff(user)) {
    if (platformRank(user) < PLATFORM_RANK.ops && c.req.method !== "GET") {
      return c.json({ error: "The support role cannot make changes." }, 403);
    }
    c.set("user", user);
    c.set("membership", null);
    await next();
    return;
  }
  const membership = primaryOrganization(user);
  if (!canManageOrganization(membership) && !canManageUnit(membership, membership?.unit_id)) {
    return c.json({ error: "You do not have admin access for the selected organization." }, 403);
  }
  c.set("user", user);
  c.set("membership", membership);
  await next();
}

export {
  signToken,
  verifyToken,
  requireAuth,
  requirePlatform,
  requirePlatformAdmin,
  requireOrgManager,
  optionalAuth,
  currentUserFromRequest,
  primaryOrganization,
  canManageOrganization,
  canManageUnit,
  normalizeOrgRole,
  normalizePlatformRole,
  platformRank,
  isPlatformStaff,
  isPlatformOperator,
  isPlatformOwner,
  scopeForUser,
  ASSIGNABLE_PLATFORM_ROLES,
  PLATFORM_ROLE_LABELS,
};
