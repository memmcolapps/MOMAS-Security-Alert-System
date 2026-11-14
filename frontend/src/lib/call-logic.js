// Small pure pieces of console calling, kept apart so they can be tested
// without a browser.

/**
 * Turn two getStats() snapshots into "good", "fair" or "poor".
 * Loss is measured between the two snapshots, so one bad patch an hour ago
 * does not keep the bars low for the rest of the call.
 */
export function callQuality(previous, current) {
  if (!current) return null;
  const received = current.packetsReceived - (previous?.packetsReceived ?? 0);
  const lost = current.packetsLost - (previous?.packetsLost ?? 0);
  const total = received + Math.max(0, lost);
  const loss = total > 0 ? Math.max(0, lost) / total : 0;
  const rtt = current.roundTripTime ?? 0;
  if (total === 0 && previous) return "poor"; // nothing arrived at all
  if (loss < 0.02 && rtt < 0.3) return "good";
  if (loss < 0.08 && rtt < 0.6) return "fair";
  return "poor";
}

/** Pull the numbers callQuality needs out of an RTCStatsReport. */
export function readStats(report) {
  let packetsReceived = 0;
  let packetsLost = 0;
  let roundTripTime = null;
  report.forEach((entry) => {
    if (entry.type === "inbound-rtp" && entry.kind === "audio") {
      packetsReceived += entry.packetsReceived || 0;
      packetsLost += entry.packetsLost || 0;
    }
    if (entry.type === "candidate-pair" && entry.nominated && entry.state === "succeeded") {
      roundTripTime = entry.currentRoundTripTime ?? roundTripTime;
    }
  });
  return { packetsReceived, packetsLost, roundTripTime };
}

/**
 * What to tell the person when a call ends or fails, or null to say nothing
 * (another of their tabs answered, say).
 */
export function endNotice(reason, role, peerName) {
  const name = peerName || "They";
  const missed = { text: `Missed call from ${peerName || "a colleague"}`, missed: true };
  const byReason = {
    caller: {
      declined: { text: `${name} declined the call` },
      no_answer: { text: `${name} didn't answer` },
      unreachable: { text: `Couldn't reach ${peerName || "them"}` },
      hung_up: { text: "Call ended" },
      connection_lost: { text: "Call dropped: the connection was lost" },
      gone: { text: "Call ended" },
    },
    callee: {
      cancelled: missed,
      missed,
      hung_up: { text: "Call ended" },
      connection_lost: { text: "Call dropped: the connection was lost" },
      gone: { text: "Call ended" },
      answered_elsewhere: null,
      declined: null,
    },
  };
  const table = byReason[role] || byReason.caller;
  return reason in table ? table[reason] : { text: "Call ended" };
}

/** Why a call could not be started. */
export function failNotice(reason, peerName) {
  const name = peerName || "They";
  switch (reason) {
    case "busy":
      return `${name} is in another call`;
    case "offline":
      return `${name} closed EPAIL`;
    case "not_allowed":
      return "You can't call this person";
    case "already_in_call":
      return "You're already in a call";
    default:
      return "The call couldn't be started";
  }
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
