// Annual-card arithmetic for the vendor's licence model. One card buys one
// year on one radio or dispatcher. Kept apart from the database code so the
// date rules can be tested without MySQL.

export const MAX_CARD_YEARS = 10;

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

// Calendar years, not 365-day blocks. 29 Feb lands on 28 Feb in a common year
// rather than rolling into March.
export function addYears(value: Date, years: number) {
  const next = new Date(value.getTime());
  const day = next.getDate();
  next.setDate(1);
  next.setFullYear(next.getFullYear() + years);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
}

function isLive(end: Date | null, now: Date) {
  return Boolean(end) && end!.getTime() > now.getTime();
}

// The vendor console's recharge: a live account is extended from its current
// expiry and keeps its start date; an expired or never-activated one starts
// again from today.
export function cardServiceWindow({
  begin,
  end,
  years,
  now = new Date(),
}: {
  begin: Date | null;
  end: Date | null;
  years: number;
  now?: Date;
}) {
  if (isLive(end, now)) {
    return { begin: begin ?? startOfDay(now), end: addYears(end!, years) };
  }
  const today = startOfDay(now);
  return { begin: today, end: addYears(today, years) };
}

// A date picked by a platform owner. It may be earlier than today, which is how
// an account is cut off on purpose. The start date only moves when an expired
// account comes back to life.
export function manualServiceWindow({
  begin,
  end,
  until,
  now = new Date(),
}: {
  begin: Date | null;
  end: Date | null;
  until: Date;
  now?: Date;
}) {
  const revived = !isLive(end, now) && isLive(until, now);
  return { begin: revived || !begin ? startOfDay(now) : begin, end: until };
}

// "YYYY-MM-DD" in local time, the format the vendor writes into its log.
export function day(value: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

// A plain calendar date from a form, read as local midnight. Anything else is
// refused rather than guessed at.
export function parseDay(value: unknown) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return day(parsed) === match[0] ? parsed : null;
}
