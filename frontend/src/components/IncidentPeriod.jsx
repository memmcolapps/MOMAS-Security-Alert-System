import { CalendarDays, ChevronUp, Tv, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useIsNarrow } from "../lib/use-is-narrow";
import { useTyping } from "../lib/use-typing";

function shortDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * The incident period and the Live Mode tour.
 *
 * Wide screens: the bar along the bottom of the map, as it always was.
 * Phones: that bar wrapped onto four rows and covered a third of the map, and
 * rode up over the radio list when the keyboard opened. There it is one small
 * button that opens the choices as a sheet, and it steps aside while someone
 * is typing or the radio list is open.
 */
export function IncidentPeriod({
  modes,
  activeMode,
  onMode,
  from,
  to,
  onRange,
  liveMode,
  onStartLive,
  onStopLive,
  tourCount,
  hidden,
  raised,
  shiftedLeft,
  radioListOpen,
}) {
  const narrow = useIsNarrow();
  const typing = useTyping();
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    if (!sheetOpen) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  if (hidden) return null;

  const modeLabel = modes.find(([mode]) => mode === activeMode)?.[1];
  const periodLabel = modeLabel || (from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`);
  const bottom = raised ? "bottom-[4.5rem]" : "bottom-3";

  if (!narrow) {
    return (
      <section
        className={`glass-panel absolute z-[1000] flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition-transform ${bottom} ${
          shiftedLeft ? "left-1/2 -translate-x-[calc(50%+190px)]" : "left-1/2 -translate-x-1/2"
        }`}
      >
        <span className="text-[9px] font-bold uppercase tracking-wide text-neutral-600">Incidents</span>
        <PeriodControls modes={modes} activeMode={activeMode} onMode={onMode} from={from} to={to} onRange={onRange} />
        <span className="mx-1 h-4 w-px bg-white/10" />
        <LiveButton liveMode={liveMode} onStartLive={onStartLive} onStopLive={onStopLive} tourCount={tourCount} />
      </section>
    );
  }

  const stepAside = typing || radioListOpen;
  const pick = (action) => (...args) => {
    action(...args);
    setSheetOpen(false);
  };

  return (
    <>
      {stepAside && !sheetOpen ? null : (
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className={`glass-panel absolute left-1/2 z-[1000] inline-flex h-10 -translate-x-1/2 items-center gap-2 rounded-full px-4 text-[12px] font-bold text-neutral-200 active:scale-[0.98] ${bottom}`}
        >
          <CalendarDays size={14} className="text-ops-red" />
          <span className="text-neutral-500">Incidents:</span>
          <span>{periodLabel}</span>
          {liveMode ? <span className="rounded bg-ops-red px-1.5 py-0.5 text-[10px] text-black">Live</span> : null}
          <ChevronUp size={14} className="text-neutral-500" />
        </button>
      )}
      {sheetOpen
        ? createPortal(
            <div className="fixed inset-0 z-[1250]">
              <button type="button" aria-label="Close" className="absolute inset-0 bg-black/50" onClick={() => setSheetOpen(false)} />
              <div className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-white/10 bg-neutral-950 px-4 pb-[calc(16px+env(safe-area-inset-bottom))] pt-2 shadow-2xl">
                <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-white/20" />
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-neutral-500">Incidents period</p>
                  <button type="button" onClick={() => setSheetOpen(false)} aria-label="Close" className="grid h-9 w-9 place-items-center rounded text-neutral-400 active:bg-white/10">
                    <X size={18} />
                  </button>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {modes.map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={pick(() => onMode(mode))}
                      className={`h-11 rounded-lg text-[13px] font-bold ${activeMode === mode ? "bg-ops-red text-black" : "bg-white/[0.06] text-neutral-300 active:bg-white/[0.12]"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mb-1.5 mt-4 text-[11px] text-neutral-500">Or pick dates</p>
                <div className="flex items-center gap-2">
                  <input className="h-11 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2 text-neutral-200" type="date" value={from} onChange={(event) => onRange([event.target.value, to])} aria-label="From" />
                  <span className="text-neutral-600">→</span>
                  <input className="h-11 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2 text-neutral-200" type="date" value={to} onChange={(event) => onRange([from, event.target.value])} aria-label="To" />
                </div>
                <button
                  type="button"
                  onClick={pick(liveMode ? onStopLive : onStartLive)}
                  disabled={!liveMode && !tourCount}
                  className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-ops-red text-[14px] font-bold text-black active:brightness-90 disabled:opacity-40"
                >
                  <Tv size={16} /> {liveMode ? "Exit Live Mode" : tourCount ? `Live Mode: tour ${tourCount} pins` : "Live Mode: no pins to tour"}
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function PeriodControls({ modes, activeMode, onMode, from, to, onRange }) {
  return (
    <>
      {modes.map(([mode, label]) => (
        <button
          className={`rounded px-2 py-1 text-[10px] font-bold ${activeMode === mode ? "bg-ops-red text-black" : "text-neutral-400 hover:text-ops-red"}`}
          key={mode}
          onClick={() => onMode(mode)}
        >
          {label}
        </button>
      ))}
      <input className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px]" type="date" value={from} onChange={(event) => onRange([event.target.value, to])} aria-label="From" />
      <span className="text-neutral-600">→</span>
      <input className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px]" type="date" value={to} onChange={(event) => onRange([from, event.target.value])} aria-label="To" />
    </>
  );
}

function LiveButton({ liveMode, onStartLive, onStopLive, tourCount }) {
  return (
    <button
      className="rounded px-2 py-1 text-[10px] font-bold text-ops-red hover:bg-red-500/15 disabled:opacity-50"
      onClick={liveMode ? onStopLive : onStartLive}
      disabled={!liveMode && !tourCount}
      title={tourCount ? `Tour ${tourCount} pins` : "No pins to tour"}
    >
      <Tv size={12} className="mr-1 inline" /> {liveMode ? "Exit Live" : "Live Mode"}
    </button>
  );
}
