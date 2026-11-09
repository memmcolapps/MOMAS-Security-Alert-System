import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Building2, ChevronRight, Plus, RefreshCw, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  allocateRadioToOrganization,
  createOrganization,
  getMe,
  getRadioNetwork,
  listOrganizations,
  runPocstarsPlatformSync,
} from "../lib/api";
import { NIGERIAN_STATES } from "../lib/domain";
import { isPlatformOperator } from "../lib/platform-roles";

// The platform home: every organization, how its radios are doing, and what
// needs someone's attention. It replaces the Companies list and the Radio
// network page, which answered halves of the same question in two places.

const emptyOrg = {
  name: "",
  slug: "",
  all_states: false,
  states: [],
  radio_seats: 2,
  platform_radio_seats: 1,
  modules: ["radio", "drone", "osint"],
};

const isDiscovered = (org) => org?.status === "discovered";

// Organization rows from two sources joined once: the list (people, states,
// status) and the radio network view (radios, online, mixed channels).
function shapeHome(organizations, network) {
  const byOrg = new Map((network?.organizations || []).map((org) => [Number(org.id), org]));
  const mixedByOrg = new Map();
  for (const row of network?.foreign || []) {
    const owner = (network.channels || []).find((channel) => Number(channel.id) === Number(row.channel_id));
    if (!owner) continue;
    const key = Number(owner.organization_id);
    if (!mixedByOrg.has(key)) mixedByOrg.set(key, new Set());
    mixedByOrg.get(key).add(Number(row.channel_id));
  }
  const idleByOrg = new Map();
  const waiting = [];
  for (const radio of network?.radios || []) {
    if (radio.organization_id == null) {
      waiting.push(radio);
      continue;
    }
    if (!(radio.channel_ids || []).length) {
      const key = Number(radio.organization_id);
      idleByOrg.set(key, (idleByOrg.get(key) || 0) + 1);
    }
  }
  const rows = organizations.map((org) => {
    const radio = byOrg.get(Number(org.id)) || {};
    const issues = [];
    // Notes are worth seeing but not worth chasing: most organizations on the
    // shared network have no MOMAS users at all, and flagging that as a problem
    // buried the radio problems under it.
    const notes = [];
    if (!isDiscovered(org)) {
      if (!org.pocstars_company_id) issues.push("Not on the radio network");
      if (!Number(org.channel_count)) issues.push("No channels");
      if (!Number(org.user_count)) notes.push("No people yet");
    }
    const mixed = mixedByOrg.get(Number(org.id))?.size || 0;
    if (mixed) issues.push(`${mixed} mixed channel${mixed === 1 ? "" : "s"}`);
    const idle = idleByOrg.get(Number(org.id)) || 0;
    if (idle && !isDiscovered(org)) issues.push(`${idle} radio${idle === 1 ? "" : "s"} on no channel`);
    return {
      ...org,
      radios: Number(radio.radio_count ?? org.device_count ?? 0),
      online: Number(radio.online_count ?? 0),
      issues,
      notes,
    };
  });
  return { rows, waiting };
}

export function AdminOrganizationsRoute() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const canWrite = isPlatformOperator(meQuery.data?.user);
  const [creating, setCreating] = useState(false);
  const [orgForm, setOrgForm] = useState(emptyOrg);
  const [search, setSearch] = useState("");
  // Dozens of discovered organizations belong to other operators, so the ones
  // MOMAS runs stay the default view.
  const [scope, setScope] = useState("operated");

  const orgsQuery = useQuery({ queryKey: ["organizations"], queryFn: listOrganizations });
  const networkQuery = useQuery({ queryKey: ["radio-network"], queryFn: getRadioNetwork, staleTime: 30_000 });

  const [createResult, setCreateResult] = useState(null);
  const createMutation = useMutation({
    mutationFn: createOrganization,
    onSuccess: (result) => {
      setOrgForm(emptyOrg);
      setCreating(false);
      setCreateResult(result || null);
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      queryClient.invalidateQueries({ queryKey: ["radio-network"] });
    },
  });
  const syncMutation = useMutation({
    mutationFn: runPocstarsPlatformSync,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      queryClient.invalidateQueries({ queryKey: ["radio-network"] });
    },
  });

  const organizations = useMemo(() => orgsQuery.data?.organizations || [], [orgsQuery.data?.organizations]);
  const { rows, waiting } = useMemo(() => shapeHome(organizations, networkQuery.data), [organizations, networkQuery.data]);
  const term = search.trim().toLowerCase();
  const counts = useMemo(() => ({
    operated: rows.filter((org) => !isDiscovered(org)).length,
    attention: rows.filter((org) => org.issues.length).length,
    discovered: rows.filter(isDiscovered).length,
    all: rows.length,
  }), [rows]);
  const filtered = rows
    .filter((org) => {
      if (scope === "operated") return !isDiscovered(org);
      if (scope === "attention") return org.issues.length > 0;
      if (scope === "discovered") return isDiscovered(org);
      return true;
    })
    .filter((org) => !term || [org.name, org.slug].filter(Boolean).some((value) => value.toLowerCase().includes(term)))
    .sort((a, b) => b.radios - a.radios || a.name.localeCompare(b.name));
  // A search can also be for a radio: the old Radio network page's main use.
  const radioMatches = term.length >= 2
    ? (networkQuery.data?.radios || [])
      .filter((radio) => `${radio.name || ""} ${radio.device_id} ${radio.imei || ""}`.toLowerCase().includes(term))
      .slice(0, 12)
    : [];
  const orgName = new Map(organizations.map((org) => [Number(org.id), org.name]));

  const network = networkQuery.data;
  const totalRadios = network?.radios?.length ?? 0;
  const totalOnline = (network?.radios || []).filter((radio) => radio.pocstars_online).length;
  const loading = orgsQuery.isLoading;

  return (
    <main className="device-page bg-ops-bg px-6 pb-10 pt-[calc(var(--ops-chrome)+2rem)] text-neutral-200">
      <div className="mx-auto max-w-[1400px]">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold text-neutral-100">
              <Building2 size={20} className="text-ops-red" /> Organizations
            </h1>
            <p className="mt-1 text-[12px] text-neutral-500">
              {network ? `${totalRadios} radios · ${totalOnline} online · ${counts.operated} organizations run by MOMAS` : "Every organization and how its radios are doing."}
            </p>
          </div>
          {canWrite ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md border border-white/15 px-3 py-2 text-xs font-bold text-neutral-200 hover:bg-white/5 disabled:opacity-50"
                disabled={syncMutation.isPending}
                onClick={() => syncMutation.mutate()}
                title="Read every company, channel and radio from the radio network now"
              >
                <RefreshCw size={13} className={syncMutation.isPending ? "animate-spin" : ""} />
                {syncMutation.isPending ? "Syncing…" : "Sync radio network"}
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md bg-ops-red px-4 py-2 text-xs font-bold text-black hover:opacity-85"
                onClick={() => setCreating((value) => !value)}
              >
                {creating ? <X size={14} /> : <Plus size={14} />}
                {creating ? "Cancel" : "New organization"}
              </button>
            </div>
          ) : null}
        </header>

        {syncMutation.error ? <p className="mb-4 text-xs text-ops-red">{syncMutation.error.message}</p> : null}

        {createResult ? (
          <div
            className={`mb-6 flex flex-wrap items-start justify-between gap-3 rounded-lg border px-4 py-3 text-xs ${
              createResult.warning
                ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                : "border-green-500/30 bg-green-500/10 text-ops-green"
            }`}
          >
            <div className="min-w-0">
              <p className="font-bold">
                {createResult.organization?.name} created
                {createResult.warning ? ", but it is not on the radio network yet" : " and set up on the radio network"}
              </p>
              {createResult.warning ? (
                <p className="mt-1 text-[11px] opacity-90">{createResult.warning} You can retry from its Platform tab.</p>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-2">
              {createResult.organization ? (
                <Link
                  to="/admin/organizations/$id"
                  params={{ id: String(createResult.organization.id) }}
                  className="rounded-md border border-current px-3 py-1 text-[11px] font-bold"
                >
                  Open it
                </Link>
              ) : null}
              <button type="button" className="rounded px-2 py-1 text-[11px] opacity-70 hover:opacity-100" onClick={() => setCreateResult(null)}>
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        {creating ? (
          <form
            className="glass-panel mb-6 rounded-lg p-5"
            onSubmit={(event) => {
              event.preventDefault();
              createMutation.mutate(orgForm);
            }}
          >
            <h2 className="mb-4 text-[13px] font-bold text-neutral-100">New organization</h2>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Name">
                <input autoFocus className="field-input" value={orgForm.name} onChange={(event) => setOrgForm({ ...orgForm, name: event.target.value })} />
              </Field>
              <Field label="Short name">
                <input className="field-input" value={orgForm.slug} onChange={(event) => setOrgForm({ ...orgForm, slug: event.target.value })} placeholder="Made from the name if left blank" />
              </Field>
              <Field label="Console seats (their calls at once)">
                <input className="field-input" type="number" min="1" value={orgForm.radio_seats} onChange={(event) => setOrgForm({ ...orgForm, radio_seats: event.target.value })} />
              </Field>
              <Field label="Platform seats (ours)">
                <input className="field-input" type="number" min="0" value={orgForm.platform_radio_seats} onChange={(event) => setOrgForm({ ...orgForm, platform_radio_seats: event.target.value })} />
              </Field>
            </div>
            <fieldset className="mt-4">
              <legend className="mb-2 text-[11px] font-bold uppercase tracking-wide text-neutral-400">Modules they can access</legend>
              <div className="flex flex-wrap gap-2">
                {[["radio", "Radio"], ["drone", "Drone"], ["osint", "OSINT"]].map(([value, label]) => {
                  const checked = orgForm.modules.includes(value);
                  return (
                    <label key={value} className={`inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs ${checked ? "border-ops-red/50 bg-red-500/10 text-neutral-100" : "border-white/10 bg-white/[0.02] text-neutral-400"}`}>
                      <input
                        type="checkbox"
                        className="accent-red-500"
                        checked={checked}
                        onChange={() => setOrgForm((current) => ({
                          ...current,
                          modules: checked
                            ? current.modules.filter((module) => module !== value)
                            : [...current.modules, value],
                        }))}
                      />
                      {label}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <StatePicker value={orgForm} onChange={setOrgForm} />
            {createMutation.error ? <p className="mt-3 text-xs text-ops-red">{createMutation.error.message}</p> : null}
            <p className="mt-3 text-[11px] text-neutral-500">Its company and console seats are created on the radio network automatically.</p>
            <button className="mt-4 inline-flex items-center gap-2 rounded-md bg-ops-red px-4 py-2 text-xs font-bold text-black hover:opacity-85 disabled:opacity-50" disabled={createMutation.isPending || !orgForm.name.trim() || !orgForm.modules.length}>
              <Plus size={14} /> {createMutation.isPending ? "Creating…" : "Create organization"}
            </button>
          </form>
        ) : null}

        {waiting.length ? <WaitingRadios radios={waiting} organizations={organizations} canWrite={canWrite} /> : null}

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="flex min-w-[240px] flex-1 items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <Search size={14} className="text-neutral-500" />
            <input
              className="flex-1 bg-transparent text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
              placeholder="Find an organization, or a radio by name or IMEI"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {[
              { key: "operated", label: `Run by MOMAS (${counts.operated})` },
              { key: "attention", label: `Needs attention (${counts.attention})` },
              { key: "discovered", label: `Discovered (${counts.discovered})` },
              { key: "all", label: `All (${counts.all})` },
            ].map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setScope(tab.key)}
                className={`rounded-full border px-3 py-1 text-[11px] font-bold transition ${
                  scope === tab.key
                    ? "border-ops-red/50 bg-ops-red/15 text-ops-red"
                    : "border-white/10 bg-white/[0.03] text-neutral-400 hover:text-neutral-200"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {radioMatches.length ? (
          <section className="glass-panel mb-4 overflow-hidden rounded-lg">
            <div className="border-b border-white/10 px-4 py-2.5 text-[11px] text-neutral-500">Radios matching “{search.trim()}”</div>
            <div className="divide-y divide-white/5">
              {radioMatches.map((radio) => (
                <div key={radio.device_id} className="flex items-center gap-3 px-4 py-2.5 text-[12px]">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${radio.pocstars_online ? "bg-ops-green" : "bg-neutral-600"}`} />
                  <span className="min-w-0 flex-1 truncate text-neutral-100">{radio.name || `Radio ${radio.device_id}`}</span>
                  <span className="hidden font-mono text-[10px] text-neutral-600 sm:inline">{radio.imei || radio.device_id}</span>
                  {radio.organization_id != null ? (
                    <Link
                      to="/admin/organizations/$id"
                      params={{ id: String(radio.organization_id) }}
                      className="shrink-0 text-[11px] font-bold text-ops-green hover:underline"
                    >
                      {orgName.get(Number(radio.organization_id)) || "Open organization"}
                    </Link>
                  ) : (
                    <span className="shrink-0 text-[11px] text-amber-300/90">Waiting for an organization</span>
                  )}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="glass-panel overflow-hidden rounded-lg">
          <div className="hidden grid-cols-[minmax(0,2fr)_80px_80px_90px_80px_minmax(0,2fr)_20px] gap-3 border-b border-white/10 px-4 py-2.5 text-[10px] uppercase tracking-wide text-neutral-600 md:grid">
            <span>Organization</span>
            <span className="text-right">Radios</span>
            <span className="text-right">Online</span>
            <span className="text-right">Channels</span>
            <span className="text-right">People</span>
            <span>Needs attention</span>
            <span />
          </div>
          <div className="divide-y divide-white/5">
            {loading
              ? Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="flex items-center gap-3 px-4 py-3.5">
                  <span className="h-3 w-48 animate-pulse rounded bg-white/[0.07]" />
                  <span className="ml-auto h-3 w-24 animate-pulse rounded bg-white/[0.05]" />
                </div>
              ))
              : null}
            {filtered.map((org) => (
              <Link
                key={org.id}
                to="/admin/organizations/$id"
                params={{ id: String(org.id) }}
                className="grid grid-cols-1 gap-1 px-4 py-3 transition hover:bg-white/[0.04] md:grid-cols-[minmax(0,2fr)_80px_80px_90px_80px_minmax(0,2fr)_20px] md:items-center md:gap-3"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-bold text-neutral-100">{org.name}</span>
                  {isDiscovered(org) ? (
                    <span className="shrink-0 rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-[9px] font-bold uppercase text-sky-300">Discovered</span>
                  ) : org.status !== "active" ? (
                    <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[9px] font-bold uppercase text-neutral-400">{org.status}</span>
                  ) : null}
                </span>
                <Num label="radios" value={org.radios} />
                <Num label="online" value={org.online} tone={org.online ? "text-ops-green" : ""} />
                <Num label="channels" value={Number(org.channel_count) || 0} />
                <Num label="people" value={Number(org.user_count) || 0} />
                <span className="flex min-w-0 flex-wrap gap-1">
                  {org.issues.map((issue) => (
                    <span key={issue} className="inline-flex items-center gap-1 rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-200">
                      <AlertTriangle size={10} /> {issue}
                    </span>
                  ))}
                  {org.notes.map((note) => (
                    <span key={note} className="px-1 py-0.5 text-[10px] text-neutral-600">{note}</span>
                  ))}
                </span>
                <ChevronRight size={15} className="hidden text-neutral-600 md:block" />
              </Link>
            ))}
            {!loading && !filtered.length ? (
              <div className="px-4 py-12 text-center text-[12px] text-neutral-500">
                {search ? "No organization matches." : scope === "attention" ? "Nothing needs attention." : "No organizations here yet."}
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}

function Num({ label, value, tone = "" }) {
  return (
    <span className={`text-[12px] tabular-nums text-neutral-300 md:text-right ${tone}`}>
      {value}
      <span className="ml-1 text-[11px] text-neutral-600 md:hidden">{label}</span>
    </span>
  );
}

// Radios the platform holds that no organization has yet. Only shown when there
// are some: giving them out is the one job here, and an empty panel is noise.
function WaitingRadios({ radios, organizations, canWrite }) {
  const queryClient = useQueryClient();
  const [targets, setTargets] = useState({});
  const choices = organizations.filter((org) => !isDiscovered(org)).sort((a, b) => a.name.localeCompare(b.name));
  const mutation = useMutation({
    mutationFn: ({ deviceId, orgId }) => allocateRadioToOrganization(deviceId, Number(orgId), []),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["radio-network"] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
  });

  return (
    <section className="glass-panel mb-6 overflow-hidden rounded-lg border border-amber-400/20">
      <div className="border-b border-white/10 px-4 py-3">
        <h2 className="text-[13px] font-bold text-neutral-100">Waiting for an organization · {radios.length}</h2>
        <p className="mt-0.5 text-[11px] text-neutral-500">These radios belong to no one yet. Give each to the organization that will use it.</p>
      </div>
      <div className="divide-y divide-white/5">
        {radios.map((radio) => (
          <div key={radio.device_id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[12px]">
            <span className={`h-2 w-2 shrink-0 rounded-full ${radio.pocstars_online ? "bg-ops-green" : "bg-neutral-600"}`} />
            <span className="min-w-0 flex-1 truncate text-neutral-100">{radio.name || `Radio ${radio.device_id}`}</span>
            <span className="font-mono text-[10px] text-neutral-600">{radio.imei || radio.device_id}</span>
            {canWrite ? (
              <span className="flex items-center gap-2">
                <select
                  className="field-input w-48"
                  value={targets[radio.device_id] || ""}
                  onChange={(event) => setTargets({ ...targets, [radio.device_id]: event.target.value })}
                >
                  <option value="">Choose organization</option>
                  {choices.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
                </select>
                <button
                  type="button"
                  className="rounded-md bg-ops-green px-3 py-1.5 text-[11px] font-bold text-black hover:opacity-85 disabled:opacity-40"
                  disabled={!targets[radio.device_id] || mutation.isPending}
                  onClick={() => mutation.mutate({ deviceId: radio.device_id, orgId: targets[radio.device_id] })}
                >
                  Give
                </button>
              </span>
            ) : null}
          </div>
        ))}
      </div>
      {mutation.error ? <p className="px-4 py-2 text-[11px] text-ops-red">{mutation.error.message}</p> : null}
    </section>
  );
}

function Field({ label, children }) {
  return (
    <label className="mb-3 flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

function StatePicker({ value, onChange }) {
  const states = value.states || [];
  const toggleState = (state) => {
    const next = states.includes(state) ? states.filter((item) => item !== state) : [...states, state];
    onChange({ ...value, states: next, all_states: false });
  };

  return (
    <div className="mt-2">
      <p className="mb-2 text-[10px] uppercase tracking-wide text-neutral-500">States it can see</p>
      <label className="mb-3 flex items-center gap-2 text-xs text-neutral-300">
        <input type="checkbox" checked={Boolean(value.all_states)} onChange={(event) => onChange({ ...value, all_states: event.target.checked })} />
        All states
      </label>
      {!value.all_states ? (
        <div className="grid max-h-52 grid-cols-2 gap-2 overflow-y-auto rounded border border-white/10 bg-white/[0.03] p-3 md:grid-cols-3">
          {NIGERIAN_STATES.map((state) => (
            <label className="flex items-center gap-2 text-[11px] text-neutral-400" key={state}>
              <input type="checkbox" checked={states.includes(state)} onChange={() => toggleState(state)} />
              {state}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
