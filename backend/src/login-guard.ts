// Limits password guessing. Wrong passwords are counted per email and per
// address over a short window; past the limit, sign-in is refused for that
// email (or address) until the window has passed. Kept in memory: one server,
// and a restart forgetting the counts is acceptable.
//
// The email limit is the tight one. The address limit is loose because the
// gateway in front of the server may make many people share one address.

const WINDOW_MS = 15 * 60 * 1000;
export const EMAIL_LIMIT = 8;
export const IP_LIMIT = 100;

type Entry = { failures: number; firstAt: number };

export function createLoginGuard(now: () => number = Date.now) {
  const byEmail = new Map<string, Entry>();
  const byIp = new Map<string, Entry>();

  const live = (map: Map<string, Entry>, key: string) => {
    const entry = map.get(key);
    if (!entry) return null;
    if (now() - entry.firstAt >= WINDOW_MS) {
      map.delete(key);
      return null;
    }
    return entry;
  };

  const bump = (map: Map<string, Entry>, key: string) => {
    const entry = live(map, key);
    if (entry) entry.failures += 1;
    else map.set(key, { failures: 1, firstAt: now() });
  };

  return {
    /** Seconds to wait before trying again, or 0 when sign-in may proceed. */
    retryAfter(email: string, ip: string | null) {
      const emailEntry = live(byEmail, email);
      const ipEntry = ip ? live(byIp, ip) : null;
      const blocked = [
        emailEntry && emailEntry.failures >= EMAIL_LIMIT ? emailEntry : null,
        ipEntry && ipEntry.failures >= IP_LIMIT ? ipEntry : null,
      ].filter(Boolean) as Entry[];
      if (!blocked.length) return 0;
      const until = Math.max(...blocked.map((entry) => entry.firstAt + WINDOW_MS));
      return Math.max(1, Math.ceil((until - now()) / 1000));
    },
    failed(email: string, ip: string | null) {
      bump(byEmail, email);
      if (ip) bump(byIp, ip);
      // Bounded: a flood of made-up emails must not grow memory forever.
      if (byEmail.size > 50_000) byEmail.clear();
      if (byIp.size > 50_000) byIp.clear();
    },
    succeeded(email: string) {
      byEmail.delete(email);
    },
  };
}

export const loginGuard = createLoginGuard();
