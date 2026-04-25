import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, ChevronRight, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { createOrganization, listOrganizations } from "../lib/api";
import { NIGERIAN_STATES } from "../lib/domain";

const emptyOrg = { name: "", slug: "", all_states: false, states: [] };

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

  const organizations = orgsQuery.data?.organizations || [];
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
    </main>
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
