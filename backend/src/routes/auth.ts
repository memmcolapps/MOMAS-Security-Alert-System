import { Hono } from "hono";
import {
  duressView,
  isDuressRequest,
  platformRank,
  requestSession,
  requireAuth,
  SESSION_MAX_SECONDS,
  sessionStartedAt,
  signToken,
  verifyToken,
} from "../auth";
import * as db from "../db";
import { loginGuard } from "../login-guard";
import { clientIp, count, securityEvent } from "../metrics";
import {
  checkPassword,
  isPanicPassword,
  setAppPin,
  setPanicSecrets,
  whichPin,
} from "../security/credentials";
import { isUnusualPlace, openDuressAlarm, raisePersonAlarm } from "../security/person-alarms";
import { phoneAllowed, policyForUser } from "../security/policy";
import {
  createSession,
  describeUserAgent,
  endOtherSessions,
  endSession,
  findOrCreateDevice,
  listDevices,
  listSessions,
  looksLikePhone,
  markDuress,
  notePinFailure,
  previousLocations,
  setDeviceStatus,
  unlockSession,
} from "../security/sessions";

const router = new Hono();

// A real bcrypt hash of a random password, made once, used for unknown emails.
let dummy: Promise<string> | null = null;
function dummyHash() {
  dummy ||= (Bun as any).password.hash(crypto.randomUUID(), { algorithm: "bcrypt", cost: 10 });
  return dummy as Promise<string>;
}

// The random id a browser keeps for itself, so the same phone is recognised
// next time. Old consoles send none.
function deviceKeyFrom(body: any) {
  const key = String(body?.device?.id || "");
  return /^[A-Za-z0-9_-]{16,128}$/.test(key) ? key : null;
}

function locationFrom(body: any) {
  const lat = Number(body?.location?.lat);
  const lon = Number(body?.location?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// A platform owner approves devices, so nobody is above them to approve
// theirs; their devices are exempt rather than lock the platform out.
const approvesOwnDevices = (user: any) => platformRank(user) >= 3;

function refusal(c: any, status: 401 | 403, error: string, message: string) {
  return c.json({ error, message }, status);
}

router.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) return c.json({ error: "email and password are required" }, 400);

  const ip = clientIp(c);
  const wait = loginGuard.retryAfter(email, ip);
  if (wait) {
    securityEvent("login_failed", { ip, email, path: c.req.path });
    c.header("Retry-After", String(wait));
    return c.json({ error: `Too many sign-in attempts. Try again in ${Math.ceil(wait / 60)} minutes.` }, 429);
  }
  const refuse = () => {
    loginGuard.failed(email, ip);
    securityEvent("login_failed", { ip, email, path: c.req.path });
    return c.json({ error: "invalid credentials" }, 401);
  };
  const user = await db.getUserByEmail(email);
  // An unknown email still pays for a password check, so the response time
  // does not reveal which emails have accounts.
  const real = await (Bun as any).password.verify(password, user?.password_hash || (await dummyHash()));
  const duress = Boolean(user && !real && (await isPanicPassword(password, user)));
  if (!user || user.status !== "active" || (!real && !duress)) return refuse();

  const memberships = await db.getMembershipsForUser(user.id);
  const ua = c.req.header("user-agent");
  const label = describeUserAgent(ua);
  const isPhone = looksLikePhone(ua, body?.device?.phone);
  const location = locationFrom(body);

  if (duress) {
    // The alarm goes first, whatever happens to this sign-in next, and the
    // person's other devices are signed out so the captor cannot use them.
    count("auth.panic_sign_in");
    await raisePersonAlarm({
      type: "duress",
      user,
      memberships,
      lat: location?.lat,
      lon: location?.lon,
      detail: { device: label, ip, how: "panic password at sign-in" },
    }).catch((error) => console.error("[Security] panic alarm failed:", error));
    await endOtherSessions(user.id, null, "panic sign-in").catch(() => {});
  } else if (await openDuressAlarm(user.id)) {
    // After a panic sign-in the real password stops working until an admin
    // closes the alarm. It answers exactly like a wrong password.
    return refuse();
  }
  loginGuard.succeeded(email);

  const policy = await policyForUser(user, memberships);
  if (isPhone && !phoneAllowed(policy, user)) {
    return refusal(c, 403, "phone_not_allowed", "Signing in on a phone is turned off for your account. Use a computer, or ask your admin.");
  }

  const deviceKey = deviceKeyFrom(body);
  const needsApproval = policy.device_approval && !approvesOwnDevices(user);
  if (!deviceKey && needsApproval) {
    return refusal(c, 403, "device_unknown", "This page is out of date. Reload it and sign in again.");
  }
  let device = deviceKey
    ? await findOrCreateDevice(user.id, deviceKey, { label, isPhone, status: needsApproval ? "pending" : "approved" })
    : null;
  if (device?.status === "blocked") {
    return refusal(c, 403, "device_blocked", "This device has been blocked. Ask your admin.");
  }
  if (device?.status === "pending") {
    if (needsApproval) {
      return refusal(c, 403, "device_pending", `This device is waiting for approval. Ask your admin to approve "${label}".`);
    }
    // Approval was switched off after this device asked.
    device = await setDeviceStatus(user.id, device.id, "approved", user.id);
  }

  const session = await createSession({
    userId: user.id,
    deviceId: device?.id ?? null,
    label,
    isPhone,
    ip,
    lat: location?.lat,
    lon: location?.lon,
    duress,
  });
  count("auth.login_ok");

  if (!duress && location && policy.unusual_location_alerts) {
    const before = await previousLocations(user.id, session.id);
    if (isUnusualPlace(location, before)) {
      await raisePersonAlarm({
        type: "unusual_sign_in",
        user,
        memberships,
        lat: location.lat,
        lon: location.lon,
        detail: { device: label, ip },
      }).catch((error) => console.error("[Security] unusual-place alarm failed:", error));
    }
  }

  const shown = duress ? duressView(user, memberships) : { user, memberships };
  const token = signToken({ sub: user.id, email: user.email, platform_role: user.platform_role, sid: session.id });
  return c.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      platform_role: shown.user.platform_role,
      must_change_password: shown.user.must_change_password,
      memberships: shown.memberships,
    },
  });
});

// Ends this sign-in. Works while the screen is locked, and without the full
// sign-in check, so a lost-phone scare can always end at least this session.
router.post("/logout", async (c) => {
  const auth = c.req.header("authorization") || "";
  const payload = auth.startsWith("Bearer ") ? verifyToken(auth.slice(7)) : null;
  if (payload?.sid) await endSession(payload.sub, payload.sid, "signed out", payload.sub).catch(() => {});
  return c.json({ ok: true });
});

router.get("/me", requireAuth, async (c) => {
  return c.json({ user: (c as any).get("user") });
});

// The console calls this while it is open, to swap its session for a fresh
// 12-hour one. The sign-in time carries over, so renewing never stretches a
// session past 7 days from the password being typed.
router.post("/refresh", requireAuth, async (c) => {
  const user = (c as any).get("user");
  const startedAt = sessionStartedAt(c);
  if (!startedAt || Math.floor(Date.now() / 1000) - startedAt >= SESSION_MAX_SECONDS) {
    return c.json({ error: "Please sign in again." }, 401);
  }
  let sid = requestSession(c)?.id;
  if (!sid) {
    // Signed in before sessions were recorded: record this one now, so it
    // shows in the device list and can be ended. Its device is taken as known.
    const body = await c.req.json().catch(() => ({}));
    const ua = c.req.header("user-agent");
    const label = describeUserAgent(ua);
    const isPhone = looksLikePhone(ua, body?.device?.phone);
    const deviceKey = deviceKeyFrom(body);
    const device = deviceKey ? await findOrCreateDevice(user.id, deviceKey, { label, isPhone, status: "approved" }) : null;
    sid = (await createSession({ userId: user.id, deviceId: device?.id ?? null, label, isPhone, ip: clientIp(c) })).id;
  }
  const token = signToken({ sub: user.id, email: user.email, platform_role: user.platform_role, auth_time: startedAt, sid });
  return c.json({ token });
});

router.post("/change-password", requireAuth, async (c) => {
  const currentUser = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  const currentPassword = String(body.current_password || "");
  const newPassword = String(body.new_password || "");
  if (!currentPassword || !newPassword) {
    return c.json({ error: "Enter your current password and a new password." }, 400);
  }
  if (newPassword.length < 8) {
    return c.json({ error: "Your new password must be at least 8 characters." }, 400);
  }
  if (currentPassword === newPassword) {
    return c.json({ error: "Choose a new password that is different from your temporary password." }, 400);
  }
  const user = await db.getUserByEmail(currentUser.email);
  const ok = user ? await (Bun as any).password.verify(currentPassword, user.password_hash) : false;
  if (!ok) return c.json({ error: "Your current password is incorrect." }, 400);

  const updated = await db.updateUserPassword(currentUser.id, newPassword);
  const memberships = await db.getMembershipsForUser(currentUser.id);
  // Changing the password signs out every other session, so this one gets a
  // fresh token to stay signed in.
  const sid = requestSession(c)?.id;
  await endOtherSessions(currentUser.id, sid ?? null, "password changed", currentUser.id);
  const token = signToken({ sub: updated.id, email: updated.email, platform_role: updated.platform_role, sid });
  return c.json({
    token,
    user: {
      ...updated,
      memberships,
      active_organization_id: currentUser.active_organization_id,
      active_membership: currentUser.active_membership,
    },
  });
});

// ── My devices ──────────────────────────────────────────────────────────────

router.get("/sessions", requireAuth, async (c) => {
  const user = (c as any).get("user");
  const current = requestSession(c);
  // The panic view shows only the phone in the captor's hands.
  if (isDuressRequest(c)) {
    const mine = (await listSessions(user.id)).filter((session) => session.id === current?.id);
    return c.json({
      sessions: mine.map((session) => ({ ...session, duress: false, current: true })),
      devices: (await listDevices(user.id)).filter((device) => device.id === current?.device_id),
    });
  }
  const [sessions, devices] = await Promise.all([listSessions(user.id), listDevices(user.id)]);
  return c.json({
    sessions: sessions.map(({ duress: _duress, ...session }) => ({ ...session, current: session.id === current?.id })),
    devices,
  });
});

router.post("/sessions/:id/end", requireAuth, async (c) => {
  const user = (c as any).get("user");
  const ended = await endSession(user.id, c.req.param("id"), "signed out from another device", user.id);
  if (!ended) return c.json({ error: "That sign-in has already ended." }, 404);
  return c.json({ ok: true });
});

// A phone reported lost: blocked, every sign-in on it ended, and an amber
// alarm so the control room knows.
router.post("/devices/:id/lost", requireAuth, async (c) => {
  const user = (c as any).get("user");
  const deviceId = Number(c.req.param("id"));
  const device = Number.isInteger(deviceId) ? await setDeviceStatus(user.id, deviceId, "blocked", user.id) : null;
  if (!device) return c.json({ error: "That device was not found." }, 404);
  const memberships = await db.getMembershipsForUser(user.id);
  const last = (await db.pool.query(
    "SELECT lat, lon FROM user_sessions WHERE device_id = $1 AND lat IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    [deviceId],
  )).rows[0];
  await raisePersonAlarm({
    type: "device_lost",
    user,
    memberships,
    lat: last?.lat,
    lon: last?.lon,
    detail: { device: device.label, reported_by: user.email },
  }).catch((error) => console.error("[Security] lost-device alarm failed:", error));
  return c.json({ ok: true });
});

// ── App PIN and panic secrets ───────────────────────────────────────────────

router.post("/pin", requireAuth, async (c) => {
  const user = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  if (!(await checkPassword(user.id, String(body.password || "")))) {
    return c.json({ error: "Your password is incorrect." }, 400);
  }
  try {
    await setAppPin(user.id, String(body.pin || ""));
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
  return c.json({ ok: true });
});

router.post("/panic", requireAuth, async (c) => {
  const user = (c as any).get("user");
  const body = await c.req.json().catch(() => ({}));
  if (!(await checkPassword(user.id, String(body.password || "")))) {
    return c.json({ error: "Your password is incorrect." }, 400);
  }
  try {
    await setPanicSecrets(user.id, { password: body.panic_password, pin: body.panic_pin });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
  return c.json({ ok: true });
});

const MAX_PIN_TRIES = 5;

router.post("/unlock", requireAuth, async (c) => {
  const user = (c as any).get("user");
  const session = requestSession(c);
  if (!session) return c.json({ ok: true });
  const body = await c.req.json().catch(() => ({}));
  const which = await whichPin(user.id, String(body.pin || ""));
  if (which === "panic" && !session.duress) {
    // Unlocks like the right PIN, into the panic view, and raises the alarm.
    count("auth.panic_unlock");
    const memberships = await db.getMembershipsForUser(user.id);
    await markDuress(session);
    await raisePersonAlarm({
      type: "duress",
      user,
      memberships,
      lat: session.lat,
      lon: session.lon,
      detail: { device: session.label, how: "panic PIN at the lock screen" },
    }).catch((error) => console.error("[Security] panic alarm failed:", error));
    await endOtherSessions(user.id, session.id, "panic sign-in").catch(() => {});
  }
  if (which) {
    await unlockSession(session);
    return c.json({ ok: true });
  }
  const failures = await notePinFailure(session);
  if (failures >= MAX_PIN_TRIES) {
    await endSession(user.id, session.id, "too many wrong PINs");
    return c.json({ error: "too_many_tries", message: "Too many wrong PINs. Sign in again." }, 401);
  }
  const left = MAX_PIN_TRIES - failures;
  return c.json({ error: "wrong_pin", message: `Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left.` }, 400);
});

export default router;
