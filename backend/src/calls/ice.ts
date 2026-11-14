import { createHmac } from "node:crypto";

type IceSettings = {
  stunUrls: string;
  turnUrls: string;
  turnSecret: string;
  turnTtlSec: number;
};

const list = (value: string) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * The STUN/TURN servers one console may use. The TURN password follows
 * coturn's "TURN REST API" scheme (use-auth-secret): the username carries its
 * own expiry and the password is an HMAC of it under the shared secret, so the
 * relay can check it without a database and a leaked one stops working.
 */
export function iceServersFor(userId: number, settings: IceSettings, nowSec = Math.floor(Date.now() / 1000)) {
  const servers: { urls: string[]; username?: string; credential?: string }[] = [];
  const stun = list(settings.stunUrls);
  if (stun.length) servers.push({ urls: stun });
  const turn = list(settings.turnUrls);
  if (turn.length && settings.turnSecret) {
    const username = `${nowSec + settings.turnTtlSec}:${userId}`;
    const credential = createHmac("sha1", settings.turnSecret).update(username).digest("base64");
    servers.push({ urls: turn, username, credential });
  }
  return servers;
}
