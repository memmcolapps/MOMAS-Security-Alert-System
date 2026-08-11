import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MessageSquare, Plus, Radio, Save, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  deleteDevice,
  getLocations,
  getMe,
  getOrgAdmin,
  listDevices,
  listOrganizations,
  onboardRadio,
  saveDevice,
} from "../lib/api";
import { RadioConsole } from "../components/RadioConsole";
import { Toast, useToast } from "../components/Toast";
import { deviceTypeLabel } from "../lib/domain";

const emptyForm = {
  device_id: "",
  // Onboarding identifies a handset by the IMEI printed on it. The radio
  // network assigns the uid, so device_id is an outcome of onboarding rather
  // than something anyone can type in.
  imei: "",
  name: "",
  organization_id: "",
  unit_id: "",
  operator: "",
  device_type: "",
  active: "true",
  notes: "",
  channel_id: "",
  service_ends_at: defaultServiceEnd(),
  gps_enabled: "true",
  gps_frequency: "30",
};

// Radios are sold with a service window and are refused at sign-in once it
// lapses, so a new handset needs a real date rather than an open-ended one.
function defaultServiceEnd() {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 2);
  return date.toISOString().slice(0, 10);
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}


export function DevicesRoute() {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [selectedRadio, setSelectedRadio] = useState(null);
  const { toast, notify, dismiss: dismissToast } = useToast();

  const devicesQuery = useQuery({
    queryKey: ["devices"],
    queryFn: listDevices,
  });

  // Only needed by the open console, which wants the handset's last position.
  const locationsQuery = useQuery({
    queryKey: ["locations"],
    queryFn: getLocations,
    enabled: Boolean(selectedRadio),
    staleTime: 15_000,
  });
  const latestLocations = useMemo(
    () => new Map((locationsQuery.data?.data || []).map((row) => [String(row.Uid), row])),
    [locationsQuery.data?.data],
  );

  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const isPlatformAdmin = meQuery.data?.user?.platform_role === "admin";
  const orgRole = meQuery.data?.user?.active_membership?.role || meQuery.data?.user?.memberships?.[0]?.role;
  const canManageDevices = isPlatformAdmin || ["org_owner", "org_admin", "admin"].includes(orgRole);

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: listOrganizations,
    enabled: isPlatformAdmin,
  });
  const orgAdminQuery = useQuery({
    queryKey: ["org-admin"],
    queryFn: getOrgAdmin,
    enabled: !isPlatformAdmin && canManageDevices,
  });

  const [orgFilter, setOrgFilter] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [search, setSearch] = useState("");

  const allDevices = useMemo(() => devicesQuery.data?.devices || [], [devicesQuery.data?.devices]);
  const organizations = useMemo(() => orgsQuery.data?.organizations || [], [orgsQuery.data?.organizations]);
  const units = orgAdminQuery.data?.units || [];
  const organizationDevices = useMemo(() => {
    if (orgFilter === "all") return allDevices;
    if (orgFilter === "unassigned") return allDevices.filter((device) => !device.organization_id);
    return allDevices.filter((device) => String(device.organization_id) === String(orgFilter));
  }, [allDevices, orgFilter]);
  const channels = useMemo(() => {
    const seen = new Map();
    for (const device of organizationDevices) {
      for (const channel of device.channels || []) {
        if (!seen.has(String(channel.id))) {
          seen.set(String(channel.id), {
            id: String(channel.id),
            name: channel.name,
            organizationName: device.organization_name,
          });
        }
      }
    }
    return [...seen.values()];
  }, [organizationDevices]);
  const devices = useMemo(() => {
    const term = search.trim().toLowerCase();
    let list = organizationDevices;
    if (channelFilter === "unassigned") {
      list = list.filter((device) => !(device.channels || []).length);
    } else if (channelFilter !== "all") {
      list = list.filter((device) =>
        (device.channels || []).some((channel) => String(channel.id) === channelFilter));
    }
    if (!term) return list;
    // Search covers what people actually know: the IMEI printed on the handset,
    // the radio name, who carries it, and which company owns it.
    return list.filter((device) => [
      device.device_id,
      device.name,
      device.operator,
      device.organization_name,
    ].filter(Boolean).some((value) => String(value).toLowerCase().includes(term)));
  }, [channelFilter, organizationDevices, search]);
  const activeCount = useMemo(() => devices.filter((device) => device.active).length, [devices]);

  // Channels a new radio can be put on: those of the organization chosen in the
  // form. Derived from radios already on the network, so a channel nobody is on
  // yet will not appear - it can be assigned from the channel screen afterwards.
  const orgChannels = useMemo(() => {
    if (!form.organization_id) return [];
    const seen = new Map();
    for (const device of allDevices) {
      if (String(device.organization_id) !== String(form.organization_id)) continue;
      for (const channel of device.channels || []) {
        if (!seen.has(String(channel.id))) seen.set(String(channel.id), { id: String(channel.id), name: channel.name });
      }
    }
    return [...seen.values()];
  }, [allDevices, form.organization_id]);


  useEffect(() => {
    setChannelFilter("all");
  }, [orgFilter]);

  const saveMutation = useMutation({
    mutationFn: saveDevice,
    onSuccess: async () => {
      notify("Device updated", "success");
      closeForm();
      await queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (error) => notify(error.message, "error"),
  });

  const onboardMutation = useMutation({
    mutationFn: onboardRadio,
    onSuccess: async (result) => {
      // The uid is worth showing: it is how the radio is identified everywhere
      // else, and the person holding the handset only knows its IMEI.
      notify(`Radio onboarded as ${result?.radio?.uid ?? "a new device"}`, "success");
      closeForm();
      await queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (error) => notify(error.message, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteDevice,
    onSuccess: async () => {
      notify("Device removed", "success");
      await queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (error) => notify(error.message, "error"),
  });

  function openAdd() {
    setEditingId(null);
    setForm(emptyForm);
    setFormOpen(true);
  }

  function openEdit(device) {
    setEditingId(device.device_id);
    setForm({
      device_id: device.device_id || "",
      name: device.name || "",
      organization_id: device.organization_id ? String(device.organization_id) : "",
      unit_id: device.unit_id ? String(device.unit_id) : "",
      operator: device.operator || "",
      device_type: device.device_type || "",
      active: String(Boolean(device.active)),
      notes: device.notes || "",
    });
    setFormOpen(true);
  }

  function closeForm() {
    setEditingId(null);
    setForm(emptyForm);
    setFormOpen(false);
  }

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function submitForm(event) {
    event.preventDefault();

    // A new radio is created on the radio network; an existing one is only
    // edited here. They are different operations against different systems.
    if (!editingId) {
      const imei = form.imei.trim();
      if (!/^\d{10,20}$/.test(imei)) {
        notify("Enter the IMEI printed on the handset", "error");
        return;
      }
      if (!form.name.trim()) {
        notify("Give the radio a name", "error");
        return;
      }
      if (!form.organization_id) {
        notify("Choose the organization this radio belongs to", "error");
        return;
      }
      onboardMutation.mutate({
        imei,
        name: form.name.trim(),
        organization_id: Number(form.organization_id),
        unit_id: form.unit_id ? Number(form.unit_id) : null,
        channel_ids: form.channel_id ? [Number(form.channel_id)] : [],
        default_channel_id: form.channel_id ? Number(form.channel_id) : null,
        service_ends_at: `${form.service_ends_at} 00:00:00`,
        gps_enabled: form.gps_enabled === "true",
        gps_frequency: Number(form.gps_frequency) || 30,
        operator: form.operator.trim() || null,
        device_type: form.device_type || "handheld",
        notes: form.notes.trim() || null,
      });
      return;
    }

    const deviceId = form.device_id.trim();
    if (!deviceId) {
      notify("Device ID is required", "error");
      return;
    }
    saveMutation.mutate({
      device_id: deviceId,
      name: form.name.trim() || null,
      organization_id: form.organization_id ? Number(form.organization_id) : null,
      unit_id: form.unit_id ? Number(form.unit_id) : null,
      operator: form.operator.trim() || null,
      device_type: form.device_type || null,
      notes: form.notes.trim() || null,
      active: form.active === "true",
    });
  }

  return (
    <main className="device-page bg-ops-bg px-6 pb-8 pt-20 text-neutral-200">
      <header className="mb-7 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ops-green">
            <Radio size={21} /> Device Registry
          </h1>
          <p className="mt-1 text-[11px] text-neutral-500">
            {isPlatformAdmin
              ? "Manage radios and vehicle trackers"
              : "View your assigned devices and update operational details"}
          </p>
        </div>
        {isPlatformAdmin ? (
          <button className="inline-flex items-center gap-2 rounded-md bg-ops-green px-4 py-2 text-xs font-bold text-black hover:opacity-85" onClick={openAdd}>
            <Plus size={14} /> Add device
          </button>
        ) : null}
      </header>

      {formOpen ? (
        <form className="glass-panel mb-7 rounded-lg border-green-500/30 p-5" onSubmit={submitForm}>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[13px] font-bold text-ops-green">{editingId ? "Edit device" : "Onboard a radio"}</h2>
            <button type="button" className="rounded p-1 text-neutral-500 hover:text-neutral-200" onClick={closeForm}>
              <X size={16} />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {editingId ? (
              <Field label="Device ID">
                <input className="field-input font-mono" value={form.device_id} disabled />
              </Field>
            ) : (
              <Field label="IMEI" required>
                <input className="field-input font-mono" value={form.imei} onChange={(event) => updateField("imei", event.target.value)} placeholder="15 digits, printed on the handset" />
              </Field>
            )}
            <Field label="Name" required={!editingId}>
              <input className="field-input" value={form.name} onChange={(event) => updateField("name", event.target.value)} placeholder="e.g. TK-100 Gate" />
            </Field>
            {isPlatformAdmin ? (
              <Field label="Company">
                <select className="field-input" value={form.organization_id} onChange={(event) => updateField("organization_id", event.target.value)}>
                  <option value="">Unassigned</option>
                  {organizations.map((org) => (
                    <option value={org.id} key={org.id}>{org.name}</option>
                  ))}
                </select>
              </Field>
            ) : null}
            {!isPlatformAdmin && canManageDevices ? (
              <Field label="Unit">
                <select className="field-input" value={form.unit_id} onChange={(event) => updateField("unit_id", event.target.value)}>
                  <option value="">No unit</option>
                  {units.map((unit) => (
                    <option value={unit.id} key={unit.id}>{unit.name}</option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label="Assigned Operator">
              <input className="field-input" value={form.operator} onChange={(event) => updateField("operator", event.target.value)} placeholder="e.g. John Doe" />
            </Field>
            <Field label="Device Type">
              <select className="field-input" value={form.device_type} onChange={(event) => updateField("device_type", event.target.value)}>
                <option value="">Select</option>
                <option value="handheld">Handheld radio</option>
                <option value="vehicle">Vehicle tracker</option>
                <option value="fixed">Fixed unit</option>
                <option value="other">Other</option>
              </select>
            </Field>
            {editingId ? (
              <Field label="Status">
                <select className="field-input" value={form.active} onChange={(event) => updateField("active", event.target.value)}>
                  <option value="true">Active</option>
                  <option value="false">Inactive (hidden from map)</option>
                </select>
              </Field>
            ) : null}
            {!editingId ? (
              <>
                <Field label="Channel">
                  <select className="field-input" value={form.channel_id} onChange={(event) => updateField("channel_id", event.target.value)}>
                    <option value="">No channel yet</option>
                    {orgChannels.map((channel) => (
                      <option value={channel.id} key={channel.id}>{channel.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Service expires">
                  <input type="date" className="field-input" value={form.service_ends_at} onChange={(event) => updateField("service_ends_at", event.target.value)} />
                </Field>
                <Field label="Location reporting">
                  <select className="field-input" value={form.gps_enabled} onChange={(event) => updateField("gps_enabled", event.target.value)}>
                    <option value="true">On, every {form.gps_frequency}s</option>
                    <option value="false">Off</option>
                  </select>
                </Field>
              </>
            ) : null}
            <Field label="Notes" wide>
              <textarea className="field-input min-h-[68px] resize-y" value={form.notes} onChange={(event) => updateField("notes", event.target.value)} placeholder="Any additional details" />
            </Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="rounded bg-white/10 px-4 py-2 text-xs text-neutral-400 hover:text-neutral-100" onClick={closeForm}>
              Cancel
            </button>
            <button type="submit" disabled={saveMutation.isPending || onboardMutation.isPending} className="inline-flex items-center gap-2 rounded bg-ops-green px-4 py-2 text-xs font-bold text-black disabled:opacity-50">
              <Save size={14} />
              {editingId
                ? (saveMutation.isPending ? "Saving..." : "Save device")
                : (onboardMutation.isPending ? "Onboarding on the radio network..." : "Onboard radio")}
            </button>
          </div>
        </form>
      ) : null}

      {isPlatformAdmin ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <FilterChip active={orgFilter === "all"} onClick={() => setOrgFilter("all")}>
            All ({allDevices.length})
          </FilterChip>
          <FilterChip active={orgFilter === "unassigned"} onClick={() => setOrgFilter("unassigned")}>
            Unassigned ({allDevices.filter((device) => !device.organization_id).length})
          </FilterChip>
          {organizations.map((org) => (
            <FilterChip key={org.id} active={String(orgFilter) === String(org.id)} onClick={() => setOrgFilter(String(org.id))}>
              {org.name}
            </FilterChip>
          ))}
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[9px] font-bold uppercase tracking-wider text-neutral-600">Channel</span>
        <FilterChip active={channelFilter === "all"} onClick={() => setChannelFilter("all")}>
          All ({organizationDevices.length})
        </FilterChip>
        <FilterChip active={channelFilter === "unassigned"} onClick={() => setChannelFilter("unassigned")}>
          On no channel ({organizationDevices.filter((device) => !(device.channels || []).length).length})
        </FilterChip>
        {channels.map((channel) => (
          <FilterChip key={channel.id} active={channelFilter === channel.id} onClick={() => setChannelFilter(channel.id)}>
            {isPlatformAdmin && orgFilter === "all" && channel.organizationName
              ? `${channel.organizationName} / ${channel.name}`
              : channel.name}
          </FilterChip>
        ))}
      </div>

      <div className="mb-3 flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
        <Search size={14} className="text-neutral-500" />
        <input
          className="flex-1 bg-transparent text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
          placeholder="Search by IMEI, name, operator or company"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {search ? (
          <button className="text-neutral-500 hover:text-neutral-200" onClick={() => setSearch("")} aria-label="Clear search">
            <X size={13} />
          </button>
        ) : null}
      </div>

      <section className="glass-panel overflow-hidden rounded-lg border-green-500/25">
        <div className="border-b border-white/10 px-4 py-3 text-[11px] text-neutral-500">
          {devicesQuery.isLoading ? "Loading..." : `${devices.length} device${devices.length === 1 ? "" : "s"} · ${activeCount} active`}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-white/10 text-[9px] uppercase tracking-wide text-neutral-500">
                <th className="px-4 py-3">Device ID</th>
                <th className="px-4 py-3">Name</th>
                {isPlatformAdmin ? <th className="px-4 py-3">Company</th> : null}
                <th className="px-4 py-3">Channels</th>
                <th className="px-4 py-3">Operator</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Added</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {devicesQuery.isLoading ? (
                <tr>
                  <td className="px-4 py-10 text-center text-neutral-500" colSpan={isPlatformAdmin ? 9 : 8}>Loading devices...</td>
                </tr>
              ) : devices.length ? (
                devices.map((device) => (
                  <tr className="border-b border-white/5 hover:bg-white/[0.03]" key={device.device_id}>
                    <td className="px-4 py-3 font-mono text-[11px] text-ops-green">{device.device_id}</td>
                    <td className="px-4 py-3">{device.name || <Muted />}</td>
                    {isPlatformAdmin ? (
                      <td className="px-4 py-3">{device.organization_name || <span className="text-neutral-700">Unassigned</span>}</td>
                    ) : null}
                    <td className="px-4 py-3">
                      {(device.channels || []).length ? (
                        <div className="flex flex-wrap gap-1">
                          {device.channels.map((channel) => (
                            <span key={channel.id} className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-neutral-300">
                              {channel.name}
                            </span>
                          ))}
                        </div>
                      ) : <span className="text-neutral-700">No channel</span>}
                    </td>
                    <td className="px-4 py-3">
                      <OperatorCell
                        device={device}
                        canEdit={canManageDevices}
                        onSaved={() => queryClient.invalidateQueries({ queryKey: ["devices"] })}
                      />
                    </td>
                    <td className="px-4 py-3">{device.device_type ? deviceTypeLabel(device.device_type) : <Muted />}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold ${
                        device.active && (!device.pocstars_managed || device.pocstars_online)
                          ? "border-green-500/30 bg-green-500/10 text-ops-green"
                          : "border-white/10 bg-white/5 text-neutral-500"
                      }`}>
                        {!device.active
                          ? "Inactive"
                          : device.pocstars_managed
                            ? (device.pocstars_online ? "Online" : "Offline")
                            : "Active"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[11px] text-neutral-600">{formatDate(device.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button className="inline-flex items-center gap-1 rounded border border-green-500/25 px-2 py-1 text-[10px] text-ops-green hover:bg-green-500/10" onClick={() => setSelectedRadio(device)}>
                          <MessageSquare size={11} /> Open radio
                        </button>
                        {canManageDevices ? (
                        <button className="rounded border border-white/10 px-2 py-1 text-[10px] text-neutral-500 hover:border-ops-green hover:text-ops-green" onClick={() => openEdit(device)}>
                          Edit
                        </button>
                        ) : null}
                        {isPlatformAdmin ? (
                          <button className="inline-flex items-center gap-1 rounded border border-red-500/20 px-2 py-1 text-[10px] text-red-400/70 hover:border-ops-red hover:text-ops-red" onClick={() => {
                            if (window.confirm(`Remove device ${device.device_id}?`)) deleteMutation.mutate(device.device_id);
                          }}>
                            <Trash2 size={11} /> Remove
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-4 py-12 text-center text-neutral-500" colSpan={isPlatformAdmin ? 9 : 8}>
                    <Radio className="mx-auto mb-2" size={28} /> No devices yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selectedRadio ? (
        <>
          <button
            aria-label="Close radio console"
            className="fixed inset-x-0 bottom-0 top-20 z-[998] cursor-default bg-black/60"
            onClick={() => setSelectedRadio(null)}
          />
          <aside className="fixed bottom-0 right-0 top-20 z-[999] flex w-full max-w-md flex-col border-l border-green-500/25 bg-[#090d0b] shadow-2xl">
            <header className="flex items-start justify-between border-b border-white/10 px-5 py-4">
              <div>
                <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-ops-green">Radio console</p>
                <h2 className="mt-1 text-base font-bold text-neutral-100">
                  {selectedRadio.name || `Radio ${selectedRadio.device_id}`}
                </h2>
                <p className="mt-1 font-mono text-[10px] text-neutral-500">
                  UID {selectedRadio.device_id}
                  {selectedRadio.operator ? ` · ${selectedRadio.operator}` : ""}
                </p>
                <p className="mt-1 text-[10px] text-neutral-500">
                  {selectedRadio.organization_name || "Unallocated"}
                  {(selectedRadio.channels || []).length
                    ? ` · ${selectedRadio.channels.map((channel) => channel.name).join(", ")}`
                    : " · on no channel"}
                </p>
              </div>
              <button className="rounded p-2 text-neutral-500 hover:bg-white/5 hover:text-neutral-100" onClick={() => setSelectedRadio(null)}>
                <X size={18} />
              </button>
            </header>

            <RadioConsole device={selectedRadio} location={latestLocations.get(String(selectedRadio.device_id))} />
          </aside>
        </>
      ) : null}

      <Toast toast={toast} onDismiss={dismissToast} />
    </main>
  );
}

function Field({ label, required, wide, children }) {
  return (
    <label className={`flex flex-col gap-1 ${wide ? "md:col-span-2 lg:col-span-3" : ""}`}>
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">
        {label} {required ? <span className="text-ops-green">*</span> : null}
      </span>
      {children}
    </label>
  );
}

// Who is carrying this handset. MOMAS owns this fact - the radio network only
// knows the device label - so it is edited in place rather than imported.
function OperatorCell({ device, canEdit, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(device.operator || "");
  const mutation = useMutation({
    mutationFn: (operator) => saveDevice({
      device_id: device.device_id,
      name: device.name,
      organization_id: device.organization_id,
      unit_id: device.unit_id,
      operator: operator.trim() || null,
      device_type: device.device_type,
      notes: device.notes,
      active: device.active,
    }),
    onSuccess: () => {
      setEditing(false);
      onSaved();
    },
  });

  if (!canEdit) return device.operator || <Muted />;
  if (!editing) {
    return (
      <button
        className="rounded px-1 py-0.5 text-left hover:bg-white/[0.06]"
        onClick={() => { setValue(device.operator || ""); setEditing(true); }}
        title="Set who is carrying this radio"
      >
        {device.operator || <span className="text-neutral-700">Assign…</span>}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <input
        className="w-28 rounded border border-white/15 bg-black/40 px-1.5 py-0.5 text-[11px] text-neutral-100 focus:outline-none"
        value={value}
        autoFocus
        placeholder="Name"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") mutation.mutate(value);
          if (event.key === "Escape") setEditing(false);
        }}
      />
      <button
        className="rounded bg-ops-green px-1.5 py-0.5 text-[10px] font-bold text-black disabled:opacity-50"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate(value)}
      >
        <Check size={10} />
      </button>
      <button className="text-neutral-500 hover:text-neutral-200" onClick={() => setEditing(false)} aria-label="Cancel">
        <X size={11} />
      </button>
    </span>
  );
}

function Muted() {
  return <span className="text-neutral-700">-</span>;
}

function FilterChip({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-[10px] font-bold transition ${
        active
          ? "border-ops-green bg-green-500/15 text-ops-green"
          : "border-white/10 bg-white/[0.03] text-neutral-400 hover:text-neutral-200"
      }`}
    >
      {children}
    </button>
  );
}
