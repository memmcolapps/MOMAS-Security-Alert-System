import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BellOff, ChevronDown, Siren, Volume2 } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { listAlarms, startAlarmResponse, subscribeAlerts } from "../lib/api";
import { alarmHeadline, LEVEL_STYLES, levelOf } from "../lib/alarm-levels";
import {
  armSiren,
  sirenState,
  startAmberAlarm,
  startSiren,
  startYellowAlarm,
  stopAmberAlarm,
  stopSiren,
  stopYellowAlarm,
  subscribeSiren,
} from "../lib/sos-siren";

const SosAlarmContext = createContext({ ringing: [], silence: () => {}, soundState: "blocked" });

export function useSosAlarm() {
  return useContext(SosAlarmContext);
}

const alarmKey = (alert) => String(alert.alert_key || `pocstars:${alert.sos_msg_id}`);
const alarmLabel = (alert) => alarmHeadline(alert);
const LEVEL_RANK = { yellow: 0, amber: 1, red: 2 };

/** Loudest first, then newest first within a level. */
function byUrgency(a, b) {
  return (
    LEVEL_RANK[levelOf(b)] - LEVEL_RANK[levelOf(a)] ||
    (new Date(b.triggered_at).getTime() || 0) - (new Date(a.triggered_at).getTime() || 0)
  );
}

/**
 * Rings for alarms that arrive while the console is open, on every page.
 *
 * It used to live in the operations map, so an operator on the alarms or
 * devices screen heard nothing. An alarm rings until somebody starts a
 * response to it (status leaves 0) or silences it here; silencing covers the
 * alarms ringing now, never the next one.
 *
 * Every level is an alarm that rings until answered, more urgent the more it
 * matters. Red (every SOS, and red geofence rules) sounds the siren under a
 * red banner. Amber beeps under an amber banner. Yellow repeats a warning
 * burst every few seconds under a yellow banner.
 */
export function SosAlarmProvider({ enabled = true, children }) {
  const queryClient = useQueryClient();
  // Same key as the operations map, so the two share one request.
  const alertsQuery = useQuery({
    queryKey: ["alarms", "operations"],
    queryFn: () => listAlarms({ status: "open", limit: 500 }),
    refetchInterval: 15_000,
    enabled,
  });
  const soundState = useSyncExternalStore(subscribeSiren, sirenState);
  const knownRef = useRef(null);
  const [ringingKeys, setRingingKeys] = useState(() => new Set());

  // The push carries the whole alarm, in the same shape as the list. It used
  // to be treated only as a cue to download the list again, so the siren
  // waited on a second round trip - on a weak desktop link, about a minute
  // after the channel prompt (which reads the push directly) had already
  // shown. The alarm now goes straight into the shared list, which rings the
  // siren and puts it on the map at once; the refetch only reconciles.
  useEffect(() => {
    if (!enabled) return undefined;
    const apply = (event) => {
      let alert = null;
      try {
        alert = JSON.parse(event.data);
      } catch {
        // Malformed payload: the refetch below still picks the alarm up.
      }
      // Only once this session has its baseline: before that, writing to the
      // list would fold the new alarm into "already open" and it would never ring.
      if (alert?.alert_key && knownRef.current) {
        queryClient.setQueryData(["alarms", "operations"], (current) => {
          if (!current?.alerts) return current;
          const key = alarmKey(alert);
          const rest = current.alerts.filter((existing) => alarmKey(existing) !== key);
          // This list holds open alarms only, so a resolved one leaves it.
          const alerts = Number(alert.status) >= 2 ? rest : [alert, ...rest];
          return { ...current, alerts };
        });
      }
      queryClient.invalidateQueries({ queryKey: ["alarms"] });
    };
    return subscribeAlerts({
      onEvent: (_name, event) => apply(event),
      // Anything pushed while the stream was down is fetched on reconnect
      // rather than waiting for the next poll.
      onOpen: () => queryClient.invalidateQueries({ queryKey: ["alarms"] }),
    });
  }, [enabled, queryClient]);

  // Signed out (login, password change) there is nothing to ring for, and a
  // cached list from the last session must not keep the siren going.
  const cached = alertsQuery.data?.alerts;
  const alerts = useMemo(() => (enabled && cached) || [], [enabled, cached]);

  // Each sign-in starts a fresh "already open" baseline. The query cache can
  // still hold the previous session's list, so only a response fetched after
  // this session began is allowed to seed it.
  const sessionStartRef = useRef(0);
  useEffect(() => {
    knownRef.current = null;
    sessionStartRef.current = Date.now();
    setRingingKeys((current) => (current.size ? new Set() : current));
  }, [enabled]);

  useEffect(() => {
    // Seed from the first real response, not the empty pending one: alarms
    // already open when the console loads are on screen, and ringing for all
    // of them on every page load is what this guards against.
    if (!enabled || !alertsQuery.isSuccess) return;
    if (!knownRef.current && alertsQuery.dataUpdatedAt < sessionStartRef.current) return;
    const unanswered = alerts.filter(
      (alert) => Number(alert.status) === 0 && !alert.returned_at,
    );
    const unansweredKeys = new Set(unanswered.map(alarmKey));
    if (!knownRef.current) {
      knownRef.current = new Set(alerts.map(alarmKey));
      return;
    }
    const arrived = unanswered.filter((alert) => !knownRef.current.has(alarmKey(alert)));
    alerts.forEach((alert) => knownRef.current.add(alarmKey(alert)));
    if (arrived.length) notifyDesktop(arrived);
    setRingingKeys((current) => {
      const next = new Set([...current].filter((key) => unansweredKeys.has(key)));
      arrived.forEach((alert) => next.add(alarmKey(alert)));
      return next.size === current.size && [...next].every((key) => current.has(key)) ? current : next;
    });
  }, [alerts, alertsQuery.dataUpdatedAt, alertsQuery.isSuccess, enabled]);

  const ringing = useMemo(
    () => alerts.filter((alert) => ringingKeys.has(alarmKey(alert))),
    [alerts, ringingKeys],
  );

  const redCount = useMemo(() => ringing.filter((alert) => levelOf(alert) === "red").length, [ringing]);
  const amberCount = useMemo(() => ringing.filter((alert) => levelOf(alert) === "amber").length, [ringing]);
  const yellowCount = useMemo(() => ringing.filter((alert) => levelOf(alert) === "yellow").length, [ringing]);

  // One sound at a time, the loudest level ringing: the siren covers
  // everything while any red rings, then amber beeping, then the yellow burst.
  useEffect(() => {
    const loudest = redCount ? "red" : amberCount ? "amber" : yellowCount ? "yellow" : null;
    if (loudest === "red") void startSiren();
    else stopSiren();
    if (loudest === "amber") void startAmberAlarm();
    else stopAmberAlarm();
    if (loudest === "yellow") void startYellowAlarm();
    else stopYellowAlarm();
  }, [redCount, amberCount, yellowCount]);

  useEffect(
    () => () => {
      stopSiren();
      stopAmberAlarm();
      stopYellowAlarm();
    },
    [],
  );

  // A tab title is visible from another tab, another window and the taskbar,
  // and unlike a flashing title it needs no timer for a background tab to throttle.
  useEffect(() => {
    if (!ringing.length) return undefined;
    const original = window.document.title;
    window.document.title = `(${ringing.length}) ${redCount ? "ALARM" : "Alert"} - ${original}`;
    return () => {
      window.document.title = original;
    };
  }, [ringing.length, redCount]);

  // Any click or key press unlocks audio, so the first touch of the console
  // arms the siren without anyone having to find a particular button.
  useEffect(() => {
    if (soundState !== "blocked") return undefined;
    const unlock = () => void armSiren();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [soundState]);

  // Silence takes the alarms to quiet. Without a list it quiets only the
  // loudest level ringing, so muting amber beeping can never also mute a red
  // siren that came in a moment later: that one stays on until silenced itself.
  const silence = useCallback(
    (keys) => {
      const chosen = Array.isArray(keys)
        ? new Set(keys)
        : (() => {
            const top = Math.max(-1, ...ringing.map((alert) => LEVEL_RANK[levelOf(alert)]));
            return new Set(ringing.filter((alert) => LEVEL_RANK[levelOf(alert)] === top).map(alarmKey));
          })();
      setRingingKeys((current) => new Set([...current].filter((key) => !chosen.has(key))));
    },
    [ringing],
  );
  const value = useMemo(() => ({ ringing, silence, soundState }), [ringing, silence, soundState]);

  return <SosAlarmContext.Provider value={value}>{children}</SosAlarmContext.Provider>;
}

function notifyDesktop(arrived) {
  if (!("Notification" in window) || window.Notification.permission !== "granted") return;
  if (!window.document.hidden) return;
  arrived.forEach((alert) => {
    try {
      const notification = new window.Notification(levelOf(alert) === "red" ? "Alarm" : "Alert", {
        body: alarmLabel(alert),
        tag: alarmKey(alert),
        requireInteraction: true,
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch {
      // Some browsers only allow notifications from a service worker.
    }
  });
}

function enableAlerts() {
  void armSiren();
  if ("Notification" in window && window.Notification.permission === "default") {
    void window.Notification.requestPermission().catch(() => {});
  }
}

export function SosAlarmBanner() {
  const { ringing, silence, soundState } = useSosAlarm();
  const blocked = soundState === "blocked";

  if (!ringing.length) {
    if (!blocked) return null;
    return (
      <button
        type="button"
        onClick={enableAlerts}
        // The tracked-radio tiles start below anything marked like this.
        data-grid-avoid=""
        // One line at every width: the long sentence wrapped to three lines on
        // a phone and covered the page title.
        className="fixed left-1/2 top-[calc(var(--ops-chrome)+8px)] z-[1200] inline-flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-amber-400/50 bg-[#1a1408]/95 px-3 py-1.5 text-[11px] font-bold text-amber-300 shadow-lg backdrop-blur hover:bg-[#2a200c] active:bg-[#2a200c]"
      >
        <Volume2 size={13} className="shrink-0" />
        <span className="md:hidden">Alarm sound off · Tap to turn on</span>
        <span className="hidden md:inline">Alarm sound is off until this screen is clicked. Click to turn it on.</span>
      </button>
    );
  }

  // The loudest alarm leads the banner and decides its colour.
  const ordered = [...ringing].sort(byUrgency);
  return <RingingBanner blocked={blocked} ordered={ordered} silence={silence} />;
}

function LevelDot({ alert }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-black/30"
      style={{ background: LEVEL_STYLES[levelOf(alert)]?.dot }}
      title={LEVEL_STYLES[levelOf(alert)]?.label}
    />
  );
}

function sinceText(alert) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(alert.triggered_at).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

// The banner takes the colour of the loudest alarm in it.
const BANNER_LOOK = {
  red: { bar: "border-red-300 bg-red-700 text-white", blockedText: "text-red-700", answer: "bg-white text-red-700 hover:bg-white/90" },
  amber: { bar: "border-amber-300 bg-amber-500 text-black", blockedText: "text-amber-700", answer: "bg-black text-amber-300 hover:bg-black/85" },
  yellow: { bar: "border-yellow-200 bg-yellow-300 text-black", blockedText: "text-yellow-800", answer: "bg-black text-yellow-200 hover:bg-black/85" },
};

function RingingBanner({ blocked, ordered, silence }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const red = levelOf(ordered[0]) === "red";
  const topLevel = levelOf(ordered[0]);
  const atTop = ordered.filter((alert) => levelOf(alert) === topLevel).length;
  const shown = ordered.slice(0, 3);
  const more = ordered.length - shown.length;

  // Answering starts the response, which is what stops an alarm ringing. It
  // leaves the banner at once and comes back if the server refuses.
  const answer = useMutation({
    mutationFn: (alert) => startAlarmResponse({ alertKey: alert.alert_key }),
    onMutate: async (alert) => {
      await queryClient.cancelQueries({ queryKey: ["alarms", "operations"] });
      const previous = queryClient.getQueryData(["alarms", "operations"]);
      queryClient.setQueryData(["alarms", "operations"], (current) =>
        current?.alerts
          ? { ...current, alerts: current.alerts.map((item) => (alarmKey(item) === alarmKey(alert) ? { ...item, status: 1 } : item)) }
          : current,
      );
      return { previous };
    },
    onError: (_error, _alert, context) => {
      if (context?.previous) queryClient.setQueryData(["alarms", "operations"], context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["alarms"] }),
  });

  const edge = red ? "border-white/60 hover:bg-white/10 active:bg-white/20" : "border-black/40 hover:bg-black/10 active:bg-black/20";
  const bar = BANNER_LOOK[topLevel] || BANNER_LOOK.red;
  return (
    <div
      role="alert"
      data-grid-avoid=""
      className={`fixed inset-x-0 top-[var(--ops-chrome)] z-[1200] border-b-2 ${
        bar.bar
      }`}
    >
      <div className={`mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-2.5 ${red && !open ? "animate-pulse" : ""}`}>
        <Siren size={20} className="shrink-0" />
        <button
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-black"
          onClick={() => setOpen((value) => !value)}
          title={open ? "Hide the list" : "Show every alarm"}
          type="button"
        >
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {shown.map((alert) => (
              <span className="inline-flex min-w-0 items-center gap-1.5" key={alarmKey(alert)}>
                <LevelDot alert={alert} />
                <span className="truncate">{alarmLabel(alert)}</span>
              </span>
            ))}
            {more > 0 ? <span className="opacity-80">and {more} more</span> : null}
          </span>
          <ChevronDown size={16} className={`ml-auto shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {blocked ? (
          <button
            type="button"
            onClick={enableAlerts}
            className={`rounded border border-white/70 bg-white px-3 py-1.5 text-[11px] font-black ${bar.blockedText}`}
          >
            <Volume2 size={13} className="mr-1 inline" /> Sound is blocked - click to hear
          </button>
        ) : null}
        <Link to="/alarms" className={`rounded border px-3 py-1.5 text-[11px] font-bold ${edge}`}>
          Open alarms
        </Link>
        <button
          type="button"
          onClick={() => silence()}
          className={`inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-[11px] font-bold ${edge}`}
          title={atTop < ordered.length ? `Quiets the ${LEVEL_STYLES[topLevel].label.toLowerCase()} alarms only` : ""}
        >
          <BellOff size={13} /> Silence {atTop < ordered.length ? LEVEL_STYLES[topLevel].label.toLowerCase() : ""}
        </button>
      </div>

      {open ? (
        <ul className="mx-auto max-h-[50vh] max-w-5xl overflow-y-auto px-4 pb-3">
          {ordered.map((alert) => (
            <li
              className={`flex items-center gap-2.5 border-t py-2 text-[12px] ${red ? "border-white/15" : "border-black/15"}`}
              key={alarmKey(alert)}
            >
              <LevelDot alert={alert} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-bold">{alarmLabel(alert)}</span>
                <span className="block text-[10px] opacity-75">
                  {LEVEL_STYLES[levelOf(alert)]?.label} · {sinceText(alert)}
                </span>
              </span>
              <button
                type="button"
                className={`rounded border px-2.5 py-1 text-[11px] font-bold ${edge}`}
                onClick={() => silence([alarmKey(alert)])}
              >
                Silence
              </button>
              {alert.alert_key ? (
                <button
                  type="button"
                  disabled={answer.isPending && answer.variables && alarmKey(answer.variables) === alarmKey(alert)}
                  className={`rounded px-2.5 py-1 text-[11px] font-black disabled:opacity-60 ${bar.answer}`}
                  onClick={() => answer.mutate(alert)}
                >
                  Answer
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
