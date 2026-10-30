import { ChevronDown, ChevronRight, Crosshair, Eye, EyeOff, History, MapPin, Navigation, RefreshCw, Search, WifiOff, X } from "lucide-react";
import { useMemo, useState } from "react";
import { itinerary, radioStateAt } from "../lib/fleet-replay";
import { compassFor } from "../lib/radio-motion";
import { replayPosition } from "../lib/radio-replay";
import { clock, duration } from "./ReplayTimeline";

export const WINDOW_CHOICES = [
  ["1h", "Last hour"],
  ["4h", "Last 4 h"],
  ["12h", "Last 12 h"],
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["custom", "Pick a time…"],
];

const km = (m) => (m >= 10_000 ? `${Math.round(m / 1000)} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

function StateLine({ radio, time }) {
  const state = radioStateAt(radio, time);
  if (state.kind === "before") return <span className="text-neutral-500">Not reporting yet</span>;
  if (state.kind === "silent")
    return (
      <span className="inline-flex items-center gap-1 text-amber-300/90">
        <WifiOff size={10} /> No signal for {duration(time - state.since)}
      </span>
    );
  if (state.kind === "stopped") return <span className="text-neutral-400">Stopped · {duration(time - state.since)}</span>;
  const here = replayPosition(radio, time);
  return (
    <span className="inline-flex items-center gap-1 font-bold" style={{ color: radio.colour }}>
      <Navigation size={10} style={{ transform: `rotate(${Math.round(here?.bearing || 0)}deg)` }} />
      Moving{here?.moving ? ` · ${Math.round(here.speedMs * 3.6)} km/h ${compassFor(here.bearing) || ""}` : ""}
    </span>
  );
}

// When the radio was moving across the window, with the replay time marked.
function ActivityStrip({ radio, from, to, time }) {
  const span = to - from;
  const pct = (t) => `${(((t - from) / span) * 100).toFixed(2)}%`;
  return (
    <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
      {radio.spells.map((spell) => (
        <div
          key={spell.from}
          className="absolute h-full"
          style={{ left: pct(spell.from), width: `max(1.5px, ${(((spell.to - spell.from) / span) * 100).toFixed(2)}%)`, background: radio.colour }}
        />
      ))}
      <div className="absolute top-0 h-full w-px bg-white" style={{ left: pct(time) }} />
    </div>
  );
}

function Itinerary({ radio, time, onTime, onPan }) {
  const entries = useMemo(() => itinerary(radio), [radio]);
  if (!entries.length) return null;
  let stopNumber = 0;
  return (
    <ol className="mt-2 space-y-0.5 border-l border-white/10 pl-2">
      {entries.map((entry) => {
        const current = time >= entry.from && time <= entry.to;
        if (entry.kind === "stop") stopNumber += 1;
        return (
          <li key={`${entry.kind}-${entry.from}`}>
            <button
              onClick={() => {
                onTime(entry.from);
                if (entry.kind === "stop") onPan({ lat: entry.lat, lon: entry.lon, key: entry.from });
              }}
              className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[10.5px] hover:bg-white/5 ${current ? "bg-white/10" : ""}`}
            >
              <span className="w-[74px] shrink-0 font-mono tabular-nums text-neutral-500">
                {clock(entry.from, false)}–{clock(entry.to, false)}
              </span>
              {entry.kind === "trip" ? (
                <span className="font-bold" style={{ color: radio.colour }}>
                  Moved {km(entry.distanceM)}
                  <span className="font-normal text-neutral-500"> · {duration(entry.to - entry.from)}</span>
                </span>
              ) : entry.kind === "stop" ? (
                <span className="inline-flex items-center gap-1 text-neutral-200">
                  <MapPin size={10} className="text-neutral-500" /> Stop {stopNumber} · {duration(entry.to - entry.from)}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-amber-300/90">
                  <WifiOff size={10} /> No signal · {duration(entry.to - entry.from)}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="text-[12px] font-bold tabular-nums text-neutral-100">{value}</div>
    </div>
  );
}

function CustomWindow({ onApply }) {
  const today = new Date();
  const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const earliest = new Date(today.getTime() - 7 * 86_400_000);
  const [date, setDate] = useState(iso(today));
  const [start, setStart] = useState("06:00");
  const [end, setEnd] = useState("18:00");
  const from = new Date(`${date}T${start}`).getTime();
  let to = new Date(`${date}T${end}`).getTime();
  if (to <= from) to += 86_400_000; // 22:00–06:00 runs into the next morning
  to = Math.min(to, Date.now());
  const valid = Number.isFinite(from) && Number.isFinite(to) && to > from;
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 rounded border border-white/10 bg-white/[0.03] p-2 text-[10px] text-neutral-400">
      <label className="flex flex-col gap-0.5">
        Day
        <input type="date" value={date} min={iso(earliest)} max={iso(today)} onChange={(event) => setDate(event.target.value)} className="rounded border border-white/10 bg-black px-1 py-0.5 text-[11px] text-neutral-100 [color-scheme:dark]" />
      </label>
      <label className="flex flex-col gap-0.5">
        From
        <input type="time" value={start} onChange={(event) => setStart(event.target.value)} className="rounded border border-white/10 bg-black px-1 py-0.5 text-[11px] text-neutral-100 [color-scheme:dark]" />
      </label>
      <label className="flex flex-col gap-0.5">
        To
        <input type="time" value={end} onChange={(event) => setEnd(event.target.value)} className="rounded border border-white/10 bg-black px-1 py-0.5 text-[11px] text-neutral-100 [color-scheme:dark]" />
      </label>
      <button
        disabled={!valid}
        onClick={() => onApply({ from, to })}
        className="rounded bg-ops-red px-2.5 py-1 text-[11px] font-bold text-black disabled:opacity-40"
      >
        Show
      </button>
    </div>
  );
}

/**
 * The left-hand side of the Replay tab: which window, who moved in it, and
 * what each of them was doing at the replay time. Picking a radio tells its
 * window as a story of trips and stops.
 */
export function ReplayFleetPanel({
  windowChoice,
  onWindow,
  onCustomWindow,
  onRefresh,
  relative,
  fleet,
  loading,
  error,
  time,
  onTime,
  focusId,
  onFocus,
  follow,
  onFollow,
  hiddenIds,
  onToggleHidden,
  showStill,
  onShowStill,
  onPan,
  names,
  units,
  notHeard,
}) {
  const [search, setSearch] = useState("");
  const [stillOpen, setStillOpen] = useState(false);
  const term = search.trim().toLowerCase();
  const matches = (uid) => !term || `${names(uid)} ${units(uid)} ${uid}`.toLowerCase().includes(term);
  const movers = fleet ? fleet.movers.filter((radio) => matches(radio.uid)) : [];
  const still = fleet ? fleet.still.filter((radio) => matches(radio.uid)) : [];
  const movingNow = fleet ? fleet.movers.filter((radio) => radioStateAt(radio, time).kind === "moving").length : 0;

  // The busiest hour-long stretch, to point someone at where to look first.
  const busiest = useMemo(() => {
    if (!fleet) return null;
    const { bins } = fleet;
    const per = Math.max(1, Math.round((3600_000 / (fleet.to - fleet.from)) * bins.length));
    let best = null;
    for (let index = 0; index + per <= bins.length; index += 1) {
      const total = bins.slice(index, index + per).reduce((sum, bin) => sum + bin.moving, 0);
      if (total && (!best || total > best.total)) best = { total, from: bins[index].from, to: bins[index + per - 1].to };
    }
    return per < bins.length ? best : null;
  }, [fleet]);

  return (
    <aside className="glass-panel absolute bottom-3 left-3 top-[calc(var(--ops-chrome)+0.75rem)] z-[1000] flex w-[22rem] flex-col rounded-md text-[11px] text-neutral-200">
      <header className="border-b border-white/10 px-3 pb-2.5 pt-3">
        <div className="flex items-center gap-2">
          <History size={15} className="text-ops-red" />
          <h1 className="text-[13px] font-bold tracking-wide">Replay</h1>
          <span className="text-[10px] text-neutral-500">where the radios went</span>
          {relative ? (
            <button onClick={onRefresh} title="Bring the window up to now" className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-neutral-400 hover:bg-white/5 hover:text-neutral-100">
              <RefreshCw size={11} /> Up to now
            </button>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {WINDOW_CHOICES.map(([key, label]) => (
            <button
              key={key}
              onClick={() => onWindow(key)}
              className={`rounded border px-2 py-0.5 text-[10.5px] font-bold ${
                windowChoice === key ? "border-ops-red/60 bg-red-500/15 text-neutral-50" : "border-white/10 text-neutral-400 hover:border-white/25 hover:text-neutral-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {windowChoice === "custom" ? <CustomWindow onApply={onCustomWindow} /> : null}
      </header>

      {fleet && !loading ? (
        <div className="grid grid-cols-3 gap-2 border-b border-white/10 px-3 py-2.5">
          <Stat label="Moved" value={`${fleet.movers.length} radio${fleet.movers.length === 1 ? "" : "s"}`} />
          <Stat label="Ground covered" value={km(fleet.distanceM)} />
          <Stat label="Moving now" value={movingNow} />
          {busiest ? (
            <button onClick={() => onTime(busiest.from)} className="col-span-3 -mx-1 rounded px-1 py-0.5 text-left text-[10.5px] text-neutral-400 hover:bg-white/5">
              Busiest hour <span className="font-bold text-neutral-100">{clock(busiest.from, false)}–{clock(busiest.to, false)}</span> · jump there
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {loading ? <p className="px-1 py-3 text-neutral-500">Loading every radio's positions…</p> : null}
        {error ? <p className="px-1 py-3 text-amber-300">{error}</p> : null}
        {fleet && !loading && !fleet.movers.length ? (
          <div className="px-1 py-3 text-neutral-400">
            <p className="font-bold text-neutral-200">No radio moved in this window.</p>
            <p className="mt-1 text-neutral-500">
              {fleet.still.length
                ? `${fleet.still.length} radio${fleet.still.length === 1 ? "" : "s"} reported but stayed where they were. Try a longer window.`
                : "No radio sent a position in this window. Try a longer one."}
            </p>
          </div>
        ) : null}

        {fleet && fleet.movers.length > 5 ? (
          <label className="mb-2 flex items-center gap-1.5 rounded border border-white/10 bg-white/[0.03] px-2 py-1">
            <Search size={12} className="text-neutral-500" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a radio or unit" className="w-full bg-transparent text-[11px] outline-none placeholder:text-neutral-600" />
            {search ? (
              <button onClick={() => setSearch("")} aria-label="Clear search">
                <X size={12} className="text-neutral-500" />
              </button>
            ) : null}
          </label>
        ) : null}

        <ul className="space-y-1">
          {movers.map((radio) => {
            const focused = focusId === radio.uid;
            const hidden = hiddenIds.has(radio.uid);
            return (
              <li
                key={radio.uid}
                className={`rounded border ${focused ? "border-white/25 bg-white/[0.07]" : "border-transparent hover:bg-white/[0.04]"} ${hidden ? "opacity-45" : ""}`}
                style={focused ? { boxShadow: `inset 3px 0 0 ${radio.colour}` } : undefined}
              >
                <div className="flex items-start gap-2 px-2 py-1.5">
                  <button onClick={() => onFocus(focused ? null : radio.uid)} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: radio.colour }} />
                      <span className="truncate text-[12px] font-bold text-neutral-100">{names(radio.uid)}</span>
                      <span className="ml-auto shrink-0 font-bold tabular-nums text-neutral-200">{km(radio.distanceM)}</span>
                    </div>
                    {units(radio.uid) ? <div className="truncate pl-4 text-[10px] text-neutral-500">{units(radio.uid)}</div> : null}
                    <div className="pl-4 text-[10.5px]">
                      <StateLine radio={radio} time={time} />
                    </div>
                    <div className="pl-4">
                      <ActivityStrip radio={radio} from={fleet.from} to={fleet.to} time={time} />
                    </div>
                  </button>
                  <button
                    onClick={() => onToggleHidden(radio.uid)}
                    title={hidden ? "Show on the map" : "Hide from the map"}
                    className="mt-0.5 rounded p-1 text-neutral-500 hover:bg-white/10 hover:text-neutral-100"
                  >
                    {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                </div>

                {focused ? (
                  <div className="border-t border-white/10 px-2 pb-2 pt-2">
                    <div className="grid grid-cols-4 gap-2 pl-1">
                      <Stat label="Moving" value={duration(radio.movingSec * 1000)} />
                      <Stat label="Top speed" value={`${Math.round(radio.topSpeedMs * 3.6)} km/h`} />
                      <Stat label="Stops" value={radio.stops.length} />
                      <Stat label="Heard" value={`${clock(radio.from, false)}–${clock(radio.to, false)}`} />
                    </div>
                    <div className="mt-2 flex gap-1.5 pl-1">
                      <button
                        onClick={() => onFollow(!follow)}
                        className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10.5px] font-bold ${follow ? "border-ops-red/60 bg-red-500/15 text-neutral-50" : "border-white/10 text-neutral-400 hover:text-neutral-100"}`}
                      >
                        <Crosshair size={11} /> {follow ? "Following" : "Follow on map"}
                      </button>
                      <button onClick={() => onFocus(null)} className="rounded border border-white/10 px-2 py-0.5 text-[10.5px] font-bold text-neutral-400 hover:text-neutral-100">
                        Back to all radios
                      </button>
                    </div>
                    <Itinerary radio={radio} time={time} onTime={onTime} onPan={onPan} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        {fleet && fleet.still.length ? (
          <div className="mt-3 border-t border-white/10 pt-2">
            <div className="flex items-center gap-1 px-1">
              <button onClick={() => setStillOpen((value) => !value)} className="inline-flex items-center gap-1 text-[10.5px] font-bold text-neutral-400 hover:text-neutral-100">
                {stillOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Stayed put ({fleet.still.length})
              </button>
              <label className="ml-auto inline-flex cursor-pointer items-center gap-1 text-[10px] text-neutral-500">
                <input type="checkbox" checked={showStill} onChange={(event) => onShowStill(event.target.checked)} className="accent-ops-red" />
                Show on map
              </label>
            </div>
            {stillOpen ? (
              <ul className="mt-1">
                {still.map((radio) => (
                  <li key={radio.uid}>
                    <button
                      onClick={() => {
                        onShowStill(true);
                        onPan({ lat: radio.lat, lon: radio.lon, key: radio.uid });
                      }}
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-white/5"
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-400" />
                      <span className="truncate text-neutral-300">{names(radio.uid)}</span>
                      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-neutral-500">
                        {clock(radio.firstAt, false)}–{clock(radio.lastAt, false)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {fleet && notHeard > 0 ? (
          <p className="mt-2 px-1 text-[10px] text-neutral-600">
            {notHeard} more radio{notHeard === 1 ? "" : "s"} sent no position in this window.
          </p>
        ) : null}
      </div>
      <footer className="border-t border-white/10 px-3 py-1.5 text-[9.5px] text-neutral-600">
        Space play/pause · ← → 1 min · Shift 10 min · Esc all radios
      </footer>
    </aside>
  );
}
