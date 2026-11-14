import type { Context } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { canOperate, isPlatformStaff, isUserStillActive } from "../auth";
import { env } from "../config";
import * as db from "../db";
import { createCallHub, type HubConnection, type PersonCard } from "./hub";
import { iceServersFor } from "./ice";
import type { CallIdentity } from "./rules";

const ROLE_LABELS: Record<string, string> = {
  org_owner: "Owner",
  org_admin: "Admin",
  admin: "Admin",
  unit_admin: "Unit admin",
  operator: "Operator",
  viewer: "Viewer",
};

const MAX_MESSAGE_BYTES = 64 * 1024;

export const callHub = createCallHub({
  ringMs: env.CALLS_RING_SEC * 1000,
  // Every attempt is logged, answered or not, so an organization can see who
  // called its consoles - platform staff included.
  onCallEnded: (entry) => {
    void db.createAuditLog({
      organization_id: entry.organizationId,
      actor_user_id: entry.callerUserId,
      action: "console_call",
      target_type: "user",
      target_id: entry.calleeUserId,
      metadata: { callId: entry.callId, outcome: entry.outcome, durationSec: entry.durationSec },
    }).catch(() => {});
  },
});

export function callIdentity(user: any): CallIdentity {
  const platformStaff = isPlatformStaff(user);
  return {
    userId: Number(user.id),
    platformStaff,
    activeOrganizationId: platformStaff ? null : Number(user.active_organization_id) || null,
    organizationIds: (user.memberships || []).map((membership: any) => Number(membership.organization_id)),
    // Viewers answer but do not start calls. Every platform tier may call.
    mayStart: platformStaff || canOperate(user),
  };
}

function personCard(user: any): PersonCard {
  const platformStaff = isPlatformStaff(user);
  const membership = user.active_membership || user.memberships?.[0];
  const detail = platformStaff
    ? "EPAIL"
    : membership?.scope_level === "unit" && membership?.unit_name
      ? String(membership.unit_name)
      : ROLE_LABELS[String(membership?.role)] || "";
  return {
    userId: Number(user.id),
    name: String(user.name || user.email || `User ${user.id}`),
    detail,
    platformStaff,
    organizations: (user.memberships || []).map((entry: any) => ({ id: Number(entry.organization_id), name: String(entry.name) })),
  };
}

export function callsWebSocket(c: Context): WSEvents {
  const user = c.get("user");
  let conn: HubConnection | null = null;
  let accountCheck: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (accountCheck) clearInterval(accountCheck);
    accountCheck = null;
    if (conn) callHub.disconnect(conn);
    conn = null;
  };

  return {
    onOpen: (_event, ws: WSContext) => {
      const identity = callIdentity(user);
      conn = {
        id: crypto.randomUUID(),
        identity,
        card: personCard(user),
        onRadio: false,
        send: (message) => {
          try {
            ws.send(JSON.stringify(message));
          } catch {
            // Socket already closing; onClose cleans up.
          }
        },
      };
      conn.send({
        type: "ready",
        me: { userId: identity.userId },
        canStart: identity.mayStart,
        iceServers: iceServersFor(identity.userId, {
          stunUrls: env.CALLS_STUN_URLS,
          turnUrls: env.CALLS_TURN_URLS,
          turnSecret: env.CALLS_TURN_SECRET,
          turnTtlSec: env.CALLS_TURN_TTL_SEC,
        }),
      });
      callHub.connect(conn);
      // A socket outlives the sign-in check that opened it, so a disabled
      // account is cut off here within a minute.
      accountCheck = setInterval(async () => {
        if (await isUserStillActive(identity.userId).catch(() => true)) return;
        stop();
        try {
          ws.close(4003, "account_disabled");
        } catch {}
      }, 60_000);
    },
    onMessage: (event) => {
      if (!conn || typeof event.data !== "string" || event.data.length > MAX_MESSAGE_BYTES) return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      callHub.handle(conn, message);
    },
    onClose: stop,
    onError: stop,
  };
}
