import { Laptop, MapPin, Smartphone } from "lucide-react";
import { formatDateTime, relativeAge } from "../org/shared";

// The sign-ins and devices of one person, shared by their own Security page
// and the panel an admin opens from People. Actions are passed in, so each
// screen offers only what its viewer may do.

const STATUS = {
  approved: { label: "Approved", className: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" },
  pending: { label: "Waiting for approval", className: "border-amber-400/40 bg-amber-400/10 text-amber-300" },
  blocked: { label: "Blocked", className: "border-red-400/40 bg-red-500/10 text-red-300" },
};

function DeviceIcon({ phone }) {
  const Icon = phone ? Smartphone : Laptop;
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-neutral-300">
      <Icon size={15} />
    </span>
  );
}

function Place({ lat, lon }) {
  // null would read as 0, 0 - a point in the sea off Ghana.
  if (lat === null || lat === undefined || lon === null || lon === undefined) return null;
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
  return (
    <a
      className="inline-flex items-center gap-0.5 text-neutral-500 hover:text-neutral-200"
      href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=14/${lat}/${lon}`}
      target="_blank"
      rel="noreferrer"
    >
      <MapPin size={10} /> {Number(lat).toFixed(3)}, {Number(lon).toFixed(3)}
    </a>
  );
}

export function SmallButton({ children, onClick, danger, disabled, primary }) {
  const tone = primary
    ? "border-transparent bg-ops-red text-black hover:opacity-85"
    : danger
      ? "border-red-500/25 text-red-300/90 hover:border-ops-red hover:text-ops-red"
      : "border-white/10 text-neutral-300 hover:border-white/25 hover:text-neutral-100";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`shrink-0 rounded-md border px-2.5 py-1 text-[11px] font-bold transition active:scale-[0.97] disabled:opacity-40 ${tone}`}
    >
      {children}
    </button>
  );
}

/** Sign-ins still open, newest use first. `actions(session)` returns buttons. */
export function SessionRows({ sessions, actions, showPanic = false }) {
  if (!sessions.length) return <p className="py-3 text-[12px] text-neutral-500">Not signed in anywhere.</p>;
  return (
    <ul className="divide-y divide-white/5">
      {sessions.map((session) => (
        <li key={session.id} className="flex items-center gap-3 py-2.5">
          <DeviceIcon phone={session.is_phone} />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-neutral-100">
              {session.label || "Unknown device"}
              {session.current ? (
                <span className="rounded-full bg-white/[0.08] px-1.5 text-[10px] text-neutral-300">This device</span>
              ) : null}
              {showPanic && session.duress ? (
                <span className="rounded-full border border-red-400/50 bg-red-500/15 px-1.5 text-[10px] font-bold text-red-300">Panic sign-in</span>
              ) : null}
              {session.locked_at ? <span className="rounded-full bg-white/[0.06] px-1.5 text-[10px] text-neutral-400">Locked</span> : null}
            </p>
            <p className="flex flex-wrap gap-x-2 text-[11px] text-neutral-500">
              <span>Used {relativeAge(session.last_active_at) || "—"}</span>
              <span>Signed in {formatDateTime(session.created_at)}</span>
              <Place lat={session.lat} lon={session.lon} />
            </p>
          </div>
          {actions ? <div className="flex gap-1.5">{actions(session)}</div> : null}
        </li>
      ))}
    </ul>
  );
}

/** Every device this person has signed in from. `actions(device)` returns buttons. */
export function DeviceRows({ devices, actions }) {
  if (!devices.length) return <p className="py-3 text-[12px] text-neutral-500">No devices yet.</p>;
  return (
    <ul className="divide-y divide-white/5">
      {devices.map((device) => {
        const status = STATUS[device.status] || STATUS.approved;
        return (
          <li key={device.id} className="flex items-center gap-3 py-2.5">
            <DeviceIcon phone={device.is_phone} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-neutral-100">
                {device.label || "Unknown device"}
                <span className={`rounded-full border px-1.5 text-[10px] ${status.className}`}>{status.label}</span>
              </p>
              <p className="text-[11px] text-neutral-500">
                First seen {formatDateTime(device.first_seen_at)} · last {relativeAge(device.last_seen_at) || "—"}
              </p>
            </div>
            {actions ? <div className="flex gap-1.5">{actions(device)}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}
