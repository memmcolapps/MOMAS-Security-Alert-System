import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Radio, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { deleteDevice, getMe, listDevices, listOrganizations, saveDevice } from "../lib/api";
import { deviceTypeLabel } from "../lib/domain";

const emptyForm = {
  device_id: "",
  name: "",
  organization_id: "",
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

export function DevicesRoute() {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [toast, setToast] = useState(null);

  const devicesQuery = useQuery({
    queryKey: ["devices"],
    queryFn: listDevices,
  });

  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const isPlatformAdmin = meQuery.data?.user?.platform_role === "admin";

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: listOrganizations,
    enabled: isPlatformAdmin,
  });

  const [orgFilter, setOrgFilter] = useState("all");

  const allDevices = devicesQuery.data?.devices || [];
  const organizations = orgsQuery.data?.organizations || [];
  const devices = useMemo(() => {
    if (orgFilter === "all") return allDevices;
    if (orgFilter === "unassigned") return allDevices.filter((device) => !device.organization_id);
    return allDevices.filter((device) => String(device.organization_id) === String(orgFilter));
  }, [allDevices, orgFilter]);
  const activeCount = useMemo(() => devices.filter((device) => device.active).length, [devices]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

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
          <p className="mt-1 text-[11px] text-neutral-500">Manage POCSTARS radios and vehicle trackers</p>
        </div>
        <button className="inline-flex items-center gap-2 rounded-md bg-ops-green px-4 py-2 text-xs font-bold text-black hover:opacity-85" onClick={openAdd}>
          <Plus size={14} /> Add device
        </button>
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
                <th className="px-4 py-3">Operator</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Added</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {devicesQuery.isLoading ? (
                <tr>
                  <td className="px-4 py-10 text-center text-neutral-500" colSpan={isPlatformAdmin ? 8 : 7}>Loading devices...</td>
                </tr>
              ) : devices.length ? (
                devices.map((device) => (
                  <tr className="border-b border-white/5 hover:bg-white/[0.03]" key={device.device_id}>
                    <td className="px-4 py-3 font-mono text-[11px] text-ops-green">{device.device_id}</td>
                    <td className="px-4 py-3">{device.name || <Muted />}</td>
                    {isPlatformAdmin ? (
                      <td className="px-4 py-3">{device.organization_name || <span className="text-neutral-700">Unassigned</span>}</td>
                    ) : null}
                    <td className="px-4 py-3">{device.operator || <Muted />}</td>
                    <td className="px-4 py-3">{device.device_type ? deviceTypeLabel(device.device_type) : <Muted />}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold ${device.active ? "border-green-500/30 bg-green-500/10 text-ops-green" : "border-white/10 bg-white/5 text-neutral-500"}`}>
                        {device.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[11px] text-neutral-600">{formatDate(device.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button className="rounded border border-white/10 px-2 py-1 text-[10px] text-neutral-500 hover:border-ops-green hover:text-ops-green" onClick={() => openEdit(device)}>
                          Edit
                        </button>
                        <button className="inline-flex items-center gap-1 rounded border border-red-500/20 px-2 py-1 text-[10px] text-red-400/70 hover:border-ops-red hover:text-ops-red" onClick={() => {
                          if (window.confirm(`Remove device ${device.device_id}?`)) deleteMutation.mutate(device.device_id);
                        }}>
                          <Trash2 size={11} /> Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-4 py-12 text-center text-neutral-500" colSpan={isPlatformAdmin ? 8 : 7}>
                    <Radio className="mx-auto mb-2" size={28} /> No devices yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

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
