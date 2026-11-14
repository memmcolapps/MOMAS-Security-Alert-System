import { Map as MapIcon, Mic, MicOff, Phone, PhoneIncoming, PhoneOff, Signal, SignalLow, SignalMedium, X } from "lucide-react";
import { useEffect, useState } from "react";
import { formatDuration } from "../../lib/call-logic";
import { useCalls } from "../../lib/console-calls";
import { initials } from "./CallsMenu";
import { useIsNarrow } from "../../lib/use-is-narrow";

const QUALITY = {
  good: { label: "Good", Icon: Signal, tone: "text-ops-green" },
  fair: { label: "Fair", Icon: SignalMedium, tone: "text-ops-amber" },
  poor: { label: "Poor", Icon: SignalLow, tone: "text-ops-red" },
};

function useElapsed(since) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [since]);
  return since ? (now - since) / 1000 : 0;
}

function statusLine(call, elapsed) {
  if (call.phase === "calling") return "Calling…";
  if (call.phase === "connecting") return "Connecting…";
  if (call.peerAway) return "Their connection dropped. Waiting for them…";
  if (call.reconnecting) return "Reconnecting…";
  return formatDuration(elapsed);
}

function QualityBadge({ quality, compact = false }) {
  const look = QUALITY[quality];
  if (!look) return null;
  const { Icon } = look;
  return (
    <span className={`inline-flex items-center gap-1 ${look.tone}`} title={`Connection ${look.label.toLowerCase()}`}>
      <Icon size={14} />
      {compact ? null : <span>{look.label}</span>}
    </span>
  );
}

/** Typing in a field must never answer or mute a call. */
function typingInField(event) {
  const target = event.target;
  return target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName);
}

/**
 * The thin bar under the header during a call. Always shown on big screens;
 * on a phone it is what a minimized call shrinks to.
 */
export function CallStrip() {
  const calls = useCalls();
  const narrow = useIsNarrow();
  const call = calls.call;
  const elapsed = useElapsed(call?.phase === "active" ? call.answeredAt : null);
  if (!call || call.phase === "ringing") return null;
  if (narrow && !calls.minimized) return null;

  const live = call.phase === "active";
  return (
    <div className={`border-b border-white/10 ${live && !call.reconnecting ? "bg-emerald-950/80" : "bg-neutral-900/90"} backdrop-blur`}>
      <div className="flex h-9 items-center gap-3 px-3 text-[12px] md:px-4">
        <button
          type="button"
          onClick={() => narrow && calls.setMinimized(false)}
          className="flex min-w-0 items-center gap-2 text-left"
          aria-label={narrow ? "Open call" : undefined}
        >
          <Phone size={14} className={live ? "text-ops-green" : "text-neutral-400"} />
          <span className="truncate font-bold text-neutral-100">{call.peer?.name}</span>
          <span className="shrink-0 tabular-nums text-neutral-400">{statusLine(call, elapsed)}</span>
        </button>
        {live ? <QualityBadge quality={call.quality} compact={narrow} /> : null}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {live || call.phase === "connecting" ? (
            <button
              type="button"
              onClick={calls.toggleMute}
              disabled={call.noMic}
              aria-pressed={Boolean(call.muted)}
              className={`inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-[11px] font-bold transition active:scale-95 ${
                call.muted ? "bg-ops-amber text-black" : "border border-white/15 bg-white/[0.06] text-neutral-200 hover:bg-white/[0.1]"
              }`}
            >
              {call.muted ? <MicOff size={13} /> : <Mic size={13} />}
              <span className="hidden sm:inline">{call.muted ? "Unmute" : "Mute"}</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={calls.hangUp}
            className="inline-flex h-7 items-center gap-1.5 rounded bg-ops-red px-3 text-[11px] font-bold text-black transition hover:brightness-110 active:scale-95"
          >
            <PhoneOff size={13} />
            {call.phase === "calling" ? "Cancel" : "End"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Incoming call card, the full-screen call on phones, and short notices. */
export function CallOverlays() {
  const calls = useCalls();
  const narrow = useIsNarrow();
  const call = calls.call;

  // Enter answers, Escape declines, M mutes - for desks where the mouse is
  // across the room.
  useEffect(() => {
    if (!call) return undefined;
    const onKey = (event) => {
      if (event.defaultPrevented || event.repeat || typingInField(event) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (call.phase === "ringing" && event.key === "Enter") {
        event.preventDefault();
        void calls.answer();
      } else if (call.phase === "ringing" && event.key === "Escape") {
        event.preventDefault();
        calls.decline();
      } else if (call.phase === "active" && (event.key === "m" || event.key === "M")) {
        event.preventDefault();
        calls.toggleMute();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [call, calls]);

  return (
    <>
      {call?.phase === "ringing" ? <IncomingCall narrow={narrow} /> : null}
      {call && call.phase !== "ringing" && narrow && !calls.minimized ? <CallScreen /> : null}
      {calls.notice ? <CallNotice narrow={narrow} /> : null}
    </>
  );
}

function IncomingCall({ narrow }) {
  const calls = useCalls();
  const call = calls.call;
  // Bottom of the screen on every size: the SOS banner owns the top, and on a
  // phone the buttons sit under the thumb.
  const place = narrow
    ? "inset-x-3 bottom-[calc(12px+env(safe-area-inset-bottom))]"
    : "bottom-4 left-4 w-80";
  return (
    <div role="alertdialog" aria-label={`Incoming call from ${call.peer?.name}`} className={`fixed z-[1190] ${place} rounded-xl border border-white/15 bg-neutral-950/95 p-3.5 shadow-2xl backdrop-blur`}>
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 animate-pulse place-items-center rounded-full bg-ops-green/15 text-[13px] font-bold text-ops-green">
          {initials(call.peer?.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
            <PhoneIncoming size={12} /> Incoming call
          </p>
          <p className="truncate text-[15px] font-bold text-neutral-100">{call.peer?.name}</p>
          {call.peer?.detail ? <p className="truncate text-[11px] text-neutral-500">{call.peer.detail}</p> : null}
        </div>
      </div>
      {calls.silentRing ? (
        <p className="mt-2 rounded bg-ops-amber/10 px-2 py-1 text-[11px] text-ops-amber">Ringing silently while an alarm sounds.</p>
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => void calls.answer()}
          className={`inline-flex items-center justify-center gap-1.5 rounded-lg bg-ops-green font-bold text-black transition hover:brightness-110 active:scale-[0.98] ${narrow ? "h-12 text-[14px]" : "h-9 text-[12px]"}`}
        >
          <Phone size={narrow ? 17 : 14} /> Answer
        </button>
        <button
          type="button"
          onClick={calls.decline}
          className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.06] font-bold text-neutral-200 transition hover:bg-white/[0.1] active:scale-[0.98] ${narrow ? "h-12 text-[14px]" : "h-9 text-[12px]"}`}
        >
          <PhoneOff size={narrow ? 17 : 14} /> Decline
        </button>
      </div>
      {narrow ? null : <p className="mt-2 text-center text-[10px] text-neutral-600">Enter to answer · Esc to decline</p>}
    </div>
  );
}

function CallScreen() {
  const calls = useCalls();
  const call = calls.call;
  const elapsed = useElapsed(call.phase === "active" ? call.answeredAt : null);
  const live = call.phase === "active";
  return (
    <div className="fixed inset-0 z-[1180] flex flex-col items-center justify-between bg-neutral-950 px-6 pb-[calc(32px+env(safe-area-inset-bottom))] pt-[calc(var(--ops-chrome)+48px)] text-neutral-100">
      <div className="flex flex-col items-center text-center">
        <span className={`grid h-24 w-24 place-items-center rounded-full text-[28px] font-bold ${live ? "bg-ops-green/15 text-ops-green" : "animate-pulse bg-white/[0.06] text-neutral-300"}`}>
          {initials(call.peer?.name)}
        </span>
        <p className="mt-4 text-[22px] font-bold">{call.peer?.name}</p>
        {call.peer?.detail ? <p className="text-[13px] text-neutral-500">{call.peer.detail}</p> : null}
        <p className="mt-2 text-[15px] tabular-nums text-neutral-300">{statusLine(call, elapsed)}</p>
        {live ? (
          <div className="mt-2 text-[13px]">
            <QualityBadge quality={call.quality} />
          </div>
        ) : null}
        {call.noMic ? <p className="mt-3 text-[12px] text-ops-amber">No microphone: they can't hear you.</p> : null}
      </div>
      <div className="flex items-center gap-6">
        <RoundButton label={call.muted ? "Unmute" : "Mute"} onClick={calls.toggleMute} disabled={call.noMic || call.phase === "calling"} active={call.muted}>
          {call.muted ? <MicOff size={24} /> : <Mic size={24} />}
        </RoundButton>
        <RoundButton label="Map" onClick={() => calls.setMinimized(true)}>
          <MapIcon size={24} />
        </RoundButton>
        <RoundButton label={call.phase === "calling" ? "Cancel" : "End"} onClick={calls.hangUp} danger>
          <PhoneOff size={26} />
        </RoundButton>
      </div>
    </div>
  );
}

function RoundButton({ label, onClick, children, danger = false, active = false, disabled = false }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={`grid h-16 w-16 place-items-center rounded-full transition active:scale-95 disabled:opacity-40 ${
          danger ? "bg-ops-red text-black" : active ? "bg-ops-amber text-black" : "bg-white/[0.08] text-neutral-100"
        }`}
      >
        {children}
      </button>
      <span className="text-[12px] text-neutral-400">{label}</span>
    </div>
  );
}

function CallNotice({ narrow }) {
  const calls = useCalls();
  const notice = calls.notice;
  return (
    <div
      role="status"
      className={`fixed z-[1195] flex items-center gap-2 rounded-lg border border-white/10 bg-neutral-900/95 px-3 py-2 text-[12px] text-neutral-200 shadow-xl backdrop-blur ${
        narrow ? "inset-x-3 bottom-[calc(12px+env(safe-area-inset-bottom))]" : "bottom-4 left-1/2 -translate-x-1/2"
      }`}
    >
      <span className="min-w-0 flex-1">{notice.text}</span>
      <button type="button" onClick={calls.dismissNotice} aria-label="Dismiss" className="grid h-6 w-6 place-items-center rounded text-neutral-500 hover:text-neutral-200">
        <X size={13} />
      </button>
    </div>
  );
}
