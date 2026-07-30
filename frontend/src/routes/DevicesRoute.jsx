import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MessageSquare, Mic, Phone, PhoneOff, Plus, Radio, Save, Search, Send, Trash2, Volume2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  deleteDevice,
  getMe,
  getOrgAdmin,
  listDevices,
  listOrganizations,
  saveDevice,
  sendRadioMessage,
} from "../lib/api";
import { deviceTypeLabel } from "../lib/domain";
import { useLiveRadioSession } from "../lib/live-radio-session";

const emptyForm = {
  device_id: "",
  name: "",
  organization_id: "",
  unit_id: "",
  operator: "",
  device_type: "",
  active: "true",
  notes: "",
};

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatRadioTime(value) {
  if (!value) return "Unknown time";
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}


export function DevicesRoute() {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [toast, setToast] = useState(null);
  const [selectedRadio, setSelectedRadio] = useState(null);
  const [radioMessage, setRadioMessage] = useState("");
  const [sentMessages, setSentMessages] = useState({});
  const liveRadio = useLiveRadioSession();

  const devicesQuery = useQuery({
    queryKey: ["devices"],
    queryFn: listDevices,
  });

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
  const radioMessageBytes = useMemo(
    () => new window.TextEncoder().encode(radioMessage.trim()).length,
    [radioMessage],
  );


  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    setChannelFilter("all");
  }, [orgFilter]);

  const saveMutation = useMutation({
    mutationFn: saveDevice,
    onSuccess: async () => {
      setToast(editingId ? "Device updated" : "Device added");
      closeForm();
      await queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (error) => setToast(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteDevice,
    onSuccess: async () => {
      setToast("Device removed");
      await queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (error) => setToast(error.message),
  });

  const messageMutation = useMutation({
    mutationFn: sendRadioMessage,
    onSuccess: (result, variables) => {
      setSentMessages((current) => ({
        ...current,
        [variables.device_id]: [
          ...(current[variables.device_id] || []),
          {
            id: result.deliveryId || `${Date.now()}`,
            message: variables.message,
            sentAt: result.acceptedAt || new Date().toISOString(),
          },
        ],
      }));
      setRadioMessage("");
      setToast(`Message sent to ${selectedRadio?.name || selectedRadio?.device_id || "radio"}`);
    },
    onError: (error) => setToast(error.message),
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
    const deviceId = form.device_id.trim();
    if (!deviceId) {
      setToast("Device ID is required");
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

  function sendMessage(event) {
    event.preventDefault();
    const message = radioMessage.trim();
    if (!selectedRadio || !message || radioMessageBytes > 200) return;
    messageMutation.mutate({
      device_id: selectedRadio.device_id,
      message,
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
        {canManageDevices ? (
          <button className="inline-flex items-center gap-2 rounded-md bg-ops-green px-4 py-2 text-xs font-bold text-black hover:opacity-85" onClick={openAdd}>
            <Plus size={14} /> Add device
          </button>
        ) : null}
      </header>

      {formOpen ? (
        <form className="glass-panel mb-7 rounded-lg border-green-500/30 p-5" onSubmit={submitForm}>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[13px] font-bold text-ops-green">{editingId ? "Edit device" : "New device"}</h2>
            <button type="button" className="rounded p-1 text-neutral-500 hover:text-neutral-200" onClick={closeForm}>
              <X size={16} />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            <Field label="Device ID" required>
              <input className="field-input font-mono" value={form.device_id} disabled={Boolean(editingId)} onChange={(event) => updateField("device_id", event.target.value)} placeholder="IMEI or UID" />
            </Field>
            <Field label="Name">
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
            <Field label="Status">
              <select className="field-input" value={form.active} onChange={(event) => updateField("active", event.target.value)}>
                <option value="true">Active</option>
                <option value="false">Inactive (hidden from map)</option>
              </select>
            </Field>
            <Field label="Notes" wide>
              <textarea className="field-input min-h-[68px] resize-y" value={form.notes} onChange={(event) => updateField("notes", event.target.value)} placeholder="Any additional details" />
            </Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="rounded bg-white/10 px-4 py-2 text-xs text-neutral-400 hover:text-neutral-100" onClick={closeForm}>
              Cancel
            </button>
            <button type="submit" disabled={saveMutation.isPending} className="inline-flex items-center gap-2 rounded bg-ops-green px-4 py-2 text-xs font-bold text-black disabled:opacity-50">
              <Save size={14} /> {saveMutation.isPending ? "Saving..." : "Save device"}
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
                        <button className="rounded border border-white/10 px-2 py-1 text-[10px] text-neutral-500 hover:border-ops-green hover:text-ops-green" onClick={() => openEdit(device)}>
                          Edit
                        </button>
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

            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <section className="rounded-lg border border-green-500/25 bg-green-500/[0.04] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="flex items-center gap-2 text-xs font-bold text-neutral-100">
                      <Radio size={14} className="text-ops-green" /> Private call
                    </h3>
                    <p className="mt-1 text-[10px] text-neutral-500">
                      Open a private call to this handset. To listen to a whole channel, use the channel bar at the top.
                    </p>
                  </div>
                  <span className={`rounded-full border px-2 py-1 text-[9px] font-bold uppercase ${
                    liveRadio.mode === "private" && liveRadio.callState === "connected"
                      ? "border-green-500/30 bg-green-500/10 text-ops-green"
                      : "border-white/10 text-neutral-500"
                  }`}>
                    {liveRadio.mode === "private" ? liveRadio.callState : "idle"}
                  </span>
                </div>

                {liveRadio.error && liveRadio.mode !== "monitor" ? (
                  <p className="mt-3 rounded bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{liveRadio.error}</p>
                ) : null}
                {liveRadio.mode === "private" && liveRadio.speaker ? (
                  <p className="mt-3 flex items-center gap-2 text-[11px] text-ops-green">
                    <Volume2 size={13} className="animate-pulse" /> {liveRadio.speaker.name || `Radio ${liveRadio.speaker.uid}`} is speaking
                  </p>
                ) : null}

                <div className="mt-4">
                  {liveRadio.configured === false ? (
                    <button
                      className="w-full rounded-md border border-red-500/20 px-4 py-3 text-xs text-red-300/70"
                      disabled
                    >
                      Live radio unavailable
                    </button>
                  ) : liveRadio.mode !== "private" ? (
                    <div className="space-y-2">
                      <button
                        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-ops-green px-4 py-2.5 text-xs font-bold text-black hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={liveRadio.callState === "connecting"}
                        onClick={() => liveRadio.callRadio(selectedRadio)}
                      >
                        <Phone size={16} /> Call this radio
                      </button>
                      {liveRadio.mode === "monitor" ? (
                        <p className="text-[10px] text-neutral-500">
                          Channel listening pauses during the call and resumes when it ends.
                        </p>
                      ) : null}
                    </div>
                  ) : liveRadio.callDevice && String(liveRadio.callDevice.device_id) !== String(selectedRadio.device_id) ? (
                    <div className="space-y-3">
                      <p className="rounded border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                        In a call with {liveRadio.callDevice.name || liveRadio.callDevice.device_id}. End it before calling this radio.
                      </p>
                      <button
                        className="inline-flex w-full items-center justify-center gap-2 rounded border border-red-500/25 px-3 py-2 text-[11px] text-red-300 hover:bg-red-500/10"
                        onClick={liveRadio.endCall}
                      >
                        <PhoneOff size={13} /> End that call
                      </button>
                    </div>
                  ) : liveRadio.callState === "connected" ? (
                    <div className="space-y-3">
                      <button
                        className={`flex min-h-24 w-full touch-none select-none flex-col items-center justify-center gap-2 rounded-lg border text-sm font-black uppercase tracking-wider transition ${
                          liveRadio.pttState === "granted"
                            ? "border-red-400 bg-red-500/25 text-red-200 shadow-[0_0_28px_rgba(239,68,68,0.18)]"
                            : "border-green-500/40 bg-green-500/10 text-ops-green hover:bg-green-500/15"
                        }`}
                        onPointerDown={(event) => {
                          event.currentTarget.setPointerCapture(event.pointerId);
                          liveRadio.startPtt();
                        }}
                        onPointerUp={liveRadio.stopPtt}
                        onPointerCancel={liveRadio.stopPtt}
                        onKeyDown={(event) => {
                          if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                            event.preventDefault();
                            liveRadio.startPtt();
                          }
                        }}
                        onKeyUp={(event) => {
                          if (event.key === " " || event.key === "Enter") liveRadio.stopPtt();
                        }}
                      >
                        <Mic size={24} />
                        {liveRadio.pttState === "granted" ? "Speaking · release to stop" : liveRadio.pttState === "requesting" ? "Requesting microphone…" : "Hold to talk"}
                      </button>
                      <button
                        className="inline-flex w-full items-center justify-center gap-2 rounded border border-red-500/25 px-3 py-2 text-[11px] text-red-300 hover:bg-red-500/10"
                        onClick={liveRadio.endCall}
                      >
                        <PhoneOff size={13} /> End call
                      </button>
                    </div>
                  ) : (
                    <button className="w-full rounded-md border border-white/10 px-4 py-3 text-xs text-neutral-500" disabled>
                      Connecting the call…
                    </button>
                  )}
                </div>
              </section>


              {(sentMessages[selectedRadio.device_id] || []).length ? (
                <section>
                  <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wide text-neutral-500">Sent this session</h3>
                  <div className="space-y-2">
                    {(sentMessages[selectedRadio.device_id] || []).map((item) => (
                      <article className="ml-10 rounded-lg border border-green-500/20 bg-green-500/[0.07] px-3 py-2" key={item.id}>
                        <p className="text-xs text-neutral-200">{item.message}</p>
                        <p className="mt-1 text-right text-[9px] text-neutral-600">{formatRadioTime(item.sentAt)} · MOMAS Command</p>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>

            <form className="border-t border-white/10 bg-black/25 p-4" onSubmit={sendMessage}>
              <label className="mb-2 block text-[10px] font-bold uppercase tracking-wide text-neutral-500">
                Send text command
              </label>
              <textarea
                className="field-input min-h-[82px] resize-none"
                value={radioMessage}
                onChange={(event) => setRadioMessage(event.target.value)}
                placeholder={`Message ${selectedRadio.name || selectedRadio.device_id}`}
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className={`text-[9px] ${radioMessageBytes > 200 ? "text-red-400" : "text-neutral-600"}`}>
                  {radioMessageBytes}/200 bytes · delivered over the radio network
                </span>
                <button
                  type="submit"
                  disabled={!radioMessage.trim() || radioMessageBytes > 200 || messageMutation.isPending}
                  className="inline-flex items-center gap-2 rounded bg-ops-green px-4 py-2 text-xs font-bold text-black disabled:opacity-40"
                >
                  <Send size={13} /> {messageMutation.isPending ? "Sending..." : "Send"}
                </button>
              </div>
            </form>
          </aside>
        </>
      ) : null}

      {toast ? (
        <div className="fixed bottom-6 left-1/2 z-[999] -translate-x-1/2 rounded-md border border-green-500/40 bg-black px-4 py-2 text-xs text-neutral-100">
          {toast}
        </div>
      ) : null}
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
