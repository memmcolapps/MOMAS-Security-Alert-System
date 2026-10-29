import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Newspaper, RefreshCw, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { approveReviewEvent, dismissReviewEvent, getReviewQueue } from "../lib/api";

// Reasons a reviewer gives most often, so approving rarely needs typing. The
// first fits an event several outlets carried and is chosen for those.
const REASONS = [
  "Reported by several independent outlets",
  "Credible outlet with specific details",
  "Confirmed by our own contact",
];

const TYPE_LABELS = {
  massacre: "Massacre",
  banditry: "Banditry",
  armed_attack: "Armed attack",
  terrorism: "Terrorism",
  kidnapping: "Kidnapping",
  bombing: "Bombing",
  displacement: "Displacement",
};

function age(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

function scoreTone(score) {
  return score >= 70 ? "text-ops-green" : score >= 55 ? "text-yellow-300" : "text-orange-300";
}

/**
 * The review queue by event. Every outlet's report of one attack is a single
 * card, led by its strongest report; one approval publishes the event and
 * attaches the rest as evidence, one dismissal clears them all.
 */
export function ReviewByEvent({ notify }) {
  const queryClient = useQueryClient();
  const [recentOnly, setRecentOnly] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [reasons, setReasons] = useState({});
  const [notes, setNotes] = useState({});

  const queueQuery = useQuery({ queryKey: ["osint-review-queue"], queryFn: getReviewQueue, refetchInterval: 60_000 });
  const allEvents = useMemo(() => queueQuery.data?.events || [], [queueQuery.data?.events]);
  const events = useMemo(() => (recentOnly ? allEvents.filter((event) => !event.stale) : allEvents), [allEvents, recentOnly]);
  const selected = events.find((event) => event.id === selectedId) || events[0] || null;

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["osint-review-queue"] });
    await queryClient.invalidateQueries({ queryKey: ["osint-items"] });
    await queryClient.invalidateQueries({ queryKey: ["osint-pending-count"] });
  }, [queryClient]);

  const noteFor = useCallback(
    (event) => {
      const typed = (notes[event.id] || "").trim();
      const reason = reasons[event.id] ?? (event.outlets >= 2 ? REASONS[0] : null);
      return [reason, typed].filter(Boolean).join(" — ") || null;
    },
    [notes, reasons],
  );

  // After a decision the next card is selected, so a reviewer can work down
  // the queue without reaching for the mouse.
  const advance = useCallback(
    (event) => {
      const index = events.findIndex((candidate) => candidate.id === event.id);
      const next = events[index + 1] || events[index - 1] || null;
      setSelectedId(next?.id ?? null);
    },
    [events],
  );

  // A decision takes the card off the screen the moment it is made; the
  // server catches up behind it. Waiting for the round trip and a reload of
  // the whole queue cost 1-3 seconds a card. If the server refuses, the queue
  // is reloaded and the card comes back with the reason.
  const decisionCallbacks = {
    mutationKey: ["review-decision"],
    onMutate: async (event) => {
      await queryClient.cancelQueries({ queryKey: ["osint-review-queue"] });
      advance(event);
      queryClient.setQueryData(["osint-review-queue"], (current) =>
        current
          ? {
              ...current,
              events: current.events.filter((candidate) => candidate.id !== event.id),
              reports: Math.max(0, (current.reports || 0) - event.reports.length),
            }
          : current,
      );
    },
    onError: (error) => notify(error.message, "error"),
    // Reloaded once the last decision in flight is done, so an earlier reply
    // cannot bring back a card whose own decision is still on its way.
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: ["review-decision"] }) <= 1) void refresh();
    },
  };

  const approve = useMutation({
    ...decisionCallbacks,
    mutationFn: (event) => approveReviewEvent({ lead_id: event.id, ids: event.reports.map((report) => report.id), analyst_note: noteFor(event) }),
    onSuccess: (result) => {
      notify(
        result.status === "merged"
          ? "Added to an existing incident"
          : `Published${result.attached ? `, with ${result.attached} more report${result.attached === 1 ? "" : "s"} attached` : ""}`,
        "success",
      );
      void queryClient.invalidateQueries({ queryKey: ["incidents"] });
    },
  });

  const dismiss = useMutation({
    ...decisionCallbacks,
    mutationFn: (event) => dismissReviewEvent({ lead_id: event.id, ids: event.reports.map((report) => report.id), analyst_note: (notes[event.id] || "").trim() || null }),
    onSuccess: (result) => notify(`Dismissed ${result.dismissed} report${result.dismissed === 1 ? "" : "s"}`, "success"),
  });

  // j/k to move, a to approve, d to dismiss - ignored while typing a note.
  useEffect(() => {
    function onKey(event) {
      const el = event.target;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || !selected) return;
      const index = events.findIndex((candidate) => candidate.id === selected.id);
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedId((events[index + 1] || selected).id);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedId((events[index - 1] || selected).id);
      } else if (event.key === "a") {
        event.preventDefault();
        approve.mutate(selected);
      } else if (event.key === "d") {
        event.preventDefault();
        dismiss.mutate(selected);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [events, selected, approve, dismiss]);

  const hidden = allEvents.length - events.length;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 px-4 py-2 text-[11px] text-neutral-500">
        <span>
          <span className="font-bold text-neutral-200">{events.length}</span> event{events.length === 1 ? "" : "s"} ·{" "}
          {queueQuery.data?.reports ?? 0} reports waiting
        </span>
        <label className="inline-flex items-center gap-1.5">
          <input type="checkbox" checked={recentOnly} onChange={(event) => setRecentOnly(event.target.checked)} />
          Last 3 days only{hidden && recentOnly ? ` (${hidden} older hidden)` : ""}
        </label>
        <span className="ml-auto hidden text-neutral-600 md:inline">j/k move · a approve · d dismiss</span>
        {queueQuery.isFetching ? <RefreshCw size={12} className="animate-spin" /> : null}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {queueQuery.isLoading ? <p className="p-6 text-center text-xs text-neutral-500">Loading the queue…</p> : null}
        {!queueQuery.isLoading && !events.length ? (
          <p className="p-6 text-center text-xs text-neutral-500">
            Nothing waiting{recentOnly && hidden ? " from the last 3 days" : ""}.
          </p>
        ) : null}
        {events.map((event) => {
          const active = selected?.id === event.id;
          const chosen = reasons[event.id] ?? (event.outlets >= 2 ? REASONS[0] : null);
          return (
            <article
              key={event.id}
              onClick={() => setSelectedId(event.id)}
              className={`rounded-lg border p-3 transition ${active ? "border-ops-red/60 bg-white/[0.05]" : "border-white/10 bg-white/[0.02] hover:border-white/20"}`}
            >
              <div className="flex flex-wrap items-start gap-2">
                <h3 className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-neutral-100">{event.title}</h3>
                <span className={`shrink-0 text-sm font-black tabular-nums ${scoreTone(event.score)}`}>{event.score}%</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-neutral-500">
                <span className="font-bold text-neutral-300">{TYPE_LABELS[event.type] || event.type || "Incident"}</span>
                <span>{[event.location, event.state].filter(Boolean).join(" · ") || "Place unknown"}</span>
                {event.date ? <span>{new Date(event.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span> : null}
                <span>last report {age(event.lastSeen)}</span>
                <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-bold ${event.outlets >= 2 ? "bg-ops-green/15 text-ops-green" : "bg-white/5 text-neutral-400"}`}>
                  <Newspaper size={10} /> {event.outlets} outlet{event.outlets === 1 ? "" : "s"}
                </span>
                {event.stale ? <span className="rounded bg-white/5 px-1.5 py-0.5 text-neutral-500">older than 3 days</span> : null}
              </div>
              {event.blockers.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {event.blockers.map((blocker) => (
                    <span key={blocker} className="rounded border border-orange-500/25 bg-orange-500/[0.06] px-1.5 py-0.5 text-[10px] text-orange-200/90">
                      {blocker}
                    </span>
                  ))}
                </div>
              ) : null}

              <ul className="mt-2 space-y-1 border-t border-white/5 pt-2">
                {(active ? event.reports : event.reports.slice(0, 3)).map((report) => (
                  <li key={report.id} className="flex items-center gap-2 text-[11px]">
                    <span className="w-28 shrink-0 truncate font-bold text-neutral-400">{report.source}</span>
                    <span className="min-w-0 flex-1 truncate text-neutral-300">{report.title}</span>
                    <span className={`shrink-0 tabular-nums ${scoreTone(report.score)}`}>{report.score}%</span>
                    {report.url ? (
                      <a href={report.url} target="_blank" rel="noreferrer" onClick={(click) => click.stopPropagation()} className="shrink-0 text-neutral-500 hover:text-neutral-200" aria-label="Open the article">
                        <ExternalLink size={11} />
                      </a>
                    ) : null}
                  </li>
                ))}
                {!active && event.reports.length > 3 ? <li className="text-[10px] text-neutral-600">+{event.reports.length - 3} more</li> : null}
              </ul>

              {active ? (
                <div className="mt-3 space-y-2 border-t border-white/5 pt-2" onClick={(click) => click.stopPropagation()}>
                  <div className="flex flex-wrap gap-1">
                    {REASONS.map((reason) => (
                      <button
                        key={reason}
                        onClick={() => setReasons((current) => ({ ...current, [event.id]: chosen === reason ? "" : reason }))}
                        className={`rounded border px-2 py-0.5 text-[10px] ${chosen === reason ? "border-ops-green/60 bg-ops-green/15 text-ops-green" : "border-white/10 text-neutral-400 hover:text-neutral-200"}`}
                      >
                        {reason}
                      </button>
                    ))}
                  </div>
                  <input
                    value={notes[event.id] || ""}
                    onChange={(change) => setNotes((current) => ({ ...current, [event.id]: change.target.value }))}
                    placeholder="Add a note (optional)"
                    className="w-full rounded border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-neutral-200 outline-none placeholder:text-neutral-600"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      disabled={event.score < 70 && !noteFor(event)}
                      onClick={() => approve.mutate(event)}
                      title={event.score < 70 && !noteFor(event) ? "Pick a reason or write a note first" : "Publish this event"}
                      className="inline-flex items-center gap-1.5 rounded bg-ops-green/20 px-3 py-1.5 text-[11px] font-bold text-ops-green hover:bg-ops-green/30 disabled:opacity-40"
                    >
                      <CheckCircle2 size={13} /> Approve{event.reports.length > 1 ? ` all ${event.reports.length}` : ""}
                    </button>
                    <button
                      onClick={() => dismiss.mutate(event)}
                      className="inline-flex items-center gap-1.5 rounded border border-white/10 px-3 py-1.5 text-[11px] font-bold text-neutral-300 hover:border-red-400/50 hover:text-red-300 disabled:opacity-40"
                    >
                      <XCircle size={13} /> Dismiss
                    </button>
                    <span className={`text-[10px] ${event.score < 70 && !noteFor(event) ? "text-orange-300/80" : "text-neutral-600"}`}>
                      {event.score < 70 && !noteFor(event)
                        ? "Pick a reason above to approve, or leave it to wait for another outlet."
                        : "Or leave it here to wait for another outlet."}
                    </span>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
