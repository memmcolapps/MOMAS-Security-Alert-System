import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, ChevronRight, Plus, Radio, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  assignPocstarsGroup,
  createOrganization,
  getPocstarsRegistry,
  listOrganizations,
  runPocstarsPlatformSync,
} from "../lib/api";
import { NIGERIAN_STATES } from "../lib/domain";

const emptyOrg = {
  name: "",
  slug: "",
  all_states: false,
  states: [],
  pocstars_company_id: "",
  pocstars_company_name: "",
};

export function AdminOrganizationsRoute() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [orgForm, setOrgForm] = useState(emptyOrg);
  const [search, setSearch] = useState("");

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: listOrganizations,
  });

  const createMutation = useMutation({
    mutationFn: createOrganization,
    onSuccess: () => {
      setOrgForm(emptyOrg);
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
  });

  const organizations = useMemo(() => orgsQuery.data?.organizations || [], [orgsQuery.data?.organizations]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return organizations;
    return organizations.filter((org) =>
      [org.name, org.slug].filter(Boolean).some((value) => value.toLowerCase().includes(term)),
    );
  }, [organizations, search]);

  return (
    <main className="device-page bg-ops-bg px-6 pb-8 pt-20 text-neutral-200">
      <header className="mb-7 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ops-red">
            <Building2 size={22} /> Companies
          </h1>
          <p className="mt-1 text-[11px] text-neutral-500">All client workspaces. Click a company to manage its access, admins, and devices.</p>
        </div>
        <button
          className="inline-flex items-center gap-2 rounded-md bg-ops-red px-4 py-2 text-xs font-bold text-black hover:opacity-85"
          onClick={() => setCreating((value) => !value)}
        >
          {creating ? <X size={14} /> : <Plus size={14} />}
          {creating ? "Cancel" : "New company"}
        </button>
      </header>

      {creating ? (
        <form
          className="glass-panel mb-6 rounded-lg p-5"
          onSubmit={(event) => {
            event.preventDefault();
            createMutation.mutate(orgForm);
          }}
        >
          <h2 className="mb-4 text-[13px] font-bold text-ops-red">New company</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Company name">
              <input className="field-input" value={orgForm.name} onChange={(event) => setOrgForm({ ...orgForm, name: event.target.value })} />
            </Field>
            <Field label="Slug">
              <input className="field-input" value={orgForm.slug} onChange={(event) => setOrgForm({ ...orgForm, slug: event.target.value })} placeholder="auto-created if blank" />
            </Field>
            <Field label="POCSTARS company ID">
              <input className="field-input font-mono" value={orgForm.pocstars_company_id} onChange={(event) => setOrgForm({ ...orgForm, pocstars_company_id: event.target.value })} placeholder="Optional vendor company ID" />
            </Field>
            <Field label="POCSTARS company name">
              <input className="field-input" value={orgForm.pocstars_company_name} onChange={(event) => setOrgForm({ ...orgForm, pocstars_company_name: event.target.value })} placeholder="Optional vendor display name" />
            </Field>
          </div>
          <StatePicker value={orgForm} onChange={setOrgForm} />
          {createMutation.error ? <p className="mt-3 text-xs text-ops-red">{createMutation.error.message}</p> : null}
          <button className="mt-4 inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-50" disabled={createMutation.isPending || !orgForm.name.trim()}>
            <Plus size={14} /> Create company
          </button>
        </form>
      ) : null}

      <div className="mb-4 flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
        <Search size={14} className="text-neutral-500" />
        <input
          className="flex-1 bg-transparent text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
          placeholder="Search companies"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <section className="glass-panel overflow-hidden rounded-lg">
        <div className="border-b border-white/10 px-4 py-3 text-[11px] text-neutral-500">
          {orgsQuery.isLoading ? "Loading..." : `${filtered.length} of ${organizations.length} compan${organizations.length === 1 ? "y" : "ies"}`}
        </div>
        <div className="divide-y divide-white/5">
          {filtered.map((org) => (
            <Link
              key={org.id}
              to="/admin/organizations/$id"
              params={{ id: String(org.id) }}
              className="flex items-center justify-between gap-3 px-4 py-3 transition hover:bg-white/[0.04]"
            >
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-neutral-100">{org.name}</h3>
                <p className="mt-1 truncate text-[11px] text-neutral-500">
                  {org.slug} · {org.status} · {org.device_count || 0} device{org.device_count === 1 ? "" : "s"} · {org.user_count || 0} user{org.user_count === 1 ? "" : "s"}
                </p>
                <p className="mt-1 truncate text-[11px] text-neutral-600">
                  {org.all_states ? "All states" : (org.states || []).join(", ") || "No states assigned"}
                </p>
              </div>
              <ChevronRight size={16} className="shrink-0 text-neutral-500" />
            </Link>
          ))}
          {!orgsQuery.isLoading && !filtered.length ? (
            <div className="px-4 py-12 text-center text-[12px] text-neutral-500">
              <Building2 className="mx-auto mb-2" size={28} />
              {search ? "No companies match your search" : "No companies yet"}
            </div>
          ) : null}
        </div>
      </section>

      <PocstarsRegistryPanel organizations={organizations} />
    </main>
  );
}

function PocstarsRegistryPanel({ organizations }) {
  const queryClient = useQueryClient();
  const [assignTargets, setAssignTargets] = useState({});

  const registryQuery = useQuery({
    queryKey: ["pocstars-registry"],
    queryFn: getPocstarsRegistry,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["pocstars-registry"] });
    queryClient.invalidateQueries({ queryKey: ["organizations"] });
  };

  const syncMutation = useMutation({
    mutationFn: runPocstarsPlatformSync,
    onSuccess: refresh,
  });

  const assignMutation = useMutation({
    mutationFn: ({ groupId, organizationId }) =>
      assignPocstarsGroup(groupId, { organization_id: organizationId }),
    onSuccess: refresh,
  });

  const registry = registryQuery.data;
  const dispatcher = registry?.dispatchers?.[0];
  const groups = registry?.groups || [];
  const poolRadios = registry?.pool_radios || [];
  const summary = syncMutation.data?.summary || dispatcher?.last_sync_summary;

  return (
    <section className="glass-panel mt-6 rounded-lg p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[13px] font-bold text-ops-green">
            <Radio size={15} /> POCSTARS radio network
          </h2>
          <p className="mt-1 text-[11px] text-neutral-500">
            The whole radio network imports here first. Assign each POCSTARS group to a company; its radios follow automatically. Unassigned radios stay platform-only until you place them.
          </p>
          <p className="mt-1 text-[11px] text-neutral-500">
            {dispatcher
              ? `Dispatcher ${dispatcher.name || dispatcher.dispatcher_uid} (UID ${dispatcher.dispatcher_uid})${dispatcher.last_sync_at ? ` · Last sync ${new Date(dispatcher.last_sync_at).toLocaleString("en-GB")}` : ""}`
              : "No sync has run yet."}
            {registry && !registry.configured ? " · Live bridge not configured on this server." : ""}
          </p>
        </div>
        <button
          className="inline-flex items-center gap-2 rounded-md bg-ops-green px-4 py-2 text-xs font-bold text-black hover:opacity-85 disabled:opacity-50"
          disabled={syncMutation.isPending || (registry && !registry.configured)}
          onClick={() => syncMutation.mutate()}
        >
          <Radio size={13} /> {syncMutation.isPending ? "Syncing from POCSTARS…" : "Sync from POCSTARS"}
        </button>
      </div>

      {syncMutation.error ? <p className="mt-3 text-xs text-ops-red">{syncMutation.error.message}</p> : null}
      {assignMutation.error ? <p className="mt-3 text-xs text-ops-red">{assignMutation.error.message}</p> : null}
      {summary ? (
        <p className="mt-3 text-[11px] text-neutral-400">
          {summary.groupsFound} groups · {summary.radiosFound} radios seen · {summary.radiosCreated} added · {summary.radiosUpdated} refreshed · {summary.pooled ?? 0} awaiting assignment
          {summary.dispatchersSkipped ? ` · ${summary.dispatchersSkipped} dispatcher console${summary.dispatchersSkipped === 1 ? "" : "s"} skipped` : ""}
        </p>
      ) : null}

      {groups.length ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-neutral-500">
                <th className="py-2 pr-3">Group</th>
                <th className="py-2 pr-3">POCSTARS ID</th>
                <th className="py-2 pr-3">Radios</th>
                <th className="py-2 pr-3">Assigned to</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {groups.map((group) => (
                <tr key={group.group_id} className={group.active ? "" : "opacity-50"}>
                  <td className="py-2 pr-3 font-bold text-neutral-200">
                    {group.name}
                    {group.active ? "" : " (gone from POCSTARS)"}
                  </td>
                  <td className="py-2 pr-3 font-mono text-neutral-400">{group.group_id}</td>
                  <td className="py-2 pr-3 text-neutral-400">{group.radio_count}</td>
                  <td className="py-2 pr-3 text-neutral-300">
                    {group.organization_id ? `${group.organization_name} · ${group.unit_name}` : (
                      <select
                        className="field-input py-1 text-[11px]"
                        value={assignTargets[group.group_id] || ""}
                        onChange={(event) => setAssignTargets({ ...assignTargets, [group.group_id]: event.target.value })}
                      >
                        <option value="">Choose a company…</option>
                        {organizations.map((org) => (
                          <option key={org.id} value={org.id}>{org.name}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {!group.organization_id ? (
                      <button
                        className="rounded bg-ops-green px-3 py-1 text-[11px] font-bold text-black disabled:opacity-40"
                        disabled={!assignTargets[group.group_id] || assignMutation.isPending}
                        onClick={() => assignMutation.mutate({
                          groupId: group.group_id,
                          organizationId: Number(assignTargets[group.group_id]),
                        })}
                      >
                        Assign
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : registryQuery.isLoading ? (
        <p className="mt-4 text-[11px] text-neutral-500">Loading registry…</p>
      ) : (
        <p className="mt-4 text-[11px] text-neutral-500">No POCSTARS groups imported yet. Run a sync to load the radio network.</p>
      )}

      {poolRadios.length ? (
        <div className="mt-4 rounded border border-white/10 bg-white/[0.03] p-3">
          <h3 className="text-[11px] font-bold text-neutral-300">
            {poolRadios.length} radio{poolRadios.length === 1 ? "" : "s"} awaiting assignment
          </h3>
          <p className="mt-1 text-[10px] text-neutral-500">
            These radios are not in any assigned group. Assign their group above, or attach them to a company from its device list.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {poolRadios.map((radio) => (
              <span key={radio.device_id} className="inline-flex items-center gap-1 rounded bg-white/[0.05] px-2 py-1 text-[10px] text-neutral-300">
                <span className={`h-1.5 w-1.5 rounded-full ${radio.pocstars_online ? "bg-ops-green" : "bg-neutral-600"}`} />
                {radio.name || radio.device_id}
              </span>
            ))}
          </div>
        </div>
      ) : null}
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
    <div className="mt-4">
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
