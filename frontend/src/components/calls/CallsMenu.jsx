import { Phone, PhoneMissed, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCalls } from "../../lib/console-calls";
import { useIsNarrow } from "../../lib/use-is-narrow";

const STATUS_TEXT = { online: "Online", on_radio: "On radio", busy: "In a call" };

export function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return (parts[0]?.[0] || "?").concat(parts.length > 1 ? parts[parts.length - 1][0] : "").toUpperCase();
}

function timeAgo(at) {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/** The header button: who is online, plus a badge for missed calls. */
export function CallsButton() {
  const calls = useCalls();
  const narrow = useIsNarrow();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (!narrow && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, narrow]);

  // Opening the list is how missed calls are seen.
  useEffect(() => {
    if (open && calls.missed.length) calls.clearMissed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!calls.available) return null;
  const online = calls.people.length;
  const missedCount = calls.missed.length;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={`Calls, ${online} online${missedCount ? `, ${missedCount} missed` : ""}`}
        aria-expanded={open}
        className="relative inline-flex h-9 items-center gap-1.5 rounded border border-white/10 bg-white/[0.03] px-2.5 text-[11px] font-bold text-neutral-200 transition hover:bg-white/[0.07] active:bg-white/[0.1] md:h-auto md:py-1"
      >
        <Phone size={14} className="text-neutral-300" />
        <span className="hidden min-[1180px]:inline">Calls</span>
        <span className={`h-1.5 w-1.5 rounded-full ${calls.connected ? "bg-ops-green" : "bg-neutral-600"}`} />
        <span className="tabular-nums text-neutral-400">{online}</span>
        {missedCount ? (
          <span className="absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-ops-red px-1 text-[9px] font-bold text-black">
            {missedCount}
          </span>
        ) : null}
      </button>
      {open ? (
        narrow ? (
          // Drawn on the page itself, not inside the header: the header's blur
          // makes "fixed" mean "inside the header", which squeezed this sheet
          // into the header strip with its close button off screen.
          createPortal(
            <div className="fixed inset-0 z-[1250]">
              <button type="button" aria-label="Close" className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
              <div className="absolute inset-x-0 bottom-0 flex max-h-[75dvh] flex-col overflow-hidden rounded-t-2xl border-t border-white/10 bg-neutral-950 pb-[env(safe-area-inset-bottom)] shadow-2xl">
                <div className="mx-auto my-2 h-1 w-9 shrink-0 rounded-full bg-white/20" />
                <PeopleList onDone={() => setOpen(false)} large />
              </div>
            </div>,
            document.body,
          )
        ) : (
          <div className="absolute right-0 top-full z-[1250] mt-2 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-lg border border-white/10 bg-black/95 shadow-2xl backdrop-blur">
            <PeopleList onDone={() => setOpen(false)} />
          </div>
        )
      ) : null}
    </div>
  );
}

function PeopleList({ onDone, large = false }) {
  const calls = useCalls();
  const [query, setQuery] = useState("");
  const missedSnapshot = useRef(calls.missed);
  const anyOrgInfo = calls.people.some((person) => person.organizations?.length || person.platformStaff);
  const showSearch = calls.people.length > 6 || anyOrgInfo;

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = calls.people.filter((person) => {
      if (!needle) return true;
      const orgs = (person.organizations || []).map((org) => org.name).join(" ");
      return `${person.name} ${person.detail} ${orgs}`.toLowerCase().includes(needle);
    });
    // Platform staff see everyone, grouped by organization. Everyone else
    // only ever sees their own organization, so one flat list.
    if (!anyOrgInfo) return [{ key: "all", title: null, people: matches }];
    const byGroup = new Map();
    for (const person of matches) {
      const title = person.platformStaff ? "EPAIL team" : person.organizations?.[0]?.name || "Other";
      if (!byGroup.has(title)) byGroup.set(title, []);
      byGroup.get(title).push(person);
    }
    return [...byGroup.entries()]
      .sort(([a], [b]) => (a === "EPAIL team" ? -1 : b === "EPAIL team" ? 1 : a.localeCompare(b)))
      .map(([title, people]) => ({ key: title, title, people }));
  }, [anyOrgInfo, calls.people, query]);

  const call = (person) => {
    onDone();
    void calls.startCall(person);
  };

  const rowPad = large ? "py-3" : "py-2";
  const recentMissed = missedSnapshot.current;

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12px] text-neutral-200">
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <p className="text-[9px] font-bold uppercase tracking-wide text-neutral-500">People online</p>
        {large ? (
          <button type="button" onClick={onDone} aria-label="Close" className="grid h-8 w-8 place-items-center rounded text-neutral-400 active:bg-white/10">
            <X size={16} />
          </button>
        ) : null}
      </div>
      {showSearch ? (
        <label className="mx-3 mb-1 flex items-center gap-2 rounded border border-white/10 bg-white/[0.03] px-2">
          <Search size={13} className="text-neutral-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={anyOrgInfo ? "Name or organization" : "Name"}
            className={`w-full bg-transparent text-neutral-200 outline-none placeholder:text-neutral-600 ${large ? "h-10 text-[14px]" : "h-8"}`}
          />
        </label>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {recentMissed.length ? (
          <div className="border-b border-white/10 pb-1">
            {recentMissed.map((entry) => {
              const live = calls.people.find((person) => person.userId === entry.peer?.userId);
              return (
                <div key={entry.at} className={`flex items-center gap-2 px-3 ${rowPad}`}>
                  <PhoneMissed size={14} className="shrink-0 text-ops-red" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">Missed: {entry.peer?.name}</div>
                    <div className="text-[10px] text-neutral-500">{timeAgo(entry.at)}</div>
                  </div>
                  {live?.callable && live.status !== "busy" && calls.canStart ? (
                    <button type="button" onClick={() => call(live)} className="rounded bg-ops-green px-2 py-1 text-[11px] font-bold text-black hover:brightness-110 active:brightness-90">
                      Call back
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {groups.every((group) => !group.people.length) ? (
          <p className="px-3 py-4 text-[11px] leading-relaxed text-neutral-500">
            {query
              ? "Nobody online matches that."
              : calls.connected
                ? "Nobody else who can take a call has EPAIL open right now."
                : "Connecting…"}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.key}>
              {group.title ? (
                <p className="px-3 pb-0.5 pt-2 text-[9px] font-bold uppercase tracking-wide text-neutral-600">{group.title}</p>
              ) : null}
              {group.people.map((person) => (
                <PersonRow key={person.userId} person={person} pad={rowPad} large={large} canStart={calls.canStart} onCall={call} />
              ))}
            </div>
          ))
        )}
        {!calls.canStart && calls.people.length ? (
          <p className="px-3 pb-2 pt-1 text-[10px] text-neutral-500">Your role can answer calls but not start them.</p>
        ) : null}
      </div>
    </div>
  );
}

function PersonRow({ person, pad, large, canStart, onCall }) {
  const busy = person.status === "busy";
  const showButton = canStart && person.callable && !busy;
  return (
    <div className={`flex items-center gap-2.5 px-3 ${pad} hover:bg-white/[0.04]`}>
      <span className={`grid shrink-0 place-items-center rounded-full bg-white/[0.08] font-bold text-neutral-300 ${large ? "h-9 w-9 text-[12px]" : "h-7 w-7 text-[10px]"}`}>
        {initials(person.name)}
      </span>
      <div className="min-w-0 flex-1">
        <div className={`truncate ${large ? "text-[14px]" : ""}`}>{person.name}</div>
        <div className="flex items-center gap-1.5 truncate text-[10px] text-neutral-500">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${busy ? "bg-ops-amber" : "bg-ops-green"}`} />
          <span className="truncate">{[person.detail, STATUS_TEXT[person.status]].filter(Boolean).join(" · ")}</span>
        </div>
      </div>
      {showButton ? (
        <button
          type="button"
          onClick={() => onCall(person)}
          aria-label={`Call ${person.name}`}
          className={`grid shrink-0 place-items-center rounded-full bg-ops-green text-black transition hover:brightness-110 active:scale-95 active:brightness-90 ${large ? "h-10 w-10" : "h-7 w-7"}`}
        >
          <Phone size={large ? 17 : 13} />
        </button>
      ) : null}
    </div>
  );
}
