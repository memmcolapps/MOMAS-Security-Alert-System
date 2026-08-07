import { CheckCircle2, X, XCircle, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

// Failures outlive successes on purpose. "Device updated" is confirmation of
// something the operator just did and can go quickly; "the call was rejected"
// may need acting on, and in a room where somebody looked away for a moment a
// two-second message never happened at all.
const DISMISS_MS = { error: 8000, alert: 8000, success: 2600, info: 3200 };

const TONES = {
  error: { className: "border-ops-red/50 bg-red-500/15 text-red-200", Icon: XCircle },
  alert: { className: "border-yellow-500/40 bg-yellow-500/10 text-yellow-200", Icon: Zap },
  success: { className: "border-ops-green/40 bg-ops-green/10 text-ops-green", Icon: CheckCircle2 },
  info: { className: "border-white/10 bg-black/90 text-neutral-200", Icon: null },
};

/**
 * Transient messages: they announce themselves and go.
 *
 * Standing conditions do not belong here - something that stays true (no
 * microphone on this screen, radio not configured on this server) has to be
 * shown next to the control it explains, or the operator is left with a dead
 * button and no reason. This is only for things that describe a moment.
 */
export function useToast() {
  const [toast, setToast] = useState(null);
  const timerRef = useRef(null);

  const dismiss = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setToast(null);
  }, []);

  const notify = useCallback((message, tone = "info") => {
    if (!message) return;
    const text = message instanceof Error ? message.message : String(message);
    // A fresh message restarts the clock rather than inheriting the remainder
    // of the previous one's.
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setToast({ id: Date.now(), message: text, tone: TONES[tone] ? tone : "info" });
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    timerRef.current = window.setTimeout(() => setToast(null), DISMISS_MS[toast.tone] ?? 3200);
    return () => window.clearTimeout(timerRef.current);
  }, [toast]);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  return { toast, notify, dismiss };
}

export function Toast({ toast, onDismiss }) {
  if (!toast) return null;
  const { className, Icon } = TONES[toast.tone] || TONES.info;
  return (
    <div
      // Announced to screen readers, and assertive for failures so they are not
      // queued behind whatever else is being read out.
      role="status"
      aria-live={toast.tone === "error" ? "assertive" : "polite"}
      className={`fixed bottom-5 right-5 z-[1500] flex max-w-[min(420px,calc(100vw-2rem))] items-center gap-2 rounded border px-4 py-2 text-xs font-bold shadow-xl ${className}`}
    >
      {Icon ? <Icon size={13} className="shrink-0" /> : null}
      <span className="min-w-0">{toast.message}</span>
      {/* Always dismissible: an operator who has read it should not have to
          wait out the timer, and one who needs longer can re-trigger. */}
      <button
        aria-label="Dismiss message"
        className="-mr-1 ml-1 shrink-0 rounded p-1 opacity-60 hover:opacity-100"
        onClick={onDismiss}
      >
        <X size={12} />
      </button>
    </div>
  );
}
