/**
 * Platform tier tests.
 *
 * These cover the boundary the rest of the codebase now leans on: ~15 call
 * sites ask isPlatformStaff whether to drop organization scoping, and every
 * platform route asks requirePlatform whether to run at all. A tier that ranks
 * wrong here is a cross-tenant read or an unauthorised write everywhere else.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const usersById = new Map<number, any>();

mock.module("./db", () => ({
  getUserById: async (id: number) => usersById.get(Number(id)) ?? null,
  getMembershipsForUser: async () => [],
}));

const {
  signToken,
  platformRank,
  isPlatformStaff,
  isPlatformOperator,
  isPlatformOwner,
  normalizePlatformRole,
  requirePlatform,
} = await import("./auth");

function seedUser(id: number, platform_role: string, overrides: Record<string, unknown> = {}) {
  const user = { id, email: `${platform_role}@example.test`, platform_role, status: "active", ...overrides };
  usersById.set(id, user);
  return user;
}

/** Minimal stand-in for the Hono context the guards actually touch. */
function contextFor(token: string | null, method = "GET") {
  const stored: Record<string, unknown> = {};
  let status: number | null = null;
  let body: any = null;
  return {
    ctx: {
      req: {
        method,
        path: "/api/platform/staff",
        header: (name: string) =>
          name.toLowerCase() === "authorization" && token ? `Bearer ${token}` : undefined,
        query: () => undefined,
      },
      set: (key: string, value: unknown) => {
        stored[key] = value;
      },
      get: (key: string) => stored[key],
      json: (value: any, code?: number) => {
        body = value;
        status = code ?? 200;
        return { body, status };
      },
    } as any,
    result: () => ({ status, body, stored }),
  };
}

async function run(guard: any, user: any | null, method = "GET") {
  const token = user
    ? signToken({ sub: user.id, email: user.email, platform_role: user.platform_role })
    : "";
  const { ctx, result } = contextFor(token || null, method);
  let reachedHandler = false;
  await guard(ctx, async () => {
    reachedHandler = true;
  });
  return { reachedHandler, ...result() };
}

beforeEach(() => usersById.clear());

describe("platform ranks", () => {
  test("orders the tiers and treats anything unknown as no access", () => {
    expect(platformRank({ platform_role: "admin" })).toBe(3);
    expect(platformRank({ platform_role: "ops" })).toBe(2);
    expect(platformRank({ platform_role: "support" })).toBe(1);
    expect(platformRank({ platform_role: "none" })).toBe(0);
    // A tier this build does not know must fail closed, not open.
    expect(platformRank({ platform_role: "superuser" })).toBe(0);
    expect(platformRank(null)).toBe(0);
  });

  test("staff covers every tier, operator and owner do not", () => {
    const support = { platform_role: "support" };
    const ops = { platform_role: "ops" };
    const owner = { platform_role: "admin" };
    const tenant = { platform_role: "none" };

    expect([support, ops, owner].every(isPlatformStaff)).toBe(true);
    expect(isPlatformStaff(tenant)).toBe(false);

    expect(isPlatformOperator(support)).toBe(false);
    expect(isPlatformOperator(ops)).toBe(true);
    expect(isPlatformOperator(owner)).toBe(true);

    expect(isPlatformOwner(ops)).toBe(false);
    expect(isPlatformOwner(owner)).toBe(true);
  });

  test("only the three named tiers may be assigned", () => {
    expect(normalizePlatformRole("ops")).toBe("ops");
    expect(() => normalizePlatformRole("none")).toThrow(/not a platform role/);
    expect(() => normalizePlatformRole("owner")).toThrow(/not a platform role/);
    expect(() => normalizePlatformRole("")).toThrow(/not a platform role/);
  });
});

describe("requirePlatform", () => {
  test("admits the required tier and everything above it", async () => {
    const ops = seedUser(1, "ops");
    const owner = seedUser(2, "admin");

    expect((await run(requirePlatform("ops"), ops)).reachedHandler).toBe(true);
    expect((await run(requirePlatform("ops"), owner)).reachedHandler).toBe(true);
  });

  test("refuses a tier below the requirement", async () => {
    const support = seedUser(3, "support");
    const denied = await run(requirePlatform("ops"), support);
    expect(denied.reachedHandler).toBe(false);
    expect(denied.status).toBe(403);

    const ops = seedUser(4, "ops");
    const owners_only = await run(requirePlatform("admin"), ops);
    expect(owners_only.reachedHandler).toBe(false);
    expect(owners_only.status).toBe(403);
  });

  test("refuses a tenant user and an anonymous request", async () => {
    const tenant = seedUser(5, "none");
    const asTenant = await run(requirePlatform("support"), tenant);
    expect(asTenant.reachedHandler).toBe(false);
    expect(asTenant.status).toBe(403);

    const anonymous = await run(requirePlatform("support"), null);
    expect(anonymous.reachedHandler).toBe(false);
    expect(anonymous.status).toBe(401);
  });

  test("holds a staff account on its temporary password", async () => {
    const fresh = seedUser(6, "admin", { must_change_password: true });
    const held = await run(requirePlatform("admin"), fresh);
    expect(held.reachedHandler).toBe(false);
    expect(held.status).toBe(403);
    expect(held.body.must_change_password).toBe(true);
  });

  test("refuses a disabled account whose token is still valid", async () => {
    const suspended = seedUser(7, "admin", { status: "disabled" });
    const refused = await run(requirePlatform("support"), suspended);
    expect(refused.reachedHandler).toBe(false);
    expect(refused.status).toBe(401);
  });

  test("reads the tier from the database, not from the token", async () => {
    // A token minted while somebody was an owner must not keep owner powers
    // after they are demoted - the guard re-reads the row every request.
    const demoted = seedUser(8, "admin");
    const token = signToken({ sub: 8, email: demoted.email, platform_role: "admin" });
    usersById.set(8, { ...demoted, platform_role: "support" });

    const { ctx } = contextFor(token);
    let reached = false;
    await requirePlatform("admin")(ctx, async () => {
      reached = true;
    });
    expect(reached).toBe(false);
  });
});
