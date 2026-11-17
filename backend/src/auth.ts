import crypto from "node:crypto";
import type { Context, Next } from "hono";
import { env } from "./config";
import * as db from "./db";
import { clientIp, count, securityEvent } from "./metrics";
import { policyForUser, type SecurityPolicy } from "./security/policy";
import { getSession, judgeSession, noteActivity, type SessionRow } from "./security/sessions";

type TokenPayload = {
  sub: number;
  email: string;
  platform_role: string;
  exp: number;
  iat?: number;
  // When the person typed their password. Renewing a session keeps it, so a
  // session can be renewed for at most SESSION_MAX_SECONDS after sign-in.
  auth_time?: number;
  // The user_sessions row behind this token, so it can be ended from
  // anywhere. Tokens from before sessions were recorded have none until the
  // console next renews them.
  sid?: string;
};

// A session lasts 12 hours. The console renews it while it is open, so a
// dispatcher is not signed out mid-shift, but a copied token stops working
// within 12 hours of the console that held it closing. No session outlives
// 7 days from the password being typed.
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const SESSION_MAX_SECONDS = 7 * 24 * 60 * 60;

const base64url = (value: Buffer | string) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const sign = (data: string, secret: string) =>
  base64url(crypto.createHmac("sha256", secret).update(data).digest());

function signToken(payload: Omit<TokenPayload, "exp" | "iat">, ttlSeconds = SESSION_TTL_SECONDS) {
  const header = { alg: "HS256", typ: "JWT" };
  const issuedAt = Math.floor(Date.now() / 1000);
  const authTime = payload.auth_time ?? issuedAt;
  const body: TokenPayload = {
    ...payload,
    auth_time: authTime,
    iat: issuedAt,
    // Never past the hard cap, however often the session is renewed.
    exp: Math.min(issuedAt + ttlSeconds, authTime + SESSION_MAX_SECONDS),
  };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedBody = base64url(JSON.stringify(body));
  return `${encodedHeader}.${encodedBody}.${sign(`${encodedHeader}.${encodedBody}`, env.AUTH_JWT_SECRET)}`;
}

function signedByUs(data: string, signature: string) {
  const given = Buffer.from(signature);
  return [env.AUTH_JWT_SECRET, env.AUTH_JWT_SECRET_PREVIOUS]
    .filter(Boolean)
    .some((secret) => {
      const expected = Buffer.from(sign(data, secret));
      // timingSafeEqual throws on a length mismatch, which used to turn a
      // malformed token into a 500 instead of a refusal.
      return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    });
}

// "expired" is an ordinary session running out. "invalid" is a token this
// server never signed, which nobody gets by accident.
type TokenCheck = { payload: TokenPayload } | { payload: null; reason: "invalid" | "expired" };

function checkToken(token: string): TokenCheck {
  const invalid = { payload: null, reason: "invalid" } as const;
  const [encodedHeader, encodedBody, signature] = token.split(".");
  if (!encodedHeader || !encodedBody || !signature) return invalid;
  if (!signedByUs(`${encodedHeader}.${encodedBody}`, signature)) return invalid;
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

/** When the caller's session began (their sign-in), from the bearer token. */
function sessionStartedAt(c: Context) {
  const auth = c.req.header("authorization") || "";
  const payload = auth.startsWith("Bearer ") ? verifyToken(auth.slice(7)) : null;
  if (!payload) return null;
  return payload.auth_time ?? payload.iat ?? null;
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

/**
 * True while the account behind a long-lived connection may still use it:
 * the account is enabled and, when known, its session has not been ended.
 */
async function isUserStillActive(userId: number, sessionId?: string | null) {
  const identity = await loadIdentity(userId);
  if (!identity || identity.user.status !== "active") return false;
  if (!sessionId) return true;
  const session = await getSession(sessionId);
  return Boolean(session && !session.ended_at);
}

// The organization a panic session appears to belong to. No organization has
// this id, so every company-scoped query finds nothing, through the same
// checks that already keep one company out of another's data.
const DURESS_ORG_ID = -1;

type SessionContext = { session: SessionRow | null; policy: SecurityPolicy | null; locked: boolean; duress: boolean };

// Kept off the user object's own fields so it never reaches the console in
// /api/auth/me: the panic view must not be able to tell it is one.
const sessionContexts = new WeakMap<object, SessionContext>();

function sessionContextOf(user: any): SessionContext {
  return (user && sessionContexts.get(user)) || { session: null, policy: null, locked: false, duress: false };
}

/** What a panic session shows: a viewer in an organization with nothing in it. */
function duressView(user: any, memberships: any[]) {
  const shown = memberships.slice(0, 1).map((membership) => ({
    ...membership,
    organization_id: DURESS_ORG_ID,
    role: "viewer",
    scope_level: "organization",
    unit_id: null,
    unit_name: null,
    unit_state: null,
  }));
  return {
    user: {
      ...user,
      platform_role: "none",
      must_change_password: false,
      has_panic_password: false,
      has_panic_pin: false,
    },
    memberships: shown,
  };
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

  const context: SessionContext = { session: null, policy: null, locked: false, duress: false };
  if (payload.sid) {
    const session = await getSession(payload.sid);
    if (!session || Number(session.user_id) !== Number(payload.sub)) return null;
    const policy = await policyForUser(identity.user, identity.memberships);
    const verdict = await judgeSession(session, policy);
    if (!verdict.ok) {
      count("auth.session_ended");
      return null;
    }
    // A stream reconnecting is not someone using the phone.
    if (!URL_TOKEN_PATHS.test(c.req.path)) {
      const header = c.req.header("x-last-input");
      const seconds = header === undefined || header === "" ? null : Number(header);
      noteActivity(session, Number.isFinite(seconds) ? (seconds as number) : null);
    }
    // Without a PIN there is nothing to unlock with; the PIN setup screen
    // (pin_required below) holds the session instead.
    const locked = verdict.locked && Boolean(identity.user.has_app_pin);
    Object.assign(context, { session, policy, locked, duress: session.duress });
  }

  const { sessions_valid_after: _validAfter, ...realUser } = identity.user;
  const view = context.duress ? duressView(realUser, identity.memberships) : { user: realUser, memberships: identity.memberships };
  const { memberships } = view;
  const requestedOrganizationId = Number(c.req.header("x-organization-id") || c.req.query("organization_id") || "");
  const activeMembership =
    memberships.find((membership) => Number(membership.organization_id) === requestedOrganizationId) ||
    memberships[0] ||
    null;
  const session = context.session;
  const user = {
    ...view.user,
    memberships,
    active_organization_id: activeMembership?.organization_id || null,
    active_membership: activeMembership,
    session_id: session?.id ?? null,
    // What the console needs to enforce the rules on its side too: lock the
    // screen at once on waking rather than after the first refused request.
    session_rules: session?.is_phone && context.policy
      ? { phone: true, lock_minutes: context.policy.phone_lock_minutes, idle_minutes: context.policy.phone_idle_minutes }
      : { phone: Boolean(session?.is_phone), lock_minutes: null, idle_minutes: null },
    pin_required: Boolean(session?.is_phone && context.policy?.phone_lock_minutes && !view.user.has_app_pin),
    // The console opens straight onto the lock screen rather than the map.
    app_locked: context.locked,
  };
  sessionContexts.set(user, context);
  return user;
}

// Paths a session may still reach while its screen is locked, or before its
// PIN is set, or in the panic view. Everything else waits. /me answers while
// locked so the console knows to show the lock screen; it carries only the
// person's own name and roles.
const LOCKED_PATHS = new Set(["/api/auth/unlock", "/api/auth/logout", "/api/auth/me"]);
const PIN_SETUP_PATHS = new Set(["/api/auth/me", "/api/auth/pin", "/api/auth/logout", "/api/auth/refresh", "/api/auth/change-password"]);
const DURESS_WRITE_PATHS = new Set(["/api/auth/logout", "/api/auth/refresh", "/api/auth/unlock"]);

/** A refusal for a signed-in request the session's state does not allow, or null. */
function sessionGate(c: Context, user: any): Response | null {
  const context = sessionContextOf(user);
  const path = c.req.path;
  if (context.locked && !LOCKED_PATHS.has(path)) {
    return c.json({ error: "app_locked", message: "Enter your PIN to continue." }, 423);
  }
  if (user.pin_required && !PIN_SETUP_PATHS.has(path)) {
    return c.json({ error: "pin_required", message: "Set an app PIN to use EPAIL on this phone." }, 403);
  }
  // The panic view looks around but changes nothing.
  if (context.duress && c.req.method !== "GET" && !DURESS_WRITE_PATHS.has(path)) {
    return c.json({ error: "forbidden", message: "Your role can view this but not change it." }, 403);
  }
  return null;
}

/** The session behind a signed-in request, for the routes that manage sessions. */
function requestSession(c: Context) {
  return sessionContextOf(c.get("user")).session;
}

/** True when the request comes from a panic sign-in. */
function isDuressRequest(c: Context) {
  return sessionContextOf(c.get("user")).duress;
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
  const gated = sessionGate(c, user);
  if (gated) return gated;
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
    const gated = sessionGate(c, user);
    if (gated) return gated;
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
  if (user && !sessionGate(c, user)) c.set("user", user);
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
  const gated = sessionGate(c, user);
  if (gated) return gated;
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
  sessionStartedAt,
  requestSession,
  isDuressRequest,
  duressView,
  DURESS_ORG_ID,
  SESSION_TTL_SECONDS,
  SESSION_MAX_SECONDS,
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
