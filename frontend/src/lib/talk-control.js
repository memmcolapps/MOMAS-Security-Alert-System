// One talk control for the whole console: tap to talk and tap again to stop,
// or press and hold like a handset and let go to stop. Every way in - the
// radio bar, the radio card, the big phone button, the Space bar, a USB pedal
// that types Space - drives this same control, so they never disagree about
// whether the console is on air.
//
// A press shorter than TAP_MS counts as a tap and leaves the console talking.
// Any transmission, tapped or held, stops itself after MAX_TALK_MS so a
// forgotten tap or a stuck pedal cannot block the channel.

export const TAP_MS = 300;
export const MAX_TALK_MS = 45_000;

export function createTalkControl({
  start,
  stop,
  onChange = () => {},
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  tapMs = TAP_MS,
  maxTalkMs = MAX_TALK_MS,
}) {
  // "idle", "holding" (finger or key down) or "latched" (tapped on).
  let state = "idle";
  let pressedAt = 0;
  let startedAt = 0;
  let limitTimer = null;
  // A press that turned a latched talk off: its release must do nothing.
  let swallowRelease = false;

  const set = (next, reason) => {
    state = next;
    onChange({ state, startedAt, reason });
  };

  const endTalk = (reason) => {
    if (limitTimer) clearTimer(limitTimer);
    limitTimer = null;
    startedAt = 0;
    set("idle", reason);
  };

  return {
    get state() {
      return state;
    },
    get startedAt() {
      return startedAt;
    },
    /** Finger down, key down or pedal down. kind is "start" or "takeover". */
    press(kind = "start") {
      if (state === "latched") {
        swallowRelease = true;
        stop();
        endTalk("tapped_off");
        return;
      }
      if (state === "holding") return;
      swallowRelease = false;
      pressedAt = now();
      startedAt = pressedAt;
      start(kind);
      limitTimer = setTimer(() => {
        limitTimer = null;
        if (state === "idle") return;
        stop();
        endTalk("time_limit");
      }, maxTalkMs);
      set("holding");
    },
    /** Finger up, key up or pedal up. */
    release() {
      if (swallowRelease) {
        swallowRelease = false;
        return;
      }
      if (state !== "holding") return;
      if (now() - pressedAt < tapMs) {
        set("latched");
        return;
      }
      stop();
      endTalk("released");
    },
    /**
     * The talk ended from outside: the network refused or took the channel,
     * the call ended, the connection dropped. Nothing is sent.
     */
    reset(reason = "ended") {
      swallowRelease = false;
      if (state === "idle") return;
      endTalk(reason);
    },
  };
}
