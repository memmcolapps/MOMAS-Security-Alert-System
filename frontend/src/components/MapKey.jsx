import { ChevronDown, ChevronUp, Layers } from "lucide-react";
import { severityColors, severityLabels } from "../lib/domain";

const BASEMAPS = [
  ["satellite", "Satellite"],
  ["streets", "Streets"],
  ["grey", "Grey"],
];

const SEVERITY_NAMES = { RED: "Critical", ORANGE: "Serious", YELLOW: "Moderate", BLUE: "Low" };

// The radio statuses as the map draws them, using the map's own classes so the
// key cannot drift from the pins.
const RADIO_KEY = [
  ["status-moving", "Moving (arrow shows direction)"],
  ["status-online", "Online, not moving"],
  ["status-nofix", "Online, no new position"],
  ["status-sos", "SOS alarm"],
];

/**
 * The basemap switch and the legend in one small corner control. Closed it is
 * a single row; the key opens only when someone wants to read it, instead of
 * permanently covering the pins in that corner.
 */
export function MapKey({ basemap, onBasemap, open, onToggle, className = "" }) {
  return (
    <section className={`glass-panel z-[1000] w-[210px] rounded-md p-2 text-[10px] ${className}`}>
      <div className="flex items-center gap-1">
        {BASEMAPS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => onBasemap(key)}
            className={`flex-1 rounded px-1.5 py-1 text-[10px] font-bold ${
              basemap === key ? "bg-white/15 text-neutral-100" : "text-neutral-500 hover:text-neutral-200"
            }`}
          >
            {label}
          </button>
        ))}
        <button onClick={onToggle} className="rounded p-1 text-neutral-500 hover:text-neutral-100" title={open ? "Hide the key" : "Show the key"}>
          <Layers size={12} className="inline" /> {open ? <ChevronUp size={11} className="inline" /> : <ChevronDown size={11} className="inline" />}
        </button>
      </div>
      {open ? (
        <div className="mt-2 space-y-2 border-t border-white/10 pt-2">
          <div>
            <div className="mb-1 text-[9px] uppercase tracking-wide text-neutral-600">Radios</div>
            {RADIO_KEY.map(([status, label]) => (
              <div className="my-1 flex items-center gap-2 text-neutral-400" key={status}>
                <span className={`device-pin ${status} !h-3 !w-3 !animate-none !text-[0px]`} />
                {label}
              </div>
            ))}
            <div className="my-1 flex items-center gap-2 text-neutral-400">
              <span className="device-dot !h-2 !w-2" /> Offline
            </div>
            <div className="my-1 flex items-center gap-2 text-neutral-400">
              <span className="grid h-3.5 w-3.5 place-items-center rounded-full border border-ops-green text-[7px] font-bold text-ops-green">3</span>
              Radios in one place
            </div>
          </div>
          <div>
            <div className="mb-1 text-[9px] uppercase tracking-wide text-neutral-600">Incidents</div>
            {Object.entries(severityLabels).map(([key, label]) => (
              <div className="my-1 flex items-center gap-2 text-neutral-400" key={key}>
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: severityColors[key] }} />
                <span className="rounded bg-white/5 px-1 text-[9px] font-bold" style={{ color: severityColors[key] }}>
                  {label}
                </span>
                {SEVERITY_NAMES[key] || ""}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
