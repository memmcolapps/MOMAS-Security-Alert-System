import { Crosshair, History, LocateFixed, X } from "lucide-react";
import { useEffect, useState } from "react";
import { MOTION, compassFor, formatAge } from "../lib/radio-motion";

/**
 * What the operator needs about the one radio being tracked, at a glance:
 * whether it is moving, how fast and which way, and how old the position is.
 * The age matters most - a pin that has not moved may be a person standing
 * still or a handset indoors that has stopped getting a fix, and only the age
 * tells those apart.
 */
export function TrackingStrip({ device, location, motion, paused, trailMinutes, onRecentre, onStop, onReplay }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const name = device?.name || `Radio ${device?.device_id}`;
  const present = motion?.present;
  const ageSec = present && motion.seenMs ? Math.max(0, Math.round((now - motion.seenMs) / 1000)) : null;
  const stale = ageSec != null && ageSec > MOTION.staleSec;
  const moving = present && motion.moving && !stale;
  const offline = !device?.pocstars_online && location?.processStatus !== 1;

  let status = "No position reported";
  if (present) {
    if (offline) status = "Offline · last known position";
    else if (stale) status = "No new fix · may be indoors";
    else if (moving) status = "Moving";
    else status = "Not moving";
  }

  return (
    <section
      // Top centre: the bottom edge already belongs to the stats bar and, while
      // a vehicle is responding, the FollowBar.
      className="glass-panel absolute left-1/2 top-[calc(var(--ops-chrome)+0.75rem)] z-[1100] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-ops-green/40 px-3 py-2 text-[11px] text-neutral-200"
    >
      <span className="inline-flex min-w-0 items-center gap-1.5 font-bold text-ops-green">
        <Crosshair size={13} className="shrink-0" />
        <span className="truncate">Tracking {name}</span>
      </span>
      <span className={stale || offline ? "text-amber-300" : "text-neutral-300"}>{status}</span>
      {moving ? (
        <span className="tabular-nums text-neutral-100">
          {Number.isFinite(motion.speedMs) ? `${Math.round(motion.speedMs * 3.6)} km/h` : "—"}
          {compassFor(motion.bearing) ? ` · ${compassFor(motion.bearing)}` : ""}
        </span>
      ) : null}
      <span className="tabular-nums text-neutral-500">
        fix {ageSec == null ? "—" : `${formatAge(ageSec)} ago`}
        {/* Playback runs a batch behind real time; saying so is what makes a
            smooth pin trustworthy. The faint dot ahead of it is the newest point. */}
        {motion?.behindSec ? ` · ~${motion.behindSec}s behind` : ""} · trail {trailMinutes} min
      </span>
      <div className="ml-auto flex items-center gap-1">
        {onReplay ? (
          <button
            onClick={onReplay}
            title="Replay where this radio has been"
            className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-0.5 text-[10px] font-bold text-neutral-300 hover:border-violet-400 hover:text-violet-300"
          >
            <History size={12} /> Replay
          </button>
        ) : null}
        {paused ? (
          <button
            onClick={onRecentre}
            className="inline-flex items-center gap-1 rounded border border-ops-green/50 px-2 py-0.5 text-[10px] font-bold text-ops-green hover:bg-ops-green/10"
          >
            <LocateFixed size={12} /> Re-centre
          </button>
        ) : null}
        <button
          onClick={onStop}
          aria-label="Stop tracking"
          title="Stop tracking"
          className="rounded p-1 text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
        >
          <X size={13} />
        </button>
      </div>
    </section>
  );
}
