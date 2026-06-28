import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Bell, CheckCircle2, Database, Download, ExternalLink, FileSearch, GitBranch, Link2, Network, Plus, RefreshCw, Search, ShieldCheck, Tags, Trash2, XCircle, Zap } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import {
  deleteOsintSource,
  deleteOsintWatchlist,
  evaluateOsintAlerts,
  extractOsintItem,
  getOsintItem,
  linkOsintItem,
  listOsintAlerts,
  listOsintEntities,
  listOsintItems,
  listOsintSources,
  listOsintWatchlists,
  osintEventsUrl,
  getOsintSourceAnalytics,
  getOsintBrief,
  getOsintGraph,
  promoteOsintItem,
  reviewOsintItem,
  saveOsintSource,
  saveOsintWatchlist,
  updateOsintAlertStatus,
} from "../lib/api";

const statuses = [
  { value: "pending", label: "Pending" },
  { value: "needs_review", label: "Needs review" },
  { value: "linked", label: "Linked" },
  { value: "incident", label: "Incident" },
  { value: "merged", label: "Merged" },
  { value: "dismissed", label: "Dismissed" },
  { value: "non_incident", label: "Non-incident" },
  { value: "all", label: "All" },
];

const statusStyles = {
  pending: "border-yellow-500/30 bg-yellow-500/10 text-yellow-300",
  needs_review: "border-orange-500/30 bg-orange-500/10 text-orange-300",
  linked: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  incident: "border-red-500/30 bg-red-500/10 text-red-300",
  merged: "border-purple-500/30 bg-purple-500/10 text-purple-300",
  dismissed: "border-neutral-500/30 bg-neutral-500/10 text-neutral-400",
  non_incident: "border-neutral-500/30 bg-neutral-500/10 text-neutral-400",
};

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relativeTime(value) {
  if (!value) return "-";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "-";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

function sourceLabel(item) {
  return [item.source_type, item.source].filter(Boolean).join(" / ") || "Unknown source";
}

function confidenceColor(value) {
  const score = Number(value || 0);
  if (score >= 75) return "text-ops-green";
  if (score >= 55) return "text-yellow-300";
  return "text-orange-300";
}

function confBarColor(value) {
  const score = Number(value || 0);
  if (score >= 75) return "#22c55e";
  if (score >= 55) return "#fde047";
  return "#fb923c";
}

function SkeletonRows() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 8 }).map((_, index) => (
        <div className="border-b border-white/5 px-4 py-3" key={index}>
          <div className="mb-2 h-3 w-3/4 rounded bg-white/10" />
          <div className="h-2 w-1/2 rounded bg-white/[0.06]" />
        </div>
      ))}
    </div>
  );
}

export function OsintRoute() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("inbox");
  const [status, setStatus] = useState("pending");
  const [sourceType, setSourceType] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [alertStatus, setAlertStatus] = useState("new");
  const [selectedId, setSelectedId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [note, setNote] = useState("");
  const [incidentId, setIncidentId] = useState("");
  const [watchlistForm, setWatchlistForm] = useState({ name: "", query_text: "", severity: "YELLOW", enabled: true, rule_type: "all_terms", min_confidence: 0, window_hours: 24 });
  const [toast, setToast] = useState(null);
  const [liveAlerts, setLiveAlerts] = useState(0);
  const [streamLive, setStreamLive] = useState(false);

  const notify = useCallback((message, type = "info") => {
    if (message) setToast({ message: String(message), type });
  }, []);

  const listQuery = useQuery({
    queryKey: ["osint-items", status, sourceType, search, page],
    queryFn: () => listOsintItems({ status, source_type: sourceType, q: search, limit: 50, offset: page * 50 }),
    refetchInterval: status === "pending" ? 30000 : false,
  });

  const items = useMemo(() => listQuery.data?.items || [], [listQuery.data?.items]);
  const selected = useMemo(
    () => items.find((item) => Number(item.id) === Number(selectedId)) || null,
    [items, selectedId],
  );

  const detailQuery = useQuery({
    queryKey: ["osint-item", selectedId],
    queryFn: () => getOsintItem(selectedId),
    enabled: Boolean(selectedId),
  });
  const detail = detailQuery.data?.item || selected;
  const detailEntities = detailQuery.data?.entities || [];

  const sourcesQuery = useQuery({
    queryKey: ["osint-sources"],
    queryFn: listOsintSources,
    staleTime: 60_000,
  });
  const watchlistsQuery = useQuery({
    queryKey: ["osint-watchlists"],
    queryFn: listOsintWatchlists,
    enabled: tab === "watchlists" || tab === "alerts",
  });
  const entitiesQuery = useQuery({
    queryKey: ["osint-entities"],
    queryFn: () => listOsintEntities({ limit: 100 }),
    enabled: tab === "entities",
  });
  const alertsQuery = useQuery({
    queryKey: ["osint-alerts", alertStatus],
    queryFn: () => listOsintAlerts({ status: alertStatus, limit: 100 }),
    enabled: tab === "alerts",
    refetchInterval: tab === "alerts" ? 30000 : false,
  });
  const sourceAnalyticsQuery = useQuery({
    queryKey: ["osint-source-analytics"],
    queryFn: getOsintSourceAnalytics,
    enabled: tab === "analytics",
  });
  const graphQuery = useQuery({
    queryKey: ["osint-graph"],
    queryFn: () => getOsintGraph({ limit: 90 }),
    enabled: tab === "graph",
  });
  const briefQuery = useQuery({
    queryKey: ["osint-brief"],
    queryFn: () => getOsintBrief({ hours: 72 }),
    enabled: tab === "reports",
  });

  // Lightweight counts that drive the tab badges regardless of the active tab.
  const pendingCountQuery = useQuery({
    queryKey: ["osint-pending-count"],
    queryFn: () => listOsintItems({ status: "pending", limit: 1 }),
    refetchInterval: 60000,
  });
  const newAlertsQuery = useQuery({
    queryKey: ["osint-new-alerts-count"],
    queryFn: () => listOsintAlerts({ status: "new", limit: 100 }),
    refetchInterval: 60000,
  });
  const pendingCount = pendingCountQuery.data?.total ?? 0;
  const newAlertsCount = (newAlertsQuery.data?.alerts || []).length;

  const sourceTypes = useMemo(() => {
    const values = new Set([
      ...(sourcesQuery.data?.sources || []).map((source) => source.source_type),
      ...(sourcesQuery.data?.discovered || []).map((source) => source.source_type),
      ...items.map((item) => item.source_type),
    ].filter(Boolean));
    return ["all", ...Array.from(values).sort()];
  }, [items, sourcesQuery.data]);

  useEffect(() => {
    if (items.length && !items.some((item) => Number(item.id) === Number(selectedId))) {
      setSelectedId(items[0].id);
    }
    if (!items.length) setSelectedId(null);
  }, [items, selectedId]);

  useEffect(() => {
    setNote(detail?.analyst_note || "");
    setIncidentId(detail?.incident_id ? String(detail.incident_id) : "");
  }, [detail?.id, detail?.analyst_note, detail?.incident_id]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Live alert stream. The backend pushes newly matched watchlist alerts over
  // SSE; we surface a count badge + toast and refresh the relevant queries so
  // the analyst sees matches the moment they land instead of on the next poll.
  useEffect(() => {
    const source = new EventSource(osintEventsUrl());
    source.addEventListener("open", () => setStreamLive(true));
    source.addEventListener("error", () => setStreamLive(false));
    source.addEventListener("osint_alert", (event) => {
      let alert = null;
      try {
        alert = JSON.parse(event.data);
      } catch {
        alert = null;
      }
      setLiveAlerts((count) => count + 1);
      notify(`New alert: ${alert?.watchlist_name || alert?.title || "watchlist match"}`, "alert");
      queryClient.invalidateQueries({ queryKey: ["osint-new-alerts-count"] });
      queryClient.invalidateQueries({ queryKey: ["osint-alerts"] });
    });
    return () => source.close();
  }, [queryClient, notify]);

  // Acknowledge the live badge once the analyst is actually looking at alerts.
  useEffect(() => {
    if (tab === "alerts") setLiveAlerts(0);
  }, [tab]);

  // Keyboard triage: j/k to move, e promote, d dismiss, r needs-review, o open
  // source. Ignored while typing into a field so notes/search stay usable.
  useEffect(() => {
    if (tab !== "inbox") return undefined;
    function onKey(event) {
      const el = event.target;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const idx = items.findIndex((item) => Number(item.id) === Number(selectedId));
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        const next = items[idx + 1] || items[idx];
        if (next) setSelectedId(next.id);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        const prev = items[idx - 1] || items[idx];
        if (prev) setSelectedId(prev.id);
      } else if (event.key === "e") {
        event.preventDefault();
        promote();
      } else if (event.key === "d") {
        event.preventDefault();
        saveReview("dismissed", { advance: true });
      } else if (event.key === "r") {
        event.preventDefault();
        saveReview("needs_review", { advance: true });
      } else if (event.key === "o" && detail?.source_url) {
        event.preventDefault();
        window.open(detail.source_url, "_blank", "noreferrer");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, items, selectedId, detail, promote, saveReview]);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["osint-items"] });
    await queryClient.invalidateQueries({ queryKey: ["osint-alerts"] });
    await queryClient.invalidateQueries({ queryKey: ["osint-entities"] });
    if (selectedId) await queryClient.invalidateQueries({ queryKey: ["osint-item", selectedId] });
  }

  const reviewMutation = useMutation({
    mutationFn: ({ id, payload }) => reviewOsintItem(id, payload),
    onSuccess: async () => {
      notify("Review saved", "success");
      await refresh();
    },
    onError: async (error) => {
      notify(error.message, "error");
      await refresh();
    },
  });

  const promoteMutation = useMutation({
    mutationFn: ({ id, payload }) => promoteOsintItem(id, payload),
    onSuccess: async (result) => {
      notify(result?.promoted?.status === "merged" ? "Linked to matching incident" : "Promoted to incident", "success");
      await queryClient.invalidateQueries({ queryKey: ["incidents"] });
      await refresh();
    },
    onError: async (error) => {
      notify(error.message, "error");
      await refresh();
    },
  });

  const linkMutation = useMutation({
    mutationFn: ({ id, payload }) => linkOsintItem(id, payload),
    onSuccess: async () => {
      notify("Linked to incident", "success");
      await queryClient.invalidateQueries({ queryKey: ["incidents"] });
      await refresh();
    },
    onError: (error) => notify(error.message, "error"),
  });

  const extractMutation = useMutation({
    mutationFn: extractOsintItem,
    onSuccess: async (result) => {
      notify(`Extracted ${result.entities?.length || 0} entities, ${result.alerts?.length || 0} alert match(es)`, "success");
      await refresh();
    },
    onError: (error) => notify(error.message, "error"),
  });

  const sourceMutation = useMutation({
    mutationFn: saveOsintSource,
    onSuccess: async () => {
      notify("Source saved", "success");
      await queryClient.invalidateQueries({ queryKey: ["osint-sources"] });
    },
    onError: (error) => notify(error.message, "error"),
  });

  const deleteSourceMutation = useMutation({
    mutationFn: deleteOsintSource,
    onSuccess: async () => {
      notify("Source removed", "success");
      await queryClient.invalidateQueries({ queryKey: ["osint-sources"] });
    },
    onError: (error) => notify(error.message, "error"),
  });

  const watchlistMutation = useMutation({
    mutationFn: saveOsintWatchlist,
    onSuccess: async () => {
      notify("Watchlist saved", "success");
      setWatchlistForm({ name: "", query_text: "", severity: "YELLOW", enabled: true, rule_type: "all_terms", min_confidence: 0, window_hours: 24 });
      await queryClient.invalidateQueries({ queryKey: ["osint-watchlists"] });
    },
    onError: (error) => notify(error.message, "error"),
  });

  const deleteWatchlistMutation = useMutation({
    mutationFn: deleteOsintWatchlist,
    onSuccess: async () => {
      notify("Watchlist removed", "success");
      await queryClient.invalidateQueries({ queryKey: ["osint-watchlists"] });
    },
    onError: (error) => notify(error.message, "error"),
  });

  const alertStatusMutation = useMutation({
    mutationFn: ({ id, status }) => updateOsintAlertStatus(id, status),
    onSuccess: async () => {
      notify("Alert updated", "success");
      await queryClient.invalidateQueries({ queryKey: ["osint-alerts"] });
    },
    onError: (error) => notify(error.message, "error"),
  });

  const evaluateAlertsMutation = useMutation({
    mutationFn: evaluateOsintAlerts,
    onSuccess: async (result) => {
      notify(`Scanned ${result.scanned || 0}; created ${result.alerts_created || 0}, updated ${result.alerts_updated || 0}`, "success");
      await queryClient.invalidateQueries({ queryKey: ["osint-alerts"] });
    },
    onError: (error) => notify(error.message, "error"),
  });

  // Optimistically move selection to the next row so triage keeps flowing after
  // an item leaves the current queue. Falls back to the previous row at the end.
  const advanceSelection = useCallback(() => {
    const idx = items.findIndex((item) => Number(item.id) === Number(selectedId));
    if (idx === -1) return;
    const next = items[idx + 1] || items[idx - 1] || null;
    setSelectedId(next ? next.id : null);
  }, [items, selectedId]);

  function saveReview(nextStatus, { advance = false } = {}) {
    if (!detail) return;
    reviewMutation.mutate({
      id: detail.id,
      payload: { status: nextStatus, analyst_note: note },
    });
    if (advance) advanceSelection();
  }

  function promote() {
    if (!detail) return;
    promoteMutation.mutate({ id: detail.id, payload: { analyst_note: note } });
    advanceSelection();
  }

  const toggleRowSelected = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  function bulkReview(nextStatus) {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    ids.forEach((id) =>
      reviewMutation.mutate({ id, payload: { status: nextStatus, analyst_note: null } }),
    );
    setSelectedIds(new Set());
  }

  function linkToIncident() {
    if (!detail || !incidentId.trim()) {
      notify("Enter an incident ID first", "error");
      return;
    }
    linkMutation.mutate({
      id: detail.id,
      payload: { incident_id: incidentId.trim(), analyst_note: note },
    });
  }

  const busy = reviewMutation.isPending || promoteMutation.isPending || linkMutation.isPending || extractMutation.isPending;

  return (
    <main className="flex h-screen flex-col bg-ops-bg pt-12 text-neutral-200">
      <section className="shrink-0 border-b border-white/10 bg-black/40 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-sm font-bold text-neutral-100">
              <FileSearch size={16} className="text-ops-red" /> OSINT Inbox
            </h1>
            <p className="mt-1 text-[11px] text-neutral-500">
              Review collected source items, preserve evidence, and promote confirmed reports.
            </p>
          </div>
          <span
            className={`ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold ${
              streamLive ? "border-ops-green/40 bg-ops-green/10 text-ops-green" : "border-white/10 bg-white/[0.03] text-neutral-500"
            }`}
            title={streamLive ? "Live alert stream connected" : "Live alert stream offline"}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${streamLive ? "animate-pulse bg-ops-green" : "bg-neutral-600"}`} />
            {streamLive ? "Live" : "Offline"}
          </span>
          <button
            className="inline-flex items-center gap-2 rounded border border-ops-line px-3 py-1.5 text-[11px] font-bold text-neutral-300 hover:bg-white/5"
            onClick={refresh}
          >
            <RefreshCw size={13} className={listQuery.isFetching ? "animate-spin" : ""} /> Refresh
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-bold">
          <TabButton active={tab === "inbox"} icon={FileSearch} label="Inbox" badge={pendingCount} onClick={() => setTab("inbox")} />
          <TabButton active={tab === "alerts"} icon={Bell} label="Alerts" badge={newAlertsCount} pulse={liveAlerts > 0} onClick={() => setTab("alerts")} />
          <TabButton active={tab === "watchlists"} icon={Tags} label="Watchlists" onClick={() => setTab("watchlists")} />
          <TabButton active={tab === "sources"} icon={Database} label="Sources" onClick={() => setTab("sources")} />
          <TabButton active={tab === "entities"} icon={Network} label="Entities" onClick={() => setTab("entities")} />
          <TabButton active={tab === "graph"} icon={GitBranch} label="Graph" onClick={() => setTab("graph")} />
          <TabButton active={tab === "analytics"} icon={Activity} label="Analytics" onClick={() => setTab("analytics")} />
          <TabButton active={tab === "reports"} icon={Download} label="Reports" onClick={() => setTab("reports")} />
        </div>

        {tab === "inbox" ? <div className="mt-4 grid gap-3 md:grid-cols-[170px_170px_1fr]">
          <select
            className="rounded border border-ops-line bg-black/60 px-3 py-2 text-xs outline-none"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setSourceType("all");
              setSelectedId(null);
              setPage(0);
            }}
          >
            {statuses.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <select
            className="rounded border border-ops-line bg-black/60 px-3 py-2 text-xs outline-none"
            value={sourceType}
            onChange={(event) => {
              setSourceType(event.target.value);
              setSelectedId(null);
              setPage(0);
            }}
          >
            {sourceTypes.map((type) => (
              <option key={type} value={type}>{type === "all" ? "All sources" : type}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 rounded border border-ops-line bg-black/60 px-3 py-2 text-xs">
            <Search size={13} className="text-neutral-500" />
            <input
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-neutral-600"
              placeholder="Search title, text, or source"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSelectedId(null);
                setPage(0);
              }}
            />
          </label>
        </div> : null}
      </section>

      {tab === "inbox" ? <section className="grid min-h-0 flex-1 lg:grid-cols-[420px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-white/10 bg-black/25">
          <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2 text-[11px] text-neutral-500">
            <span>{listQuery.data?.total ?? items.length} item(s)</span>
            {listQuery.isFetching ? <RefreshCw size={12} className="animate-spin" /> : null}
          </div>

          {selectedIds.size ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-white/[0.04] px-3 py-2 text-[11px]">
              <span className="font-bold text-neutral-200">{selectedIds.size} selected</span>
              <button className="rounded border border-orange-500/40 bg-orange-500/10 px-2 py-1 font-bold text-orange-300 disabled:opacity-50" disabled={busy} onClick={() => bulkReview("needs_review")}>Review</button>
              <button className="rounded border border-neutral-500/40 bg-neutral-500/10 px-2 py-1 font-bold text-neutral-300 disabled:opacity-50" disabled={busy} onClick={() => bulkReview("dismissed")}>Dismiss</button>
              <button className="ml-auto text-neutral-500 hover:text-neutral-200" onClick={() => setSelectedIds(new Set())}>Clear</button>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {listQuery.isError ? (
              <ErrorState error={listQuery.error} onRetry={() => listQuery.refetch()} />
            ) : listQuery.isLoading ? (
              <SkeletonRows />
            ) : items.length ? (
              items.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-start gap-2.5 border-b border-white/5 px-3 py-3 hover:bg-white/[0.04] ${
                    Number(selectedId) === Number(item.id) ? "bg-white/[0.06]" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0 accent-ops-red"
                    checked={selectedIds.has(item.id)}
                    onChange={() => toggleRowSelected(item.id)}
                    aria-label="Select item"
                  />
                  <button className="min-w-0 flex-1 text-left" onClick={() => setSelectedId(item.id)}>
                    <div className="mb-1 flex items-start gap-2">
                      <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-bold ${statusStyles[item.status] || statusStyles.pending}`}>
                        {item.status}
                      </span>
                      <h2 className="line-clamp-2 text-[12px] font-bold leading-snug text-neutral-200">
                        {item.title || "Untitled source item"}
                      </h2>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-neutral-500">
                      <span className="truncate">{sourceLabel(item)}</span>
                      {item.confidence_score ? (
                        <span className="flex shrink-0 items-center gap-1" title={`Confidence ${item.confidence_score}%`}>
                          <span className="h-1 w-8 overflow-hidden rounded-full bg-white/10">
                            <span className="block h-full rounded-full" style={{ width: `${Math.min(100, item.confidence_score)}%`, backgroundColor: confBarColor(item.confidence_score) }} />
                          </span>
                        </span>
                      ) : null}
                      <span className="ml-auto shrink-0" title={formatDate(item.published_at || item.created_at)}>
                        {relativeTime(item.published_at || item.created_at)}
                      </span>
                    </div>
                  </button>
                </div>
              ))
            ) : (
              <div className="flex h-72 flex-col items-center justify-center px-8 text-center text-xs text-neutral-600">
                <FileSearch size={28} className="mb-2" />
                No OSINT items match this filter.
              </div>
            )}
          </div>
          {!listQuery.isError && (page > 0 || (page + 1) * 50 < Number(listQuery.data?.total || 0)) ? (
            <div className="flex shrink-0 items-center justify-between border-t border-white/10 p-2 text-[11px]">
              <button className="rounded border border-white/10 px-3 py-1.5 disabled:opacity-40" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous</button>
              <span className="text-neutral-500">Page {page + 1}</span>
              <button className="rounded border border-white/10 px-3 py-1.5 disabled:opacity-40" disabled={(page + 1) * 50 >= Number(listQuery.data?.total || 0)} onClick={() => setPage((value) => value + 1)}>Next</button>
            </div>
          ) : null}
        </aside>

        <article className="min-h-0 overflow-y-auto p-5">
          {detail ? (
            <div className="mx-auto max-w-5xl">
              <div className="flex flex-wrap items-start gap-3 border-b border-white/10 pb-4">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className={`rounded border px-2 py-1 text-[10px] font-bold ${statusStyles[detail.status] || statusStyles.pending}`}>
                      {detail.status}
                    </span>
                    <span className="text-[11px] text-neutral-500">{sourceLabel(detail)}</span>
                  </div>
                  <h2 className="text-lg font-bold leading-tight text-neutral-100">{detail.title || "Untitled source item"}</h2>
                  <p className="mt-2 text-[11px] text-neutral-500">
                    Published {formatDate(detail.published_at)} · collected {formatDate(detail.created_at)}
                  </p>
                  {detail.confidence_score ? (
                    <p className="mt-2 text-[11px] text-neutral-400">
                      Source confidence: <span className={`font-black ${confidenceColor(detail.confidence_score)}`}>{detail.confidence_score}%</span>
                      {detail.confidence_reason ? ` · ${detail.confidence_reason}` : ""}
                    </p>
                  ) : null}
                </div>
                {detail.source_url ? (
                  <a
                    className="inline-flex items-center gap-1 rounded border border-ops-line px-3 py-1.5 text-[11px] font-bold text-ops-red hover:bg-red-500/10"
                    href={detail.source_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open source <ExternalLink size={12} />
                  </a>
                ) : null}
              </div>

              <div className="grid gap-5 py-5 xl:grid-cols-[1fr_320px]">
                <section className="min-w-0">
                  <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-neutral-500">Collected text</h3>
                  <div className="whitespace-pre-wrap rounded border border-white/10 bg-black/30 p-4 text-sm leading-relaxed text-neutral-300">
                    {detail.content_text || detail.description || "No text captured for this item."}
                  </div>
                  {detail.description && detail.content_text && detail.content_text !== detail.description ? (
                    <details className="mt-3 rounded border border-white/10 bg-black/20 p-3 text-xs text-neutral-400">
                      <summary className="cursor-pointer font-bold text-neutral-300">Original summary</summary>
                      <div className="mt-3 whitespace-pre-wrap leading-relaxed">{detail.description}</div>
                    </details>
                  ) : null}
                </section>

                <aside className="rounded border border-white/10 bg-black/25 p-4">
                  <h3 className="text-[11px] font-bold uppercase tracking-wide text-neutral-500">Analyst actions</h3>

                  <label className="mt-4 block text-[11px] font-bold text-neutral-400">
                    Analyst note
                    <textarea
                      className="mt-1 h-24 w-full resize-none rounded border border-ops-line bg-black/60 p-2 text-xs font-normal text-neutral-200 outline-none"
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="Why this was promoted, linked, or dismissed"
                    />
                  </label>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      className="inline-flex items-center justify-center gap-1 rounded border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-[11px] font-bold text-orange-300 disabled:opacity-50"
                      disabled={busy}
                      onClick={() => saveReview("needs_review")}
                    >
                      <AlertTriangle size={13} /> Review
                    </button>
                    <button
                      className="inline-flex items-center justify-center gap-1 rounded border border-neutral-500/40 bg-neutral-500/10 px-3 py-2 text-[11px] font-bold text-neutral-300 disabled:opacity-50"
                      disabled={busy}
                      onClick={() => saveReview("dismissed")}
                    >
                      <XCircle size={13} /> Dismiss
                    </button>
                  </div>

                  <button
                    className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] font-bold text-red-300 disabled:opacity-50"
                    disabled={busy}
                    onClick={promote}
                  >
                    <ShieldCheck size={13} /> Promote to incident
                  </button>

                  <button
                    className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded border border-ops-line bg-white/[0.03] px-3 py-2 text-[11px] font-bold text-neutral-300 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => extractMutation.mutate(detail.id)}
                  >
                    <Network size={13} /> Extract entities / match watchlists
                  </button>

                  <div className="mt-5 border-t border-white/10 pt-4">
                    <label className="block text-[11px] font-bold text-neutral-400">
                      Link to existing incident ID
                      <input
                        className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal text-neutral-200 outline-none"
                        value={incidentId}
                        onChange={(event) => setIncidentId(event.target.value)}
                        placeholder="e.g. 42"
                      />
                    </label>
                    <button
                      className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-[11px] font-bold text-sky-300 disabled:opacity-50"
                      disabled={busy}
                      onClick={linkToIncident}
                    >
                      <Link2 size={13} /> Link evidence
                    </button>
                  </div>

                  {detail.incident_id ? (
                    <div className="mt-4 rounded border border-sky-500/20 bg-sky-500/10 p-3 text-[11px] text-sky-200">
                      <div className="flex items-center gap-2 font-bold">
                        <CheckCircle2 size={13} /> Evidence linked to incident #{detail.incident_id}
                      </div>
                      {detail.incident_title ? <p className="mt-1 text-sky-100/80">{detail.incident_title}</p> : null}
                    </div>
                  ) : null}

                  {detail.analyst_note ? (
                    <div className="mt-4 text-[11px] text-neutral-500">
                      Last note: <span className="text-neutral-300">{detail.analyst_note}</span>
                    </div>
                  ) : null}

                  {detailEntities.length ? (
                    <div className="mt-4 border-t border-white/10 pt-4">
                      <h4 className="mb-2 text-[10px] font-bold uppercase tracking-wide text-neutral-500">Entities</h4>
                      <div className="flex flex-wrap gap-1.5">
                        {detailEntities.map((entity) => (
                          <span className="rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] text-neutral-300" key={`${entity.entity_type}-${entity.value}`}>
                            {entity.entity_type}: {entity.value}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </aside>
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-[420px] flex-col items-center justify-center text-center text-xs text-neutral-600">
              <FileSearch size={34} className="mb-3" />
              Select an OSINT item to review.
              <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5 text-[10px] text-neutral-700">
                {[["j / k", "move"], ["e", "promote"], ["d", "dismiss"], ["r", "review"], ["o", "open source"]].map(([key, action]) => (
                  <span className="inline-flex items-center gap-1" key={key}>
                    <kbd className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-neutral-400">{key}</kbd>
                    {action}
                  </span>
                ))}
              </div>
            </div>
          )}
        </article>
      </section> : (
      <div className="min-h-0 flex-1 overflow-y-auto">
      {tab === "alerts" ? (
        <AlertsPanel
          alerts={alertsQuery.data?.alerts || []}
          error={alertsQuery.error}
          evaluating={evaluateAlertsMutation.isPending}
          loading={alertsQuery.isLoading}
          onEvaluate={() => evaluateAlertsMutation.mutate({ hours: 72 })}
          onRetry={() => alertsQuery.refetch()}
          onStatusFilter={setAlertStatus}
          onStatus={(id, statusValue) => alertStatusMutation.mutate({ id, status: statusValue })}
          status={alertStatus}
        />
      ) : null}

      {tab === "watchlists" ? (
        <WatchlistsPanel
          form={watchlistForm}
          loading={watchlistsQuery.isLoading}
          onChange={setWatchlistForm}
          onDelete={(id) => deleteWatchlistMutation.mutate(id)}
          onSubmit={() => watchlistMutation.mutate(watchlistForm)}
          pending={watchlistMutation.isPending || deleteWatchlistMutation.isPending}
          watchlists={watchlistsQuery.data?.watchlists || []}
        />
      ) : null}

      {tab === "sources" ? (
        <SourcesPanel
          discovered={sourcesQuery.data?.discovered || []}
          loading={sourcesQuery.isLoading}
          onSubmit={(payload) => sourceMutation.mutateAsync(payload)}
          onDelete={(id) => deleteSourceMutation.mutate(id)}
          pending={sourceMutation.isPending || deleteSourceMutation.isPending}
          sources={sourcesQuery.data?.sources || []}
        />
      ) : null}

      {tab === "entities" ? (
        <EntitiesPanel entities={entitiesQuery.data?.entities || []} loading={entitiesQuery.isLoading} />
      ) : null}

      {tab === "analytics" ? (
        <AnalyticsPanel
          loading={sourceAnalyticsQuery.isLoading}
          sources={sourceAnalyticsQuery.data?.sources || []}
          trends={sourceAnalyticsQuery.data?.trends || []}
        />
      ) : null}

      {tab === "graph" ? (
        <GraphPanel graph={graphQuery.data || { nodes: [], edges: [] }} loading={graphQuery.isLoading} />
      ) : null}

      {tab === "reports" ? (
        <ReportsPanel brief={briefQuery.data} loading={briefQuery.isLoading} onRefresh={() => queryClient.invalidateQueries({ queryKey: ["osint-brief"] })} />
      ) : null}
      </div>
      )}

      {toast ? (
        <div
          className={`fixed bottom-5 right-5 z-[1200] flex items-center gap-2 rounded border px-4 py-2 text-xs font-bold shadow-xl ${
            toast.type === "error"
              ? "border-ops-red/50 bg-red-500/15 text-red-200"
              : toast.type === "success"
                ? "border-ops-green/40 bg-ops-green/10 text-ops-green"
                : toast.type === "alert"
                  ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-200"
                  : "border-white/10 bg-black/90 text-neutral-200"
          }`}
        >
          {toast.type === "error" ? <XCircle size={13} /> : toast.type === "alert" ? <Zap size={13} /> : toast.type === "success" ? <CheckCircle2 size={13} /> : null}
          {toast.message}
        </div>
      ) : null}
    </main>
  );
}

function TabButton({ active, icon: Icon, label, onClick, badge, pulse }) {
  const showBadge = Number(badge) > 0;
  return (
    <button
      className={`relative inline-flex items-center gap-1.5 rounded border px-3 py-1.5 transition ${
        active ? "border-ops-red bg-red-500/10 text-ops-red" : "border-white/10 bg-white/[0.03] text-neutral-400 hover:text-neutral-100"
      }`}
      onClick={onClick}
    >
      <Icon size={13} /> {label}
      {showBadge ? (
        <span
          className={`ml-0.5 inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 py-0.5 text-[9px] font-black leading-none ${
            pulse ? "animate-pulse bg-ops-red text-white" : active ? "bg-ops-red/20 text-ops-red" : "bg-white/10 text-neutral-300"
          }`}
        >
          {Number(badge) > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <label className="block text-[11px] font-bold text-neutral-400">
      {label}
      {children}
    </label>
  );
}

function ErrorState({ error, onRetry }) {
  return (
    <div className="flex h-72 flex-col items-center justify-center px-8 text-center text-xs text-red-300">
      <AlertTriangle size={28} className="mb-2" />
      <p>{error?.message || "This data could not be loaded."}</p>
      <button className="mt-3 rounded border border-red-500/30 px-3 py-1.5 font-bold" onClick={onRetry}>Try again</button>
    </div>
  );
}

const EMPTY_SOURCE = { name: "", source_type: "rss", locator: "", keywords: "", reliability_score: "50", cadence_minutes: "30", enabled: true, notes: "" };

// Local form state lives here (not in OsintRoute) so typing only re-renders this
// panel instead of the whole route — that was the source of the input jank.
function SourcesPanel({ sources, discovered, onSubmit, onDelete, loading, pending }) {
  const [form, setForm] = useState(EMPTY_SOURCE);
  const [editingId, setEditingId] = useState(null);
  const formRef = useRef(null);
  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  function editSource(source) {
    setEditingId(source.id);
    setForm({
      name: source.name || "",
      source_type: source.source_type || "",
      locator: source.locator || "",
      keywords: source.keywords || "",
      reliability_score: String(source.reliability_score ?? 50),
      cadence_minutes: String(source.cadence_minutes ?? 30),
      enabled: source.enabled !== false,
      notes: source.notes || "",
    });
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(EMPTY_SOURCE);
  }

  async function submit() {
    try {
      await onSubmit({
        ...form,
        reliability_score: Number(form.reliability_score) || 0,
        cadence_minutes: Number(form.cadence_minutes) || 30,
      });
      cancelEdit();
    } catch {
      // Mutation surfaces its own error toast; keep the form populated to retry.
    }
  }

  return (
    <section className="grid gap-5 p-5 lg:grid-cols-[360px_minmax(0,1fr)]">
      <aside ref={formRef} className="self-start rounded border border-white/10 bg-black/25 p-4">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-bold text-neutral-100"><Database size={15} className="text-ops-red" /> {editingId ? "Edit source" : "Add source"}</h2>
        {editingId ? (
          <p className="mb-3 text-[10px] text-neutral-500">Editing <span className="font-bold text-neutral-300">{form.name || "source"}</span> · type &amp; locator are locked while editing.</p>
        ) : <p className="mb-3 text-[10px] text-neutral-500">Register a feed to collect and score.</p>}
        <div className="grid gap-3">
          <Field label="Name"><input className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Type"><input className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none disabled:opacity-50" value={form.source_type} disabled={Boolean(editingId)} onChange={(e) => set({ source_type: e.target.value })} /></Field>
          <Field label="Locator / URL / channel"><input className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none disabled:opacity-50" value={form.locator} disabled={Boolean(editingId)} onChange={(e) => set({ locator: e.target.value })} /></Field>
          <Field label="Keywords"><textarea className="mt-1 h-16 w-full resize-none rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" value={form.keywords} onChange={(e) => set({ keywords: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Reliability"><input className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" type="number" min="0" max="100" value={form.reliability_score} onChange={(e) => set({ reliability_score: e.target.value })} /></Field>
            <Field label="Cadence min"><input className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" type="number" min="1" value={form.cadence_minutes} onChange={(e) => set({ cadence_minutes: e.target.value })} /></Field>
          </div>
          <Field label="Notes"><textarea className="mt-1 h-16 w-full resize-none rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" value={form.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-xs text-neutral-300"><input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled</label>
          <div className="flex gap-2">
            <button disabled={pending || !form.name.trim() || !form.locator.trim()} className="inline-flex flex-1 items-center justify-center gap-2 rounded border border-ops-red bg-red-500/10 px-3 py-2 text-xs font-bold text-ops-red disabled:opacity-50" onClick={submit}>
              <Plus size={13} /> {editingId ? "Update source" : "Save source"}
            </button>
            {editingId ? (
              <button disabled={pending} className="rounded border border-white/10 px-3 py-2 text-xs font-bold text-neutral-400 hover:text-neutral-100 disabled:opacity-50" onClick={cancelEdit}>Cancel</button>
            ) : null}
          </div>
        </div>
      </aside>

      <div className="grid min-w-0 content-start gap-5">
        <Panel title="Managed sources" loading={loading}>
          {sources.length ? sources.map((source) => (
            <ManagedSourceRow
              key={source.id}
              source={source}
              editing={Number(editingId) === Number(source.id)}
              onEdit={() => editSource(source)}
              onDelete={() => {
                if (Number(editingId) === Number(source.id)) cancelEdit();
                onDelete(source.id);
              }}
              pending={pending}
            />
          )) : <Empty text="No managed sources yet." />}
        </Panel>
        <Panel title="Discovered from collected items">
          {discovered.length ? discovered.map((source) => (
            <Row key={`${source.source_type}-${source.locator}`} title={source.name} meta={`${source.source_type} · ${source.item_count} item(s) · ${formatDate(source.last_seen)}`} badge="observed" />
          )) : <Empty text="No discovered sources yet." />}
        </Panel>
      </div>
    </section>
  );
}

function ManagedSourceRow({ source, editing, onEdit, onDelete, pending }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return undefined;
    const timer = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  return (
    <div className={`mb-2 flex items-center gap-3 rounded border bg-black/25 p-3 ${editing ? "border-ops-red/50" : "border-white/10"}`}>
      <div className="min-w-0 flex-1">
        <div className="break-words text-sm font-bold text-neutral-100">{source.name}</div>
        <div className="mt-1 break-words text-[11px] text-neutral-500">{source.source_type} · reliability {source.reliability_score}% · every {source.cadence_minutes} min</div>
      </div>
      <span className={`shrink-0 rounded border px-2 py-0.5 text-[9px] uppercase ${source.enabled ? "border-ops-green/30 text-ops-green" : "border-white/10 text-neutral-500"}`}>{source.enabled ? "enabled" : "disabled"}</span>
      <button className="shrink-0 rounded border border-white/10 px-2 py-1 text-[10px] text-neutral-400 hover:text-neutral-100" onClick={onEdit}>Edit</button>
      {confirming ? (
        <button disabled={pending} className="shrink-0 rounded border border-ops-red/50 bg-red-500/15 px-2 py-1 text-[10px] font-bold text-red-300 disabled:opacity-40" onClick={onDelete}>Confirm</button>
      ) : (
        <button disabled={pending} className="shrink-0 rounded p-2 text-neutral-500 hover:text-ops-red disabled:opacity-40" onClick={() => setConfirming(true)} aria-label="Delete source"><Trash2 size={14} /></button>
      )}
    </div>
  );
}

function WatchlistsPanel({ watchlists, form, onChange, onSubmit, onDelete, loading, pending }) {
  return (
    <section className="grid gap-5 p-5 lg:grid-cols-[360px_minmax(0,1fr)]">
      <aside className="rounded border border-white/10 bg-black/25 p-4">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-bold text-neutral-100"><Tags size={15} className="text-ops-red" /> Watchlist</h2>
        <div className="grid gap-3">
          <Field label="Name"><input className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} /></Field>
          <Field label="Match terms"><textarea className="mt-1 h-20 w-full resize-none rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" value={form.query_text} placeholder="e.g. Kaduna, kidnap" onChange={(e) => onChange({ ...form, query_text: e.target.value })} /></Field>
          <Field label="Severity">
            <select className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" value={form.severity} onChange={(e) => onChange({ ...form, severity: e.target.value })}>
              <option value="RED">RED</option><option value="ORANGE">ORANGE</option><option value="YELLOW">YELLOW</option><option value="BLUE">BLUE</option>
            </select>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Rule">
              <select className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" value={form.rule_type} onChange={(e) => onChange({ ...form, rule_type: e.target.value })}>
                <option value="all_terms">All terms</option>
                <option value="any_term">Any term</option>
              </select>
            </Field>
            <Field label="Min conf."><input className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" type="number" value={form.min_confidence} onChange={(e) => onChange({ ...form, min_confidence: Number(e.target.value) })} /></Field>
            <Field label="Window hrs"><input className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" type="number" value={form.window_hours} onChange={(e) => onChange({ ...form, window_hours: Number(e.target.value) })} /></Field>
          </div>
          <label className="flex items-center gap-2 text-xs text-neutral-300"><input type="checkbox" checked={form.enabled} onChange={(e) => onChange({ ...form, enabled: e.target.checked })} /> Enabled</label>
          <button disabled={pending} className="inline-flex items-center justify-center gap-2 rounded border border-ops-red bg-red-500/10 px-3 py-2 text-xs font-bold text-ops-red disabled:opacity-50" onClick={onSubmit}>
            <Plus size={13} /> Save watchlist
          </button>
        </div>
      </aside>
      <Panel title="Active watchlists" loading={loading}>
        {watchlists.length ? watchlists.map((watchlist) => (
          <WatchlistRow key={watchlist.id} watchlist={watchlist} onEdit={() => onChange({ ...watchlist })} onDelete={() => onDelete(watchlist.id)} pending={pending} />
        )) : <Empty text="No watchlists yet." />}
      </Panel>
    </section>
  );
}

function WatchlistRow({ watchlist, onEdit, onDelete, pending }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return undefined;
    const timer = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  return (
    <div className="mb-2 flex items-center gap-3 rounded border border-white/10 bg-black/25 p-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-neutral-100">{watchlist.name}</div>
        <div className="mt-1 text-[11px] text-neutral-500">
          {watchlist.query_text} · {watchlist.severity} · {watchlist.rule_type || "all_terms"} · min {watchlist.min_confidence || 0}%
        </div>
      </div>
      <button className="rounded border border-white/10 px-2 py-1 text-[10px] text-neutral-400" onClick={onEdit}>Edit</button>
      {confirming ? (
        <button disabled={pending} className="rounded border border-ops-red/50 bg-red-500/15 px-2 py-1 text-[10px] font-bold text-red-300 disabled:opacity-40" onClick={onDelete}>Confirm</button>
      ) : (
        <button disabled={pending} className="rounded p-2 text-neutral-500 hover:text-ops-red disabled:opacity-40" onClick={() => setConfirming(true)} aria-label="Delete watchlist"><Trash2 size={14} /></button>
      )}
    </div>
  );
}

function AlertsPanel({ alerts, evaluating, loading, onEvaluate, onStatus, status, onStatusFilter, error, onRetry }) {
  return (
    <section className="p-5">
      <Panel title="Watchlist alerts" loading={loading}>
        <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          className="inline-flex items-center gap-2 rounded border border-ops-red bg-red-500/10 px-3 py-2 text-xs font-bold text-ops-red disabled:opacity-50"
          disabled={evaluating}
          onClick={onEvaluate}
        >
          <RefreshCw size={13} className={evaluating ? "animate-spin" : ""} /> Evaluate recent items
        </button>
        <select className="rounded border border-white/10 bg-black/60 px-3 py-2 text-xs" value={status} onChange={(event) => onStatusFilter(event.target.value)}>
          <option value="new">New</option><option value="reviewed">Reviewed</option><option value="dismissed">Dismissed</option><option value="all">All history</option>
        </select>
        </div>
        {error ? <ErrorState error={error} onRetry={onRetry} /> : alerts.length ? alerts.map((alert) => (
          <div className="mb-3 rounded border border-white/10 bg-black/25 p-3" key={alert.id}>
            <div className="flex items-start gap-3">
              <Bell size={15} className="mt-0.5 text-ops-red" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-neutral-100">{alert.title || "Matched source item"}</div>
                <div className="mt-1 text-[11px] text-neutral-500">{alert.watchlist_name} · {alert.reason}</div>
                <div className="mt-1 text-[10px] font-bold text-yellow-300">Match score {alert.score || 0}%</div>
                <div className="mt-1 text-[10px] text-neutral-600">{sourceLabel(alert)} · {formatDate(alert.matched_at)}</div>
              </div>
              {alert.status !== "reviewed" ? <button className="rounded border border-white/10 px-2 py-1 text-[10px] font-bold text-neutral-300" onClick={() => onStatus(alert.id, "reviewed")}>Reviewed</button> : null}
              {alert.status !== "dismissed" ? <button className="rounded border border-white/10 px-2 py-1 text-[10px] font-bold text-neutral-500" onClick={() => onStatus(alert.id, "dismissed")}>Dismiss</button> : null}
              {alert.status !== "new" ? <button className="rounded border border-white/10 px-2 py-1 text-[10px] font-bold text-neutral-500" onClick={() => onStatus(alert.id, "new")}>Restore</button> : null}
            </div>
          </div>
        )) : <Empty text="No new watchlist alerts." />}
      </Panel>
    </section>
  );
}

function downloadMarkdown(filename, markdown) {
  const blob = new Blob([markdown || ""], { type: "text/markdown;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function AnalyticsPanel({ sources, trends, loading }) {
  const top = sources[0];
  return (
    <section className="p-5">
      <Panel title="Source reliability analytics" loading={loading}>
        <div className="mb-4 grid gap-3 md:grid-cols-4">
          <MetricBox label="Sources" value={sources.length} />
          <MetricBox label="Best source" value={top?.source || "-"} small />
          <MetricBox label="Best reliability" value={top ? `${top.reliability_index || 0}%` : "-"} />
          <MetricBox label="30d trend points" value={trends.length} />
        </div>
        {sources.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="border-b border-white/10 p-2">Source</th>
                  <th className="border-b border-white/10 p-2">Items</th>
                  <th className="border-b border-white/10 p-2">Evidence</th>
                  <th className="border-b border-white/10 p-2">Useful</th>
                  <th className="border-b border-white/10 p-2">Rejected</th>
                  <th className="border-b border-white/10 p-2">Avg confidence</th>
                  <th className="border-b border-white/10 p-2">Useful rate</th>
                  <th className="border-b border-white/10 p-2">Reliability</th>
                  <th className="border-b border-white/10 p-2">Alerts</th>
                  <th className="border-b border-white/10 p-2">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr className="text-neutral-300" key={`${source.source_type}-${source.source}`}>
                    <td className="border-b border-white/5 p-2">
                      <div className="font-bold">{source.source}</div>
                      <div className="text-[10px] text-neutral-600">{source.source_type}</div>
                    </td>
                    <td className="border-b border-white/5 p-2">{source.item_count}</td>
                    <td className="border-b border-white/5 p-2">{source.evidence_count}</td>
                    <td className="border-b border-white/5 p-2 text-ops-green">{source.useful_count}</td>
                    <td className="border-b border-white/5 p-2 text-orange-300">{source.rejected_count}</td>
                    <td className="border-b border-white/5 p-2">{source.avg_confidence || 0}%</td>
                    <td className="border-b border-white/5 p-2">{source.useful_rate || 0}%</td>
                    <td className="border-b border-white/5 p-2 font-bold text-ops-red">{source.reliability_index || 0}%</td>
                    <td className="border-b border-white/5 p-2">{source.alert_count || 0}</td>
                    <td className="border-b border-white/5 p-2 text-neutral-500">{formatDate(source.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty text="No source analytics yet." />}
      </Panel>
    </section>
  );
}

const GRAPH_TYPE_COLORS = {
  source: "#38bdf8",
  incident: "#ef4444",
  actor: "#f59e0b",
  location: "#22c55e",
  organization: "#a78bfa",
  route: "#14b8a6",
  impact: "#f97316",
};

const graphColorFor = (type) => GRAPH_TYPE_COLORS[type] || "#a3a3a3";
const graphNodeRadius = (node) => Math.max(3, Math.min(12, 3 + Math.sqrt(Number(node.weight) || 1)));

function GraphPanel({ graph, loading }) {
  const rawNodes = graph.nodes || [];
  const rawEdges = graph.edges || [];

  const fgRef = useRef(null);
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ width: 800, height: 560 });
  const [hoverId, setHoverId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState(() => new Set());

  // Which entity types actually appear, in a stable order — drives filters + legend.
  const presentTypes = useMemo(() => {
    const order = ["source", "actor", "organization", "location", "route", "impact", "incident"];
    const seen = new Set(rawNodes.map((node) => node.type));
    return order.filter((type) => seen.has(type));
  }, [rawNodes]);

  // Clone into the {nodes, links} shape ForceGraph mutates, with hidden types removed
  // and links kept only when both endpoints survive the filter.
  const data = useMemo(() => {
    const nodes = rawNodes
      .filter((node) => !hidden.has(node.type))
      .map((node) => ({ id: node.id, label: node.label, type: node.type, weight: Number(node.weight) || 1 }));
    const visible = new Set(nodes.map((node) => node.id));
    const links = rawEdges
      .filter((edge) => visible.has(edge.source) && visible.has(edge.target))
      .map((edge) => ({ source: edge.source, target: edge.target, type: edge.type, weight: Number(edge.weight) || 1 }));
    return { nodes, links };
  }, [rawNodes, rawEdges, hidden]);

  // Adjacency over the *visible* graph for neighbour highlighting.
  const adjacency = useMemo(() => {
    const map = new Map();
    for (const link of data.links) {
      const s = typeof link.source === "object" ? link.source.id : link.source;
      const t = typeof link.target === "object" ? link.target.id : link.target;
      if (!map.has(s)) map.set(s, new Set());
      if (!map.has(t)) map.set(t, new Set());
      map.get(s).add(t);
      map.get(t).add(s);
    }
    return map;
  }, [data.links]);

  const term = search.trim().toLowerCase();
  const focusId = hoverId || selectedId;

  // Set of node ids to keep bright; empty set means "no focus, show everything".
  const highlightNodes = useMemo(() => {
    const set = new Set();
    if (focusId) {
      set.add(focusId);
      for (const id of adjacency.get(focusId) || []) set.add(id);
    }
    if (term) {
      for (const node of data.nodes) {
        if (String(node.label || "").toLowerCase().includes(term)) set.add(node.id);
      }
    }
    return set;
  }, [focusId, term, adjacency, data.nodes]);

  const focusActive = highlightNodes.size > 0;

  // Measure the container so the canvas fills it (and tracks resizes). Runs
  // before paint and only accepts positive dimensions, so the graph never
  // mounts with a zero width (which renders an invisible canvas).
  useLayoutEffect(() => {
    if (!wrapRef.current) return;
    const el = wrapRef.current;
    const update = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (width > 0 && height > 0) setSize({ width, height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const paintNode = useCallback(
    (node, ctx, globalScale) => {
      const dim = focusActive && !highlightNodes.has(node.id);
      const r = graphNodeRadius(node);
      ctx.globalAlpha = dim ? 0.12 : 1;

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = graphColorFor(node.type);
      ctx.fill();
      if (node.id === selectedId) {
        ctx.lineWidth = 2 / globalScale;
        ctx.strokeStyle = "#fafafa";
        ctx.stroke();
      }

      // Label only when it won't clutter: zoomed in, focused, or a heavy node.
      const showLabel = highlightNodes.has(node.id) || globalScale > 1.4 || node.weight >= 6;
      if (showLabel && !dim) {
        const label = String(node.label || "").slice(0, 36);
        const fontSize = Math.max(11 / globalScale, 2);
        ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#e5e5e5";
        ctx.fillText(label, node.x + r + 2, node.y);
      }
      ctx.globalAlpha = 1;
    },
    [focusActive, highlightNodes, selectedId],
  );

  const paintPointerArea = useCallback((node, color, ctx) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, graphNodeRadius(node) + 3, 0, 2 * Math.PI);
    ctx.fill();
  }, []);

  const linkColor = useCallback(
    (link) => {
      if (!focusActive) return "rgba(255,255,255,0.10)";
      const s = typeof link.source === "object" ? link.source.id : link.source;
      const t = typeof link.target === "object" ? link.target.id : link.target;
      const lit = highlightNodes.has(s) && highlightNodes.has(t);
      if (!lit) return "rgba(255,255,255,0.03)";
      return link.type === "supports" ? "rgba(34,197,94,0.55)" : "rgba(255,255,255,0.45)";
    },
    [focusActive, highlightNodes],
  );

  const toggleType = (type) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(type) ? next.delete(type) : next.add(type);
      return next;
    });

  return (
    <section className="p-5">
      <Panel title="Entity / source graph" loading={loading}>
        {rawNodes.length ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Find entity…"
                  className="w-48 rounded border border-white/10 bg-black/30 py-1.5 pl-7 pr-2 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-white/25"
                />
              </div>
              {presentTypes.map((type) => {
                const off = hidden.has(type);
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => toggleType(type)}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize transition ${
                      off ? "border-white/5 bg-transparent text-neutral-600" : "border-white/15 bg-white/[0.06] text-neutral-200"
                    }`}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: off ? "#525252" : graphColorFor(type) }} />
                    {type}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => fgRef.current?.zoomToFit(400, 50)}
                className="ml-auto rounded border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-neutral-300 hover:bg-white/[0.08]"
              >
                Fit view
              </button>
            </div>

            <div ref={wrapRef} className="relative h-[560px] overflow-hidden rounded border border-white/10 bg-black/40">
              <span className="pointer-events-none absolute right-2 top-2 z-10 rounded bg-black/60 px-2 py-0.5 text-[10px] text-neutral-400">
                {data.nodes.length} nodes · {data.links.length} links · {size.width}×{size.height}
              </span>
              <ForceGraph2D
                ref={fgRef}
                graphData={data}
                width={size.width}
                height={size.height}
                backgroundColor="rgba(0,0,0,0)"
                cooldownTicks={120}
                onEngineStop={() => fgRef.current?.zoomToFit(400, 50)}
                nodeRelSize={4}
                nodeCanvasObject={paintNode}
                nodePointerAreaPaint={paintPointerArea}
                linkColor={linkColor}
                linkWidth={(link) => Math.max(0.5, Math.min(3, link.weight || 1))}
                linkDirectionalParticles={(link) => (focusActive && link.type === "supports" ? 2 : 0)}
                linkDirectionalParticleWidth={2}
                onNodeHover={(node) => setHoverId(node ? node.id : null)}
                onNodeClick={(node) => setSelectedId((prev) => (prev === node.id ? null : node.id))}
                onBackgroundClick={() => setSelectedId(null)}
              />
            </div>

            <p className="text-[11px] text-neutral-600">
              Hover a node to trace its connections · click to pin focus · drag to reposition · scroll to zoom · toggle types above.
            </p>
          </div>
        ) : (
          <Empty text="No graph data yet. Extract entities from OSINT items first." />
        )}
      </Panel>
    </section>
  );
}

function ReportsPanel({ brief, loading, onRefresh }) {
  return (
    <section className="p-5">
      <Panel title="Report generation" loading={loading}>
        <div className="mb-4 flex flex-wrap gap-2">
          <button className="inline-flex items-center gap-2 rounded border border-ops-red bg-red-500/10 px-3 py-2 text-xs font-bold text-ops-red" onClick={onRefresh}>
            <RefreshCw size={13} /> Regenerate brief
          </button>
          <button
            className="inline-flex items-center gap-2 rounded border border-ops-line bg-white/[0.03] px-3 py-2 text-xs font-bold text-neutral-300"
            disabled={!brief?.markdown}
            onClick={() => downloadMarkdown(`osint-brief-${new Date().toISOString().slice(0, 10)}.md`, brief?.markdown || "")}
          >
            <Download size={13} /> Download markdown
          </button>
        </div>
        {brief?.markdown ? (
          <pre className="max-h-[620px] overflow-auto whitespace-pre-wrap rounded border border-white/10 bg-black/40 p-4 text-xs leading-relaxed text-neutral-300">{brief.markdown}</pre>
        ) : <Empty text="No brief generated yet." />}
      </Panel>
    </section>
  );
}

function MetricBox({ label, value, small }) {
  return (
    <div className="rounded border border-white/10 bg-black/25 p-3">
      <div className={`${small ? "text-sm" : "text-xl"} font-black text-ops-red`}>{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
    </div>
  );
}

function EntitiesPanel({ entities, loading }) {
  return (
    <section className="p-5">
      <Panel title="Extracted entities" loading={loading}>
        {entities.length ? (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {entities.map((entity) => (
              <div className="rounded border border-white/10 bg-black/25 p-3" key={`${entity.entity_type}-${entity.value}`}>
                <div className="text-sm font-bold text-neutral-100">{entity.value}</div>
                <div className="mt-1 text-[11px] text-neutral-500">{entity.entity_type} · {entity.mentions} mention(s)</div>
              </div>
            ))}
          </div>
        ) : <Empty text="No entities extracted yet." />}
      </Panel>
    </section>
  );
}

function Panel({ title, children, loading }) {
  return (
    <section className="rounded border border-white/10 bg-black/20 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-neutral-100">{title}</h2>
        {loading ? <RefreshCw size={13} className="animate-spin text-neutral-500" /> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ title, meta, badge }) {
  return (
    <div className="mb-2 flex items-center gap-3 rounded border border-white/10 bg-black/25 p-3">
      <div className="min-w-0 flex-1">
        <div className="break-words text-sm font-bold text-neutral-100">{title}</div>
        <div className="mt-1 break-words text-[11px] text-neutral-500">{meta}</div>
      </div>
      <span className="shrink-0 rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] font-bold text-neutral-400">{badge}</span>
    </div>
  );
}

function Empty({ text }) {
  return <div className="flex h-32 items-center justify-center rounded border border-dashed border-white/10 text-xs text-neutral-600">{text}</div>;
}
