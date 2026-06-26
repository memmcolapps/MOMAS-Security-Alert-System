import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Bell, CheckCircle2, Database, Download, ExternalLink, FileSearch, GitBranch, Link2, Network, Plus, RefreshCw, Search, ShieldCheck, Tags, Trash2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
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

function snippet(item) {
  const text = item?.description || item?.content_text || "";
  return text.length > 260 ? `${text.slice(0, 260)}...` : text;
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

export function OsintRoute() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("inbox");
  const [status, setStatus] = useState("pending");
  const [sourceType, setSourceType] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [alertStatus, setAlertStatus] = useState("new");
  const [selectedId, setSelectedId] = useState(null);
  const [note, setNote] = useState("");
  const [incidentId, setIncidentId] = useState("");
  const [sourceForm, setSourceForm] = useState({ name: "", source_type: "rss", locator: "", keywords: "", reliability_score: 50, cadence_minutes: 30, enabled: true, notes: "" });
  const [watchlistForm, setWatchlistForm] = useState({ name: "", query_text: "", severity: "YELLOW", enabled: true, rule_type: "all_terms", min_confidence: 0, window_hours: 24 });
  const [toast, setToast] = useState(null);

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

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["osint-items"] });
    await queryClient.invalidateQueries({ queryKey: ["osint-alerts"] });
    await queryClient.invalidateQueries({ queryKey: ["osint-entities"] });
    if (selectedId) await queryClient.invalidateQueries({ queryKey: ["osint-item", selectedId] });
  }

  const reviewMutation = useMutation({
    mutationFn: ({ id, payload }) => reviewOsintItem(id, payload),
    onSuccess: async () => {
      setToast("Review saved");
      await refresh();
    },
    onError: async (error) => {
      setToast(error.message);
      await refresh();
    },
  });

  const promoteMutation = useMutation({
    mutationFn: ({ id, payload }) => promoteOsintItem(id, payload),
    onSuccess: async (result) => {
      setToast(result?.promoted?.status === "merged" ? "Linked to matching incident" : "Promoted to incident");
      await queryClient.invalidateQueries({ queryKey: ["incidents"] });
      await refresh();
    },
    onError: async (error) => {
      setToast(error.message);
      await refresh();
    },
  });

  const linkMutation = useMutation({
    mutationFn: ({ id, payload }) => linkOsintItem(id, payload),
    onSuccess: async () => {
      setToast("Linked to incident");
      await queryClient.invalidateQueries({ queryKey: ["incidents"] });
      await refresh();
    },
    onError: (error) => setToast(error.message),
  });

  const extractMutation = useMutation({
    mutationFn: extractOsintItem,
    onSuccess: async (result) => {
      setToast(`Extracted ${result.entities?.length || 0} entities, ${result.alerts?.length || 0} alert match(es)`);
      await refresh();
    },
    onError: (error) => setToast(error.message),
  });

  const sourceMutation = useMutation({
    mutationFn: saveOsintSource,
    onSuccess: async () => {
      setToast("Source saved");
      setSourceForm({ name: "", source_type: "rss", locator: "", keywords: "", reliability_score: 50, cadence_minutes: 30, enabled: true, notes: "" });
      await queryClient.invalidateQueries({ queryKey: ["osint-sources"] });
    },
    onError: (error) => setToast(error.message),
  });

  const watchlistMutation = useMutation({
    mutationFn: saveOsintWatchlist,
    onSuccess: async () => {
      setToast("Watchlist saved");
      setWatchlistForm({ name: "", query_text: "", severity: "YELLOW", enabled: true, rule_type: "all_terms", min_confidence: 0, window_hours: 24 });
      await queryClient.invalidateQueries({ queryKey: ["osint-watchlists"] });
    },
    onError: (error) => setToast(error.message),
  });

  const deleteWatchlistMutation = useMutation({
    mutationFn: deleteOsintWatchlist,
    onSuccess: async () => {
      setToast("Watchlist removed");
      await queryClient.invalidateQueries({ queryKey: ["osint-watchlists"] });
    },
    onError: (error) => setToast(error.message),
  });

  const alertStatusMutation = useMutation({
    mutationFn: ({ id, status }) => updateOsintAlertStatus(id, status),
    onSuccess: async () => {
      setToast("Alert updated");
      await queryClient.invalidateQueries({ queryKey: ["osint-alerts"] });
    },
    onError: (error) => setToast(error.message),
  });

  const evaluateAlertsMutation = useMutation({
    mutationFn: evaluateOsintAlerts,
    onSuccess: async (result) => {
      setToast(`Scanned ${result.scanned || 0}; created ${result.alerts_created || 0}, updated ${result.alerts_updated || 0}`);
      await queryClient.invalidateQueries({ queryKey: ["osint-alerts"] });
    },
    onError: (error) => setToast(error.message),
  });

  function saveReview(nextStatus) {
    if (!detail) return;
    reviewMutation.mutate({
      id: detail.id,
      payload: { status: nextStatus, analyst_note: note },
    });
  }

  function promote() {
    if (!detail) return;
    promoteMutation.mutate({ id: detail.id, payload: { analyst_note: note } });
  }

  function linkToIncident() {
    if (!detail || !incidentId.trim()) {
      setToast("Enter an incident ID first");
      return;
    }
    linkMutation.mutate({
      id: detail.id,
      payload: { incident_id: incidentId.trim(), analyst_note: note },
    });
  }

  const busy = reviewMutation.isPending || promoteMutation.isPending || linkMutation.isPending || extractMutation.isPending;

  return (
    <main className="min-h-screen bg-ops-bg pt-12 text-neutral-200">
      <section className="border-b border-white/10 bg-black/40 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-sm font-bold text-neutral-100">
              <FileSearch size={16} className="text-ops-red" /> OSINT Inbox
            </h1>
            <p className="mt-1 text-[11px] text-neutral-500">
              Review collected source items, preserve evidence, and promote confirmed reports.
            </p>
          </div>
          <button
            className="ml-auto inline-flex items-center gap-2 rounded border border-ops-line px-3 py-1.5 text-[11px] font-bold text-neutral-300 hover:bg-white/5"
            onClick={refresh}
          >
            <RefreshCw size={13} className={listQuery.isFetching ? "animate-spin" : ""} /> Refresh
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-bold">
          <TabButton active={tab === "inbox"} icon={FileSearch} label="Inbox" onClick={() => setTab("inbox")} />
          <TabButton active={tab === "alerts"} icon={Bell} label="Alerts" onClick={() => setTab("alerts")} />
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

      {tab === "inbox" ? <section className="grid min-h-[calc(100vh-207px)] lg:grid-cols-[420px_1fr]">
        <aside className="border-r border-white/10 bg-black/25">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-[11px] text-neutral-500">
            <span>{listQuery.data?.total ?? items.length} item(s)</span>
            {listQuery.isLoading ? <span>Loading...</span> : null}
          </div>
          <div className="max-h-[calc(100vh-207px)] overflow-y-auto">
            {listQuery.isError ? (
              <ErrorState error={listQuery.error} onRetry={() => listQuery.refetch()} />
            ) : items.length ? (
              items.map((item) => (
                <button
                  key={item.id}
                  className={`block w-full border-b border-white/5 px-4 py-3 text-left hover:bg-white/[0.04] ${
                    Number(selectedId) === Number(item.id) ? "bg-white/[0.06]" : ""
                  }`}
                  onClick={() => setSelectedId(item.id)}
                >
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
                      <span className={`shrink-0 font-black ${confidenceColor(item.confidence_score)}`}>
                        {item.confidence_score}%
                      </span>
                    ) : null}
                    <span className="ml-auto shrink-0">{formatDate(item.published_at || item.created_at)}</span>
                  </div>
                </button>
              ))
            ) : (
              <div className="flex h-72 flex-col items-center justify-center px-8 text-center text-xs text-neutral-600">
                <FileSearch size={28} className="mb-2" />
                No OSINT items match this filter.
              </div>
            )}
          </div>
          {!listQuery.isError && (page > 0 || (page + 1) * 50 < Number(listQuery.data?.total || 0)) ? (
            <div className="flex items-center justify-between border-t border-white/10 p-2 text-[11px]">
              <button className="rounded border border-white/10 px-3 py-1.5 disabled:opacity-40" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous</button>
              <span className="text-neutral-500">Page {page + 1}</span>
              <button className="rounded border border-white/10 px-3 py-1.5 disabled:opacity-40" disabled={(page + 1) * 50 >= Number(listQuery.data?.total || 0)} onClick={() => setPage((value) => value + 1)}>Next</button>
            </div>
          ) : null}
        </aside>

        <article className="min-w-0 p-5">
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
                    {snippet(detail) || "No text captured for this item."}
                  </div>
                  {detail.content_text && detail.content_text !== detail.description ? (
                    <details className="mt-3 rounded border border-white/10 bg-black/20 p-3 text-xs text-neutral-400">
                      <summary className="cursor-pointer font-bold text-neutral-300">Full extracted text</summary>
                      <div className="mt-3 whitespace-pre-wrap leading-relaxed">{detail.content_text}</div>
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
            </div>
          )}
        </article>
      </section> : null}

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
          onDelete={(id) => {
            if (window.confirm("Delete this watchlist?")) deleteWatchlistMutation.mutate(id);
          }}
          onSubmit={() => watchlistMutation.mutate(watchlistForm)}
          pending={watchlistMutation.isPending || deleteWatchlistMutation.isPending}
          watchlists={watchlistsQuery.data?.watchlists || []}
        />
      ) : null}

      {tab === "sources" ? (
        <SourcesPanel
          discovered={sourcesQuery.data?.discovered || []}
          form={sourceForm}
          loading={sourcesQuery.isLoading}
          onChange={setSourceForm}
          onSubmit={() => sourceMutation.mutate(sourceForm)}
          pending={sourceMutation.isPending}
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

      {toast ? (
        <div className="fixed bottom-5 right-5 z-[1200] rounded border border-white/10 bg-black/90 px-4 py-2 text-xs font-bold text-neutral-200 shadow-xl">
          {toast}
        </div>
      ) : null}
    </main>
  );
}

function TabButton({ active, icon: Icon, label, onClick }) {
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded border px-3 py-1.5 transition ${
        active ? "border-ops-red bg-red-500/10 text-ops-red" : "border-white/10 bg-white/[0.03] text-neutral-400 hover:text-neutral-100"
      }`}
      onClick={onClick}
    >
      <Icon size={13} /> {label}
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

function SourcesPanel({ sources, discovered, form, onChange, onSubmit, loading, pending }) {
  return (
    <section className="grid gap-5 p-5 lg:grid-cols-[360px_1fr]">
      <aside className="rounded border border-white/10 bg-black/25 p-4">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-bold text-neutral-100"><Database size={15} className="text-ops-red" /> Source metadata</h2>
        <div className="grid gap-3">
          <Field label="Name"><input className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} /></Field>
          <Field label="Type"><input className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" value={form.source_type} onChange={(e) => onChange({ ...form, source_type: e.target.value })} /></Field>
          <Field label="Locator / URL / channel"><input className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" value={form.locator} onChange={(e) => onChange({ ...form, locator: e.target.value })} /></Field>
          <Field label="Keywords"><textarea className="mt-1 h-16 w-full resize-none rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" value={form.keywords} onChange={(e) => onChange({ ...form, keywords: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Reliability"><input className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" type="number" value={form.reliability_score} onChange={(e) => onChange({ ...form, reliability_score: Number(e.target.value) })} /></Field>
            <Field label="Cadence min"><input className="mt-1 w-full rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" type="number" value={form.cadence_minutes} onChange={(e) => onChange({ ...form, cadence_minutes: Number(e.target.value) })} /></Field>
          </div>
          <Field label="Notes"><textarea className="mt-1 h-16 w-full resize-none rounded border border-ops-line bg-black/60 p-2 text-xs font-normal outline-none" value={form.notes} onChange={(e) => onChange({ ...form, notes: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-xs text-neutral-300"><input type="checkbox" checked={form.enabled} onChange={(e) => onChange({ ...form, enabled: e.target.checked })} /> Enabled</label>
          <button disabled={pending} className="inline-flex items-center justify-center gap-2 rounded border border-ops-red bg-red-500/10 px-3 py-2 text-xs font-bold text-ops-red disabled:opacity-50" onClick={onSubmit}>
            <Plus size={13} /> Save source
          </button>
        </div>
      </aside>

      <div className="grid gap-5">
        <Panel title="Managed sources" loading={loading}>
          {sources.length ? sources.map((source) => (
            <div className="mb-2 flex items-center gap-3 rounded border border-white/10 bg-black/25 p-3" key={source.id}>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-neutral-100">{source.name}</div>
                <div className="mt-1 text-[11px] text-neutral-500">{source.source_type} · reliability {source.reliability_score}% · every {source.cadence_minutes} min</div>
              </div>
              <span className="rounded border border-white/10 px-2 py-0.5 text-[9px] uppercase text-neutral-500">{source.enabled ? "enabled" : "disabled"}</span>
              <button className="rounded border border-white/10 px-2 py-1 text-[10px] text-neutral-400" onClick={() => onChange({ ...source, notes: source.notes || "", keywords: source.keywords || "" })}>Edit</button>
            </div>
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

function WatchlistsPanel({ watchlists, form, onChange, onSubmit, onDelete, loading, pending }) {
  return (
    <section className="grid gap-5 p-5 lg:grid-cols-[360px_1fr]">
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
          <div className="mb-2 flex items-center gap-3 rounded border border-white/10 bg-black/25 p-3" key={watchlist.id}>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-neutral-100">{watchlist.name}</div>
              <div className="mt-1 text-[11px] text-neutral-500">
                {watchlist.query_text} · {watchlist.severity} · {watchlist.rule_type || "all_terms"} · min {watchlist.min_confidence || 0}%
              </div>
            </div>
            <button className="rounded border border-white/10 px-2 py-1 text-[10px] text-neutral-400" onClick={() => onChange({ ...watchlist })}>Edit</button>
            <button disabled={pending} className="rounded p-2 text-neutral-500 hover:text-ops-red disabled:opacity-40" onClick={() => onDelete(watchlist.id)}><Trash2 size={14} /></button>
          </div>
        )) : <Empty text="No watchlists yet." />}
      </Panel>
    </section>
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

function GraphPanel({ graph, loading }) {
  const nodes = useMemo(() => graph.nodes || [], [graph.nodes]);
  const edges = graph.edges || [];
  const positioned = useMemo(() => {
    const width = 960;
    const byType = {
      source: nodes.filter((node) => node.type === "source"),
      incident: nodes.filter((node) => node.type === "incident"),
      actor: nodes.filter((node) => node.type === "actor"),
      location: nodes.filter((node) => node.type === "location"),
      organization: nodes.filter((node) => node.type === "organization"),
      route: nodes.filter((node) => node.type === "route"),
      impact: nodes.filter((node) => node.type === "impact"),
    };
    const height = Math.max(560, 110 + Math.max(1, ...Object.values(byType).map((group) => group.length)) * 48);
    const placements = new Map();
    const columns = [
      ["source", 120],
      ["actor", 330],
      ["organization", 470],
      ["location", 610],
      ["route", 720],
      ["impact", 790],
      ["incident", 870],
    ];
    for (const [type, x] of columns) {
      const group = byType[type] || [];
      group.forEach((node, index) => {
        placements.set(node.id, { ...node, x, y: 55 + index * 48 });
      });
    }
    return { width, height, nodes: Array.from(placements.values()), placements };
  }, [nodes]);

  const colorFor = (type) => ({
    source: "#38bdf8",
    incident: "#ef4444",
    actor: "#f59e0b",
    location: "#22c55e",
    organization: "#a78bfa",
    route: "#14b8a6",
    impact: "#f97316",
  }[type] || "#aaa");

  return (
    <section className="p-5">
      <Panel title="Entity / source graph" loading={loading}>
        {nodes.length ? (
          <div className="overflow-auto rounded border border-white/10 bg-black/30 p-3">
            <svg viewBox={`0 0 ${positioned.width} ${positioned.height}`} width={positioned.width} height={positioned.height} className="min-w-[960px]">
              {edges.map((edge, index) => {
                const source = positioned.placements.get(edge.source);
                const target = positioned.placements.get(edge.target);
                if (!source || !target) return null;
                return <line key={`${edge.source}-${edge.target}-${index}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke="rgba(255,255,255,.16)" strokeWidth={Math.max(1, Math.min(4, edge.weight || 1))} />;
              })}
              {positioned.nodes.map((node) => (
                <g key={node.id}>
                  <circle cx={node.x} cy={node.y} r={Math.max(7, Math.min(18, 6 + Number(node.weight || 1)))} fill={colorFor(node.type)} opacity="0.9" />
                  <text x={node.x + 14} y={node.y + 4} fill="#d4d4d4" fontSize="11">{String(node.label).slice(0, 34)}</text>
                  <text x={node.x + 14} y={node.y + 17} fill="#737373" fontSize="9">{node.type}</text>
                </g>
              ))}
            </svg>
          </div>
        ) : <Empty text="No graph data yet. Extract entities from OSINT items first." />}
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
        <div className="truncate text-sm font-bold text-neutral-100">{title}</div>
        <div className="mt-1 text-[11px] text-neutral-500">{meta}</div>
      </div>
      <span className="rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] font-bold text-neutral-400">{badge}</span>
    </div>
  );
}

function Empty({ text }) {
  return <div className="flex h-32 items-center justify-center rounded border border-dashed border-white/10 text-xs text-neutral-600">{text}</div>;
}
