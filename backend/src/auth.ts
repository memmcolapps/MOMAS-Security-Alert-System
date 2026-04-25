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
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = await db.getUserById(payload.sub);
  if (!user || user.status !== "active") return null;
  const memberships = await db.getMembershipsForUser(user.id);
  return { ...user, memberships };
}

async function requireAuth(c: Context, next: Next) {
  const user = await currentUserFromRequest(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
}

async function requirePlatformAdmin(c: Context, next: Next) {
  const user = await currentUserFromRequest(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  if (user.platform_role !== "admin") return c.json({ error: "forbidden" }, 403);
  c.set("user", user);
  await next();
}

async function optionalAuth(c: Context, next: Next) {
  const user = await currentUserFromRequest(c);
  if (user) c.set("user", user);
  await next();
}

function primaryOrganization(user: any) {
  return user?.memberships?.[0] || null;
}

async function scopeForUser(user: any) {
  if (!user || user.platform_role === "admin") {
    return { allStates: true, allowedStates: [], organizationId: null };
  }
  const org = primaryOrganization(user);
  if (!org) return { allStates: false, allowedStates: [], organizationId: null };
  return db.getOrganizationScope(org.organization_id);
}

export {
  signToken,
  verifyToken,
  requireAuth,
  requirePlatformAdmin,
  optionalAuth,
  currentUserFromRequest,
  primaryOrganization,
  scopeForUser,
};
