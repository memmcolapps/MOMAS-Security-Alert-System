import { Link } from "@tanstack/react-router";
import { Crosshair, ExternalLink, Navigation, X } from "lucide-react";
import { formatDistance, compassPoint, navigationUrl, useFollow } from "../lib/follow-session";

/**
 * The responding vehicle's strip. Deliberately not a map overlay: it stays put
 * across pages for the whole drive, and reads at a glance rather than rewarding
 * close attention, because whoever is looking at it is driving to an alarm.
 */
export function FollowBar() {
  const { target, position, distance_m, bearing, error, stopFollowing } = useFollow();
  if (!target) return null;

  return (
    <aside className="fixed inset-x-0 bottom-0 z-[1400] border-t border-ops-red/50 bg-[#0b0708]/95 px-4 py-2.5 backdrop-blur">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Navigation size={16} className="shrink-0 text-ops-red" />
          <div className="min-w-0">
            <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-ops-red">Responding to</p>
            <p className="truncate text-sm font-bold text-neutral-100">{target.label}</p>
          </div>
        </div>

        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-black tabular-nums text-neutral-100">
            {distance_m == null ? "—" : formatDistance(distance_m)}
          </span>
          {bearing == null ? null : (
            <span className="text-sm font-bold text-neutral-400">
              {compassPoint(bearing)} · {Math.round(bearing)}°
            </span>
          )}
        </div>

        {/* Straight-line, and labelled as such. A lot of alarm locations sit off
            the mapped road network, where a confident route line would be a
            worse answer than a bearing. */}
        <p className="text-[10px] leading-tight text-neutral-500">
          {error ? (
            <span className="text-amber-300">{error}</span>
          ) : (
            <>
              Straight line{position?.accuracy_m ? ` · fix ±${Math.round(position.accuracy_m)} m` : ""}
              <br />
              {target.lat.toFixed(5)}, {target.lon.toFixed(5)}
            </>
          )}
        </p>

        <div className="ml-auto flex items-center gap-2">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-2 text-[11px] text-neutral-300 hover:border-ops-red hover:text-ops-red"
          >
            <Crosshair size={13} /> Map
          </Link>
          {/* Built and opened synchronously so the popup blocker treats it as
              the user gesture it is. */}
          <a
            href={navigationUrl(target)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded bg-ops-red px-3 py-2 text-[11px] font-bold text-black hover:opacity-85"
          >
            <ExternalLink size={13} /> Directions
          </a>
          <button
            aria-label="Stop following"
            className="rounded p-2 text-neutral-500 hover:bg-white/5 hover:text-neutral-100"
            onClick={stopFollowing}
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
