// The secrets beside a person's password: the app PIN that unlocks a phone,
// and the panic password and panic PIN that sign in or unlock normally while
// silently raising an alarm. All are stored as bcrypt hashes.

import * as db from "../db";

const hash = (value: string) => (Bun as any).password.hash(value, { algorithm: "bcrypt", cost: 10 }) as Promise<string>;
const matches = (value: string, stored: string | null | undefined) =>
  stored ? ((Bun as any).password.verify(value, stored) as Promise<boolean>) : Promise.resolve(false);

export const PIN_PATTERN = /^\d{4,8}$/;

export async function loadSecrets(userId: number) {
  const { rows } = await db.pool.query(
    "SELECT password_hash, app_pin_hash, duress_password_hash, duress_pin_hash FROM users WHERE id = $1",
    [userId],
  );
  return rows[0] ?? null;
}

export const checkPassword = async (userId: number, password: string) =>
  matches(password, (await loadSecrets(userId))?.password_hash);

/** Which secret a value is: the app PIN, the panic PIN, or neither. */
export async function whichPin(userId: number, pin: string): Promise<"pin" | "panic" | null> {
  const secrets = await loadSecrets(userId);
  if (!secrets) return null;
  // Checked in turn, not short-circuited on the first, so both take the same time.
  const [isPin, isPanic] = await Promise.all([matches(pin, secrets.app_pin_hash), matches(pin, secrets.duress_pin_hash)]);
  return isPin ? "pin" : isPanic ? "panic" : null;
}

export const isPanicPassword = (password: string, user: { duress_password_hash?: string | null }) =>
  matches(password, user.duress_password_hash);

export async function setAppPin(userId: number, pin: string) {
  if (!PIN_PATTERN.test(pin)) throw new Error("A PIN is 4 to 8 digits.");
  const secrets = await loadSecrets(userId);
  if (await matches(pin, secrets?.duress_pin_hash)) throw new Error("Your app PIN must be different from your panic PIN.");
  await db.pool.query("UPDATE users SET app_pin_hash = $2, updated_at = NOW() WHERE id = $1", [userId, await hash(pin)]);
}

/**
 * Sets or clears the panic password and panic PIN. undefined leaves one as it
 * is; null or "" clears it.
 */
export async function setPanicSecrets(userId: number, input: { password?: string | null; pin?: string | null }) {
  const secrets = await loadSecrets(userId);
  const updates: string[] = [];
  const values: unknown[] = [userId];
  if (input.password !== undefined) {
    const value = String(input.password || "");
    if (value) {
      if (value.length < 8) throw new Error("A panic password needs at least 8 characters.");
      if (await matches(value, secrets?.password_hash)) throw new Error("Your panic password must be different from your password.");
    }
    values.push(value ? await hash(value) : null);
    updates.push(`duress_password_hash = $${values.length}`);
  }
  if (input.pin !== undefined) {
    const value = String(input.pin || "");
    if (value) {
      if (!PIN_PATTERN.test(value)) throw new Error("A panic PIN is 4 to 8 digits.");
      if (await matches(value, secrets?.app_pin_hash)) throw new Error("Your panic PIN must be different from your app PIN.");
    }
    values.push(value ? await hash(value) : null);
    updates.push(`duress_pin_hash = $${values.length}`);
  }
  if (!updates.length) return;
  await db.pool.query(`UPDATE users SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $1`, values);
}

export async function setPhoneAllowed(userId: number, allowed: boolean) {
  await db.pool.query("UPDATE users SET phone_allowed = $2, updated_at = NOW() WHERE id = $1", [userId, allowed]);
}
