import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, ClipboardList, Plus, Radio, RadioTower, Save, Trash2, UserPlus, UsersRound, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  addOrgAdminUser,
  assignDeviceUnit,
  createOrgChannel,
  createOrgUnit,
  deleteOrgChannel,
  deleteOrgUnit,
  getMe,
  getOrgAdmin,
  listOrgChannelDevices,
  listOrgChannels,
  removeOrgAdminUser,
  setOrgChannelDevice,
  updateOrgChannel,
  updateOrgUnit,
} from "../lib/api";
import { isPlatformOperator } from "../lib/platform-roles";
import { NIGERIAN_STATES, ORG_ROLES, deviceTypeLabel, orgRoleLabel } from "../lib/domain";

const TABS = [
  { id: "channels", label: "Channels", icon: RadioTower },
  { id: "units", label: "Units", icon: Building2 },
  { id: "users", label: "Users", icon: UsersRound },
  { id: "devices", label: "Devices", icon: Radio },
  { id: "audit", label: "Audit", icon: ClipboardList },
];

export function OrgAdminRoute() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("channels");
  const orgQuery = useQuery({ queryKey: ["org-admin"], queryFn: getOrgAdmin });
  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const data = orgQuery.data || {};
  const organization = data.organization;
  const currentMembership = meQuery.data?.user?.active_membership || meQuery.data?.user?.memberships?.[0];
  const canCreateUnits = isPlatformOperator(meQuery.data?.user) || ["org_owner", "org_admin", "admin"].includes(currentMembership?.role);
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

      {tab === "channels" ? <ChannelsSection devices={data.devices || []} units={data.units || []} canManage={canCreateUnits} /> : null}
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
  const emptyUnit = {
    name: "",
    type: "",
    parent_unit_id: "",
    state: "",
    lga: "",
    location: "",
  };
  const [form, setForm] = useState(emptyUnit);
  const createMutation = useMutation({
    mutationFn: createOrgUnit,
    onSuccess: () => {
      setForm(emptyUnit);
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
          <Building2 size={15} /> Add unit
        </h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <Field label="Name">
            <input className="field-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          </Field>
          <Field label="Label">
            <input className="field-input" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} placeholder="Optional, e.g. Campus, Department, Station" />
          </Field>
          <Field label="Parent">
            <select className="field-input" value={form.parent_unit_id} onChange={(event) => setForm({ ...form, parent_unit_id: event.target.value })}>
              <option value="">None</option>
              {units.map((unit) => <option value={unit.id} key={unit.id}>{unitOptionLabel(unit)}</option>)}
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
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-50" disabled={createMutation.isPending}>
            <Save size={14} /> {createMutation.isPending ? "Saving..." : "Create unit"}
          </button>
          {createMutation.isSuccess ? <span className="text-xs text-ops-green">Unit created</span> : null}
        </div>
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
    <article className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <h3 className="text-sm text-neutral-100">{unit.name}</h3>
        <p className="text-[11px] text-neutral-500">
          {unit.type || "Unit"} · {unit.parent_name || "top level"} · {unit.state || "all states"} · {unit.user_count || 0} users · {unit.device_count || 0} devices
        </p>
      </div>
      <div className="flex gap-2">
        <button className="inline-flex items-center gap-1 rounded border border-red-500/20 px-2 py-1 text-[10px] text-red-400/70 hover:border-ops-red hover:text-ops-red" onClick={() => {
          if (window.confirm(`Remove ${unit.name}?`)) deleteMutation.mutate();
        }}>
          <Trash2 size={11} /> Remove
        </button>
      </div>
    </article>
  );
}

// Channels are this organization's own talk groups. Radios allocated to the org
// by the platform admin are arranged here; the vendor group id never surfaces.
function ChannelsSection({ devices, units, canManage }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: "", unit_id: "" });
  const [openChannelId, setOpenChannelId] = useState(null);

  const channelsQuery = useQuery({ queryKey: ["org-channels"], queryFn: listOrgChannels });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["org-channels"] });

  const [warning, setWarning] = useState("");
  const createMutation = useMutation({
    mutationFn: createOrgChannel,
    onSuccess: (result) => {
      setForm({ name: "", unit_id: "" });
      setWarning(result?.warning || "");
      refresh();
    },
  });
  const renameMutation = useMutation({
    mutationFn: ({ id, name }) => updateOrgChannel(id, { name }),
    onSuccess: refresh,
  });
  const removeMutation = useMutation({ mutationFn: deleteOrgChannel, onSuccess: refresh });

  const channels = channelsQuery.data?.channels || [];

  return (
    <section className="space-y-5">
      {canManage ? (
        <form
          className="glass-panel rounded-lg p-5"
          onSubmit={(event) => {
            event.preventDefault();
            createMutation.mutate({ name: form.name, unit_id: form.unit_id || null });
          }}
        >
          <h2 className="mb-1 flex items-center gap-2 text-[13px] font-bold text-ops-red">
            <RadioTower size={15} /> Add channel
          </h2>
          <p className="mb-4 text-[11px] text-neutral-500">
            A channel is a talk group — the radios on it hear each other. Pin it to a unit to limit who can listen.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Channel name">
              <input className="field-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Lagos Patrol" />
            </Field>
            <Field label="Restrict to unit (optional)">
              <select className="field-input" value={form.unit_id} onChange={(event) => setForm({ ...form, unit_id: event.target.value })}>
                <option value="">Whole organization</option>
                {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
              </select>
            </Field>
          </div>
          {createMutation.error ? <p className="mt-2 text-xs text-ops-red">{createMutation.error.message}</p> : null}
          {warning ? <p className="mt-2 text-xs text-amber-300/90">{warning}</p> : null}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button className="inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-50" disabled={createMutation.isPending || !form.name.trim()}>
              <Plus size={14} /> {createMutation.isPending ? "Creating…" : "Create channel"}
            </button>
            {createMutation.isSuccess && !warning ? <span className="text-xs text-ops-green">Channel created and live</span> : null}
          </div>
        </form>
      ) : null}

      <List title={`${channels.length} channel${channels.length === 1 ? "" : "s"}`}>
        {channelsQuery.isLoading ? <p className="px-4 py-6 text-[11px] text-neutral-500">Loading channels…</p> : null}
        {channels.map((channel) => (
          <article key={channel.id} className={`px-4 py-3 ${channel.active ? "" : "opacity-50"}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm text-neutral-100">{channel.name}</h3>
                <p className="text-[11px] text-neutral-500">
                  {channel.unit_name ? `${channel.unit_name} only` : "Whole organization"} · {channel.device_count} radio{channel.device_count === 1 ? "" : "s"} · {channel.online_count} online
                  {channel.provision_state === "pending" ? " · not live yet" : ""}
                  {channel.active ? "" : " · retired"}
                </p>
                {channel.provision_state === "pending" ? (
                  <p className="mt-1 text-[10px] text-amber-300/80">
                    Waiting to be created on the radio network. It cannot carry audio until then.
                  </p>
                ) : null}
              </div>
              {canManage ? (
                <div className="flex gap-2">
                  <button
                    className="rounded border border-white/10 px-2 py-1 text-[10px] text-neutral-300 hover:border-ops-green hover:text-ops-green"
                    onClick={() => setOpenChannelId(openChannelId === channel.id ? null : channel.id)}
                  >
                    {openChannelId === channel.id ? "Close" : "Radios"}
                  </button>
                  <button
                    className="rounded border border-white/10 px-2 py-1 text-[10px] text-neutral-300 hover:border-ops-green hover:text-ops-green"
                    onClick={() => {
                      const name = window.prompt("Rename channel", channel.name);
                      if (name?.trim()) renameMutation.mutate({ id: channel.id, name: name.trim() });
                    }}
                  >
                    Rename
                  </button>
                  <button
                    className="inline-flex items-center gap-1 rounded border border-red-500/20 px-2 py-1 text-[10px] text-red-400/70 hover:border-ops-red hover:text-ops-red"
                    onClick={() => {
                      if (window.confirm(`Remove ${channel.name}?`)) removeMutation.mutate(channel.id);
                    }}
                  >
                    <Trash2 size={11} /> Remove
                  </button>
                </div>
              ) : null}
            </div>
            {openChannelId === channel.id ? (
              <ChannelMembers channel={channel} devices={devices} onChanged={refresh} />
            ) : null}
          </article>
        ))}
        {!channelsQuery.isLoading && !channels.length ? (
          <p className="px-4 py-10 text-center text-[12px] text-neutral-500">
            No channels yet. Create one to group radios that should hear each other.
          </p>
        ) : null}
      </List>
    </section>
  );
}

function ChannelMembers({ channel, devices, onChanged }) {
  const queryClient = useQueryClient();
  const membersQuery = useQuery({
    queryKey: ["org-channel-devices", channel.id],
    queryFn: () => listOrgChannelDevices(channel.id),
  });
  const toggleMutation = useMutation({
    mutationFn: ({ deviceId, member }) => setOrgChannelDevice(channel.id, deviceId, member),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-channel-devices", channel.id] });
      onChanged();
    },
  });
  const memberIds = new Set((membersQuery.data?.devices || []).map((device) => String(device.device_id)));

  return (
    <div className="mt-3 rounded border border-white/10 bg-white/[0.03] p-3">
      <h4 className="text-[11px] font-bold text-neutral-300">Radios on this channel</h4>
      {toggleMutation.error ? <p className="mt-1 text-[10px] text-ops-red">{toggleMutation.error.message}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {devices.map((device) => {
          const member = memberIds.has(String(device.device_id));
          return (
            <button
              key={device.device_id}
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] ${
                member ? "bg-ops-green text-black" : "border border-white/10 text-neutral-400 hover:border-ops-green hover:text-ops-green"
              }`}
              disabled={toggleMutation.isPending}
              onClick={() => toggleMutation.mutate({ deviceId: device.device_id, member: !member })}
            >
              {member ? <X size={10} /> : <Plus size={10} />}
              <span className={`h-1.5 w-1.5 rounded-full ${device.pocstars_online ? "bg-ops-green" : "bg-neutral-600"} ${member ? "opacity-60" : ""}`} />
              {device.name || device.device_id}
            </button>
          );
        })}
        {!devices.length ? (
          <p className="text-[10px] text-neutral-500">
            No radios allocated to this organization yet. A platform admin assigns them.
          </p>
        ) : null}
      </div>
    </div>
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
              {ORG_ROLES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="Unit">
            <select className="field-input" value={form.unit_id} onChange={(event) => setForm({ ...form, unit_id: event.target.value })}>
              <option value="">Whole organization</option>
              {units.map((unit) => <option value={unit.id} key={unit.id}>{unitOptionLabel(unit)}</option>)}
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
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-50" disabled={addMutation.isPending}>
            <UserPlus size={14} /> {addMutation.isPending ? "Saving..." : "Add user"}
          </button>
          {addMutation.isSuccess ? <span className="text-xs text-ops-green">User added</span> : null}
        </div>
      </form>

      <List title={`${users.length} user${users.length === 1 ? "" : "s"}`}>
        {users.map((user) => (
          <article className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" key={user.id}>
            <div className="min-w-0">
              <h3 className="text-sm text-neutral-100">{user.name || user.email}</h3>
              <p className="text-[11px] text-neutral-500">{user.email} · {orgRoleLabel(user.role)} · {user.unit_name || "whole organization"}</p>
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
            {units.map((unit) => <option value={unit.id} key={unit.id}>{unitOptionLabel(unit)}</option>)}
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

function unitOptionLabel(unit) {
  return unit.parent_name ? `${unit.parent_name} / ${unit.name}` : unit.name;
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}
