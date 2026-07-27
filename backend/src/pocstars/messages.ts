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

export function describeSyncFailure(error: any): SyncFailure {
  const detail = String(
    error?.response?.data?.message || error?.upstreamMessage || error?.message || error || "",
  ).slice(0, 1000);
  const transportCode = String(error?.code || "");
  const httpStatus = Number(error?.response?.status) || 0;
  const upstreamCode = Number(error?.upstreamCode) || 0;

  if (TIMEOUT_CODES.has(transportCode) || /timeout/i.test(detail)) {
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
  if (upstreamCode === 501 || httpStatus === 401 || httpStatus === 403) {
    return {
      message: "This platform is not authorised to update alarms on the radio network. Contact your administrator.",
      detail,
    };
  }
  if (httpStatus >= 500 || [502, 503, 504].includes(upstreamCode)) {
    return {
      message: "The radio network is temporarily unavailable — the handset still shows this alarm as active.",
      detail,
    };
  }
  if (httpStatus === 404 || upstreamCode === 404) {
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
