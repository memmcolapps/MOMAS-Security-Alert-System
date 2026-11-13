import { RefreshCw, WifiOff } from "lucide-react";
import { useConnection } from "../lib/connection";
import { applyUpdate, useUpdateReady } from "../lib/service-worker";

function formatSyncTime(timestamp) {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

// Sits in the fixed chrome under the radio bar. Offline, the map still shows
// the last data it had, and an operator who misses that will trust positions
// and alarms that are no longer live - so this is a full-width bar, not a dot.
export function ConnectionBanner() {
  const { online, serverReachable, lastSyncAt } = useConnection();
  const updateReady = useUpdateReady();

  if (!online || !serverReachable) {
    return (
      <div className="flex min-h-8 items-center gap-2 border-b border-ops-amber/40 bg-amber-500/15 px-4 py-1 text-[11px] text-amber-200 backdrop-blur">
        <WifiOff size={13} className="shrink-0" />
        <span className="font-semibold">{online ? "Can't reach the EPAIL server." : "You're offline."}</span>
        <span className="text-amber-200/80">
          {lastSyncAt ? `Showing data from ${formatSyncTime(lastSyncAt)}. ` : ""}
          Alarms, tracking and live radio are paused until the connection is back.
        </span>
      </div>
    );
  }

  if (updateReady) {
    return (
      <div className="flex h-8 items-center gap-3 border-b border-white/10 bg-black/60 px-4 text-[11px] text-neutral-300 backdrop-blur">
        <RefreshCw size={12} className="shrink-0 text-neutral-500" />
        <span>A new version of EPAIL Intelligence is ready.</span>
        <button
          className="rounded bg-ops-red px-2.5 py-0.5 font-bold text-black transition-opacity hover:opacity-85 active:opacity-70"
          onClick={applyUpdate}
        >
          Reload
        </button>
      </div>
    );
  }

  return null;
}
