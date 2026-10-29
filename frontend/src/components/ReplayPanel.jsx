import { History, Pause, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { compassFor } from "../lib/radio-motion";
import { replayPosition } from "../lib/radio-replay";

export const REPLAY_WINDOWS = [
  ["1h", "Last hour"],
  ["4h", "Last 4 h"],
  ["12h", "Last 12 h"],
  ["today", "Today"],
  ["yesterday", "Yesterday"],
];

/** The absolute span a window choice means, fixed at the moment it is picked. */
export function replayRange(choice, now = Date.now()) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (choice === "today") return { from: midnight.getTime(), to: now };
  if (choice === "yesterday") return { from: midnight.getTime() - 86_400_000, to: midnight.getTime() - 1 };
  const hours = { "1h": 1, "4h": 4, "12h": 12 }[choice] || 1;
  return { from: now - hours * 3600_000, to: now };
}

const SPEEDS = [10, 30, 60, 120];

const clock = (ms) =>
  new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const minutes = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min` : `${Math.round(sec / 60)} min`);

/**
 * A radio's shift played back: where it went, where it stopped and for how
 * long. The clock lives here; the map is told the replay time and draws the
 * radio there.
 */
export function ReplayPanel({ device, choice, onChoice, replay, loading, error, time, onTime, onClose }) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60);
  const timeRef = useRef(time);
  timeRef.current = time;

  // A new replay starts paused at its beginning.
  useEffect(() => {
    setPlaying(false);
    if (replay?.from) onTime(replay.from);
  }, [replay, onTime]);

  useEffect(() => {
    if (!playing || !replay?.to) return undefined;
    let last = window.performance.now();
    let frame = null;
    const step = (stamp) => {
      const next = Math.min(replay.to, (timeRef.current ?? replay.from) + (stamp - last) * speed);
      last = stamp;
      onTime(next);
      if (next >= replay.to) setPlaying(false);
      else frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, speed, replay, onTime]);

  const here = replay && time != null ? replayPosition(replay, time) : null;
  const name = device?.name || `Radio ${device?.device_id}`;
  const empty = replay && !replay.raw.length;

  return (
    <section className="glass-panel absolute left-1/2 top-[calc(var(--ops-chrome)+0.75rem)] z-[1100] w-[min(620px,calc(100vw-2rem))] -translate-x-1/2 rounded-md border border-violet-400/40 px-3 py-2 text-[11px] text-neutral-200">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 font-bold text-violet-300">
          <History size={13} /> Replay · {name}
        </span>
        <div className="flex gap-0.5">
          {REPLAY_WINDOWS.map(([key, label]) => (
            <button
              key={key}
              onClick={() => onChoice(key)}
              className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${choice === key ? "bg-violet-500/25 text-violet-200" : "text-neutral-500 hover:text-neutral-200"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button onClick={onClose} aria-label="Close replay" className="ml-auto rounded p-1 text-neutral-400 hover:bg-white/5 hover:text-neutral-100">
          <X size={13} />
        </button>
      </div>

      {loading ? <p className="py-2 text-neutral-500">Loading the radio's positions…</p> : null}
      {error ? <p className="py-2 text-amber-300">{error}</p> : null}
      {empty ? <p className="py-2 text-neutral-500">No positions recorded for this radio in that window.</p> : null}

      {replay && !empty ? (
        <>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => {
                if (!playing && time >= replay.to) onTime(replay.from);
                setPlaying((value) => !value);
              }}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-violet-500/25 text-violet-100 hover:bg-violet-500/40"
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause size={13} /> : <Play size={13} />}
            </button>
            <input
              type="range"
              min={replay.from}
              max={replay.to}
              step={1000}
              value={time ?? replay.from}
              onChange={(event) => onTime(Number(event.target.value))}
              className="h-1 flex-1 accent-violet-400"
              aria-label="Replay time"
            />
            <span className="w-[62px] shrink-0 text-right font-mono tabular-nums text-neutral-100">{time ? clock(time) : "—"}</span>
            <select
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
              className="rounded border border-white/10 bg-white/5 px-1 py-0.5 text-[10px]"
              aria-label="Replay speed"
            >
              {SPEEDS.map((value) => (
                <option key={value} value={value}>
                  {value}×
                </option>
              ))}
            </select>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-neutral-500">
            <span>
              {clock(replay.from)}–{clock(replay.to)}
            </span>
            <span>{(replay.distanceM / 1000).toFixed(2)} km travelled</span>
            <span>
              {replay.stops.length} stop{replay.stops.length === 1 ? "" : "s"}
            </span>
            {here?.moving ? (
              <span className="text-violet-200">
                {Math.round(here.speedMs * 3.6)} km/h {compassFor(here.bearing) || ""}
              </span>
            ) : null}
          </div>
          {replay.stops.length ? (
            <div className="scrollbar-thin mt-1.5 flex gap-1 overflow-x-auto pb-0.5">
              {replay.stops.map((stop) => (
                <button
                  key={stop.from}
                  onClick={() => onTime(stop.from)}
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
                    time >= stop.from && time <= stop.to
                      ? "border-violet-400 bg-violet-500/20 text-violet-100"
                      : "border-white/10 text-neutral-400 hover:border-violet-400/60"
                  }`}
                >
                  {clock(stop.from).slice(0, 5)} · {minutes(stop.durationSec)}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
