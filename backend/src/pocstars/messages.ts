/**
 * Operator-facing language for radio-network failures.
 *
 * The radio network is an integration detail: an operator working an alarm is
 * answering "is this person safe?", not "did the message reach the vendor's
 * server?". Nothing in here may name the vendor or leak an upstream payload —
 * every message states the consequence for the alarm in front of the operator.
 *
 * The raw upstream text is preserved as `detail` so the audit trail and admin
 * tooling keep everything needed to debug the integration.
 */

export type SyncFailure = { message: string; detail: string };

const TIMEOUT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT"]);
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * Rejection codes from the SOS service's result envelope. These are business
 * outcomes, not HTTP status codes — 502/503/504 here mean "someone else has it",
 * "you already have another one", and "wrong state", NOT server errors. Each one
 * has a different thing the operator can actually do about it.
 *
 * Source: POCSTARS_SOS_API.md.
 */
const UPSTREAM_REJECTIONS: Record<number, string> = {
  501: "This platform is not authorised to update alarms on the radio network. Contact your administrator.",
  502: "Another dispatcher is already handling this alarm on the radio network.",
  503: "The dispatch account is already handling a different alarm. Close that one on the radio network first, then retry.",
  504: "The radio network has this alarm in a different state. Refresh the alarm and try again.",
};

export function describeSyncFailure(error: any): SyncFailure {
  const upstreamText = String(
    error?.response?.data?.message || error?.upstreamMessage || error?.message || error || "",
  ).slice(0, 900);
  const transportCode = String(error?.code || "");
  const httpStatus = Number(error?.response?.status) || 0;
  const upstreamCode = Number(error?.upstreamCode) || 0;
  // Kept for administrators only: the code is what makes this diagnosable.
  const detail = [
    upstreamCode ? `upstream code ${upstreamCode}` : null,
    httpStatus ? `http ${httpStatus}` : null,
    transportCode || null,
    upstreamText || null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (TIMEOUT_CODES.has(transportCode) || /timeout/i.test(upstreamText)) {
    return {
      message: "The radio network did not respond in time — the handset still shows this alarm as active.",
      detail,
    };
  }
  if (UNREACHABLE_CODES.has(transportCode)) {
    return {
      message: "The radio network is unreachable — the handset still shows this alarm as active.",
      detail,
    };
  }
  if (UPSTREAM_REJECTIONS[upstreamCode]) {
    return { message: UPSTREAM_REJECTIONS[upstreamCode], detail };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      message: "This platform is not authorised to update alarms on the radio network. Contact your administrator.",
      detail,
    };
  }
  if (httpStatus >= 500) {
    return {
      message: "The radio network is temporarily unavailable — the handset still shows this alarm as active.",
      detail,
    };
  }
  if (httpStatus === 404) {
    return {
      message: "The radio network no longer recognises this alarm. Resolve it here and confirm the handset by voice.",
      detail,
    };
  }
  return {
    message: "The radio network rejected the update — the handset still shows this alarm as active.",
    detail,
  };
}

/** Operator-facing text for the alarm-action guard rails. */
export const ACTION_MESSAGES: Record<string, string> = {
  alarm_not_found: "This alarm is no longer available in your operational scope.",
  alarm_action_in_progress: "Another operator is updating this alarm right now. Try again in a moment.",
  alarm_already_started: "A response has already been started for this alarm.",
  alarm_already_resolved: "This alarm has already been resolved.",
  alarm_not_resolved: "Only a resolved alarm can be reopened.",
  alarm_dispatch_not_configured: "Radio dispatch is not configured, so alarms cannot be updated on the handset. Contact your administrator.",
};

export function actionMessage(code: string, fallback = "The alarm could not be updated.") {
  return ACTION_MESSAGES[code] || fallback;
}
