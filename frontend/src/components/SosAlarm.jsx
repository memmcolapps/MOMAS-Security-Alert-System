import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BellOff, Siren, Volume2 } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { alertsEventsUrl, listAlarms } from "../lib/api";
import { armSiren, sirenState, startSiren, stopSiren, subscribeSiren } from "../lib/sos-siren";

const SosAlarmContext = createContext({ ringing: [], silence: () => {}, soundState: "blocked" });

export function useSosAlarm() {
  return useContext(SosAlarmContext);
}

const alarmKey = (alert) => String(alert.alert_key || `pocstars:${alert.sos_msg_id}`);
const alarmLabel = (alert) => alert.asset_name || alert.dev_name || alert.device_name || `Device ${alert.device_id}`;

/**
 * Rings for alarms that arrive while the console is open, on every page.
 *
 * It used to live in the operations map, so an operator on the alarms or
 * devices screen heard nothing. An alarm rings until somebody starts a
 * response to it (status leaves 0) or silences it here; silencing covers the
 * alarms ringing now, never the next one.
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
    const source = new window.EventSource(alertsEventsUrl());
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
    source.addEventListener("alert_new", apply);
    source.addEventListener("alert_updated", apply);
    // Anything pushed while the stream was down is fetched on reconnect
    // rather than waiting for the next poll.
    source.addEventListener("open", () => queryClient.invalidateQueries({ queryKey: ["alarms"] }));
    return () => source.close();
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
    const unanswered = alerts.filter((alert) => Number(alert.status) === 0 && !alert.returned_at);
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

  useEffect(() => {
    if (!ringing.length) {
      stopSiren();
      return undefined;
    }
    void startSiren();
    return undefined;
  }, [ringing.length]);

  useEffect(() => () => stopSiren(), []);

  // A tab title is visible from another tab, another window and the taskbar,
  // and unlike a flashing title it needs no timer for a background tab to throttle.
  useEffect(() => {
    if (!ringing.length) return undefined;
    const original = window.document.title;
    window.document.title = `(${ringing.length}) SOS - ${original}`;
    return () => {
      window.document.title = original;
    };
  }, [ringing.length]);

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

  const silence = useCallback(() => setRingingKeys(new Set()), []);
  const value = useMemo(() => ({ ringing, silence, soundState }), [ringing, silence, soundState]);

  return <SosAlarmContext.Provider value={value}>{children}</SosAlarmContext.Provider>;
}

function notifyDesktop(arrived) {
  if (!("Notification" in window) || window.Notification.permission !== "granted") return;
  if (!window.document.hidden) return;
  arrived.forEach((alert) => {
    try {
      const notification = new window.Notification("SOS alarm", {
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
        className="fixed left-1/2 top-[calc(var(--ops-chrome)+8px)] z-[1200] inline-flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-400/50 bg-[#1a1408]/95 px-3 py-1.5 text-[11px] font-bold text-amber-300 hover:bg-[#2a200c]"
      >
        <Volume2 size={13} /> SOS siren is off until this screen is clicked - click to arm
      </button>
    );
  }

  const names = ringing.slice(0, 3).map(alarmLabel).join(", ");
  const more = ringing.length > 3 ? ` and ${ringing.length - 3} more` : "";
  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-[var(--ops-chrome)] z-[1200] animate-pulse border-b-2 border-red-300 bg-red-700 px-4 py-2.5 text-white"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
        <Siren size={20} className="shrink-0" />
        <p className="min-w-0 flex-1 text-sm font-black">
          SOS - {names}
          {more}
        </p>
        {blocked ? (
          <button
            type="button"
            onClick={enableAlerts}
            className="rounded border border-white/70 bg-white px-3 py-1.5 text-[11px] font-black text-red-700"
          >
            <Volume2 size={13} className="mr-1 inline" /> Sound is blocked - click to hear
          </button>
        ) : null}
        <Link
          to="/alarms"
          className="rounded border border-white/60 px-3 py-1.5 text-[11px] font-bold hover:bg-white/10"
        >
          Open alarms
        </Link>
        <button
          type="button"
          onClick={silence}
          className="inline-flex items-center gap-1.5 rounded border border-white/60 px-3 py-1.5 text-[11px] font-bold hover:bg-white/10"
        >
          <BellOff size={13} /> Silence
        </button>
      </div>
    </div>
  );
}
