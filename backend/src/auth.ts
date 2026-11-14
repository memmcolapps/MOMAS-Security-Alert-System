import crypto from "node:crypto";
import type { Context, Next } from "hono";
import { env } from "./config";
import * as db from "./db";
import { clientIp, count, securityEvent } from "./metrics";

type TokenPayload = {
  sub: number;
  email: string;
  platform_role: string;
  exp: number;
  iat?: number;
};

const base64url = (value: Buffer | string) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

function signToken(payload: Omit<TokenPayload, "exp" | "iat">, ttlSeconds = 7 * 24 * 60 * 60) {
  const header = { alg: "HS256", typ: "JWT" };
  const issuedAt = Math.floor(Date.now() / 1000);
  const body: TokenPayload = {
    ...payload,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedBody = base64url(JSON.stringify(body));
  const signature = crypto
    .createHmac("sha256", env.AUTH_JWT_SECRET)
    .update(`${encodedHeader}.${encodedBody}`)
    .digest();
  return `${encodedHeader}.${encodedBody}.${base64url(signature)}`;
}

// "expired" is an ordinary session running out. "invalid" is a token this
// server never signed, which nobody gets by accident.
type TokenCheck = { payload: TokenPayload } | { payload: null; reason: "invalid" | "expired" };

function checkToken(token: string): TokenCheck {
  const invalid = { payload: null, reason: "invalid" } as const;
  const [encodedHeader, encodedBody, signature] = token.split(".");
  if (!encodedHeader || !encodedBody || !signature) return invalid;
  const expected = Buffer.from(
    base64url(
      crypto
        .createHmac("sha256", env.AUTH_JWT_SECRET)
        .update(`${encodedHeader}.${encodedBody}`)
        .digest(),
    ),
  );
  const given = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch, which used to turn a
  // malformed token into a 500 instead of a refusal.
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return invalid;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedBody, "base64url").toString("utf8"));
  } catch {
    return invalid;
  }
  if (!payload?.exp || payload.exp < Math.floor(Date.now() / 1000)) return { payload: null, reason: "expired" };
  return { payload };
}

function verifyToken(token: string): TokenPayload | null {
  return checkToken(token).payload;
}

// Every authenticated request used to spend two or three sequential database
// round trips (user, memberships, organization scope) before doing any work,
// and the operations map fires half a dozen requests at once. The lookups are
// held briefly and shared between concurrent requests. Any write through the
// API drops the lot (invalidateAuthCache, wired in server.ts), so a disabled
// account, a role change or a cleared must_change_password is seen on the very
// next request; only changes made outside the API wait out the TTL.
const AUTH_CACHE_MS = 15_000;
type Cached<T> = { at: number; value: Promise<T> };
const identityCache = new Map<number, Cached<{ user: any; memberships: any[] } | null>>();
const scopeCache = new Map<number, Cached<any>>();

function cached<K, T>(cache: Map<K, Cached<T>>, key: K, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < AUTH_CACHE_MS) return hit.value;
  const value = load();
  const entry = { at: Date.now(), value };
  cache.set(key, entry);
  // A failed lookup must not be served to the next request.
  value.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return value;
}

function invalidateAuthCache() {
  identityCache.clear();
  scopeCache.clear();
}

function loadIdentity(userId: number) {
  return cached(identityCache, userId, async () => {
    const user = await db.getUserById(userId);
    if (!user) return null;
    return { user, memberships: await db.getMembershipsForUser(user.id) };
  });
}

// Streams, the live radio socket and audio players, which a browser opens
// without letting the page set headers.
const URL_TOKEN_PATHS = /\/(events|positions\/stream|radio\/live|calls\/live|radio\/recordings\/[^/]+\/audio)$/;

/** True while the account behind a long-lived connection may still use it. */
async function isUserStillActive(userId: number) {
  const identity = await loadIdentity(userId);
  return Boolean(identity && identity.user.status === "active");
}

async function currentUserFromRequest(c: Context) {
  const auth = c.req.header("authorization") || "";
  // EventSource (used by the OSINT live alert stream) cannot set headers, so we
  // accept the token and active org via query params as a fallback for SSE.
  // Only those few routes take it from the URL; a token there ends up in proxy
  // logs, so every other route needs the header.
  const token = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : URL_TOKEN_PATHS.test(c.req.path)
      ? c.req.query("access_token") || ""
      : "";
  if (!token) return null;
  const checked = checkToken(token);
  if ("reason" in checked) {
    if (checked.reason === "expired") count("auth.token_expired");
    else securityEvent("bad_token", { ip: clientIp(c), path: c.req.path });
    return null;
  }
  const payload = checked.payload;
  const identity = await loadIdentity(payload.sub);
  if (!identity || identity.user.status !== "active") return null;
  // A password change ends every session signed in before it.
  const validAfter = identity.user.sessions_valid_after ? new Date(identity.user.sessions_valid_after).getTime() : 0;
  if (validAfter && (payload.iat ?? 0) < Math.floor(validAfter / 1000)) return null;
  const { sessions_valid_after: _validAfter, ...user } = identity.user;
  const { memberships } = identity;
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

// How much each organization role may do. A manager can only hand out or touch
// roles below their own, so nobody can promote themselves or a friend past
// where they stand. Owners are the exception: they may appoint other owners.
const ORG_ROLE_RANK: Record<string, number> = {
  viewer: 0,
  operator: 1,
  unit_admin: 2,
  org_admin: 3,
  admin: 3,
  org_owner: 4,
};

function orgRoleRank(role: unknown) {
  return ORG_ROLE_RANK[String(role || "")] ?? -1;
}

function managesOnlyOneUnit(membership: any) {
  return membership?.role === "unit_admin" || (membership?.scope_level === "unit" && membership?.unit_id);
}

/**
 * Why `actor` may not add, change or remove a member, or null when they may.
 * `target` is the member's current membership (null for someone new), `next`
 * the membership asked for (null when removing). Platform staff skip this.
 */
function orgMemberChangeError({
  actor,
  actorUserId,
  targetUserId = null,
  target = null,
  next = null,
}: {
  actor: any;
  actorUserId: number;
  targetUserId?: number | null;
  target?: { role: string; unit_id?: number | null } | null;
  next?: { role: string; unit_id?: number | null } | null;
}): string | null {
  const actorRank = orgRoleRank(actor?.role);
  const isOwner = actor?.role === "org_owner";
  if (targetUserId != null && Number(targetUserId) === Number(actorUserId)) {
    return "You cannot change or remove your own access. Ask another admin.";
  }
  if (target) {
    if (!isOwner && orgRoleRank(target.role) >= actorRank) {
      return "You can only change members whose role is below yours.";
    }
    if (managesOnlyOneUnit(actor) && Number(target.unit_id) !== Number(actor.unit_id)) {
      return "You can only change members of your own unit.";
    }
  }
  if (next) {
    const nextRank = orgRoleRank(next.role);
    if (isOwner ? nextRank > actorRank : nextRank >= actorRank) {
      return "You can only give roles below your own.";
    }
    if (managesOnlyOneUnit(actor) && Number(next.unit_id) !== Number(actor.unit_id)) {
      return "You can only add members to your own unit.";
    }
  }
  return null;
}

/**
 * True when the user may act (answer alarms, message or rename radios), not
 * just watch. Viewers watch. Platform support watches; ops and admin act.
 */
function canOperate(user: any) {
  if (!user) return false;
  if (isPlatformStaff(user)) return platformRank(user) >= PLATFORM_RANK.ops;
  return orgRoleRank(primaryOrganization(user)?.role) >= ORG_ROLE_RANK.operator;
}

// Route guard for actions. Runs after requireAuth, which sets the user.
async function requireOperator(c: Context, next: Next) {
  if (!canOperate(c.get("user"))) {
    return c.json({ error: "forbidden", message: "Your role can view this but not change it." }, 403);
  }
  await next();
}

// Route guard for a module the platform switches on per company (drone,
// geofence, ...). The UI hides a module that is off; this stops its API too.
// No modules listed means all of them, as the UI reads it.
function requireModule(module: string) {
  return async (c: Context, next: Next) => {
    const user = c.get("user");
    if (!isPlatformStaff(user)) {
      const modules = primaryOrganization(user)?.modules;
      if (Array.isArray(modules) && modules.length && !modules.includes(module)) {
        return c.json({ error: "forbidden", message: "This module is not turned on for your organization." }, 403);
      }
    }
    await next();
  };
}

async function scopeForUser(user: any) {
  if (!user || isPlatformStaff(user)) {
    return { allStates: true, allowedStates: [], organizationId: null, unitId: null };
  }
  const org = primaryOrganization(user);
  if (!org) return { allStates: false, allowedStates: [], organizationId: null, unitId: null };
  const organizationId = Number(org.organization_id);
  const organizationScope = await cached(scopeCache, organizationId, () => db.getOrganizationScope(organizationId));
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
  invalidateAuthCache,
  primaryOrganization,
  canManageOrganization,
  canManageUnit,
  normalizeOrgRole,
  orgMemberChangeError,
  managesOnlyOneUnit,
  canOperate,
  requireOperator,
  requireModule,
  isUserStillActive,
  normalizePlatformRole,
  platformRank,
  isPlatformStaff,
  isPlatformOperator,
  isPlatformOwner,
  scopeForUser,
  ASSIGNABLE_PLATFORM_ROLES,
  PLATFORM_ROLE_LABELS,
};
