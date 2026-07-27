import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  MapPin,
  RefreshCw,
  Search,
  ShieldCheck,
  Siren,
  UserRoundCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getAlarm, listAlarms, resolveAlarm, startAlarmResponse } from "../lib/api";

const FILTERS = [
  ["open", "Open"],
  ["new", "New"],
  ["in_progress", "In progress"],
  ["sync_failed", "Sync failed"],
  ["resolved", "Resolved"],
  ["all", "All"],
];

const EVENT_LABELS = {
  received: "Alarm received from POCSTARS",
  response_requested: "Response requested",
  response_started: "Response started on POCSTARS",
  resolution_requested: "Resolution requested",
  resolved: "Alarm resolved on POCSTARS",
  sync_failed: "POCSTARS synchronization failed",
};

function alarmStatus(alert) {
  if (alert.sync_status === "syncing") return { label: "Synchronizing", className: "border-blue-400/40 bg-blue-400/10 text-blue-300" };
  if (alert.sync_status === "failed") return { label: "Sync failed", className: "border-red-400/50 bg-red-500/10 text-red-300" };
  if (Number(alert.status) === 2) return { label: "Resolved", className: "border-green-400/40 bg-green-400/10 text-green-300" };
  if (Number(alert.status) === 1) return { label: "In progress", className: "border-amber-400/40 bg-amber-400/10 text-amber-300" };
  return { label: "New", className: "border-red-400/50 bg-red-500/10 text-red-300" };
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

function elapsed(value, until = null) {
  if (!value) return "—";
  const milliseconds = Math.max(0, new Date(until || Date.now()).getTime() - new Date(value).getTime());
  const minutes = Math.floor(milliseconds / 60000);
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
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

function displayName(alert) {
  return alert.dev_name || alert.device_name || `Device ${alert.device_id}`;
}

export function AlarmsRoute() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("open");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [feedback, setFeedback] = useState(null);

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

  const alerts = useMemo(() => alarmsQuery.data?.alerts || [], [alarmsQuery.data?.alerts]);
  const visibleAlerts = useMemo(() => alerts.filter((alert) => matchesFilter(alert, filter)), [alerts, filter]);
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map(([key]) => [key, alerts.filter((alert) => matchesFilter(alert, key)).length])),
    [alerts],
  );
  const selected = detailQuery.data?.alert || alerts.find((alert) => String(alert.sos_msg_id) === String(selectedId)) || null;
  const actionsConfigured = alarmsQuery.data?.actionsConfigured !== false;

  useEffect(() => {
    setResolutionNote(selected?.resolution_note || "");
    setFeedback(null);
  }, [selectedId, selected?.resolution_note]);

  async function refreshAlarm(sosMsgId) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["alarms"] }),
      queryClient.invalidateQueries({ queryKey: ["alarm", sosMsgId] }),
      queryClient.invalidateQueries({ queryKey: ["sos-log"] }),
    ]);
  }

  const startMutation = useMutation({
    mutationFn: startAlarmResponse,
    onSuccess: async (_, sosMsgId) => {
      setFeedback({ type: "success", message: "Response started and synchronized with POCSTARS." });
      await refreshAlarm(sosMsgId);
    },
    onError: async (error) => {
      setFeedback({ type: "error", message: error.body?.message || error.message });
      await refreshAlarm(selectedId);
    },
  });

  const resolveMutation = useMutation({
    mutationFn: resolveAlarm,
    onSuccess: async (_, variables) => {
      setFeedback({ type: "success", message: "Alarm resolved on POCSTARS and MOMAS." });
      await refreshAlarm(variables.sosMsgId);
    },
    onError: async (error) => {
      setFeedback({ type: "error", message: error.body?.message || error.message });
      await refreshAlarm(selectedId);
    },
  });

  function submitResolution(event) {
    event.preventDefault();
    if (!selected) return;
    if (!resolutionNote.trim()) {
      setFeedback({ type: "error", message: "Add a short resolution outcome before closing the alarm." });
      return;
    }
    resolveMutation.mutate({ sosMsgId: selected.sos_msg_id, resolution_note: resolutionNote.trim() });
  }

  return (
    <main className="min-h-screen bg-ops-bg px-4 pb-10 pt-20 text-neutral-200 md:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-red-400">
            <Siren size={21} /> Alarm Operations
          </h1>
          <p className="mt-1 text-[11px] text-neutral-500">
            POCSTARS alarms are logged automatically and retained as an operational record.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-neutral-500">
          <span className={`h-2 w-2 rounded-full ${alarmsQuery.data?.pocstarsLastErr ? "bg-red-400" : "bg-green-400"}`} />
          {alarmsQuery.isFetching ? "Refreshing…" : alarmsQuery.data?.pocstarsLastErr ? "POCSTARS feed degraded" : "POCSTARS feed connected"}
          <button className="rounded p-1.5 hover:bg-white/5 hover:text-neutral-200" onClick={() => alarmsQuery.refetch()} title="Refresh alarms">
            <RefreshCw size={13} className={alarmsQuery.isFetching ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      {!actionsConfigured ? (
        <section className="mb-5 flex items-start gap-3 rounded-lg border border-amber-400/30 bg-amber-400/[0.07] px-4 py-3 text-[11px] text-amber-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <strong>POCSTARS dispatcher UID not configured.</strong>
            <p className="mt-0.5 text-amber-100/60">Alarms will continue to log, but response and resolution actions remain disabled until a dispatcher UID is configured.</p>
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
        <div className="mt-3 flex flex-wrap gap-1.5">
          {FILTERS.map(([key, label]) => (
            <button
              className={`rounded-md border px-3 py-1.5 text-[10px] font-bold ${
                filter === key ? "border-red-400 bg-red-500/15 text-red-300" : "border-white/10 text-neutral-500 hover:text-neutral-200"
              }`}
              key={key}
              onClick={() => setFilter(key)}
            >
              {label} <span className="ml-1 text-[9px] opacity-60">{counts[key] || 0}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="glass-panel overflow-hidden rounded-lg">
        <div className="hidden grid-cols-[minmax(210px,1.4fr)_minmax(130px,0.8fr)_120px_130px_110px_24px] gap-3 border-b border-white/10 px-4 py-2 text-[9px] font-bold uppercase tracking-wider text-neutral-600 md:grid">
          <span>Source</span>
          <span>Scope</span>
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
          visibleAlerts.map((alert) => {
            const state = alarmStatus(alert);
            return (
              <button
                className={`grid w-full gap-3 border-b border-white/5 px-4 py-3 text-left hover:bg-white/[0.035] md:grid-cols-[minmax(210px,1.4fr)_minmax(130px,0.8fr)_120px_130px_110px_24px] md:items-center ${
                  String(selectedId) === String(alert.sos_msg_id) ? "bg-white/[0.05]" : ""
                }`}
                key={alert.sos_msg_id}
                onClick={() => setSelectedId(alert.sos_msg_id)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-bold text-neutral-200">{displayName(alert)}</span>
                  <span className="mt-0.5 block truncate font-mono text-[9px] text-neutral-600">#{alert.sos_msg_id} · {alert.device_id}</span>
                </span>
                <span className="min-w-0 text-[10px] text-neutral-500">
                  <span className="block truncate">{alert.unit_name || alert.pocstars_group_name || alert.organization_name || "Unassigned"}</span>
                  {alert.organization_name && alert.unit_name ? <span className="block truncate text-[9px] text-neutral-700">{alert.organization_name}</span> : null}
                </span>
                <span><span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-bold ${state.className}`}>{state.label}</span></span>
                <span className="text-[10px] text-neutral-500">{formatDateTime(alert.triggered_at)}</span>
                <span className="text-[10px] font-bold text-neutral-400">{elapsed(alert.triggered_at, alert.resolved_at)}</span>
                <ChevronRight size={14} className="hidden text-neutral-700 md:block" />
              </button>
            );
          })
        ) : (
          <div className="flex h-52 flex-col items-center justify-center text-center text-xs text-neutral-600">
            <ShieldCheck size={28} className="mb-2 text-neutral-700" />
            No alarms match this view.
          </div>
        )}
      </section>

      {selected ? (
        <div className="fixed inset-0 z-[1200] flex justify-end bg-black/55" onMouseDown={(event) => event.target === event.currentTarget && setSelectedId(null)}>
          <aside className="h-full w-full max-w-lg overflow-y-auto border-l border-red-500/30 bg-[#080808] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-bold ${alarmStatus(selected).className}`}>{alarmStatus(selected).label}</span>
                  <span className="font-mono text-[9px] text-neutral-700">SOS #{selected.sos_msg_id}</span>
                </div>
                <h2 className="text-lg font-bold text-neutral-100">{displayName(selected)}</h2>
                <p className="mt-1 text-[10px] text-neutral-500">{formatDateTime(selected.triggered_at)} · {elapsed(selected.triggered_at, selected.resolved_at)}</p>
              </div>
              <button className="rounded p-1 text-neutral-500 hover:bg-white/5 hover:text-neutral-100" onClick={() => setSelectedId(null)}>
                <X size={18} />
              </button>
            </div>

            {feedback ? (
              <div className={`mt-4 rounded-md border px-3 py-2 text-[10px] ${feedback.type === "error" ? "border-red-400/40 bg-red-500/10 text-red-200" : "border-green-400/30 bg-green-400/10 text-green-200"}`}>
                {feedback.message}
              </div>
            ) : null}

            {selected.last_sync_error ? (
              <div className="mt-4 rounded-md border border-red-400/30 bg-red-500/[0.08] px-3 py-2 text-[10px] text-red-200">
                <strong>Last synchronization error</strong>
                <p className="mt-1 text-red-100/60">{selected.last_sync_error}</p>
              </div>
            ) : null}

            <section className="mt-5 grid grid-cols-2 gap-2">
              <Detail label="Device" value={selected.device_id} />
              <Detail label="Operator" value={selected.dev_operator || selected.device_name} />
              <Detail label="Organization" value={selected.organization_name || "Unassigned"} />
              <Detail label="Unit / group" value={selected.unit_name || selected.pocstars_group_name || "—"} />
              <Detail label="Started by" value={selected.acknowledged_by_name || selected.acknowledged_by_email || "—"} />
              <Detail label="Resolved by" value={selected.resolved_by_name || selected.resolved_by_email || "—"} />
            </section>

            <section className="mt-3 rounded-lg border border-white/10 bg-white/[0.025] p-3">
              <div className="flex items-center gap-2 text-[10px] font-bold text-neutral-400"><MapPin size={13} /> Alarm location</div>
              <p className="mt-2 font-mono text-[11px] text-neutral-300">
                {Number.isFinite(Number(selected.location_lat)) && Number.isFinite(Number(selected.location_lon))
                  ? `${Number(selected.location_lat).toFixed(6)}, ${Number(selected.location_lon).toFixed(6)}`
                  : "Location was not supplied"}
              </p>
            </section>

            {Number(selected.status) === 0 ? (
              <button
                className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-md bg-amber-400 px-4 py-2.5 text-xs font-bold text-black disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!actionsConfigured || startMutation.isPending || selected.sync_status === "syncing"}
                onClick={() => startMutation.mutate(selected.sos_msg_id)}
              >
                {startMutation.isPending ? <RefreshCw size={14} className="animate-spin" /> : <UserRoundCheck size={14} />}
                Start response
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
                  disabled={!actionsConfigured || resolveMutation.isPending || selected.sync_status === "syncing"}
                  type="submit"
                >
                  {resolveMutation.isPending ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  Resolve on POCSTARS
                </button>
              </form>
            ) : null}

            {Number(selected.status) === 2 && selected.resolution_note ? (
              <section className="mt-5 rounded-lg border border-green-400/20 bg-green-400/[0.035] p-4">
                <h3 className="text-[10px] font-bold uppercase tracking-wide text-green-300">Resolution outcome</h3>
                <p className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-300">{selected.resolution_note}</p>
              </section>
            ) : null}

            <section className="mt-6">
              <h3 className="mb-3 flex items-center gap-2 text-[11px] font-bold text-neutral-300"><Clock3 size={13} /> Activity</h3>
              <div className="space-y-0">
                {(detailQuery.data?.events || []).map((event, index, events) => (
                  <div className="relative flex gap-3 pb-4" key={event.id}>
                    {index < events.length - 1 ? <span className="absolute left-[5px] top-3 h-full w-px bg-white/10" /> : null}
                    <span className={`relative mt-1 h-[11px] w-[11px] shrink-0 rounded-full border ${event.event_type === "sync_failed" ? "border-red-400 bg-red-500/30" : "border-green-400/50 bg-green-500/20"}`} />
                    <div>
                      <p className="text-[10px] font-bold text-neutral-300">{EVENT_LABELS[event.event_type] || event.event_type}</p>
                      <p className="mt-0.5 text-[9px] text-neutral-600">{formatDateTime(event.created_at)}{event.actor_name || event.actor_email ? ` · ${event.actor_name || event.actor_email}` : ""}</p>
                      {event.note ? <p className="mt-1 text-[10px] text-neutral-500">{event.note}</p> : null}
                      {event.event_type === "sync_failed" && event.metadata?.error ? <p className="mt-1 text-[10px] text-red-300/70">{event.metadata.error}</p> : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>
      ) : null}
    </main>
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
