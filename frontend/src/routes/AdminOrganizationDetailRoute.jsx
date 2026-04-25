import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Building2, Globe2, Plus, Radio, Save, Trash2, UserPlus, UsersRound, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  addOrganizationUser,
  attachDeviceToOrganization,
  detachDeviceFromOrganization,
  getOrganization,
  listDevices,
  removeOrganizationUser,
  updateOrganizationAccess,
} from "../lib/api";
import { NIGERIAN_STATES, deviceTypeLabel } from "../lib/domain";

const TABS = [
  { id: "access", label: "Access", icon: Globe2 },
  { id: "users", label: "Admins", icon: UsersRound },
  { id: "devices", label: "Devices", icon: Radio },
  { id: "settings", label: "Settings", icon: Building2 },
];

export function AdminOrganizationDetailRoute() {
  const { id } = useParams({ from: "/admin/organizations/$id" });
  const orgId = Number(id);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("access");

  const orgQuery = useQuery({
    queryKey: ["organization", orgId],
    queryFn: () => getOrganization(orgId),
    enabled: Number.isFinite(orgId),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["organization", orgId] });
    queryClient.invalidateQueries({ queryKey: ["organizations"] });
  };

  if (orgQuery.isLoading) return <Wrapper>Loading...</Wrapper>;
  if (orgQuery.error) return <Wrapper>Failed to load: {orgQuery.error.message}</Wrapper>;
  const data = orgQuery.data;
  if (!data?.organization) return <Wrapper>Company not found.</Wrapper>;

  const { organization, devices = [], users = [] } = data;

  return (
    <Wrapper>
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-xl font-bold text-ops-red">
          <Building2 size={22} /> {organization.name}
        </h1>
        <p className="mt-1 text-[11px] text-neutral-500">
          {organization.slug} · {organization.status} · {devices.length} device{devices.length === 1 ? "" : "s"} · {users.length} user{users.length === 1 ? "" : "s"}
        </p>
      </header>

      <div className="mb-5 flex flex-wrap gap-2 border-b border-white/10">
        {TABS.map((entry) => {
          const Icon = entry.icon;
          const active = tab === entry.id;
          return (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-xs font-bold transition ${
                active ? "border-ops-red text-ops-red" : "border-transparent text-neutral-500 hover:text-neutral-200"
              }`}
            >
              <Icon size={13} /> {entry.label}
            </button>
          );
        })}
      </div>

      {tab === "access" ? <AccessSection organization={organization} onSaved={refresh} /> : null}
      {tab === "users" ? <UsersSection orgId={orgId} users={users} onChanged={refresh} /> : null}
      {tab === "devices" ? <DevicesSection orgId={orgId} devices={devices} onChanged={refresh} /> : null}
      {tab === "settings" ? <SettingsSection organization={organization} onSaved={refresh} /> : null}
    </Wrapper>
  );
}

function Wrapper({ children }) {
  return (
    <main className="device-page bg-ops-bg px-6 pb-8 pt-20 text-neutral-200">
      <Link to="/admin/organizations" className="mb-6 inline-flex items-center gap-2 text-xs text-neutral-500 hover:text-neutral-200">
        <ArrowLeft size={14} /> Back to companies
      </Link>
      {children}
    </main>
  );
}

function AccessSection({ organization, onSaved }) {
  const [draft, setDraft] = useState(() => ({
    all_states: Boolean(organization.all_states),
    states: organization.states || [],
  }));
  const mutation = useMutation({
    mutationFn: (payload) => updateOrganizationAccess(organization.id, payload),
    onSuccess: onSaved,
  });

  return (
    <section className="glass-panel rounded-lg p-5">
      <h2 className="mb-1 text-[13px] font-bold text-ops-red">Intelligence access</h2>
      <p className="mb-4 text-[11px] text-neutral-500">
        Pick which Nigerian states this company sees in the operations console.
      </p>
      <StatePicker value={draft} onChange={setDraft} />
      <div className="mt-4 flex items-center gap-3">
        <button
          className="inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-50"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate(draft)}
        >
          <Save size={13} /> {mutation.isPending ? "Saving..." : "Save access"}
        </button>
        {mutation.error ? <span className="text-xs text-ops-red">{mutation.error.message}</span> : null}
        {mutation.isSuccess ? <span className="text-xs text-ops-green">Saved</span> : null}
      </div>
    </section>
  );
}

function UsersSection({ orgId, users, onChanged }) {
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "admin" });

  const addMutation = useMutation({
    mutationFn: (payload) => addOrganizationUser(orgId, payload),
    onSuccess: () => {
      setForm({ email: "", name: "", password: "", role: "admin" });
      onChanged();
    },
  });
  const removeMutation = useMutation({
    mutationFn: (userId) => removeOrganizationUser(orgId, userId),
    onSuccess: onChanged,
  });

  return (
    <section className="space-y-5">
      <form
        className="glass-panel rounded-lg p-5"
        onSubmit={(event) => {
          event.preventDefault();
          addMutation.mutate(form);
        }}
      >
        <h2 className="mb-4 flex items-center gap-2 text-[13px] font-bold text-ops-red">
          <UserPlus size={15} /> Invite admin
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name">
            <input className="field-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Email">
            <input className="field-input" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required />
          </Field>
          <Field label="Temporary password">
            <input className="field-input" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required />
          </Field>
          <Field label="Role">
            <select className="field-input" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
              <option value="admin">Admin</option>
              <option value="viewer">Viewer</option>
            </select>
          </Field>
        </div>
        {addMutation.error ? <p className="mt-2 text-xs text-ops-red">{addMutation.error.message}</p> : null}
        <button className="mt-4 inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-50" disabled={addMutation.isPending}>
          <UserPlus size={14} /> {addMutation.isPending ? "Saving..." : "Add user"}
        </button>
      </form>

      <div className="glass-panel overflow-hidden rounded-lg">
        <div className="border-b border-white/10 px-4 py-3 text-[11px] text-neutral-500">
          {users.length} user{users.length === 1 ? "" : "s"}
        </div>
        <div className="divide-y divide-white/5">
          {users.map((user) => (
            <article className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" key={user.id}>
              <div className="min-w-0">
                <h3 className="text-sm text-neutral-100">{user.name || user.email}</h3>
                <p className="text-[11px] text-neutral-500">{user.email} · {user.role}</p>
              </div>
              <button
                className="inline-flex items-center gap-1 rounded border border-red-500/20 px-2 py-1 text-[10px] text-red-400/70 hover:border-ops-red hover:text-ops-red"
                onClick={() => {
                  if (window.confirm(`Remove ${user.email} from this company?`)) removeMutation.mutate(user.id);
                }}
              >
                <Trash2 size={11} /> Remove
              </button>
            </article>
          ))}
          {!users.length ? (
            <div className="px-4 py-10 text-center text-[12px] text-neutral-500">No admins yet</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function DevicesSection({ orgId, devices, onChanged }) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const allDevicesQuery = useQuery({
    queryKey: ["devices"],
    queryFn: listDevices,
    enabled: pickerOpen,
  });

  const attachMutation = useMutation({
    mutationFn: (deviceId) => attachDeviceToOrganization(orgId, deviceId),
    onSuccess: () => {
      setPickerOpen(false);
      onChanged();
    },
  });
  const detachMutation = useMutation({
    mutationFn: (deviceId) => detachDeviceFromOrganization(orgId, deviceId),
    onSuccess: onChanged,
  });

  const unassignedDevices = useMemo(() => {
    const all = allDevicesQuery.data?.devices || [];
    return all.filter((device) => !device.organization_id);
  }, [allDevicesQuery.data]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] text-neutral-500">
          {devices.length} device{devices.length === 1 ? "" : "s"} assigned to this company.
        </p>
        <div className="flex gap-2">
          <button
            className="inline-flex items-center gap-2 rounded bg-white/10 px-3 py-2 text-xs text-neutral-200 hover:bg-white/20"
            onClick={() => setPickerOpen((value) => !value)}
          >
            {pickerOpen ? <X size={13} /> : <Plus size={13} />}
            {pickerOpen ? "Close" : "Attach existing"}
          </button>
          <Link
            to="/devices"
            className="inline-flex items-center gap-2 rounded bg-ops-green px-3 py-2 text-xs font-bold text-black hover:opacity-85"
          >
            <Plus size={13} /> Register new
          </Link>
        </div>
      </div>

      {pickerOpen ? (
        <div className="glass-panel rounded-lg p-4">
          <h3 className="mb-3 text-[12px] font-bold text-ops-green">Unassigned devices</h3>
          {allDevicesQuery.isLoading ? (
            <p className="text-xs text-neutral-500">Loading...</p>
          ) : unassignedDevices.length ? (
            <div className="divide-y divide-white/5">
              {unassignedDevices.map((device) => (
                <div className="flex items-center justify-between gap-3 py-2" key={device.device_id}>
                  <div className="min-w-0">
                    <p className="font-mono text-[11px] text-ops-green">{device.device_id}</p>
                    <p className="text-[11px] text-neutral-500">{device.name || "—"}</p>
                  </div>
                  <button
                    className="rounded bg-ops-red px-3 py-1 text-[11px] font-bold text-black disabled:opacity-50"
                    disabled={attachMutation.isPending}
                    onClick={() => attachMutation.mutate(device.device_id)}
                  >
                    Attach
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-neutral-500">No unassigned devices in the registry.</p>
          )}
        </div>
      ) : null}

      <div className="glass-panel overflow-hidden rounded-lg">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-white/10 text-[9px] uppercase tracking-wide text-neutral-500">
                <th className="px-4 py-3">Device ID</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Operator</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {devices.length ? (
                devices.map((device) => (
                  <tr className="border-b border-white/5" key={device.device_id}>
                    <td className="px-4 py-3 font-mono text-[11px] text-ops-green">{device.device_id}</td>
                    <td className="px-4 py-3">{device.name || "—"}</td>
                    <td className="px-4 py-3">{device.operator || "—"}</td>
                    <td className="px-4 py-3">{device.device_type ? deviceTypeLabel(device.device_type) : "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold ${device.active ? "border-green-500/30 bg-green-500/10 text-ops-green" : "border-white/10 bg-white/5 text-neutral-500"}`}>
                        {device.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[10px] text-neutral-400 hover:border-ops-red hover:text-ops-red"
                        onClick={() => {
                          if (window.confirm(`Detach ${device.device_id} from this company?`)) detachMutation.mutate(device.device_id);
                        }}
                      >
                        Detach
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-[12px] text-neutral-500">
                    <Radio className="mx-auto mb-2" size={26} /> No devices assigned yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function SettingsSection({ organization, onSaved }) {
  const [draft, setDraft] = useState({ name: organization.name, status: organization.status });
  const mutation = useMutation({
    mutationFn: (payload) => updateOrganizationAccess(organization.id, payload),
    onSuccess: onSaved,
  });

  return (
    <section className="glass-panel rounded-lg p-5">
      <h2 className="mb-4 text-[13px] font-bold text-ops-red">Company settings</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name">
          <input className="field-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </Field>
        <Field label="Status">
          <select className="field-input" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          className="inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-50"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate(draft)}
        >
          <Save size={13} /> Save
        </button>
        {mutation.error ? <span className="text-xs text-ops-red">{mutation.error.message}</span> : null}
      </div>
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
    <div>
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
