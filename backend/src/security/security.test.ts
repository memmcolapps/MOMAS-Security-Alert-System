import { describe, expect, test } from "bun:test";

// What the session check did, instead of writing it to the database.
const writes: string[] = [];
const steps = {
  end: async (_session: unknown, reason: string) => writes.push(`end:${reason}`),
  lock: async () => writes.push("lock"),
};

const { DEFAULT_POLICY, mergePolicies, normalizePolicy, phoneAllowed } = await import("./policy");
const { distanceKm, isUnusualPlace } = await import("./person-alarms");
const { judgeSession, describeUserAgent, looksLikePhone } = await import("./sessions");

describe("rules: an organization can only be stricter than the platform", () => {
  test("the stricter of each rule wins", () => {
    const merged = mergePolicies(
      { phone_sign_in: "chosen", phone_idle_minutes: 60, phone_max_hours: null, device_approval: false },
      { phone_sign_in: "everyone", phone_idle_minutes: 120, phone_max_hours: 8, device_approval: true },
    );
    expect(merged.phone_sign_in).toBe("chosen");
    expect(merged.phone_idle_minutes).toBe(60);
    expect(merged.phone_max_hours).toBe(8);
    expect(merged.device_approval).toBe(true);
  });

  test("an organization cannot loosen the platform's 'nobody'", () => {
    expect(mergePolicies({ phone_sign_in: "nobody" }, { phone_sign_in: "everyone" }).phone_sign_in).toBe("nobody");
  });

  test("nothing set means nothing changes", () => {
    expect(mergePolicies({}, {})).toEqual(DEFAULT_POLICY);
  });

  test("'chosen' lets in only people still marked allowed", () => {
    const chosen = { ...DEFAULT_POLICY, phone_sign_in: "chosen" as const };
    expect(phoneAllowed(chosen, { phone_allowed: true })).toBe(true);
    expect(phoneAllowed(chosen, { phone_allowed: false })).toBe(false);
    expect(phoneAllowed({ ...DEFAULT_POLICY, phone_sign_in: "nobody" }, { phone_allowed: true })).toBe(false);
  });

  test("limits outside the allowed range are refused, blanks clear a limit", () => {
    expect(() => normalizePolicy({ phone_idle_minutes: 1 })).toThrow();
    expect(() => normalizePolicy({ phone_max_hours: 1000 })).toThrow();
    expect(normalizePolicy({ phone_idle_minutes: "", phone_lock_minutes: "5" })).toEqual({
      phone_idle_minutes: null,
      phone_lock_minutes: 5,
    });
    expect(normalizePolicy({ phone_sign_in: "anyone" })).toEqual({});
  });
});

describe("unusual place", () => {
  const lagos = { lat: 6.52, lon: 3.38 };
  const ikeja = { lat: 6.6, lon: 3.35 };
  const abuja = { lat: 9.06, lon: 7.5 };

  test("distances are right to within a few km", () => {
    expect(Math.round(distanceKm(lagos, abuja))).toBeGreaterThan(520);
    expect(Math.round(distanceKm(lagos, abuja))).toBeLessThan(540);
  });

  test("nothing is unusual until a few places are known", () => {
    expect(isUnusualPlace(abuja, [lagos, ikeja])).toBe(false);
  });

  test("far from every known place is unusual; near any one is not", () => {
    expect(isUnusualPlace(abuja, [lagos, ikeja, lagos])).toBe(true);
    expect(isUnusualPlace(ikeja, [lagos, abuja, abuja])).toBe(false);
  });
});

describe("phone sessions: lock and time limits", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const session = (overrides: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    user_id: 1,
    device_id: null,
    label: "iPhone · Safari",
    is_phone: true,
    ip: null,
    lat: null,
    lon: null,
    duress: false,
    created_at: minutesAgo(30),
    last_seen_at: minutesAgo(0),
    last_active_at: minutesAgo(0),
    locked_at: null,
    pin_failures: 0,
    ended_at: null,
    end_reason: null,
    ...overrides,
  });
  const rules = { ...DEFAULT_POLICY, phone_idle_minutes: 60, phone_max_hours: 8, phone_lock_minutes: 5 };

  test("a phone in use stays open and unlocked", async () => {
    expect(await judgeSession(session() as any, rules, Date.now(), steps)).toEqual({ ok: true, locked: false });
  });

  test("a phone unused past the lock time locks", async () => {
    expect(await judgeSession(session({ last_active_at: minutesAgo(10) }) as any, rules, Date.now(), steps)).toEqual({ ok: true, locked: true });
  });

  test("a phone unused past the idle limit is signed out", async () => {
    writes.length = 0;
    const verdict = await judgeSession(session({ last_active_at: minutesAgo(61) }) as any, rules, Date.now(), steps);
    expect(verdict).toEqual({ ok: false, reason: "not used" });
    expect(writes).toContain("end:not used");
  });

  test("a phone past its time limit is signed out even while in use", async () => {
    expect(await judgeSession(session({ created_at: minutesAgo(8 * 60 + 1) }) as any, rules, Date.now(), steps)).toEqual({ ok: false, reason: "time limit" });
  });

  test("a computer is never locked or timed out by the phone rules", async () => {
    const desk = session({ is_phone: false, created_at: minutesAgo(48 * 60), last_active_at: minutesAgo(600) });
    expect(await judgeSession(desk as any, rules, Date.now(), steps)).toEqual({ ok: true, locked: false });
  });

  test("an ended session stays ended", async () => {
    expect(await judgeSession(session({ ended_at: minutesAgo(1), end_reason: "signed out by an admin" }) as any, rules, Date.now(), steps)).toEqual({
      ok: false,
      reason: "signed out by an admin",
    });
  });
});

describe("recognising devices", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

  test("names the system and browser", () => {
    expect(describeUserAgent(iphone)).toBe("iPhone · Safari");
    expect(describeUserAgent(windows)).toBe("Windows · Chrome");
  });

  test("a phone asking for the desktop site is still a phone when the page says so", () => {
    expect(looksLikePhone(iphone, false)).toBe(true);
    expect(looksLikePhone(windows, false)).toBe(false);
    expect(looksLikePhone(windows, true)).toBe(true);
  });
});
