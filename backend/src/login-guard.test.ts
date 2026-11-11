import { describe, expect, test } from "bun:test";
import { EMAIL_LIMIT, IP_LIMIT, createLoginGuard } from "./login-guard";

describe("login guard", () => {
  test("stops an email after too many wrong passwords, then lets it try again", () => {
    let clock = 0;
    const guard = createLoginGuard(() => clock);
    for (let i = 0; i < EMAIL_LIMIT - 1; i++) guard.failed("a@x.test", "1.1.1.1");
    expect(guard.retryAfter("a@x.test", "1.1.1.1")).toBe(0);
    guard.failed("a@x.test", "1.1.1.1");
    expect(guard.retryAfter("a@x.test", "2.2.2.2")).toBeGreaterThan(0);
    expect(guard.retryAfter("b@x.test", "1.1.1.1")).toBe(0);
    clock += 15 * 60 * 1000;
    expect(guard.retryAfter("a@x.test", "1.1.1.1")).toBe(0);
  });

  test("a correct sign-in clears the email's count", () => {
    const guard = createLoginGuard(() => 0);
    for (let i = 0; i < EMAIL_LIMIT - 1; i++) guard.failed("a@x.test", null);
    guard.succeeded("a@x.test");
    guard.failed("a@x.test", null);
    expect(guard.retryAfter("a@x.test", null)).toBe(0);
  });

  test("stops an address trying many emails", () => {
    const guard = createLoginGuard(() => 0);
    for (let i = 0; i < IP_LIMIT; i++) guard.failed(`user${i}@x.test`, "9.9.9.9");
    expect(guard.retryAfter("new@x.test", "9.9.9.9")).toBeGreaterThan(0);
    expect(guard.retryAfter("new@x.test", "8.8.8.8")).toBe(0);
  });
});
