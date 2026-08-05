import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Building2, ClipboardList, Globe2, Plus, Radio, RadioTower, Save, Trash2, UserPlus, UsersRound, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  addOrganizationUser,
  attachDeviceToOrganization,
  deleteOrganization,
  detachDeviceFromOrganization,
  getOrganization,
  getOrganizationDeletionImpact,
  listDevices,
  provisionOrganizationRadio,
  removeOrganizationUser,
  updateOrganizationAccess,
} from "../lib/api";
import { NIGERIAN_STATES, ORG_ROLES, deviceTypeLabel, orgRoleLabel } from "../lib/domain";

// Access and Settings were two tabs holding four fields between them, while
// everything that actually differs per company - radios, channels, seats - was
// spread across other pages. One Overview, and a Radio tab that owns the whole
// radio story for this company.
const TABS = [
  { id: "overview", label: "Overview", icon: Globe2 },
  { id: "users", label: "Admins", icon: UsersRound },
  { id: "radio", label: "Radio", icon: RadioTower },
  { id: "devices", label: "Devices", icon: Radio },
  { id: "audit", label: "Audit", icon: ClipboardList },
];

export function AdminOrganizationDetailRoute() {
  const { id } = useParams({ from: "/admin/organizations/$id" });
  const orgId = Number(id);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("overview");
  // Drafts live in the child sections, so a tab switch would silently discard
  // them. The sections report dirtiness up so the switch can be caught.
  const [dirty, setDirty] = useState(false);

  const orgQuery = useQuery({
    queryKey: ["organization", orgId],
    queryFn: () => getOrganization(orgId),
    enabled: Number.isFinite(orgId),
  });

  const refresh = () => {
    setDirty(false);
    queryClient.invalidateQueries({ queryKey: ["organization", orgId] });
    queryClient.invalidateQueries({ queryKey: ["organizations"] });
  };

  const selectTab = (next) => {
    if (next === tab) return;
    if (dirty && !window.confirm("You have unsaved changes on this tab. Leave without saving?")) return;
    setDirty(false);
    setTab(next);
  };

  if (orgQuery.isLoading) return <Wrapper>Loading...</Wrapper>;
  if (orgQuery.error) return <Wrapper>Failed to load: {orgQuery.error.message}</Wrapper>;
  const data = orgQuery.data;
  if (!data?.organization) return <Wrapper>Company not found.</Wrapper>;

  const { organization, devices = [], users = [], units = [], audit = [], channels = [] } = data;

  return (
    <Wrapper>
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-xl font-bold text-ops-red">
          <Building2 size={22} /> {organization.name}
          {organization.status !== "active" ? (
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold uppercase text-neutral-400">
              {organization.status}
            </span>
          ) : null}
        </h1>
        <p className="mt-1 text-[11px] text-neutral-500">
          {organization.slug} · {devices.length} radio{devices.length === 1 ? "" : "s"} · {channels.length} channel{channels.length === 1 ? "" : "s"} · {users.length} admin{users.length === 1 ? "" : "s"}
        </p>
        {!organization.pocstars_company_id ? (
          <p className="mt-2 inline-flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
            <AlertTriangle size={12} /> This company is not on the radio network yet.
            <button className="font-bold underline" onClick={() => selectTab("radio")}>Set it up</button>
          </p>
        ) : null}
      </header>

      <div className="mb-5 flex flex-wrap gap-2 border-b border-white/10">
        {TABS.map((entry) => {
          const Icon = entry.icon;
          const active = tab === entry.id;
          return (
            <button
              key={entry.id}
              onClick={() => selectTab(entry.id)}
              className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-xs font-bold transition ${
                active ? "border-ops-red text-ops-red" : "border-transparent text-neutral-500 hover:text-neutral-200"
              }`}
            >
              <Icon size={13} /> {entry.label}
            </button>
          );
        })}
      </div>

      {tab === "overview" ? <OverviewSection organization={organization} units={units} onSaved={refresh} onDirtyChange={setDirty} /> : null}
      {tab === "users" ? <UsersSection orgId={orgId} users={users} onChanged={refresh} /> : null}
      {tab === "radio" ? <RadioSection organization={organization} channels={channels} onSaved={refresh} onDirtyChange={setDirty} /> : null}
      {tab === "devices" ? <DevicesSection orgId={orgId} devices={devices} onChanged={refresh} /> : null}
      {tab === "audit" ? <AuditSection audit={audit} /> : null}
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

// Identity, status and intelligence access in one place - they were split
// across two tabs called "Access" and "Settings" for four fields.
function OverviewSection({ organization, units, onSaved, onDirtyChange }) {
  const initial = useMemo(() => ({
    name: organization.name,
    status: organization.status,
    all_states: Boolean(organization.all_states),
    states: organization.states || [],
  }), [organization]);
  const [draft, setDraft] = useState(initial);

  const edit = (next) => {
    setDraft(next);
    onDirtyChange(JSON.stringify(next) !== JSON.stringify(initial));
  };

  const mutation = useMutation({
    mutationFn: (payload) => updateOrganizationAccess(organization.id, payload),
    onSuccess: onSaved,
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  return (
    <section className="space-y-5">
      <div className="glass-panel rounded-lg p-5">
        <h2 className="mb-4 text-[13px] font-bold text-ops-red">Company</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name">
            <input className="field-input" value={draft.name} onChange={(event) => edit({ ...draft, name: event.target.value })} />
          </Field>
          <Field label="Status">
            <select className="field-input" value={draft.status} onChange={(event) => edit({ ...draft, status: event.target.value })}>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
          </Field>
        </div>
        <p className="text-[11px] text-neutral-500">
          Suspending keeps everything intact and blocks the company from using the platform.
          Slug <span className="font-mono text-neutral-400">{organization.slug}</span> is fixed once created.
        </p>

        <h3 className="mb-1 mt-5 text-[12px] font-bold text-ops-red">Intelligence access</h3>
        <p className="mb-3 text-[11px] text-neutral-500">
          Which Nigerian states this company sees in the operations console.
        </p>
        <StatePicker value={draft} onChange={edit} />

        <SaveRow mutation={mutation} dirty={dirty} onSave={() => mutation.mutate(draft)} label="Save company" />
      </div>

      {/* Units are arranged by the company's own admins. Showing them read-only
          here answers "how is this tenant structured" without the platform
          reaching into work that belongs to them. */}
      <div className="glass-panel rounded-lg p-5">
        <h2 className="text-[13px] font-bold text-ops-red">Units</h2>
        <p className="mt-1 text-[11px] text-neutral-500">
          {units.length
            ? "Arranged by this company's own admins in their organization console."
            : "This company has not created any units yet."}
        </p>
        {units.length ? (
          <ul className="mt-3 grid gap-2 md:grid-cols-2">
            {units.map((unit) => (
              <li className="rounded border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px]" key={unit.id}>
                <span className="font-bold text-neutral-200">{unit.name}</span>
                <span className="text-neutral-500">
                  {unit.type ? ` · ${unit.type}` : ""}{unit.state ? ` · ${unit.state}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <DangerZone organization={organization} />
    </section>
  );
}

// Every save on this page reports the same way. Access used to confirm,
// Settings said nothing at all, so you could not tell a saved edit from a
// dropped one.
function SaveRow({ mutation, dirty, onSave, label }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button
        className="inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-40"
        disabled={mutation.isPending || !dirty}
        onClick={onSave}
      >
        <Save size={13} /> {mutation.isPending ? "Saving…" : label}
      </button>
      {dirty ? <span className="text-[11px] text-amber-300">Unsaved changes</span> : null}
      {mutation.error ? <span className="text-xs text-ops-red">{mutation.error.message}</span> : null}
      {mutation.isSuccess && !dirty ? <span className="text-xs text-ops-green">Saved</span> : null}
    </div>
  );
}

// The whole radio story for one company: whether it exists on the network, how
// many concurrent sessions it may hold, and which channels it owns.
function RadioSection({ organization, channels, onSaved, onDirtyChange }) {
  const initial = useMemo(() => ({
    radio_seats: organization.radio_seats ?? 2,
    platform_radio_seats: organization.platform_radio_seats ?? 1,
  }), [organization]);
  const [draft, setDraft] = useState(initial);

  const edit = (next) => {
    setDraft(next);
    onDirtyChange(JSON.stringify(next) !== JSON.stringify(initial));
  };

  const seatsMutation = useMutation({
    mutationFn: (payload) => updateOrganizationAccess(organization.id, payload),
    onSuccess: onSaved,
  });
  const provisionMutation = useMutation({
    mutationFn: () => provisionOrganizationRadio(organization.id),
    onSuccess: onSaved,
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  return (
    <section className="space-y-5">
      <div className="glass-panel rounded-lg p-5">
        <h2 className="text-[13px] font-bold text-ops-green">Radio network</h2>
        {organization.pocstars_company_id ? (
          <p className="mt-1 text-[11px] text-neutral-500">
            Connected as company <span className="font-mono text-neutral-300">{organization.pocstars_company_id}</span>
            {organization.pocstars_company_name ? ` · ${organization.pocstars_company_name}` : ""}.
            Its dispatcher seats and channels are its own.
          </p>
        ) : (
          <>
            <p className="mt-1 max-w-2xl text-[11px] text-amber-200">
              This company has no company on the radio network, so it cannot hold channels or
              radios. This usually means the setup failed when the company was created.
            </p>
            <button
              className="mt-3 inline-flex items-center gap-2 rounded bg-ops-green px-4 py-2 text-xs font-bold text-black disabled:opacity-50"
              disabled={provisionMutation.isPending}
              onClick={() => provisionMutation.mutate()}
            >
              <RadioTower size={13} />
              {provisionMutation.isPending ? "Setting up…" : "Set up on the radio network"}
            </button>
            {provisionMutation.error ? (
              <p className="mt-2 text-xs text-ops-red">{provisionMutation.error.message}</p>
            ) : null}
          </>
        )}
      </div>

      <div className="glass-panel rounded-lg p-5">
        <h2 className="mb-1 text-[13px] font-bold text-ops-red">Seats</h2>
        <p className="mb-4 text-[11px] text-neutral-500">
          How many audio sessions can run at once. Platform seats are reserved for us, so our
          monitoring never consumes theirs. Changing these does not resize the company on the
          radio network — that is done there.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Radio seats (their concurrent audio sessions)">
            <input
              className="field-input" type="number" min="1" value={draft.radio_seats}
              onChange={(event) => edit({ ...draft, radio_seats: event.target.value })}
            />
          </Field>
          <Field label="Platform seats (reserved for us)">
            <input
              className="field-input" type="number" min="0" value={draft.platform_radio_seats}
              onChange={(event) => edit({ ...draft, platform_radio_seats: event.target.value })}
            />
          </Field>
        </div>
        <SaveRow mutation={seatsMutation} dirty={dirty} onSave={() => seatsMutation.mutate(draft)} label="Save seats" />
      </div>

      <div className="glass-panel overflow-hidden rounded-lg">
        <div className="border-b border-white/10 px-4 py-3 text-[11px] text-neutral-500">
          {channels.length} channel{channels.length === 1 ? "" : "s"} · assign and release these on the Companies page
        </div>
        <div className="divide-y divide-white/5">
          {channels.map((channel) => (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" key={channel.id}>
              <div className="min-w-0">
                <h3 className="text-sm text-neutral-100">{channel.name}</h3>
                <p className="text-[11px] text-neutral-500">
                  {channel.unit_name ? `${channel.unit_name} · ` : ""}
                  {channel.device_count || 0} radio{channel.device_count === 1 ? "" : "s"}
                  {channel.pocstars_group_id
                    ? ` · network group ${channel.pocstars_group_id}`
                    : " · not live on the radio network"}
                </p>
              </div>
              <span className="text-[11px] text-neutral-400">{channel.online_count || 0} online</span>
            </div>
          ))}
          {!channels.length ? (
            <div className="px-4 py-10 text-center text-[12px] text-neutral-500">
              <RadioTower className="mx-auto mb-2" size={26} /> No channels yet
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function AuditSection({ audit }) {
  return (
    <section className="glass-panel overflow-hidden rounded-lg">
      <div className="border-b border-white/10 px-4 py-3 text-[11px] text-neutral-500">
        {audit.length} audit event{audit.length === 1 ? "" : "s"} · most recent first
      </div>
      <div className="divide-y divide-white/5">
        {audit.map((entry) => (
          <article className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3" key={entry.id}>
            <div className="min-w-0">
              <h3 className="font-mono text-[12px] text-neutral-100">{entry.action}</h3>
              <p className="text-[11px] text-neutral-500">
                {entry.actor_name || entry.actor_email || "system"}
                {entry.target_type ? ` · ${entry.target_type}${entry.target_id ? ` ${entry.target_id}` : ""}` : ""}
              </p>
            </div>
            <span className="shrink-0 text-[11px] text-neutral-500">
              {new Date(entry.created_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
            </span>
          </article>
        ))}
        {!audit.length ? (
          <div className="px-4 py-10 text-center text-[12px] text-neutral-500">
            <ClipboardList className="mx-auto mb-2" size={26} /> No audit events yet
          </div>
        ) : null}
      </div>
    </section>
  );
}

const emptyUserForm = { email: "", name: "", password: "", role: "org_admin" };

function UsersSection({ orgId, users, onChanged }) {
  const [form, setForm] = useState(emptyUserForm);

  const addMutation = useMutation({
    mutationFn: (payload) => addOrganizationUser(orgId, payload),
    onSuccess: () => {
      setForm(emptyUserForm);
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
              {ORG_ROLES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </Field>
        </div>
        {addMutation.error ? <p className="mt-2 text-xs text-ops-red">{addMutation.error.message}</p> : null}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-50" disabled={addMutation.isPending}>
            <UserPlus size={14} /> {addMutation.isPending ? "Saving..." : "Add user"}
          </button>
          {addMutation.isSuccess ? <span className="text-xs text-ops-green">Added</span> : null}
        </div>
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
                <p className="text-[11px] text-neutral-500">{user.email} · {orgRoleLabel(user.role)}</p>
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


// Deletion is the only irreversible act on this page, so it is staged: open the
// panel, read what actually goes, then type the name. Suspending is offered
// alongside because it is what most people reaching for delete actually want.
function DangerZone({ organization }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");

  const impactQuery = useQuery({
    queryKey: ["organization-deletion-impact", organization.id],
    queryFn: () => getOrganizationDeletionImpact(organization.id),
    enabled: open,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteOrganization(organization.id, confirmation.trim()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      queryClient.invalidateQueries({ queryKey: ["pocstars-registry"] });
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      navigate({ to: "/admin/organizations" });
    },
  });

  const counts = impactQuery.data?.counts;
  const radio = impactQuery.data?.radio;
  const matches = confirmation.trim() === organization.name.trim();

  return (
    <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/[0.04] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-[12px] font-bold text-ops-red">
            <AlertTriangle size={14} /> Delete this company
          </h3>
          <p className="mt-1 max-w-2xl text-[11px] text-neutral-500">
            Removes the workspace and everything filed under it. Its radios return to the
            unallocated pool. To stop a company using the platform without losing its data,
            set its status to Suspended above instead.
          </p>
        </div>
        <button
          className="shrink-0 rounded border border-red-500/30 px-3 py-2 text-[11px] font-bold text-red-300 hover:border-ops-red hover:text-ops-red"
          onClick={() => {
            setOpen((value) => !value);
            setConfirmation("");
            deleteMutation.reset();
          }}
        >
          {open ? "Cancel" : "Delete company"}
        </button>
      </div>

      {open ? (
        <div className="mt-4 border-t border-red-500/20 pt-4">
          {impactQuery.isLoading ? (
            <p className="text-[11px] text-neutral-500">Checking what this would remove…</p>
          ) : impactQuery.error ? (
            <p className="text-[11px] text-ops-red">{impactQuery.error.message}</p>
          ) : counts ? (
            <>
              <p className="text-[11px] font-bold text-neutral-300">Deleting {organization.name} will:</p>
              <ul className="mt-2 space-y-1 text-[11px] text-neutral-400">
                <ImpactLine count={counts.radios} one="radio returns" many="radios return" tail="to the unallocated pool" />
                <ImpactLine count={counts.claimed_groups} one="radio channel is released" many="radio channels are released" tail="back to the network registry" />
                <ImpactLine count={counts.members} one="admin loses access" many="admins lose access" />
                <ImpactLine count={counts.accounts_deleted} one="login is deleted" many="logins are deleted" tail="(they belong to no other company)" />
                <ImpactLine count={counts.units} one="unit is deleted" many="units are deleted" />
                <ImpactLine count={counts.channels} one="channel record is deleted" many="channel records are deleted" />
                <ImpactLine count={counts.geofences} one="geofence is deleted" many="geofences are deleted" />
                <ImpactLine count={counts.alerts} one="alert is deleted" many="alerts are deleted" />
                <ImpactLine count={counts.audit_entries} one="audit entry is deleted" many="audit entries are deleted" />
              </ul>
              {radio?.company_id ? (
                <p className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                  Radio network company {radio.company_id} is left in place — the network is shared
                  with other operators and keeps its recordings. Retire it on the network itself if
                  it is no longer needed.
                  {radio.shared_with?.length
                    ? ` It is also claimed by ${radio.shared_with.map((org) => org.name).join(", ")}.`
                    : ""}
                </p>
              ) : null}
            </>
          ) : null}

          <label className="mt-4 flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-neutral-500">
              Type <span className="font-bold text-neutral-300">{organization.name}</span> to confirm
            </span>
            <input
              className="field-input"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={organization.name}
              autoComplete="off"
            />
          </label>

          {deleteMutation.error ? (
            <p className="mt-2 text-[11px] text-ops-red">{deleteMutation.error.message}</p>
          ) : null}

          <button
            className="mt-3 inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-40"
            disabled={!matches || deleteMutation.isPending || impactQuery.isLoading}
            onClick={() => deleteMutation.mutate()}
          >
            <Trash2 size={13} />
            {deleteMutation.isPending ? "Deleting…" : `Permanently delete ${organization.name}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ImpactLine({ count, one, many, tail }) {
  if (!count) return null;
  return (
    <li className="flex gap-2">
      <span className="text-neutral-600">•</span>
      <span>
        <span className="font-bold text-neutral-200">{count}</span> {count === 1 ? one : many}
        {tail ? ` ${tail}` : ""}
      </span>
    </li>
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
