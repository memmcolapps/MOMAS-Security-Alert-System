import { Columns2, History, LocateFixed, Map as MapIcon, Maximize2, Minimize2, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deviceTypeGlyph } from "../lib/domain";
import { useSecondClock } from "../lib/frame-ticker";
import { compassFor, formatAge } from "../lib/radio-motion";
import { TILE_GAP, TILE_SIZES, capacity, gridFor } from "../lib/track-grid";
import { TrackMap } from "./TrackMap";

const STATUS_TEXT = {
  sos: "SOS",
  moving: "Moving",
  online: "Not moving",
  nofix: "No new fix · may be indoors",
  offline: "Offline · last known position",
};

// What the operator needs about one tracked radio, in one line: what it is
// doing, how fast and which way, and how old the position is.
function RadioSummary({ state, now, compact = false }) {
  if (!state) return <span className="text-neutral-500">No position reported</span>;
  const ageSec = state.seenMs ? Math.max(0, Math.round((now - state.seenMs) / 1000)) : null;
  const warn = state.status === "nofix" || state.status === "offline";
  return (
    <>
      <span className={state.status === "sos" ? "font-bold text-ops-red" : warn ? "text-amber-300" : "text-neutral-300"}>
        {STATUS_TEXT[state.status] || "—"}
      </span>
      {state.moving ? (
        <span className="tabular-nums text-neutral-100">
          {Number.isFinite(state.speedMs) ? `${Math.round(state.speedMs * 3.6)} km/h` : "—"}
          {compassFor(state.bearing) ? ` · ${compassFor(state.bearing)}` : ""}
        </span>
      ) : null}
      <span className="tabular-nums text-neutral-500">
        fix {ageSec == null ? "—" : `${formatAge(ageSec)} ago`}
        {!compact && state.behindSec ? ` · ~${state.behindSec}s behind` : ""}
      </span>
    </>
  );
}

function IconButton({ title, onClick, children, tone = "" }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`rounded p-1 text-neutral-400 transition-colors hover:bg-white/10 hover:text-neutral-100 active:bg-white/15 ${tone}`}
    >
      {children}
    </button>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="inline-flex rounded-md bg-white/[0.06] p-0.5">
      {options.map(([key, label, icon]) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold transition-colors ${
            value === key ? "bg-white/15 text-neutral-50 shadow-sm" : "text-neutral-400 hover:text-neutral-100"
          }`}
        >
          {icon}
          {label}
        </button>
      ))}
    </div>
  );
}

function TrackTile({
  radio,
  radioTracks,
  trails,
  maximised,
  hidden,
  onMaximise,
  onStop,
  onPause,
  onResume,
  onReplay,
  onDragStart,
  onDrop,
}) {
  const [state, setState] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const now = useSecondClock();
  const reportState = useCallback((_uid, next) => setState(next), []);
  const radios = useMemo(() => [radio], [radio]);
  const sos = state?.status === "sos";
  const dim = state?.status === "nofix" || state?.status === "offline";

  return (
    <section
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        onDrop();
      }}
      className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border-2 bg-black shadow-lg shadow-black/40 ${
        sos ? "animate-pulse border-ops-red" : dim ? "border-amber-400/60" : ""
      } ${maximised ? "absolute inset-0 z-10" : ""} ${hidden ? "invisible" : ""} ${dragOver ? "ring-2 ring-white/60" : ""}`}
      style={sos || dim ? undefined : { borderColor: radio.colour }}
    >
      <header
        draggable
        onDragStart={onDragStart}
        onDoubleClick={onMaximise}
        title="Drag to move this tile · double-click to fill the screen"
        className="flex cursor-grab items-center gap-x-3 gap-y-0.5 bg-neutral-950/90 px-2 py-1 text-[11px] text-neutral-200 active:cursor-grabbing"
      >
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: radio.colour }} />
        <span className="min-w-0 shrink truncate font-bold">{radio.label}</span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 overflow-hidden whitespace-nowrap">
          <RadioSummary state={state} now={now} compact={!maximised} />
        </span>
        <span className="flex shrink-0 items-center">
          {radio.paused ? (
            <button
              onClick={onResume}
              className="mr-1 inline-flex items-center gap-1 rounded bg-ops-green px-1.5 py-0.5 text-[10px] font-bold text-black hover:brightness-110 active:brightness-95"
            >
              <LocateFixed size={11} /> Re-centre
            </button>
          ) : null}
          <IconButton title="Replay where this radio has been" onClick={onReplay}>
            <History size={13} />
          </IconButton>
          <IconButton title={maximised ? "Back to all tiles (Esc)" : "Fill the screen"} onClick={onMaximise}>
            {maximised ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </IconButton>
          <IconButton title="Stop tracking this radio" onClick={onStop}>
            <X size={13} />
          </IconButton>
        </span>
      </header>
      <div className={`relative min-h-0 flex-1 ${dim ? "opacity-60" : ""}`}>
        <TrackMap
          radios={radios}
          radioTracks={radioTracks}
          trails={trails}
          paused={radio.paused}
          onPause={onPause}
          onState={reportState}
          recentreKey={radio.recentreKey}
          hidden={hidden}
        />
      </div>
    </section>
  );
}

// An empty cell: find another radio to track without going back to the list.
function AddTile({ devices, trackedIds, onTrack }) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return devices
      .filter((device) => device.active !== false && !trackedIds.has(String(device.device_id)))
      .filter((device) => `${device.name || ""} ${device.device_id} ${device.operator || ""}`.toLowerCase().includes(needle))
      .slice(0, 6);
  }, [devices, trackedIds, query]);

  return (
    <section className="flex min-h-0 min-w-0 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-white/10 p-4 text-[11px] text-neutral-500">
      <Plus size={18} />
      <span className="font-bold text-neutral-400">Add a radio</span>
      <label className="flex w-full max-w-[240px] items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1">
        <Search size={11} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name or ID"
          className="w-full bg-transparent text-neutral-200 outline-none placeholder:text-neutral-600"
        />
      </label>
      {matches.length ? (
        <ul className="w-full max-w-[240px] overflow-y-auto">
          {matches.map((device) => (
            <li key={device.device_id}>
              <button
                onClick={() => {
                  setQuery("");
                  onTrack(String(device.device_id));
                }}
                className="w-full truncate rounded px-2 py-1 text-left text-neutral-200 hover:bg-white/10"
              >
                {device.name || device.device_id}
              </button>
            </li>
          ))}
        </ul>
      ) : query.trim() ? (
        <span>No radios match.</span>
      ) : (
        <span>or pick one from the radio list</span>
      )}
    </section>
  );
}

// Every tracked radio on one map, with a list that matches colours to names.
function TogetherView({ radios, radioTracks, trails, onStop }) {
  const [states, setStates] = useState({});
  const [paused, setPaused] = useState(false);
  const [recentreKey, setRecentreKey] = useState(0);
  const now = useSecondClock();
  const reportState = useCallback((uid, next) => setStates((current) => ({ ...current, [uid]: next })), []);

  return (
    <section className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-white/10 bg-black">
      <TrackMap
        radios={radios}
        radioTracks={radioTracks}
        trails={trails}
        paused={paused}
        onPause={() => setPaused(true)}
        onState={reportState}
        recentreKey={recentreKey}
      />
      <ul className="glass-panel scrollbar-thin absolute left-2 top-2 z-[500] max-h-[calc(100%-1rem)] w-[min(320px,calc(100%-1rem))] overflow-y-auto rounded-md py-1 text-[11px]">
        {radios.map((radio) => (
          <li key={radio.uid} className="flex items-center gap-2 px-2 py-1">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: radio.colour }} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-bold text-neutral-100">{radio.label}</span>
              <span className="flex flex-wrap gap-x-2 text-[10px]">
                <RadioSummary state={states[radio.uid]} now={now} compact />
              </span>
            </span>
            <IconButton title="Stop tracking this radio" onClick={() => onStop(radio.uid)}>
              <X size={12} />
            </IconButton>
          </li>
        ))}
      </ul>
      {paused ? (
        <button
          onClick={() => {
            setPaused(false);
            setRecentreKey((key) => key + 1);
          }}
          className="absolute bottom-3 left-1/2 z-[500] inline-flex -translate-x-1/2 items-center gap-1 rounded-md bg-ops-green px-3 py-1 text-[11px] font-bold text-black shadow-lg hover:brightness-110"
        >
          <LocateFixed size={12} /> Show all radios
        </button>
      ) : null}
    </section>
  );
}

/**
 * Several tracked radios at once. The screen splits into as many tiles as fit
 * at the chosen tile size - there is no other limit - and each tile follows
 * its own radio. Or, when the radios are close together, one map shows them
 * all. Closing a tile lets the others grow; nothing reorders on its own.
 */
export function TrackGrid({
  style,
  tracked,
  devices,
  deviceRegistry,
  locations,
  radioTracks,
  trails,
  view,
  onView,
  tileSize,
  onTileSize,
  onCapacity,
  notice,
  onTrack,
  onStop,
  onStopAll,
  onPause,
  onResume,
  onReplay,
  onReorder,
  onBringForward,
}) {
  const areaRef = useRef(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [maximised, setMaximised] = useState(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const dragRef = useRef(null);

  useEffect(() => {
    const node = areaRef.current;
    if (!node) return undefined;
    const measure = () => setArea({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new window.ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [view]);

  const grid = useMemo(() => gridFor(tracked.length, area.width, area.height, tileSize), [tracked.length, area, tileSize]);
  useEffect(() => {
    if (area.width) onCapacity?.(grid.max);
  }, [grid.max, area.width, onCapacity]);

  useEffect(() => {
    if (!maximised) return undefined;
    const close = (event) => event.key === "Escape" && setMaximised(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [maximised]);
  useEffect(() => {
    if (maximised && !tracked.some((item) => item.deviceId === maximised)) setMaximised(null);
  }, [tracked, maximised]);

  // What each tile needs about its radio, rebuilt only when it changes so a
  // tile's map is not handed a "new" radio on every render.
  const radioCache = useRef(new Map());
  const radios = useMemo(() => {
    const next = tracked.map((item) => {
      const row = deviceRegistry.get(item.deviceId);
      const location = locations.get(item.deviceId);
      const radio = {
        uid: item.deviceId,
        colour: item.colour,
        paused: item.paused,
        recentreKey: item.recentreKey || 0,
        label: row?.name || `Radio ${item.deviceId}`,
        glyph: deviceTypeGlyph(row?.device_type),
        online: Boolean(row?.pocstars_online) || location?.processStatus === 1,
        location,
      };
      const cached = radioCache.current.get(item.deviceId);
      const same =
        cached && ["colour", "paused", "recentreKey", "label", "glyph", "online", "location"].every((key) => cached[key] === radio[key]);
      return same ? cached : radio;
    });
    radioCache.current = new Map(next.map((radio) => [radio.uid, radio]));
    return next;
  }, [tracked, deviceRegistry, locations]);

  const shown = view === "split" ? radios.slice(0, grid.shown) : radios;
  const notShown = view === "split" ? radios.slice(grid.shown) : [];
  const trackedIds = useMemo(() => new Set(tracked.map((item) => item.deviceId)), [tracked]);
  const emptyCells = view === "split" ? grid.cols * grid.rows - shown.length : 0;

  return (
    <>
      {/* The main map stays mounted underneath, so going back to one radio is
        instant; this hides it while the tiles are up. */}
      <div className="absolute inset-x-0 bottom-0 top-[var(--ops-chrome)] z-[899] bg-ops-bg" />
      <div style={style} className="absolute z-[900] flex flex-col gap-2">
        <div className="glass-panel flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-1.5 text-[11px] text-neutral-300">
          <span className="font-bold text-neutral-100">Tracking {tracked.length} radios</span>
          <Segmented
            value={view}
            onChange={onView}
            options={[
              ["split", "Split", <Columns2 key="s" size={11} />],
              ["together", "Together", <MapIcon key="t" size={11} />],
            ]}
          />
          {view === "split" ? (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="text-neutral-500">Tiles on this screen</span>
                <Segmented
                  value={tileSize}
                  onChange={onTileSize}
                  // How many each size fits on this screen, so the trade-off
                  // is plain before anyone clicks.
                  options={Object.entries(TILE_SIZES).map(([key, size]) => [
                    key,
                    area.width ? `${size.label} · ${capacity(area.width, area.height, key).max}` : size.label,
                  ])}
                />
              </span>
            </>
          ) : null}
          {notShown.length ? (
            <span className="relative">
              <button
                onClick={() => setOverflowOpen((open) => !open)}
                className="rounded-md bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold text-amber-200 hover:bg-amber-400/25"
              >
                +{notShown.length} not shown
              </button>
              {overflowOpen ? (
                <ul className="glass-panel absolute left-0 top-full z-20 mt-1 w-56 rounded-md py-1 shadow-xl">
                  <li className="px-2 py-1 text-[10px] text-neutral-500">No room at this tile size. Pick one to show it first.</li>
                  {notShown.map((radio) => (
                    <li key={radio.uid}>
                      <button
                        onClick={() => {
                          setOverflowOpen(false);
                          onBringForward(radio.uid);
                        }}
                        className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-white/10"
                      >
                        <span className="h-2 w-2 rounded-full" style={{ background: radio.colour }} />
                        <span className="truncate">{radio.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </span>
          ) : null}
          {notice ? <span className="text-amber-300">{notice}</span> : null}
          <span className="ml-auto text-[9px] text-neutral-600">Imagery © Esri</span>
          <button
            onClick={onStopAll}
            className="rounded-md bg-white/10 px-2.5 py-1 text-[10px] font-bold text-neutral-100 hover:bg-white/15 active:bg-white/20"
          >
            Stop all
          </button>
        </div>

        {view === "together" ? (
          <TogetherView radios={radios} radioTracks={radioTracks} trails={trails} onStop={onStop} />
        ) : (
          <div
            ref={areaRef}
            className="relative grid min-h-0 flex-1"
            style={{
              gap: TILE_GAP,
              gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))`,
            }}
          >
            {shown.map((radio) => (
              <TrackTile
                key={radio.uid}
                radio={radio}
                radioTracks={radioTracks}
                trails={trails}
                maximised={maximised === radio.uid}
                // Tiles under a maximised one stop drawing until they are back.
                hidden={Boolean(maximised) && maximised !== radio.uid}
                onMaximise={() => setMaximised((current) => (current === radio.uid ? null : radio.uid))}
                onStop={() => onStop(radio.uid)}
                onPause={() => onPause(radio.uid)}
                onResume={() => onResume(radio.uid)}
                onReplay={() => onReplay(radio.uid)}
                onDragStart={() => {
                  dragRef.current = radio.uid;
                }}
                onDrop={() => {
                  if (dragRef.current && dragRef.current !== radio.uid) onReorder(dragRef.current, radio.uid);
                  dragRef.current = null;
                }}
              />
            ))}
            {emptyCells > 0 && !maximised ? <AddTile devices={devices} trackedIds={trackedIds} onTrack={onTrack} /> : null}
          </div>
        )}
      </div>
    </>
  );
}
