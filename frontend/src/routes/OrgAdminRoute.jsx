import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, ClipboardList, Radio, Save, Trash2, UserPlus, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";
import {
  addOrgAdminUser,
  assignDeviceUnit,
  createOrgUnit,
  deleteOrgUnit,
  getMe,
  getOrgAdmin,
  removeOrgAdminUser,
} from "../lib/api";
import { NIGERIAN_STATES, deviceTypeLabel } from "../lib/domain";

const TABS = [
  { id: "units", label: "Units", icon: Building2 },
  { id: "users", label: "Users", icon: UsersRound },
  { id: "devices", label: "Devices", icon: Radio },
  { id: "audit", label: "Audit", icon: ClipboardList },
];

const UNIT_TYPES = [
  ["hq", "HQ"],
  ["zone", "Zone"],
  ["state_command", "State Command"],
  ["area_command", "Area Command"],
  ["station", "Station"],
];

const ROLES = [
  ["org_owner", "Org owner"],
  ["org_admin", "Org admin"],
  ["unit_admin", "Unit admin"],
  ["operator", "Operator"],
  ["viewer", "Viewer"],
];

export function OrgAdminRoute() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("units");
  const orgQuery = useQuery({ queryKey: ["org-admin"], queryFn: getOrgAdmin });
  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const data = orgQuery.data || {};
  const organization = data.organization;
  const currentMembership = meQuery.data?.user?.memberships?.[0];
  const canCreateUnits = meQuery.data?.user?.platform_role === "admin" || ["org_owner", "org_admin", "admin"].includes(currentMembership?.role);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["org-admin"] });

  if (orgQuery.isLoading) return <Shell>Loading...</Shell>;
  if (orgQuery.error) return <Shell>Failed to load: {orgQuery.error.message}</Shell>;

  return (
    <Shell>
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-xl font-bold text-ops-red">
          <Building2 size={22} /> {organization?.name || "Organization admin"}
        </h1>
        <p className="mt-1 text-[11px] text-neutral-500">
          Manage units, users, device assignments, and organization audit history.
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

      {tab === "units" ? <UnitsSection units={data.units || []} canCreateUnits={canCreateUnits} onChanged={refresh} /> : null}
      {tab === "users" ? <UsersSection users={data.users || []} units={data.units || []} onChanged={refresh} /> : null}
      {tab === "devices" ? <DevicesSection devices={data.devices || []} units={data.units || []} onChanged={refresh} /> : null}
      {tab === "audit" ? <AuditSection audit={data.audit || []} /> : null}
    </Shell>
  );
}

function Shell({ children }) {
  return <main className="device-page bg-ops-bg px-6 pb-8 pt-20 text-neutral-200">{children}</main>;
}

function UnitsSection({ units, canCreateUnits, onChanged }) {
  const [form, setForm] = useState({ name: "", type: "station", parent_unit_id: "", state: "", lga: "", location: "" });
  const createMutation = useMutation({
    mutationFn: createOrgUnit,
    onSuccess: () => {
      setForm({ name: "", type: "station", parent_unit_id: "", state: "", lga: "", location: "" });
      onChanged();
    },
  });

  return (
    <section className="space-y-5">
      {canCreateUnits ? (
      <form className="glass-panel rounded-lg p-5" onSubmit={(event) => {
        event.preventDefault();
        createMutation.mutate({ ...form, parent_unit_id: form.parent_unit_id || null });
      }}>
        <h2 className="mb-4 flex items-center gap-2 text-[13px] font-bold text-ops-red">
          <Building2 size={15} /> Add command or station
        </h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <Field label="Name">
            <input className="field-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          </Field>
          <Field label="Type">
            <select className="field-input" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
              {UNIT_TYPES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="Parent">
            <select className="field-input" value={form.parent_unit_id} onChange={(event) => setForm({ ...form, parent_unit_id: event.target.value })}>
              <option value="">None</option>
              {units.map((unit) => <option value={unit.id} key={unit.id}>{unit.name}</option>)}
            </select>
          </Field>
          <Field label="State">
            <select className="field-input" value={form.state} onChange={(event) => setForm({ ...form, state: event.target.value })}>
              <option value="">Not state-bound</option>
              {NIGERIAN_STATES.map((state) => <option value={state} key={state}>{state}</option>)}
            </select>
          </Field>
          <Field label="LGA">
            <input className="field-input" value={form.lga} onChange={(event) => setForm({ ...form, lga: event.target.value })} />
          </Field>
          <Field label="Location">
            <input className="field-input" value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} />
          </Field>
        </div>
        {createMutation.error ? <p className="mt-2 text-xs text-ops-red">{createMutation.error.message}</p> : null}
        <button className="mt-4 inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-50" disabled={createMutation.isPending}>
          <Save size={14} /> {createMutation.isPending ? "Saving..." : "Create unit"}
        </button>
      </form>
      ) : null}

      <List title={`${units.length} unit${units.length === 1 ? "" : "s"}`}>
        {units.map((unit) => <UnitRow key={unit.id} unit={unit} onChanged={onChanged} />)}
        {!units.length ? <Empty>No units yet</Empty> : null}
      </List>
    </section>
  );
}

function UnitRow({ unit, onChanged }) {
  const deleteMutation = useMutation({ mutationFn: () => deleteOrgUnit(unit.id), onSuccess: onChanged });
  return (
    <article className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <h3 className="text-sm text-neutral-100">{unit.name}</h3>
        <p className="text-[11px] text-neutral-500">
          {labelForUnitType(unit.type)} · {unit.parent_name || "top level"} · {unit.state || "all states"} · {unit.user_count || 0} users · {unit.device_count || 0} devices
        </p>
      </div>
      <button className="inline-flex items-center gap-1 rounded border border-red-500/20 px-2 py-1 text-[10px] text-red-400/70 hover:border-ops-red hover:text-ops-red" onClick={() => {
        if (window.confirm(`Remove ${unit.name}?`)) deleteMutation.mutate();
      }}>
        <Trash2 size={11} /> Remove
      </button>
    </article>
  );
}

function UsersSection({ users, units, onChanged }) {
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "operator", unit_id: "", scope_level: "unit" });
  const addMutation = useMutation({
    mutationFn: addOrgAdminUser,
    onSuccess: () => {
      setForm({ email: "", name: "", password: "", role: "operator", unit_id: "", scope_level: "unit" });
      onChanged();
    },
  });
  const removeMutation = useMutation({ mutationFn: removeOrgAdminUser, onSuccess: onChanged });

  return (
    <section className="space-y-5">
      <form className="glass-panel rounded-lg p-5" onSubmit={(event) => {
        event.preventDefault();
        addMutation.mutate({ ...form, unit_id: form.unit_id || null, scope_level: form.unit_id ? form.scope_level : "organization" });
      }}>
        <h2 className="mb-4 flex items-center gap-2 text-[13px] font-bold text-ops-red">
          <UserPlus size={15} /> Add user
        </h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <Field label="Name"><input className="field-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label="Email"><input className="field-input" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required /></Field>
          <Field label="Temporary password"><input className="field-input" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
          <Field label="Role">
            <select className="field-input" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
              {ROLES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="Unit">
            <select className="field-input" value={form.unit_id} onChange={(event) => setForm({ ...form, unit_id: event.target.value })}>
              <option value="">Whole organization</option>
              {units.map((unit) => <option value={unit.id} key={unit.id}>{unit.name}</option>)}
            </select>
          </Field>
          <Field label="Scope">
            <select className="field-input" value={form.scope_level} onChange={(event) => setForm({ ...form, scope_level: event.target.value })}>
              <option value="organization">Organization</option>
              <option value="unit">Unit only</option>
            </select>
          </Field>
        </div>
        {addMutation.error ? <p className="mt-2 text-xs text-ops-red">{addMutation.error.message}</p> : null}
        <button className="mt-4 inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-50" disabled={addMutation.isPending}>
          <UserPlus size={14} /> {addMutation.isPending ? "Saving..." : "Add user"}
        </button>
      </form>

      <List title={`${users.length} user${users.length === 1 ? "" : "s"}`}>
        {users.map((user) => (
          <article className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" key={user.id}>
            <div className="min-w-0">
              <h3 className="text-sm text-neutral-100">{user.name || user.email}</h3>
              <p className="text-[11px] text-neutral-500">{user.email} · {roleLabel(user.role)} · {user.unit_name || "whole organization"}</p>
            </div>
            <button className="inline-flex items-center gap-1 rounded border border-red-500/20 px-2 py-1 text-[10px] text-red-400/70 hover:border-ops-red hover:text-ops-red" onClick={() => {
              if (window.confirm(`Remove ${user.email}?`)) removeMutation.mutate(user.id);
            }}>
              <Trash2 size={11} /> Remove
            </button>
          </article>
        ))}
        {!users.length ? <Empty>No users yet</Empty> : null}
      </List>
    </section>
  );
}

function DevicesSection({ devices, units, onChanged }) {
  const [pending, setPending] = useState({});
  const assignMutation = useMutation({
    mutationFn: ({ deviceId, unitId }) => assignDeviceUnit(deviceId, unitId),
    onSuccess: onChanged,
  });
  const activeCount = useMemo(() => devices.filter((device) => device.active).length, [devices]);
  return (
    <List title={`${devices.length} device${devices.length === 1 ? "" : "s"} · ${activeCount} active`}>
      {devices.map((device) => (
        <article className="grid gap-3 px-4 py-3 text-xs md:grid-cols-[1.2fr_1fr_1fr_auto]" key={device.device_id}>
          <div>
            <h3 className="font-mono text-[11px] text-ops-green">{device.device_id}</h3>
            <p className="text-[11px] text-neutral-500">{device.name || "Unnamed"} · {device.device_type ? deviceTypeLabel(device.device_type) : "No type"}</p>
          </div>
          <div className="text-neutral-400">{device.operator || "No operator"}</div>
          <select className="field-input" value={pending[device.device_id] ?? device.unit_id ?? ""} onChange={(event) => setPending({ ...pending, [device.device_id]: event.target.value })}>
            <option value="">No unit</option>
            {units.map((unit) => <option value={unit.id} key={unit.id}>{unit.name}</option>)}
          </select>
          <button className="inline-flex items-center justify-center gap-2 rounded bg-ops-green px-3 py-2 text-xs font-bold text-black disabled:opacity-50" disabled={assignMutation.isPending} onClick={() => assignMutation.mutate({ deviceId: device.device_id, unitId: pending[device.device_id] ?? device.unit_id ?? "" })}>
            <Save size={13} /> Assign
          </button>
        </article>
      ))}
      {!devices.length ? <Empty>No assigned devices</Empty> : null}
    </List>
  );
}

function AuditSection({ audit }) {
  return (
    <List title={`${audit.length} audit event${audit.length === 1 ? "" : "s"}`}>
      {audit.map((entry) => (
        <article className="px-4 py-3" key={entry.id}>
          <h3 className="text-sm text-neutral-100">{entry.action}</h3>
          <p className="text-[11px] text-neutral-500">
            {entry.actor_name || entry.actor_email || "System"} · {entry.target_type || "target"} {entry.target_id || ""} · {formatDateTime(entry.created_at)}
          </p>
        </article>
      ))}
      {!audit.length ? <Empty>No audit events yet</Empty> : null}
    </List>
  );
}

function List({ title, children }) {
  return (
    <div className="glass-panel overflow-hidden rounded-lg">
      <div className="border-b border-white/10 px-4 py-3 text-[11px] text-neutral-500">{title}</div>
      <div className="divide-y divide-white/5">{children}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

function Empty({ children }) {
  return <div className="px-4 py-10 text-center text-[12px] text-neutral-500">{children}</div>;
}

function labelForUnitType(value) {
  return UNIT_TYPES.find(([key]) => key === value)?.[1] || value;
}

function roleLabel(value) {
  return ROLES.find(([key]) => key === value)?.[1] || value;
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}
