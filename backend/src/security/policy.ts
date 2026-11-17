// Sign-in rules for phones and new devices.
//
// The platform sets the loosest rules allowed; each organization may only make
// them stricter. A platform staff member follows the platform's rules alone.
// Every rule defaults to "off", so turning this on changes nothing until an
// admin sets something.

import * as db from "../db";

export type PhoneSignIn = "everyone" | "chosen" | "nobody";

export type SecurityPolicy = {
  /** Who may sign in on a phone: everyone, only people marked allowed, or nobody. */
  phone_sign_in: PhoneSignIn;
  /** Sign a phone out after this many minutes without use. */
  phone_idle_minutes: number | null;
  /** Sign a phone out this many hours after sign-in, used or not. */
  phone_max_hours: number | null;
  /** Ask for the app PIN after a phone has been unused this many minutes. */
  phone_lock_minutes: number | null;
  /** A new phone or computer must be approved by an admin before it can be used. */
  device_approval: boolean;
  /** Raise an amber alarm when someone signs in far from anywhere they have before. */
  unusual_location_alerts: boolean;
};

export const DEFAULT_POLICY: SecurityPolicy = {
  phone_sign_in: "everyone",
  phone_idle_minutes: null,
  phone_max_hours: null,
  phone_lock_minutes: null,
  device_approval: false,
  unusual_location_alerts: false,
};

const PHONE_ORDER: PhoneSignIn[] = ["nobody", "chosen", "everyone"];

const LIMITS = {
  phone_idle_minutes: [5, 24 * 60],
  phone_max_hours: [1, 7 * 24],
  phone_lock_minutes: [1, 24 * 60],
} as const;

/** Rules as stored, with anything missing or out of range dropped. */
export function normalizePolicy(input: any): Partial<SecurityPolicy> {
  const out: Partial<SecurityPolicy> = {};
  if (!input || typeof input !== "object") return out;
  if (PHONE_ORDER.includes(input.phone_sign_in)) out.phone_sign_in = input.phone_sign_in;
  for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value === null || value === "" || value === undefined) {
      out[key] = null;
      continue;
    }
    const number = Math.round(Number(value));
    const [min, max] = LIMITS[key];
    if (!Number.isFinite(number) || number < min || number > max) {
      throw new Error(`${describeLimit(key)} must be between ${min} and ${max}.`);
    }
    out[key] = number;
  }
  if ("device_approval" in input) out.device_approval = Boolean(input.device_approval);
  if ("unusual_location_alerts" in input) out.unusual_location_alerts = Boolean(input.unusual_location_alerts);
  return out;
}

function describeLimit(key: keyof typeof LIMITS) {
  return {
    phone_idle_minutes: "Minutes without use",
    phone_max_hours: "Hours before a phone is signed out",
    phone_lock_minutes: "Minutes before the app locks",
  }[key];
}

const stricterLimit = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.min(a, b);

/** The rules that apply when both the platform's and an organization's are in force. */
export function mergePolicies(platform: Partial<SecurityPolicy>, org: Partial<SecurityPolicy> = {}): SecurityPolicy {
  const p = { ...DEFAULT_POLICY, ...platform };
  const o = { ...DEFAULT_POLICY, ...org };
  return {
    phone_sign_in: PHONE_ORDER[Math.min(PHONE_ORDER.indexOf(p.phone_sign_in), PHONE_ORDER.indexOf(o.phone_sign_in))],
    phone_idle_minutes: stricterLimit(p.phone_idle_minutes, o.phone_idle_minutes),
    phone_max_hours: stricterLimit(p.phone_max_hours, o.phone_max_hours),
    phone_lock_minutes: stricterLimit(p.phone_lock_minutes, o.phone_lock_minutes),
    device_approval: p.device_approval || o.device_approval,
    unusual_location_alerts: p.unusual_location_alerts || o.unusual_location_alerts,
  };
}

/** May this person sign in on a phone under these rules? */
export function phoneAllowed(policy: SecurityPolicy, user: { phone_allowed?: boolean | null }) {
  if (policy.phone_sign_in === "nobody") return false;
  if (policy.phone_sign_in === "chosen") return user.phone_allowed !== false;
  return true;
}

// Read on every sign-in and, through the session check, often after it; held
// briefly and dropped on any change made through the API.
const CACHE_MS = 15_000;
let platformCache: { at: number; value: Partial<SecurityPolicy> } | null = null;
const orgCache = new Map<number, { at: number; value: Partial<SecurityPolicy> }>();

export function forgetPolicies() {
  platformCache = null;
  orgCache.clear();
}

export async function getPlatformPolicy(): Promise<Partial<SecurityPolicy>> {
  if (platformCache && Date.now() - platformCache.at < CACHE_MS) return platformCache.value;
  const { rows } = await db.pool.query("SELECT value FROM platform_settings WHERE key = 'security_policy'");
  const value = normalizePolicySafe(rows[0]?.value);
  platformCache = { at: Date.now(), value };
  return value;
}

export async function getOrgPolicy(organizationId: number): Promise<Partial<SecurityPolicy>> {
  const hit = orgCache.get(organizationId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const { rows } = await db.pool.query("SELECT security_policy FROM organizations WHERE id = $1", [organizationId]);
  const value = normalizePolicySafe(rows[0]?.security_policy);
  orgCache.set(organizationId, { at: Date.now(), value });
  return value;
}

// A stored value is trusted to have passed normalizePolicy once; if it has
// somehow gone out of range, ignore the bad field rather than lock people out.
function normalizePolicySafe(value: any): Partial<SecurityPolicy> {
  try {
    return normalizePolicy(value);
  } catch {
    return {};
  }
}

export async function setPlatformPolicy(input: any, actorId: number) {
  const value = { ...(await getPlatformPolicy()), ...normalizePolicy(input) };
  await db.pool.query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ('security_policy', $1::jsonb, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [JSON.stringify(value), actorId],
  );
  forgetPolicies();
  return value;
}

export async function setOrgPolicy(organizationId: number, input: any) {
  const value = { ...(await getOrgPolicy(organizationId)), ...normalizePolicy(input) };
  await db.pool.query("UPDATE organizations SET security_policy = $2::jsonb, updated_at = NOW() WHERE id = $1", [
    organizationId,
    JSON.stringify(value),
  ]);
  forgetPolicies();
  return value;
}

/** The rules in force for a person: the platform's, tightened by their organization's. */
export async function policyForUser(user: any, memberships: any[] = []): Promise<SecurityPolicy> {
  const platform = await getPlatformPolicy();
  const staff = user?.platform_role && user.platform_role !== "none";
  const orgId = staff ? null : Number(memberships[0]?.organization_id) || null;
  return mergePolicies(platform, orgId ? await getOrgPolicy(orgId) : {});
}
