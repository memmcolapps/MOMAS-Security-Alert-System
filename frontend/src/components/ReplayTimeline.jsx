import { FastForward, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useMemo, useRef, useState } from "react";

export const REPLAY_SPEEDS = [10, 30, 60, 120, 300, 600, 1200];

const TRAIL_MODES = [
  ["full", "Full route", "Every route faint, the part travelled so far bright"],
  ["travelled", "Travelled", "Only where each radio has been so far"],
  ["tail", "Last 10 min", "A short tail behind each radio"],
];

export const clock = (ms, seconds = true) =>
  new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });

const day = (ms) => new Date(ms).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export function duration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

// Tick spacing that gives roughly six to ten labels across the window.
function ticksFor(from, to) {
  const span = to - from;
  const step = [5, 10, 15, 30, 60, 120, 180, 240].map((m) => m * 60_000).find((ms) => span / ms <= 10) || 360 * 60_000;
  const ticks = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) ticks.push(t);
  return ticks;
}

/**
 * The replay's clock along the bottom of the screen. The track doubles as a
 * chart of how many radios were moving at each moment, so the busy stretches
 * are visible before anything plays, and clicking one jumps straight to it.
 */
export function ReplayTimeline({
  fleet,
  time,
  onTime,
  playing,
  onPlaying,
  speed,
  onSpeed,
  skipQuiet,
  onSkipQuiet,
  trailMode,
  onTrailMode,
  focused,
  skipped,
}) {
  const trackRef = useRef(null);
  const [hover, setHover] = useState(null);
  const { from, to, bins } = fleet;
  const span = to - from;
  const peak = Math.max(1, ...bins.map((bin) => bin.moving));
  const at = (t) => `${(((t - from) / span) * 100).toFixed(3)}%`;
  const ticks = useMemo(() => ticksFor(from, to), [from, to]);

  // Previous / next movement: the start of a moving spell, the focused radio's
  // when one is focused, anyone's otherwise.
  const starts = useMemo(() => {
    const radios = focused ? [focused] : fleet.movers;
    return [...new Set(radios.flatMap((radio) => radio.spells.map((spell) => spell.from)))].sort((a, b) => a - b);
  }, [fleet, focused]);
  const previousStart = [...starts].reverse().find((t) => t < time - 2000);
  const nextStart = starts.find((t) => t > time + 1000);

  const timeAt = (clientX) => {
    const rect = trackRef.current.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return from + f * span;
  };
  const scrub = (event) => {
    if (event.buttons !== 1 && event.type !== "pointerdown") return;
    onTime(timeAt(event.clientX));
  };
  const hoverBin = hover == null ? null : bins[Math.min(bins.length - 1, Math.floor(((hover - from) / span) * bins.length))];
  const playMinutes = Math.max(1, Math.round((to - time) / speed / 60_000));

  return (
    <section className="glass-panel absolute bottom-3 left-[calc(22rem+1.5rem)] right-3 z-[1000] rounded-md px-3 pb-2 pt-2.5 text-[11px] text-neutral-200">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => previousStart != null && onTime(previousStart)}
          disabled={previousStart == null}
          title={focused ? "Previous time this radio set off" : "Previous time a radio set off"}
          className="grid h-7 w-7 place-items-center rounded text-neutral-300 hover:bg-white/10 disabled:opacity-30"
        >
          <SkipBack size={14} />
        </button>
        <button
          onClick={() => onPlaying(!playing)}
          title={playing ? "Pause (space)" : "Play (space)"}
          className="grid h-9 w-9 place-items-center rounded-full bg-ops-red text-black hover:brightness-110"
        >
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="ml-0.5" />}
        </button>
        <button
          onClick={() => nextStart != null && onTime(nextStart)}
          disabled={nextStart == null}
          title={focused ? "Next time this radio sets off" : "Next time a radio sets off"}
          className="grid h-7 w-7 place-items-center rounded text-neutral-300 hover:bg-white/10 disabled:opacity-30"
        >
          <SkipForward size={14} />
        </button>

        <div className="ml-1 leading-tight">
          <div className="font-mono text-[18px] font-bold tabular-nums text-neutral-50">{clock(time)}</div>
          <div className="text-[10px] text-neutral-500">{day(time)}</div>
        </div>

        {skipped ? (
          <span className="ml-2 inline-flex items-center gap-1 rounded bg-white/10 px-2 py-0.5 text-[10px] text-neutral-300">
            <FastForward size={11} /> Skipped {duration(skipped)} with no movement
          </span>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <div className="flex rounded border border-white/10 p-0.5" role="group" aria-label="Trail">
            {TRAIL_MODES.map(([key, label, hint]) => (
              <button
                key={key}
                title={hint}
                onClick={() => onTrailMode(key)}
                className={`rounded px-2 py-0.5 text-[10px] font-bold ${trailMode === key ? "bg-white/15 text-neutral-50" : "text-neutral-500 hover:text-neutral-200"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[10px] text-neutral-300" title="While playing, jump over stretches when nobody is moving">
            <input type="checkbox" checked={skipQuiet} onChange={(event) => onSkipQuiet(event.target.checked)} className="accent-ops-red" />
            Skip quiet times
          </label>
          <label className="inline-flex items-center gap-1.5 text-[10px] text-neutral-400">
            Speed
            <select
              value={speed}
              onChange={(event) => onSpeed(Number(event.target.value))}
              className="rounded border border-white/10 bg-black px-1 py-0.5 text-[11px] text-neutral-100"
            >
              {REPLAY_SPEEDS.map((value) => (
                <option key={value} value={value}>
                  {value}×
                </option>
              ))}
            </select>
            <span className="text-neutral-500" title="Time to play to the end at this speed, before skipping quiet times">
              ≈ {playMinutes} min to end
            </span>
          </label>
        </div>
      </div>

      <div
        ref={trackRef}
        className="relative mt-2 h-14 cursor-pointer touch-none select-none"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          scrub(event);
        }}
        onPointerMove={(event) => {
          setHover(timeAt(event.clientX));
          scrub(event);
        }}
        onPointerLeave={() => setHover(null)}
        role="slider"
        aria-label="Replay time"
        aria-valuemin={from}
        aria-valuemax={to}
        aria-valuenow={Math.round(time)}
        aria-valuetext={clock(time)}
        tabIndex={0}
      >
        {/* How many radios were on the move, slice by slice. */}
        <div className="absolute inset-x-0 bottom-4 top-0 flex items-end gap-px rounded-sm bg-white/[0.03]">
          {bins.map((bin) => (
            <div
              key={bin.from}
              className={`flex-1 rounded-t-[1px] ${bin.to <= time ? "bg-ops-red/70" : "bg-neutral-500/45"}`}
              style={{ height: bin.moving ? `${Math.max(8, (bin.moving / peak) * 100)}%` : "0%" }}
            />
          ))}
        </div>
        {/* The focused radio's own moving spells, in its colour. */}
        {focused ? (
          <div className="absolute inset-x-0 bottom-[11px] h-[5px]">
            {focused.spells.map((spell) => (
              <div
                key={spell.from}
                className="absolute h-full rounded-full"
                style={{ left: at(spell.from), width: `max(2px, ${(((spell.to - spell.from) / span) * 100).toFixed(3)}%)`, background: focused.colour }}
              />
            ))}
          </div>
        ) : null}
        <div className="absolute inset-x-0 bottom-0 h-3 text-[9px] text-neutral-500">
          {ticks.map((t) => (
            <span key={t} className="absolute -translate-x-1/2 tabular-nums" style={{ left: at(t) }}>
              {clock(t, false)}
            </span>
          ))}
        </div>
        <div className="pointer-events-none absolute bottom-3 top-0 w-0.5 -translate-x-1/2 bg-neutral-50 shadow-[0_0_6px_rgba(255,255,255,0.8)]" style={{ left: at(time) }}>
          <div className="absolute -top-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-neutral-50" />
        </div>
        {hover != null ? (
          <div
            className="pointer-events-none absolute -top-7 -translate-x-1/2 whitespace-nowrap rounded bg-black/90 px-1.5 py-0.5 text-[10px] text-neutral-200 ring-1 ring-white/10"
            style={{ left: at(hover) }}
          >
            {clock(hover, false)} · {hoverBin?.moving ? `${hoverBin.moving} moving` : "nobody moving"}
          </div>
        ) : null}
      </div>
    </section>
  );
}
