import { Mic } from "lucide-react";
import { useEffect, useState } from "react";
import { useLiveRadioSession } from "../lib/live-radio-session";

/** Seconds left before an on-air talk stops itself, or null when not on air. */
export function useTalkSecondsLeft() {
  const radio = useLiveRadioSession();
  const onAir = radio.talk.state !== "idle" && radio.pttState === "granted";
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!onAir) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [onAir]);
  if (!onAir || !radio.talk.startedAt) return null;
  return Math.max(0, Math.ceil((radio.talk.startedAt + radio.talk.maxMs - now) / 1000));
}

/** What the talk button should say right now. */
export function talkLabel(radio, secondsLeft, { compact = false } = {}) {
  const { state } = radio.talk;
  if (radio.pttState === "granted" && state !== "idle") {
    const left = secondsLeft != null ? ` · ${secondsLeft}s` : "";
    if (compact) return `On air${left}`;
    return state === "latched" ? `On air · tap to stop${left}` : `On air · release to stop${left}`;
  }
  if (state !== "idle" || radio.pttState === "requesting") return "Connecting…";
  return compact ? "Talk" : "Tap or hold to talk";
}

/**
 * Press and release drive the shared talk control: a quick tap stays on air
 * until the next tap, a longer hold talks until let go. The pointer is
 * captured so sliding a finger off the button still counts as letting go.
 */
export function TalkButton({ kind = "start", className = "", title, children, ...rest }) {
  const radio = useLiveRadioSession();
  return (
    <button
      type="button"
      title={title}
      className={`touch-none select-none [-webkit-touch-callout:none] ${className}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        radio.talk.press(kind);
      }}
      onPointerUp={() => radio.talk.release()}
      onPointerCancel={() => radio.talk.release()}
      // A long press on a phone must not open the copy/share menu.
      onContextMenu={(event) => event.preventDefault()}
      // Space is handled for the whole page; Enter works on a focused button.
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.repeat) {
          event.preventDefault();
          radio.talk.press(kind);
        }
      }}
      onKeyUp={(event) => {
        if (event.key === "Enter") radio.talk.release();
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export function TalkIcon({ size = 12 }) {
  return <Mic size={size} />;
}
