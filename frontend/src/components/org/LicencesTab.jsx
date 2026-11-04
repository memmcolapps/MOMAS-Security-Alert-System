import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, CreditCard, Pencil, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { getMe, getOrganizationLicences, rechargeOrganizationLicences, setOrganizationYearCards } from "../../lib/api";
import { isPlatformOperator, isPlatformOwner } from "../../lib/platform-roles";
import { Empty, FilterChips, List, SkeletonRows, formatDateTime, plural } from "./shared";

const DAY = 86_400_000;
const SOON_DAYS = 30;

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function addYears(value, years) {
  const next = new Date(value);
  const day = next.getDate();
  next.setDate(1);
  next.setFullYear(next.getFullYear() + years);
  next.setDate(Math.min(day, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
  return next;
}

// Same rule the radio server applies, so the list can show the result before
// the server answers: a live licence extends from its expiry, an expired one
// starts again today.
function nextExpiry(account, years) {
  const end = account.serviceEndsAt ? new Date(account.serviceEndsAt) : null;
  return addYears(end && end > new Date() ? end : startOfToday(), years);
}

function status(account) {
  const end = account.serviceEndsAt ? new Date(account.serviceEndsAt).getTime() : null;
  if (!account.activated) return { key: "expired", label: "Not activated", tone: "text-amber-300 border-amber-400/30 bg-amber-400/10" };
  if (!end || end <= Date.now()) return { key: "expired", label: "Expired", tone: "text-red-300 border-red-500/30 bg-red-500/10" };
  const days = Math.ceil((end - Date.now()) / DAY);
  if (days <= SOON_DAYS) return { key: "soon", label: `${days} day${days === 1 ? "" : "s"} left`, tone: "text-amber-300 border-amber-400/30 bg-amber-400/10" };
  return { key: "active", label: "Active", tone: "text-neutral-400 border-white/10 bg-white/[0.03]" };
}

function formatDay(value) {
  if (!value) return "No date";
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// The organization's annual cards: how many it has left, when each radio and
// dispatcher runs out, and recharging them. One card is one year on one
// account. A platform owner can also set any date with no card.
export function LicencesTab({ orgId }) {
  const queryClient = useQueryClient();
  const key = useMemo(() => ["org-licences", orgId], [orgId]);
  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const canRecharge = isPlatformOperator(meQuery.data?.user);
  const canOwn = isPlatformOwner(meQuery.data?.user);
  const licencesQuery = useQuery({ queryKey: key, queryFn: () => getOrganizationLicences(orgId), staleTime: 30_000 });

  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(() => new Set());

  const data = licencesQuery.data;
  const accounts = useMemo(() => data?.accounts || [], [data?.accounts]);
  const counts = useMemo(() => {
    const next = { expired: 0, soon: 0, radios: 0, dispatchers: 0 };
    for (const account of accounts) {
      const key = status(account).key;
      if (key === "expired") next.expired += 1;
      if (key === "soon") next.soon += 1;
      if (account.kind === "radio") next.radios += 1;
      else next.dispatchers += 1;
    }
    return next;
  }, [accounts]);

  const term = search.trim().toLowerCase();
  const shown = accounts.filter((account) => {
    if (filter === "expired" && status(account).key !== "expired") return false;
    if (filter === "soon" && status(account).key !== "soon") return false;
    if (filter === "radios" && account.kind !== "radio") return false;
    if (filter === "dispatchers" && account.kind !== "dispatcher") return false;
    return !term || `${account.name} ${account.account}`.toLowerCase().includes(term);
  });
  const allShownSelected = shown.length > 0 && shown.every((account) => selected.has(account.uid));

  const toggle = (uid) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    return next;
  });
  const toggleShown = () => setSelected((current) => {
    const next = new Set(current);
    for (const account of shown) {
      if (allShownSelected) next.delete(account.uid);
      else next.add(account.uid);
    }
    return next;
  });

  // Writes show at once and roll back if the radio network refuses them.
  const optimistic = (apply) => async (payload) => {
    await queryClient.cancelQueries({ queryKey: key });
    const previous = queryClient.getQueryData(key);
    if (previous) queryClient.setQueryData(key, apply(previous, payload));
    return { previous };
  };
  const rollback = (_error, _payload, context) => {
    if (context?.previous) queryClient.setQueryData(key, context.previous);
  };
  const settle = () => {
    queryClient.invalidateQueries({ queryKey: key });
    queryClient.invalidateQueries({ queryKey: ["org-admin", orgId] });
  };

  const recharge = useMutation({
    mutationFn: (payload) => rechargeOrganizationLicences(orgId, payload),
    onMutate: optimistic((current, payload) => {
      const picked = new Set(payload.uids);
      const until = payload.until ? new Date(`${payload.until}T00:00:00`) : null;
      return {
        ...current,
        yearCards: until ? current.yearCards : current.yearCards - picked.size * payload.years,
        accounts: current.accounts.map((account) => (picked.has(account.uid)
          ? { ...account, activated: true, serviceEndsAt: (until || nextExpiry(account, payload.years)).toISOString() }
          : account)),
      };
    }),
    onError: rollback,
    onSuccess: () => setSelected(new Set()),
    onSettled: settle,
  });

  const setCards = useMutation({
    mutationFn: (yearCards) => setOrganizationYearCards(orgId, yearCards),
    onMutate: optimistic((current, yearCards) => ({ ...current, yearCards })),
    onError: rollback,
    onSettled: settle,
  });

  if (licencesQuery.error) {
    return <p className="text-xs text-ops-red">{licencesQuery.error.message}</p>;
  }

  const error = recharge.error || setCards.error;

  return (
    <section className="space-y-5">
      <div className="grid gap-3 md:grid-cols-4">
        <CardBalance
          value={data?.yearCards}
          loading={licencesQuery.isLoading}
          canEdit={canOwn}
          saving={setCards.isPending}
          onSave={(value) => setCards.mutate(value)}
        />
        <Stat label="Expired or off" value={counts.expired} tone={counts.expired ? "text-red-300" : ""} loading={licencesQuery.isLoading} />
        <Stat label={`Ending in ${SOON_DAYS} days`} value={counts.soon} tone={counts.soon ? "text-amber-300" : ""} loading={licencesQuery.isLoading} />
        <Stat label="Accounts" value={accounts.length} hint={`${plural(counts.radios, "radio")} · ${plural(counts.dispatchers, "dispatcher")}`} loading={licencesQuery.isLoading} />
      </div>

      {error ? (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">{error.message}</p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterChips
          value={filter}
          onChange={setFilter}
          options={[
            { key: "all", label: "All" },
            { key: "expired", label: `Expired (${counts.expired})` },
            { key: "soon", label: `Ending soon (${counts.soon})` },
            { key: "radios", label: "Radios" },
            { key: "dispatchers", label: "Dispatchers" },
          ]}
        />
        <label className="flex w-full items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-neutral-500 sm:w-64">
          <Search size={12} />
          <input
            className="w-full bg-transparent text-[11px] text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
            placeholder="Find a radio or dispatcher"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>

      {canRecharge && selected.size ? (
        <RechargeBar
          count={selected.size}
          cards={data?.yearCards ?? 0}
          canOwn={canOwn}
          pending={recharge.isPending}
          onClear={() => setSelected(new Set())}
          onRecharge={(payload) => recharge.mutate({ uids: [...selected], ...payload })}
        />
      ) : null}

      <List
        title={licencesQuery.isLoading ? "Loading…" : `${plural(shown.length, "account")}`}
        action={canRecharge && shown.length ? (
          <button type="button" className="text-[11px] font-bold text-neutral-400 hover:text-neutral-100" onClick={toggleShown}>
            {allShownSelected ? "Clear selection" : "Select all shown"}
          </button>
        ) : null}
      >
        {licencesQuery.isLoading ? <SkeletonRows /> : null}
        {!licencesQuery.isLoading && !shown.length ? (
          <Empty>{accounts.length ? "Nothing matches this filter." : "This organization has no radios or dispatchers yet."}</Empty>
        ) : null}
        {shown.map((account) => {
          const state = status(account);
          const checked = selected.has(account.uid);
          return (
            <label
              key={account.uid}
              className={`flex items-center gap-3 px-4 py-2.5 text-[12px] ${canRecharge ? "cursor-pointer hover:bg-white/[0.03]" : ""} ${checked ? "bg-white/[0.04]" : ""}`}
            >
              {canRecharge ? (
                <input type="checkbox" className="accent-red-500" checked={checked} onChange={() => toggle(account.uid)} />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-neutral-100">{account.name}</span>
                <span className="block truncate text-[10px] text-neutral-500">
                  {account.kind === "dispatcher" ? "Dispatcher" : "Radio"} · {account.account}
                </span>
              </span>
              <span className="hidden w-32 shrink-0 text-right text-[11px] text-neutral-400 sm:block">{formatDay(account.serviceEndsAt)}</span>
              <span className={`w-28 shrink-0 rounded-full border px-2 py-0.5 text-center text-[10px] font-bold ${state.tone}`}>{state.label}</span>
            </label>
          );
        })}
      </List>

      <History rows={data?.history || []} loading={licencesQuery.isLoading} />
    </section>
  );
}

function Stat({ label, value, hint, tone = "", loading }) {
  return (
    <div className="glass-panel rounded-lg px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</p>
      {loading ? (
        <span className="mt-2 block h-6 w-12 animate-pulse rounded bg-white/[0.07]" />
      ) : (
        <p className={`mt-1 text-2xl font-bold text-neutral-100 ${tone}`}>{value}</p>
      )}
      {hint && !loading ? <p className="text-[10px] text-neutral-500">{hint}</p> : null}
    </div>
  );
}

function CardBalance({ value, loading, canEdit, saving, onSave }) {
  const [draft, setDraft] = useState(null);
  const editing = draft !== null;
  const parsed = Number(draft);
  const valid = editing && draft !== "" && Number.isInteger(parsed) && parsed >= 0;

  return (
    <div className="glass-panel rounded-lg px-4 py-3">
      <p className="flex items-center justify-between text-[10px] uppercase tracking-wide text-neutral-500">
        <span className="inline-flex items-center gap-1.5"><CreditCard size={11} /> Cards left</span>
        {canEdit && !editing && !loading ? (
          <button type="button" aria-label="Change card balance" className="rounded p-0.5 text-neutral-500 hover:text-neutral-100" onClick={() => setDraft(String(value ?? 0))}>
            <Pencil size={11} />
          </button>
        ) : null}
      </p>
      {loading ? (
        <span className="mt-2 block h-6 w-12 animate-pulse rounded bg-white/[0.07]" />
      ) : editing ? (
        <form
          className="mt-1 flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            onSave(parsed);
            setDraft(null);
          }}
        >
          <input
            autoFocus
            type="number"
            min="0"
            className="field-input !w-24 !py-1 text-base font-bold"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") setDraft(null); }}
          />
          <button type="submit" disabled={!valid} aria-label="Save" className="rounded bg-ops-red p-1.5 text-black disabled:opacity-40"><Check size={12} /></button>
          <button type="button" aria-label="Cancel" className="rounded p-1.5 text-neutral-500 hover:text-neutral-100" onClick={() => setDraft(null)}><X size={12} /></button>
        </form>
      ) : (
        <p className={`mt-1 text-2xl font-bold ${value ? "text-neutral-100" : "text-red-300"}`}>{saving ? "…" : value}</p>
      )}
      <p className="text-[10px] text-neutral-500">1 card adds 1 year</p>
    </div>
  );
}

function RechargeBar({ count, cards, canOwn, pending, onClear, onRecharge }) {
  const [mode, setMode] = useState("cards");
  const [years, setYears] = useState(1);
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const cost = count * years;
  const short = cost > cards;

  return (
    <div className="glass-panel sticky top-[calc(var(--ops-chrome)+0.75rem)] z-10 flex flex-wrap items-center gap-3 rounded-lg border border-ops-red/30 px-4 py-3 text-[11px]">
      <span className="font-bold text-neutral-100">{plural(count, "account")} selected</span>
      {canOwn ? (
        <div className="flex rounded-md border border-white/10 p-0.5">
          {[["cards", "Use cards"], ["date", "Set a date"]].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              className={`rounded px-2.5 py-1 font-bold ${mode === key ? "bg-white/10 text-neutral-100" : "text-neutral-500 hover:text-neutral-200"}`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {mode === "cards" ? (
        <>
          <select className="field-input !w-auto !py-1" value={years} onChange={(event) => setYears(Number(event.target.value))}>
            {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{plural(value, "year")} each</option>)}
          </select>
          <span className={short ? "text-red-300" : "text-neutral-500"}>
            {short ? `Needs ${plural(cost, "card")}, only ${cards} left` : `Uses ${plural(cost, "card")} of ${cards}`}
          </span>
          <button
            type="button"
            disabled={short || pending}
            onClick={() => onRecharge({ years })}
            className="ml-auto inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-40"
          >
            <CreditCard size={13} /> {pending ? "Recharging…" : `Recharge ${plural(count, "account")}`}
          </button>
        </>
      ) : (
        <>
          <input type="date" className="field-input !w-auto !py-1" value={until} onChange={(event) => setUntil(event.target.value)} />
          <input
            className="field-input !w-56 !py-1"
            placeholder="Reason (optional)"
            maxLength={200}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <span className="text-neutral-500">No cards used</span>
          <button
            type="button"
            disabled={!until || pending}
            onClick={() => onRecharge({ until, reason: reason.trim() || undefined })}
            className="ml-auto inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-40"
          >
            <CalendarClock size={13} /> {pending ? "Saving…" : `Set date on ${plural(count, "account")}`}
          </button>
        </>
      )}
      <button type="button" aria-label="Clear selection" className="rounded p-1 text-neutral-500 hover:text-neutral-100" onClick={onClear}>
        <X size={14} />
      </button>
    </div>
  );
}

function History({ rows, loading }) {
  const [all, setAll] = useState(false);
  if (loading || !rows.length) return null;
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <List
      title="Recent recharges"
      action={rows.length > 8 ? (
        <button type="button" className="text-[11px] font-bold text-neutral-400 hover:text-neutral-100" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}
    >
      {shown.map((row) => (
        <div key={row.id} className="flex items-center gap-3 px-4 py-2.5 text-[11px]">
          <span className="min-w-0 flex-1 truncate text-neutral-200">{row.name}</span>
          <span className="hidden min-w-0 max-w-xs truncate text-neutral-500 md:block">{row.note || (row.paidBy === "reseller" ? "Reseller card" : "Company card")}</span>
          <span className="w-44 shrink-0 text-right text-neutral-400">{String(row.serviceWindow || "").replace("~", " → ")}</span>
          <span className="hidden w-36 shrink-0 text-right text-neutral-600 sm:block">{formatDateTime(row.createdAt)}</span>
        </div>
      ))}
    </List>
  );
}
