import { ChevronDown, ChevronUp, Crosshair, Radio, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { compassFor, formatAge } from "../lib/radio-motion";

// Counts-bar filters, in the order the bar shows them. "online" takes in the
// moving and no-fix radios too: it means "the network can reach it".
const FILTERS = [
  { key: "moving", label: "moving", tone: "text-ops-green", counts: ["moving"] },
  { key: "online", label: "online", tone: "text-emerald-300", counts: ["moving", "online", "nofix"] },
  { key: "nofix", label: "no fix", tone: "text-amber-300", counts: ["nofix"] },
  { key: "offline", label: "offline", tone: "text-neutral-400", counts: ["offline"] },
  // Registered radios that have never reported where they are: not on the map
  // at all, so this list is the only place they can be found.
  { key: "nopos", label: "no position", tone: "text-neutral-500", counts: ["nopos"] },
];

const ORDER = { sos: 0, moving: 1, online: 2, nofix: 3, offline: 4, nopos: 5 };

const DOT = {
  sos: "bg-ops-red animate-pulse",
  moving: "bg-ops-green shadow-[0_0_6px_rgba(0,204,102,0.9)]",
  online: "bg-ops-green",
  nofix: "border border-dashed border-ops-green bg-transparent",
  offline: "bg-neutral-600",
  nopos: "border border-neutral-600 bg-transparent",
};

function detail(info) {
  if (!info || info.status === "nopos") return "no position reported";
  if (info.status === "sos") return "SOS alarm";
  if (info.status === "offline") return "offline";
  if (info.status === "nofix") return `no new fix · ${formatAge(info.ageSec)}`;
  if (info.status === "moving") {
    const pace = `${Math.round((info.speedMs || 0) * 3.6)} km/h`;
    return compassFor(info.bearing) ? `${pace} ${compassFor(info.bearing)}` : pace;
  }
  return info.ageSec == null ? "not moving" : `not moving · ${formatAge(info.ageSec)}`;
}

/**
 * The fleet at a glance: what every radio is doing, as counts that filter the
 * map, and a list sorted by what needs attention - alarms, then whatever is
 * moving. Finding a radio no longer means hunting for its pin.
 */
export function RadioFleetPanel({ devices, statuses, filter, onFilter, trackedId, onTrack, onOpen, open, onToggle, header }) {
  const [query, setQuery] = useState("");

  // Every registered radio in service, with what the map knows about it - or
  // "no position" for one the map has never been able to place.
  const fleet = useMemo(
    () =>
      devices
        .filter((device) => device.active !== false)
        .map((device) => ({ device, info: statuses[String(device.device_id)] || { status: "nopos" } })),
    [devices, statuses],
  );

  const counts = useMemo(() => {
    const tally = { sos: 0, moving: 0, online: 0, nofix: 0, offline: 0, nopos: 0 };
    for (const { info } of fleet) tally[info.status] = (tally[info.status] || 0) + 1;
    return tally;
  }, [fleet]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const shows = FILTERS.find((item) => item.key === filter)?.counts;
    return fleet
      .filter(({ device, info }) => {
        if (shows && info.status !== "sos" && !shows.includes(info.status)) return false;
        if (!needle) return true;
        return `${device.name || ""} ${device.device_id} ${device.operator || ""}`.toLowerCase().includes(needle);
      })
      .sort(
        (a, b) =>
          ORDER[a.info.status] - ORDER[b.info.status] ||
          (b.info.speedMs || 0) - (a.info.speedMs || 0) ||
          String(a.device.name || a.device.device_id).localeCompare(String(b.device.name || b.device.device_id)),
      );
  }, [fleet, filter, query]);

  return (
    <section className="glass-panel absolute left-16 top-[calc(var(--ops-chrome)+0.75rem)] z-[1000] flex max-h-[calc(100vh-var(--ops-chrome)-6rem)] w-[280px] flex-col rounded-md">
      <div className="px-3 pt-2">{header}</div>

      <div className="flex flex-wrap items-center gap-1 px-3 py-2">
        {counts.sos ? (
          <span className="rounded border border-ops-red/60 bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold text-ops-red">
            {counts.sos} SOS
          </span>
        ) : null}
        {FILTERS.map((item) => {
          const count = item.counts.reduce((sum, status) => sum + (counts[status] || 0), 0);
          const active = filter === item.key;
          return (
            <button
              key={item.key}
              onClick={() => onFilter(active ? "all" : item.key)}
              title={active ? "Show every radio" : `Show only ${item.label} radios`}
              className={`rounded border px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${
                active ? "border-ops-green bg-ops-green/15" : "border-white/10 bg-white/[0.03] hover:border-white/30"
              }`}
            >
              <span className={item.tone}>{count}</span> <span className="text-neutral-400">{item.label}</span>
            </button>
          );
        })}
        <button
          onClick={onToggle}
          className="ml-auto inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-bold text-neutral-400 hover:text-neutral-100"
          title={open ? "Hide the radio list" : "Show the radio list"}
        >
          <Radio size={11} /> {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
      </div>

      {open ? (
        <>
          <label className="mx-3 mb-2 flex items-center gap-1.5 rounded border border-white/10 bg-white/[0.03] px-2 py-1">
            <Search size={11} className="text-neutral-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a radio"
              className="w-full bg-transparent text-[11px] text-neutral-200 outline-none placeholder:text-neutral-600"
            />
          </label>
          <ul className="scrollbar-thin min-h-0 flex-1 overflow-y-auto border-t border-white/5">
            {rows.map(({ device, info }) => {
              const uid = String(device.device_id);
              const tracked = uid === trackedId;
              return (
                <li key={uid}>
                  <button
                    // A radio with no position cannot be followed on the map,
                    // so it opens its console instead: it can still be called.
                    onClick={() => (info.status === "nopos" && onOpen ? onOpen(device) : onTrack(uid))}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[0.05] ${tracked ? "bg-ops-green/10" : ""}`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[info.status]}`} />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[11px] font-semibold ${info.status === "offline" || info.status === "nopos" ? "text-neutral-500" : "text-neutral-100"}`}>
                        {device.name || uid}
                      </span>
                      <span className={`block truncate text-[10px] ${info.status === "sos" ? "text-ops-red" : info.status === "nofix" ? "text-amber-300/80" : "text-neutral-500"}`}>
                        {detail(info)}
                      </span>
                    </span>
                    {tracked ? <Crosshair size={12} className="shrink-0 text-ops-green" /> : null}
                  </button>
                </li>
              );
            })}
            {!rows.length ? <li className="px-3 py-4 text-center text-[11px] text-neutral-600">No radios match.</li> : null}
          </ul>
        </>
      ) : null}
    </section>
  );
}
