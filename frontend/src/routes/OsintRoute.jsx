import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, FileSearch, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Toast, useToast } from "../components/Toast";
import { ReviewByEvent } from "../components/ReviewByEvent";
import {
  deleteOsintSource,
  listOsintItems,
  listOsintSources,
  getOsintSourceAnalytics,
  getSystemHealth,
  saveOsintSource,
} from "../lib/api";

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

export function OsintRoute() {
  const queryClient = useQueryClient();
  // Reviewing is by event: one card per attack, however many outlets carried
  // it. Monitors, the entity list, the graph, the per-report list and the
  // generated brief were removed in Oct 2026 to keep this page to the work
  // actually done on it.
  const [tab, setTab] = useState("events");
  const { toast, notify, dismiss: dismissToast } = useToast();

  const sourcesQuery = useQuery({
    queryKey: ["osint-sources"],
    queryFn: listOsintSources,
    staleTime: 60_000,
    enabled: tab === "sources",
  });
  const healthQuery = useQuery({
    queryKey: ["system-health"],
    queryFn: getSystemHealth,
    refetchInterval: 60_000,
  });
  const sourceAnalyticsQuery = useQuery({
    queryKey: ["osint-source-analytics"],
    queryFn: getOsintSourceAnalytics,
    enabled: tab === "analytics",
  });

  // How many reports wait for a decision, for the Queue badge.
  const pendingCountQuery = useQuery({
    queryKey: ["osint-pending-count"],
    queryFn: () => listOsintItems({ status: "attention", limit: 1 }),
    refetchInterval: 60000,
  });
  const pendingCount = pendingCountQuery.data?.total ?? 0;

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["osint-review-queue"] });
    await queryClient.invalidateQueries({ queryKey: ["osint-pending-count"] });
    await queryClient.invalidateQueries({ queryKey: ["system-health"] });
  }

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

  const systemHealth = healthQuery.data || healthQuery.error?.body;
  const lastScrapeAt = systemHealth?.osint?.last_scrape_at;
  const scrapeIsFresh = lastScrapeAt && Date.now() - new Date(lastScrapeAt).getTime() < 20 * 60_000;
  const pipelineHealthy = systemHealth?.status === "ok" && scrapeIsFresh;
  const section = ["sources", "analytics"].includes(tab) ? "sources" : "queue";

  return (
    // Padded by the measured height of the app's header and radio bar, which
    // is more than the 3rem this page used to assume - its top sat under them.
    <main className="flex h-screen flex-col bg-ops-bg pt-[var(--ops-chrome)] text-neutral-200">
      <section className="shrink-0 border-b border-white/10 bg-black/40 px-5 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-sm font-bold text-neutral-100">
              <FileSearch size={16} className="text-ops-red" /> OSINT
            </h1>
            <p className="mt-1 text-[11px] text-neutral-500">Review reported incidents and manage collection.</p>
          </div>
          <span
            className={`ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold ${
              pipelineHealthy ? "border-ops-green/40 bg-ops-green/10 text-ops-green" : "border-orange-500/30 bg-orange-500/10 text-orange-300"
            }`}
            title={lastScrapeAt ? `Last collection run ${relativeTime(lastScrapeAt)}` : "Collection health unavailable"}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${pipelineHealthy ? "animate-pulse bg-ops-green" : "bg-orange-400"}`} />
            {healthQuery.isLoading ? "Checking" : pipelineHealthy ? "Healthy" : "Degraded"}
          </span>
          <button
            className="inline-flex items-center gap-2 rounded border border-ops-line px-3 py-1.5 text-[11px] font-bold text-neutral-300 hover:bg-white/5"
            onClick={refresh}
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-bold">
          <TabButton active={section === "queue"} icon={FileSearch} label="Queue" badge={pendingCount} onClick={() => setTab("events")} />
          <TabButton active={section === "sources"} icon={Database} label="Sources" onClick={() => setTab("sources")} />
          {section === "sources" ? <>
            <span className="mx-1 h-4 w-px bg-white/10" />
            <div className="flex flex-wrap items-center gap-1 text-[10px] text-neutral-500">
              <SubnavButton active={tab === "sources"} label="Registry" onClick={() => setTab("sources")} />
              <SubnavButton active={tab === "analytics"} label="Performance" onClick={() => setTab("analytics")} />
            </div>
          </> : null}
        </div>
      </section>

      {tab === "events" ? <ReviewByEvent notify={notify} /> : (
        <div className="min-h-0 flex-1 overflow-y-auto">
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

          {tab === "analytics" ? (
            <AnalyticsPanel
              loading={sourceAnalyticsQuery.isLoading}
              sources={sourceAnalyticsQuery.data?.sources || []}
              trends={sourceAnalyticsQuery.data?.trends || []}
            />
          ) : null}
        </div>
      )}

      <Toast toast={toast} onDismiss={dismissToast} />
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

function SubnavButton({ active, label, onClick }) {
  return (
    <button
      className={`rounded px-2.5 py-1 transition ${
        active ? "bg-white/10 text-neutral-100" : "hover:bg-white/[0.05] hover:text-neutral-300"
      }`}
      onClick={onClick}
    >
      {label}
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

function MetricBox({ label, value, small }) {
  return (
    <div className="rounded border border-white/10 bg-black/25 p-3">
      <div className={`${small ? "text-sm" : "text-xl"} font-black text-ops-red`}>{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
    </div>
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
