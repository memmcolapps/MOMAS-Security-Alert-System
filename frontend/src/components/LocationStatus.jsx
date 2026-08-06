import { LocateFixed, LocateOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFollow } from "../lib/follow-session";

const STATES = {
  granted: { dot: "bg-ops-green", label: "Location on", tone: "text-ops-green" },
  prompt: { dot: "bg-amber-400", label: "Location off", tone: "text-amber-300" },
  denied: { dot: "bg-ops-red", label: "Location blocked", tone: "text-ops-red" },
  unsupported: { dot: "bg-neutral-600", label: "No location", tone: "text-neutral-500" },
  unknown: { dot: "bg-neutral-600", label: "Location unknown", tone: "text-neutral-500" },
};

/**
 * A pre-flight check, in the header where a crew sees it before anything
 * happens. The point is that a vehicle finds out its location is broken while
 * parked, rather than in the seconds after an alarm lands.
 */
export function LocationStatus() {
  const { permission, requestLocationAccess, mobileStation, setMobileStation } = useFollow();
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (event) => {
      if (!boxRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  // Desks do not need this in their face. Once a device is marked as a mobile
  // station the indicator stays visible, because then it matters every shift.
  if (!mobileStation && permission !== "denied") {
    return (
      <div className="relative" ref={boxRef}>
        <button
          className="rounded p-2 text-neutral-600 hover:bg-white/5 hover:text-neutral-300"
          title="Location and mobile station settings"
          onClick={() => setOpen((value) => !value)}
        >
          <LocateOff size={15} />
        </button>
        {open ? <Panel {...{ permission, requestLocationAccess, mobileStation, setMobileStation, asking, setAsking }} /> : null}
      </div>
    );
  }

  const state = STATES[permission] || STATES.unknown;

  return (
    <div className="relative" ref={boxRef}>
      <button
        className="inline-flex items-center gap-1.5 rounded border border-white/10 px-2 py-1.5 text-[10px] font-bold hover:border-white/25"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${state.dot}`} />
        <span className={state.tone}>{state.label}</span>
      </button>
      {open ? <Panel {...{ permission, requestLocationAccess, mobileStation, setMobileStation, asking, setAsking }} /> : null}
    </div>
  );
}

function Panel({ permission, requestLocationAccess, mobileStation, setMobileStation, asking, setAsking }) {
  return (
    <div className="absolute right-0 top-full z-[1200] mt-2 w-72 rounded-lg border border-white/10 bg-[#0b0f0d] p-3 shadow-2xl">
      <h3 className="flex items-center gap-2 text-[11px] font-bold text-neutral-100">
        <LocateFixed size={13} className="text-ops-green" /> This device
      </h3>

      <label className="mt-3 flex items-start gap-2 text-[11px] text-neutral-300">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={mobileStation}
          onChange={(event) => setMobileStation(event.target.checked)}
        />
        <span>
          This is a mobile station
          <span className="mt-0.5 block text-[10px] text-neutral-500">
            Marks this browser as one that gets sent to alarms. Location is then set up at sign-in
            instead of during an incident.
          </span>
        </span>
      </label>

      <div className="mt-3 border-t border-white/10 pt-3">
        {permission === "granted" ? (
          <p className="text-[10px] text-neutral-400">
            Location is working. Distance and bearing to an alarm will be available as soon as you
            follow one.
          </p>
        ) : permission === "denied" ? (
          <>
            <p className="text-[10px] text-red-300">
              This browser is blocking location, and only the browser can unblock it — no admin or
              console can grant it remotely.
            </p>
            <p className="mt-1.5 text-[10px] text-neutral-500">
              Open the padlock in the address bar, set Location to Allow, then reload.
            </p>
          </>
        ) : permission === "unsupported" ? (
          <p className="text-[10px] text-neutral-400">This browser cannot report a location.</p>
        ) : (
          <>
            <p className="text-[10px] text-neutral-400">
              Location has not been granted yet. Do it now, while parked.
            </p>
            <button
              className="mt-2 w-full rounded bg-ops-green px-3 py-1.5 text-[11px] font-bold text-black disabled:opacity-50"
              disabled={asking}
              onClick={async () => {
                setAsking(true);
                await requestLocationAccess();
                setAsking(false);
              }}
            >
              {asking ? "Waiting for the prompt…" : "Turn on location"}
            </button>
          </>
        )}
        <p className="mt-2 text-[10px] text-neutral-600">
          This only sets where <em>you</em> are. An alarm&apos;s own location always comes from the
          handset that raised it.
        </p>
      </div>
    </div>
  );
}
