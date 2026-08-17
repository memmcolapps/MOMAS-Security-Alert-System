import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Map as MapIcon,
  MapPin,
  Navigation,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Siren,
  Undo2,
  UserRoundCheck,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlarmMiniMap } from "../components/AlarmMiniMap";
import { useFollow } from "../lib/follow-session";
import {
  alertsEventsUrl,
  getAlarm,
  getMe,
  listAlarms,
  listRadioRecordings,
  radioRecordingAudioUrl,
  reopenAlarm,
  resolveAlarm,
  startAlarmResponse,
} from "../lib/api";
import { isPlatformStaff } from "../lib/platform-roles";

const FILTERS = [
  ["open", "Open"],
  ["new", "New"],
  ["in_progress", "In progress"],
  ["sync_failed", "Needs attention"],
  ["resolved", "Resolved"],
  ["all", "All"],
];

const SORTS = [
  ["newest", "Newest first"],
  ["longest", "Longest open"],
  ["oldest", "Oldest first"],
];

// The radio network is an integration detail. Everything here is phrased as
// what happened to the alarm, never as what happened to the vendor's server.
const EVENT_LABELS = {
  received: "Panic button pressed on radio",
  breach: "Asset left the geofence",
  returned: "Asset returned inside the geofence",
  response_requested: "Response requested",
  response_started: "Response started",
  response_started_upstream: "Response started on radio network",
  resolution_requested: "Resolution requested",
  resolved: "Alarm resolved",
  resolved_upstream: "Resolved on radio network",
  reopen_requested: "Reopen requested",
  reopened: "Alarm reopened",
  sync_failed: "Radio was not updated",
};

const LIFECYCLE = {
  0: { label: "New", className: "border-red-400/50 bg-red-500/10 text-red-300" },
  1: { label: "In progress", className: "border-amber-400/40 bg-amber-400/10 text-amber-300" },
  2: { label: "Resolved", className: "border-green-400/40 bg-green-400/10 text-green-300" },
};

const ALARM_KINDS = {
  geofence: { label: "Geofence", icon: MapPin, className: "text-sky-300" },
  radio: { label: "Radio SOS", icon: RadioTower, className: "text-red-300" },
};

/**
 * Lifecycle only. Whether the handset has caught up is a separate axis — mixing
 * the two used to hide "In progress" behind a transport error.
 */
function lifecycle(alert) {
  return LIFECYCLE[Number(alert?.status)] || LIFECYCLE[0];
}

function alarmKind(alert) {
  return alert?.source === "geofence" ? ALARM_KINDS.geofence : ALARM_KINDS.radio;
}

/** A platform reference the operator can quote, with no vendor identifier in it. */
function alarmReference(alert) {
  if (!alert) return "—";
  const prefix = alert.source === "geofence" ? "GEO" : "RAD";
  return `${prefix}-${String(alert.id ?? "").padStart(5, "0")}`;
}

const SYNC_CONSEQUENCES = {
  0: "The handset still shows this alarm as unanswered.",
  1: "The handset still shows this alarm as active.",
  2: "The handset still shows this alarm as closed.",
};

/**
 * Geofence alarms are raised and closed inside this platform, so only radio
 * alarms can fall out of step with the handset.
 */
function radioSync(alert) {
  if (!alert || alert.source === "geofence") return null;
  if (alert.sync_status === "syncing") {
    return { state: "syncing", label: "Updating radio", message: "Sending this update to the handset…" };
  }
  if (alert.sync_status === "failed") {
    return {
      state: "failed",
      label: "Radio not updated",
      message: alert.last_sync_error || "The radio network did not accept the last update.",
      // The alarm never advanced — only the push did — so the handset is still
      // showing whatever it showed before the operator acted.
      consequence: SYNC_CONSEQUENCES[Number(alert.status)] || SYNC_CONSEQUENCES[0],
    };
  }
  return null;
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateOnly(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const two = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

function recordingDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function elapsed(value, until = null, now = Date.now()) {
  if (!value) return "—";
  const milliseconds = Math.max(0, new Date(until || now).getTime() - new Date(value).getTime());
  const minutes = Math.floor(milliseconds / 60000);
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** An alarm nobody has closed gets louder the longer it sits. */
function ageTone(alert, now) {
  if (Number(alert.status) === 2) return "text-neutral-500";
  const minutes = (now - new Date(alert.triggered_at).getTime()) / 60000;
  if (minutes >= 60) return "text-red-300";
  if (minutes >= 20) return "text-amber-300";
  return "text-neutral-300";
}

function matchesFilter(alert, filter) {
  if (filter === "all") return true;
  if (filter === "open") return Number(alert.status) < 2;
  if (filter === "new") return Number(alert.status) === 0;
  if (filter === "in_progress") return Number(alert.status) === 1;
  if (filter === "resolved") return Number(alert.status) === 2;
  if (filter === "sync_failed") return alert.sync_status === "failed";
  return true;
}

function sortAlarms(alerts, sort, now) {
  const byTriggered = (alert) => new Date(alert.triggered_at).getTime();
  const openFor = (alert) => (alert.resolved_at ? new Date(alert.resolved_at).getTime() : now) - byTriggered(alert);
  const sorted = [...alerts];
  if (sort === "oldest") return sorted.sort((a, b) => byTriggered(a) - byTriggered(b));
  if (sort === "longest") return sorted.sort((a, b) => openFor(b) - openFor(a));
  return sorted.sort((a, b) => byTriggered(b) - byTriggered(a));
}

function displayName(alert) {
  return alert.asset_name || alert.dev_name || alert.device_name || `Device ${alert.device_id || alert.asset_id}`;
}

function coordinates(alert) {
  const lat = Number(alert?.location_lat);
  const lon = Number(alert?.location_lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/**
 * Keeps "elapsed" honest between the 12-second refetches. Ticks only while
 * something is still open, and at minute-display granularity rather than every
 * second — the list can carry hundreds of rows.
 */
function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function AlarmsRoute() {
  const queryClient = useQueryClient();
  const { follow } = useFollow();
  const [filter, setFilter] = useState("open");
  const [sort, setSort] = useState("newest");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [responseNote, setResponseNote] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const [reopening, setReopening] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [feedConnected, setFeedConnected] = useState(false);
  const rowRefs = useRef(new Map());
  const drawerRef = useRef(null);
  const closeButtonRef = useRef(null);

  const alarmsQuery = useQuery({
    queryKey: ["alarms", search, from, to],
    queryFn: () => listAlarms({ status: "all", search, from, to, limit: 500 }),
    refetchInterval: 12_000,
  });
  const detailQuery = useQuery({
    queryKey: ["alarm", selectedId],
    queryFn: () => getAlarm(selectedId),
    enabled: Boolean(selectedId),
  });
  // Operators get the consequence; administrators also get the raw upstream
  // code, because someone has to be able to diagnose the integration.
  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const isPlatformAdmin = isPlatformStaff(meQuery.data?.user);

  const alerts = useMemo(() => alarmsQuery.data?.alerts || [], [alarmsQuery.data?.alerts]);
  const hasOpenAlarms = useMemo(() => alerts.some((alert) => Number(alert.status) < 2), [alerts]);
  const now = useNow(hasOpenAlarms);
  const visibleAlerts = useMemo(
    () => sortAlarms(alerts.filter((alert) => matchesFilter(alert, filter)), sort, now),
    [alerts, filter, sort, now],
  );
  // Counted server-side over the whole matching population — a tally taken from
  // the capped page would undercount once the archive grows past the limit.
  const counts = alarmsQuery.data?.counts || {};
  const selected = detailQuery.data?.alert || alerts.find((alert) => String(alert.alert_key) === String(selectedId)) || null;
  const radioTrafficQuery = useQuery({
    queryKey: [
      "radio-recordings",
      selected?.device_id,
      selected?.pocstars_group_name,
      selected?.triggered_at,
      selected?.resolved_at,
    ],
    queryFn: () => listRadioRecordings({
      speakerUserId: selected.device_id,
      groupName: selected.pocstars_group_name || "",
      from: dateOnly(selected.triggered_at),
      to: dateOnly(selected.resolved_at || Date.now()),
      pageSize: 12,
    }),
    enabled: Boolean(selected && selected.source !== "geofence" && selected.device_id),
    refetchInterval: selected && Number(selected.status) < 2 ? 3_000 : false,
  });
  const sync = radioSync(selected);
  const radioDispatchReady = selected?.source === "geofence" || alarmsQuery.data?.actionsConfigured !== false;
  const isFiltered = Boolean(search || from || to);
  const busy = detailQuery.isFetching && !detailQuery.data;

  // Read through a ref so opening an alarm does not tear down and rebuild the
  // live feed — that reconnect made the status light flicker on every click.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => {
    const source = new window.EventSource(alertsEventsUrl());
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ["alarms"] });
      if (selectedIdRef.current) queryClient.invalidateQueries({ queryKey: ["alarm", selectedIdRef.current] });
    };
    source.onopen = () => setFeedConnected(true);
    source.onerror = () => setFeedConnected(false);
    source.addEventListener("alert_new", refresh);
    source.addEventListener("alert_updated", refresh);
    return () => {
      source.close();
      setFeedConnected(false);
    };
  }, [queryClient]);

  // Keyed to the selection alone: a background refetch must never clear a
  // half-typed note or wipe the confirmation the operator just earned.
  useEffect(() => {
    setResolutionNote(selected?.resolution_note || "");
    setResponseNote("");
    setReopenReason("");
    setReopening(false);
    setFeedback(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const closeDrawer = useCallback(() => setSelectedId(null), []);

  // Escape closes the drawer, and Tab stays inside it while it is open.
  const drawerOpen = Boolean(selected);
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const restoreTo = document.activeElement;
    closeButtonRef.current?.focus();

    const onWindowKeyDown = (event) => {
      if (event.key === "Escape") closeDrawer();
    };
    const onDrawerKeyDown = (event) => {
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = [
        ...drawerRef.current.querySelectorAll(
          'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const drawer = drawerRef.current;
    window.addEventListener("keydown", onWindowKeyDown);
    drawer?.addEventListener("keydown", onDrawerKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
      drawer?.removeEventListener("keydown", onDrawerKeyDown);
      if (restoreTo instanceof window.HTMLElement) restoreTo.focus();
    };
  }, [drawerOpen, selectedId, closeDrawer]);

  function onListKeyDown(event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const index = visibleAlerts.findIndex((alert) => rowRefs.current.get(alert.alert_key) === document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = visibleAlerts[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) rowRefs.current.get(next.alert_key)?.focus();
  }

  async function refreshAlarm(alertKey) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["alarms"] }),
      queryClient.invalidateQueries({ queryKey: ["alarm", alertKey] }),
      queryClient.invalidateQueries({ queryKey: ["sos-log"] }),
    ]);
  }

  /**
   * `error.message` is already the operator-facing sentence the API sent; raw
   * upstream text never reaches this screen.
   */
  function alarmMutation(mutationFn, successMessage, afterSuccess) {
    return {
      mutationFn,
      onSuccess: async (_, variables) => {
        setFeedback({ type: "success", message: successMessage });
        afterSuccess?.();
        await refreshAlarm(variables.alertKey);
      },
      onError: async (error) => {
        setFeedback({ type: "error", message: error.message });
        await refreshAlarm(selectedId);
      },
    };
  }

  const startMutation = useMutation(alarmMutation(startAlarmResponse, "Response started."));
  const resolveMutation = useMutation(alarmMutation(resolveAlarm, "Alarm resolved."));
  const reopenMutation = useMutation(
    alarmMutation(reopenAlarm, "Alarm reopened.", () => {
      setReopening(false);
      setReopenReason("");
    }),
  );

  const pending = startMutation.isPending || resolveMutation.isPending || reopenMutation.isPending;
  const actionsBlocked = !radioDispatchReady || pending || sync?.state === "syncing";

  function startResponse() {
    if (!selected) return;
    startMutation.mutate({ alertKey: selected.alert_key, note: responseNote.trim() });
  }

  function followAlarm() {
    if (!selected || !position) return;
    follow({
      lat: position.lat,
      lon: position.lon,
      label: displayName(selected),
      alertKey: selected.alert_key,
    });
    // Only open the response if it is still unacknowledged; following an alarm
    // someone else already took should not reopen or re-log it.
    if (Number(selected.status) === 0 && !actionsBlocked) startResponse();
  }

  // Navigating to an alarm already in progress does not touch its state, so it
  // is not held up by whatever blocks the lifecycle actions.
  const followDisabled = Number(selected?.status) === 0 && actionsBlocked;

  function submitResolution(event) {
    event.preventDefault();
    if (!selected) return;
    if (!resolutionNote.trim()) {
      setFeedback({ type: "error", message: "Record what was confirmed before closing the alarm." });
      return;
    }
    resolveMutation.mutate({ alertKey: selected.alert_key, note: resolutionNote.trim() });
  }

  function submitReopen(event) {
    event.preventDefault();
    if (!selected) return;
    if (!reopenReason.trim()) {
      setFeedback({ type: "error", message: "Record why this alarm is being reopened." });
      return;
    }
    reopenMutation.mutate({ alertKey: selected.alert_key, note: reopenReason.trim() });
  }

  /**
   * Re-attempts whichever update the handset refused. The alarm never advanced
   * — only the push failed — so the retry is the same action as before, which
   * the current status tells us.
   */
  function retrySync() {
    if (!selected) return;
    const status = Number(selected.status);
    if (status === 0) {
      startResponse();
      return;
    }
    if (status === 1) {
      if (!resolutionNote.trim()) {
        setFeedback({ type: "error", message: "Record the resolution outcome, then retry." });
        return;
      }
      resolveMutation.mutate({ alertKey: selected.alert_key, note: resolutionNote.trim() });
      return;
    }
    if (!reopenReason.trim()) {
      setReopening(true);
      setFeedback({ type: "error", message: "Record why this alarm is being reopened, then retry." });
      return;
    }
    reopenMutation.mutate({ alertKey: selected.alert_key, note: reopenReason.trim() });
  }

  const position = coordinates(selected);

  return (
    <main className="min-h-screen bg-ops-bg px-4 pb-10 pt-20 text-neutral-200 md:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-red-400">
            <Siren size={21} /> Alarm Operations
          </h1>
          <p className="mt-1 text-[11px] text-neutral-500">
            Radio SOS and geofence alarms are retained as an operational record.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-neutral-500">
          <span className={`h-2 w-2 rounded-full ${feedConnected ? "bg-green-400" : "bg-neutral-600"}`} />
          {alarmsQuery.isFetching ? "Refreshing…" : feedConnected ? "Live feed connected" : "Live feed reconnecting…"}
          <button className="rounded p-1.5 hover:bg-white/5 hover:text-neutral-200" onClick={() => alarmsQuery.refetch()} title="Refresh alarms">
            <RefreshCw size={13} className={alarmsQuery.isFetching ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      {alarmsQuery.data?.actionsConfigured === false ? (
        <section className="mb-5 flex items-start gap-3 rounded-lg border border-amber-400/30 bg-amber-400/[0.07] px-4 py-3 text-[11px] text-amber-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <strong>Radio dispatch is not configured.</strong>
            <p className="mt-0.5 text-amber-100/60">
              Radio alarms keep logging, but responding and resolving them stays disabled until an administrator finishes setup.
              Geofence alarms are unaffected.
            </p>
          </div>
        </section>
      ) : null}

      <section className="glass-panel mb-4 rounded-lg p-3">
        <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(240px,1fr)_150px_auto_150px]">
          <label className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-600" />
            <input className="field-input pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search device, operator, or group" />
          </label>
          <label className="w-full shrink-0 sm:w-[150px]">
            <span className="mb-1 block text-[8px] font-bold uppercase tracking-wide text-neutral-700 sm:hidden">From</span>
            <input className="field-input" type="date" value={from} onChange={(event) => setFrom(event.target.value)} aria-label="From date" />
          </label>
          <span className="text-[10px] text-neutral-600">to</span>
          <label className="w-full shrink-0 sm:w-[150px]">
            <span className="mb-1 block text-[8px] font-bold uppercase tracking-wide text-neutral-700 sm:hidden">To</span>
            <input className="field-input" type="date" value={to} onChange={(event) => setTo(event.target.value)} aria-label="To date" />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {FILTERS.map(([key, label]) => (
            <button
              className={`rounded-md border px-3 py-1.5 text-[10px] font-bold ${
                filter === key ? "border-red-400 bg-red-500/15 text-red-300" : "border-white/10 text-neutral-500 hover:text-neutral-200"
              }`}
              key={key}
              onClick={() => setFilter(key)}
            >
              {label} <span className="ml-1 text-[9px] opacity-60">{counts[key] ?? 0}</span>
            </button>
          ))}
          <label className="ml-auto flex items-center gap-2 text-[9px] font-bold uppercase tracking-wide text-neutral-600">
            Sort
            <select className="field-input w-[130px] py-1 text-[10px]" value={sort} onChange={(event) => setSort(event.target.value)}>
              {SORTS.map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="glass-panel overflow-hidden rounded-lg">
        <div className="hidden grid-cols-[minmax(190px,1.4fr)_120px_minmax(120px,0.8fr)_130px_130px_100px_24px] gap-3 border-b border-white/10 px-4 py-2 text-[9px] font-bold uppercase tracking-wider text-neutral-600 md:grid">
          <span>Alarm</span>
          <span>Type</span>
          <span>Assignment</span>
          <span>Status</span>
          <span>Raised</span>
          <span>Elapsed</span>
          <span />
        </div>
        {alarmsQuery.isLoading ? (
          <div className="flex h-52 items-center justify-center gap-2 text-xs text-neutral-500">
            <RefreshCw size={15} className="animate-spin" /> Loading alarms…
          </div>
        ) : visibleAlerts.length ? (
          // Arrow keys walk the rows; each row stays a real button so Enter and
          // Space keep working and screen readers still announce it as one.
          <div onKeyDown={onListKeyDown}>
            {visibleAlerts.map((alert) => {
              const state = lifecycle(alert);
              const rowSync = radioSync(alert);
              return (
                <button
                  className={`grid w-full gap-3 border-b border-white/5 px-4 py-3 text-left hover:bg-white/[0.035] focus:bg-white/[0.06] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-red-400/60 md:grid-cols-[minmax(190px,1.4fr)_120px_minmax(120px,0.8fr)_130px_130px_100px_24px] md:items-center ${
                    String(selectedId) === String(alert.alert_key) ? "bg-white/[0.05]" : ""
                  }`}
                  key={alert.alert_key}
                  ref={(node) => {
                    if (node) rowRefs.current.set(alert.alert_key, node);
                    else rowRefs.current.delete(alert.alert_key);
                  }}
                  onClick={() => setSelectedId(alert.alert_key)}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-bold text-neutral-200">{displayName(alert)}</span>
                    <span className="mt-0.5 block truncate font-mono text-[9px] text-neutral-600">
                      {alarmReference(alert)} · {alert.device_id}
                    </span>
                  </span>
                  <KindTag alert={alert} />
                  <span className="min-w-0 text-[10px] text-neutral-500">
                    <span className="block truncate">{alert.unit_name || alert.pocstars_group_name || alert.organization_name || "Unassigned"}</span>
                    {alert.organization_name && alert.unit_name ? <span className="block truncate text-[9px] text-neutral-700">{alert.organization_name}</span> : null}
                  </span>
                  <span>
                    <span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-bold ${state.className}`}>{state.label}</span>
                    {rowSync ? (
                      <span className={`mt-1 flex items-center gap-1 text-[8px] font-bold ${rowSync.state === "failed" ? "text-amber-300" : "text-blue-300"}`}>
                        <AlertTriangle size={9} /> {rowSync.label}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-[10px] text-neutral-500">{formatDateTime(alert.triggered_at)}</span>
                  <span className={`text-[10px] font-bold ${ageTone(alert, now)}`}>{elapsed(alert.triggered_at, alert.resolved_at, now)}</span>
                  <ChevronRight size={14} className="hidden text-neutral-700 md:block" />
                </button>
              );
            })}
          </div>
        ) : filter === "open" && !isFiltered ? (
          <div className="flex h-52 flex-col items-center justify-center text-center text-xs text-green-300/80">
            <ShieldCheck size={28} className="mb-2 text-green-400/60" />
            All clear
            <span className="mt-1 text-[10px] text-neutral-600">No alarms are currently open.</span>
          </div>
        ) : (
          <div className="flex h-52 flex-col items-center justify-center text-center text-xs text-neutral-600">
            <ShieldCheck size={28} className="mb-2 text-neutral-700" />
            No alarms match this view.
          </div>
        )}
      </section>

      {selected ? (
        <div className="fixed inset-0 z-[1200] flex justify-end bg-black/55" onMouseDown={(event) => event.target === event.currentTarget && closeDrawer()}>
          <aside
            ref={drawerRef}
            aria-label={`Alarm ${alarmReference(selected)}`}
            aria-modal="true"
            className="h-full w-full max-w-lg overflow-y-auto border-l border-red-500/30 bg-[#080808] p-5 shadow-2xl"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-bold ${lifecycle(selected).className}`}>{lifecycle(selected).label}</span>
                  <KindTag alert={selected} size={11} />
                  <span className="font-mono text-[9px] text-neutral-700">{alarmReference(selected)}</span>
                </div>
                <h2 className="text-lg font-bold text-neutral-100">{displayName(selected)}</h2>
                <p className="mt-1 text-[10px] text-neutral-500">
                  {formatDateTime(selected.triggered_at)} · {elapsed(selected.triggered_at, selected.resolved_at, now)}
                </p>
              </div>
              <button
                ref={closeButtonRef}
                className="rounded p-1 text-neutral-500 hover:bg-white/5 hover:text-neutral-100"
                onClick={closeDrawer}
                aria-label="Close alarm details"
              >
                <X size={18} />
              </button>
            </div>

            {feedback ? (
              <div
                className={`mt-4 rounded-md border px-3 py-2 text-[10px] ${feedback.type === "error" ? "border-red-400/40 bg-red-500/10 text-red-200" : "border-green-400/30 bg-green-400/10 text-green-200"}`}
                role="status"
              >
                {feedback.message}
              </div>
            ) : null}

            {sync ? (
              <div
                className={`mt-4 rounded-md border px-3 py-2 text-[10px] ${
                  sync.state === "failed" ? "border-amber-400/40 bg-amber-400/[0.08] text-amber-200" : "border-blue-400/30 bg-blue-400/[0.08] text-blue-200"
                }`}
              >
                <strong className="flex items-center gap-1.5">
                  {sync.state === "failed" ? <AlertTriangle size={12} /> : <RefreshCw size={12} className="animate-spin" />}
                  {sync.label}
                </strong>
                <p className="mt-1 opacity-70">{sync.message}</p>
                {sync.consequence ? <p className="mt-1 opacity-70">{sync.consequence}</p> : null}
                {sync.state === "failed" ? (
                  <button
                    className="mt-2 inline-flex items-center gap-1.5 rounded border border-amber-400/40 px-2.5 py-1.5 text-[10px] font-bold text-amber-200 hover:bg-amber-400/10 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={actionsBlocked}
                    onClick={retrySync}
                  >
                    <RotateCcw size={11} /> Retry radio update
                  </button>
                ) : null}
              </div>
            ) : null}

            <section className="mt-5 grid grid-cols-2 gap-2">
              <Detail label="Device" value={selected.device_id} />
              <Detail label={selected.source === "geofence" ? "Fence" : "Operator"} value={selected.geofence_name || selected.dev_operator || selected.device_name} />
              <Detail label="Organization" value={selected.organization_name || "Unassigned"} />
              <Detail label="Unit / group" value={selected.unit_name || selected.pocstars_group_name || "—"} />
              <Detail label="Started by" value={selected.acknowledged_by_name || selected.acknowledged_by_email || "—"} />
              <Detail label="Resolved by" value={selected.resolved_by_name || selected.resolved_by_email || "—"} />
            </section>

            <section className="mt-3 rounded-lg border border-white/10 bg-white/[0.025] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-[10px] font-bold text-neutral-400"><MapPin size={13} /> Alarm location</span>
                {/* The map carries open alarms only, so a resolved one has nothing to focus. */}
                {position && Number(selected.status) < 2 ? (
                  <Link
                    className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[9px] font-bold text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
                    search={{ focus: selected.alert_key }}
                    to="/"
                  >
                    <MapIcon size={10} /> Show on operations map
                  </Link>
                ) : null}
              </div>
              {position ? (
                <>
                  <div className="mt-2">
                    <AlarmMiniMap
                      accent={selected.source === "geofence" ? "#38bdf8" : "#ff4444"}
                      label={displayName(selected)}
                      lat={position.lat}
                      lon={position.lon}
                    />
                  </div>
                  <p className="mt-2 font-mono text-[10px] text-neutral-500">
                    {position.lat.toFixed(6)}, {position.lon.toFixed(6)}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-[11px] text-neutral-500">
                  No location was reported with this alarm. Confirm the position by voice before dispatching.
                </p>
              )}
            </section>

            {selected.source !== "geofence" ? (
              <section className="mt-3 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.025] p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h3 className="flex items-center gap-2 text-[10px] font-bold text-emerald-200">
                      <Volume2 size={13} /> Radio traffic
                    </h3>
                    <p className="mt-1 text-[9px] text-neutral-600">
                      New clips appear after the handset releases push-to-talk.
                    </p>
                  </div>
                  <button
                    aria-label="Refresh radio traffic"
                    className="rounded p-1.5 text-neutral-600 hover:bg-white/5 hover:text-neutral-200"
                    onClick={() => radioTrafficQuery.refetch()}
                    type="button"
                  >
                    <RefreshCw size={12} className={radioTrafficQuery.isFetching ? "animate-spin" : ""} />
                  </button>
                </div>

                {radioTrafficQuery.isLoading ? (
                  <p className="mt-3 text-[10px] text-neutral-600">Checking for radio traffic…</p>
                ) : radioTrafficQuery.isError ? (
                  <p className="mt-3 text-[10px] text-amber-300/80">{radioTrafficQuery.error.message}</p>
                ) : radioTrafficQuery.data?.recordings?.length ? (
                  <div className="mt-3 space-y-2">
                    {radioTrafficQuery.data.recordings.map((recording) => (
                      <div className="rounded-md border border-white/10 bg-black/20 p-2.5" key={recording.id}>
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-[10px] font-bold text-neutral-300">
                              {recording.speakerName || `Radio ${recording.speakerUserId}`}
                            </p>
                            <p className="mt-0.5 truncate text-[9px] text-neutral-600">
                              {recording.groupName || selected.pocstars_group_name || "Radio call"} · {formatDateTime(recording.startedAt)}
                            </p>
                          </div>
                          <span className="shrink-0 font-mono text-[9px] text-neutral-600">
                            {recordingDuration(recording.durationMs)}
                          </span>
                        </div>
                        <audio
                          aria-label={`Radio transmission from ${recording.speakerName || recording.speakerUserId}`}
                          className="h-8 w-full"
                          controls
                          preload="none"
                          src={radioRecordingAudioUrl(recording.playbackToken)}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-[10px] text-neutral-600">No recorded transmission was found for this alarm.</p>
                )}
              </section>
            ) : null}

            {Number(selected.status) === 0 ? (
              <section className="mt-5 rounded-lg border border-amber-400/20 bg-amber-400/[0.035] p-4">
                <label className="text-[10px] font-bold uppercase tracking-wide text-neutral-500" htmlFor="response-note">
                  Who is responding? <span className="font-normal normal-case tracking-normal text-neutral-600">(optional)</span>
                </label>
                <textarea
                  id="response-note"
                  className="field-input mt-2 min-h-16 resize-y"
                  value={responseNote}
                  onChange={(event) => setResponseNote(event.target.value)}
                  placeholder="Unit, patrol, or contact being sent"
                />
                <button
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md bg-amber-400 px-4 py-2.5 text-xs font-bold text-black disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={actionsBlocked}
                  onClick={startResponse}
                >
                  {startMutation.isPending ? <RefreshCw size={14} className="animate-spin" /> : <UserRoundCheck size={14} />}
                  Start response
                </button>
              </section>
            ) : null}

            {/* Available while the alarm is open, not only before someone takes
                it: a unit sent as backup, or one that acknowledged first and
                then wanted navigation, needs this just as much. Opening the
                response is the part that stays conditional. */}
            {position && Number(selected.status) < 2 ? (
              <button
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md border border-ops-red/50 px-4 py-2.5 text-xs font-bold text-ops-red hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={followDisabled}
                onClick={followAlarm}
              >
                <Navigation size={14} />
                {Number(selected.status) === 0 ? "Follow — I am responding" : "Follow this alarm"}
              </button>
            ) : null}

            {Number(selected.status) === 1 ? (
              <form className="mt-5 rounded-lg border border-green-400/20 bg-green-400/[0.035] p-4" onSubmit={submitResolution}>
                <label className="text-[10px] font-bold uppercase tracking-wide text-neutral-500" htmlFor="resolution-note">Resolution outcome</label>
                <textarea
                  id="resolution-note"
                  className="field-input mt-2 min-h-24 resize-y"
                  value={resolutionNote}
                  onChange={(event) => setResolutionNote(event.target.value)}
                  placeholder="What was confirmed and how was the alarm resolved?"
                />
                <button
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md bg-green-400 px-4 py-2.5 text-xs font-bold text-black disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={actionsBlocked}
                  type="submit"
                >
                  {resolveMutation.isPending ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  Resolve alarm
                </button>
              </form>
            ) : null}

            {Number(selected.status) === 2 ? (
              <section className="mt-5 rounded-lg border border-green-400/20 bg-green-400/[0.035] p-4">
                <h3 className="text-[10px] font-bold uppercase tracking-wide text-green-300">Resolution outcome</h3>
                <p className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-300">
                  {selected.resolution_note || "No outcome was recorded."}
                </p>
                {reopening ? (
                  <form className="mt-3 border-t border-white/10 pt-3" onSubmit={submitReopen}>
                    <label className="text-[10px] font-bold uppercase tracking-wide text-neutral-500" htmlFor="reopen-reason">Why is this being reopened?</label>
                    <textarea
                      id="reopen-reason"
                      className="field-input mt-2 min-h-16 resize-y"
                      value={reopenReason}
                      onChange={(event) => setReopenReason(event.target.value)}
                      placeholder="Closed in error, situation continued, new information…"
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        className="inline-flex flex-1 items-center justify-center gap-2 rounded-md border border-amber-400/40 px-3 py-2 text-[11px] font-bold text-amber-200 hover:bg-amber-400/10 disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={actionsBlocked}
                        type="submit"
                      >
                        {reopenMutation.isPending ? <RefreshCw size={12} className="animate-spin" /> : <Undo2 size={12} />}
                        Reopen alarm
                      </button>
                      <button className="rounded-md border border-white/10 px-3 py-2 text-[11px] text-neutral-400 hover:text-neutral-100" onClick={() => setReopening(false)} type="button">
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    className="mt-3 inline-flex items-center gap-1.5 text-[10px] font-bold text-neutral-500 hover:text-amber-200"
                    onClick={() => setReopening(true)}
                    type="button"
                  >
                    <Undo2 size={11} /> Reopen this alarm
                  </button>
                )}
              </section>
            ) : null}

            <section className="mt-6">
              <h3 className="mb-3 flex items-center gap-2 text-[11px] font-bold text-neutral-300"><Clock3 size={13} /> Activity</h3>
              {busy ? (
                <p className="text-[10px] text-neutral-600">Loading activity…</p>
              ) : (
                <div className="space-y-0">
                  {(detailQuery.data?.events || []).map((event, index, events) => (
                    <div className="relative flex gap-3 pb-4" key={event.id}>
                      {index < events.length - 1 ? <span className="absolute left-[5px] top-3 h-full w-px bg-white/10" /> : null}
                      <span className={`relative mt-1 h-[11px] w-[11px] shrink-0 rounded-full border ${event.event_type === "sync_failed" ? "border-amber-400 bg-amber-500/30" : "border-green-400/50 bg-green-500/20"}`} />
                      <div>
                        <p className="text-[10px] font-bold text-neutral-300">{EVENT_LABELS[event.event_type] || event.event_type}</p>
                        <p className="mt-0.5 text-[9px] text-neutral-600">{formatDateTime(event.created_at)}{event.actor_name || event.actor_email ? ` · ${event.actor_name || event.actor_email}` : ""}</p>
                        {event.note ? <p className="mt-1 text-[10px] text-neutral-500">{event.note}</p> : null}
                        {event.event_type === "sync_failed" && event.metadata?.error ? (
                          <p className="mt-1 text-[10px] text-amber-300/70">{event.metadata.error}</p>
                        ) : null}
                        {isPlatformAdmin && event.metadata?.detail ? (
                          <p className="mt-1 break-all font-mono text-[9px] text-neutral-600">{event.metadata.detail}</p>
                        ) : null}
                        {event.event_type === "reopened" && event.metadata?.discarded_resolution_note ? (
                          <p className="mt-1 text-[10px] text-neutral-600">
                            Previous outcome: {event.metadata.discarded_resolution_note}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </aside>
        </div>
      ) : null}
    </main>
  );
}

/** What raised the alarm — the operator's real question, in place of a vendor name. */
function KindTag({ alert, size = 12 }) {
  const kind = alarmKind(alert);
  const Icon = kind.icon;
  return (
    <span className={`flex items-center gap-1.5 text-[10px] font-bold ${kind.className}`}>
      <Icon size={size} /> {kind.label}
    </span>
  );
}

function Detail({ label, value }) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.025] px-3 py-2">
      <div className="text-[8px] font-bold uppercase tracking-wide text-neutral-700">{label}</div>
      <div className="mt-1 truncate text-[10px] text-neutral-300">{value || "—"}</div>
    </div>
  );
}
