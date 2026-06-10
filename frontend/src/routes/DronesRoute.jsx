import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plane, Plus, Save, Trash2, Wifi, WifiOff, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  deleteDrone,
  getDronePositions,
  getDroneRegistry,
  getMe,
  getOrgAdmin,
  listOrganizations,
  saveDrone,
} from "../lib/api";

const emptyForm = {
  sysid: "",
  name: "",
  registration: "",
  model: "",
  organization_id: "",
  unit_id: "",
  operator: "",
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

export function DronesRoute() {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [toast, setToast] = useState(null);

  const registryQuery = useQuery({
    queryKey: ["drone-registry"],
    queryFn: getDroneRegistry,
  });

  // Live positions — also reveals unregistered sysids currently on the wire.
  const positionsQuery = useQuery({
    queryKey: ["drone-positions"],
    queryFn: getDronePositions,
    refetchInterval: 5000,
  });

  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const isPlatformAdmin = meQuery.data?.user?.platform_role === "admin";
  const orgRole = meQuery.data?.user?.active_membership?.role || meQuery.data?.user?.memberships?.[0]?.role;
  const canManageDrones = isPlatformAdmin || ["org_owner", "org_admin", "admin"].includes(orgRole);

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: listOrganizations,
    enabled: isPlatformAdmin,
  });
  const orgAdminQuery = useQuery({
    queryKey: ["org-admin"],
    queryFn: getOrgAdmin,
    enabled: !isPlatformAdmin && canManageDrones,
  });

  const registered = registryQuery.data?.drones || [];
  const organizations = orgsQuery.data?.organizations || [];
  const units = orgAdminQuery.data?.units || [];
  const live = positionsQuery.data?.drones || [];
  const listener = positionsQuery.data?.listener;

  const liveBySysid = useMemo(() => new Map(live.map((d) => [Number(d.sysid), d])), [live]);
  const unregistered = useMemo(
    () => live.filter((d) => !registered.some((r) => Number(r.sysid) === Number(d.sysid))),
    [live, registered],
  );
  const onlineCount = useMemo(() => live.filter((d) => d.online).length, [live]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const saveMutation = useMutation({
    mutationFn: saveDrone,
    onSuccess: async () => {
      setToast(editingId ? "Drone updated" : "Drone added");
      closeForm();
      await queryClient.invalidateQueries({ queryKey: ["drone-registry"] });
      await queryClient.invalidateQueries({ queryKey: ["drone-positions"] });
    },
    onError: (error) => setToast(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteDrone,
    onSuccess: async () => {
      setToast("Drone removed");
      await queryClient.invalidateQueries({ queryKey: ["drone-registry"] });
      await queryClient.invalidateQueries({ queryKey: ["drone-positions"] });
    },
    onError: (error) => setToast(error.message),
  });

  function openAdd(prefillSysid = "") {
    setEditingId(null);
    setForm({ ...emptyForm, sysid: prefillSysid ? String(prefillSysid) : "" });
    setFormOpen(true);
  }

  function openEdit(drone) {
    setEditingId(drone.sysid);
    setForm({
      sysid: String(drone.sysid),
      name: drone.name || "",
      registration: drone.registration || "",
      model: drone.model || "",
      organization_id: drone.organization_id ? String(drone.organization_id) : "",
      unit_id: drone.unit_id ? String(drone.unit_id) : "",
      operator: drone.operator || "",
      active: String(Boolean(drone.active)),
      notes: drone.notes || "",
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
    const sysid = parseInt(form.sysid, 10);
    if (!Number.isInteger(sysid) || sysid < 1 || sysid > 255) {
      setToast("System ID must be a number between 1 and 255");
      return;
    }
    saveMutation.mutate({
      sysid,
      name: form.name.trim() || null,
      registration: form.registration.trim() || null,
      model: form.model.trim() || null,
      organization_id: form.organization_id ? Number(form.organization_id) : null,
      unit_id: form.unit_id ? Number(form.unit_id) : null,
      operator: form.operator.trim() || null,
      notes: form.notes.trim() || null,
      active: form.active === "true",
    });
  }

  return (
    <main className="device-page bg-ops-bg px-6 pb-8 pt-20 text-neutral-200">
      <header className="mb-7 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-sky-400">
            <Plane size={21} /> Drone Registry
          </h1>
          <p className="mt-1 text-[11px] text-neutral-500">
            Map each drone&apos;s MAVLink System ID to its airframe and registration
          </p>
        </div>
        {canManageDrones ? (
          <button className="inline-flex items-center gap-2 rounded-md bg-sky-400 px-4 py-2 text-xs font-bold text-black hover:opacity-85" onClick={() => openAdd()}>
            <Plus size={14} /> Add drone
          </button>
        ) : null}
      </header>

      <section className="glass-panel mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border-sky-500/25 px-4 py-3 text-[11px]">
        <span className="flex items-center gap-2">
          {listener?.enabled ? <Wifi size={14} className="text-sky-400" /> : <WifiOff size={14} className="text-neutral-600" />}
          <span className="text-neutral-400">Telemetry listener</span>
          <span className={listener?.enabled ? "font-bold text-sky-400" : "font-bold text-neutral-600"}>
            {listener ? (listener.enabled ? `port ${listener.port}` : "disabled") : "…"}
          </span>
        </span>
        <span className="text-neutral-400">
          Ground stations connected: <strong className="text-neutral-200">{listener?.connections ?? "…"}</strong>
        </span>
        <span className="text-neutral-400">
          Drones live now: <strong className={onlineCount ? "text-sky-400" : "text-neutral-200"}>{onlineCount}</strong>
        </span>
      </section>

      {unregistered.length && canManageDrones ? (
        <section className="glass-panel mb-5 rounded-lg border-amber-500/30 px-4 py-3">
          <div className="mb-2 text-[11px] font-bold text-amber-400">
            Unregistered drones detected on the telemetry stream
          </div>
          <div className="flex flex-wrap gap-2">
            {unregistered.map((d) => (
              <button
                key={d.sysid}
                onClick={() => openAdd(d.sysid)}
                className="inline-flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300 hover:bg-amber-500/20"
                title="Click to register this drone"
              >
                <Plus size={12} /> sysid {d.sysid}
                {d.online ? <span className="h-1.5 w-1.5 rounded-full bg-sky-400" /> : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {formOpen ? (
        <form className="glass-panel mb-7 rounded-lg border-sky-500/30 p-5" onSubmit={submitForm}>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[13px] font-bold text-sky-400">{editingId ? "Edit drone" : "New drone"}</h2>
            <button type="button" className="rounded p-1 text-neutral-500 hover:text-neutral-200" onClick={closeForm}>
              <X size={16} />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            <Field label="System ID (SYSID_THISMAV)" required>
              <input
                className="field-input font-mono"
                type="number"
                min="1"
                max="255"
                value={form.sysid}
                disabled={Boolean(editingId)}
                onChange={(event) => updateField("sysid", event.target.value)}
                placeholder="1–255, unique per drone"
              />
            </Field>
            <Field label="Name">
              <input className="field-input" value={form.name} onChange={(event) => updateField("name", event.target.value)} placeholder="e.g. Falcon 1" />
            </Field>
            <Field label="Registration No.">
              <input className="field-input font-mono" value={form.registration} onChange={(event) => updateField("registration", event.target.value)} placeholder="e.g. NCAA registration" />
            </Field>
            <Field label="Model / Airframe">
              <input className="field-input" value={form.model} onChange={(event) => updateField("model", event.target.value)} placeholder="e.g. Quad X500" />
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
            {!isPlatformAdmin && canManageDrones ? (
              <Field label="Unit">
                <select className="field-input" value={form.unit_id} onChange={(event) => updateField("unit_id", event.target.value)}>
                  <option value="">No unit</option>
                  {units.map((unit) => (
                    <option value={unit.id} key={unit.id}>{unit.name}</option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label="Pilot / Operator">
              <input className="field-input" value={form.operator} onChange={(event) => updateField("operator", event.target.value)} placeholder="e.g. Jane Doe" />
            </Field>
            <Field label="Status">
              <select className="field-input" value={form.active} onChange={(event) => updateField("active", event.target.value)}>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
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
            <button type="submit" disabled={saveMutation.isPending} className="inline-flex items-center gap-2 rounded bg-sky-400 px-4 py-2 text-xs font-bold text-black disabled:opacity-50">
              <Save size={14} /> {saveMutation.isPending ? "Saving..." : "Save drone"}
            </button>
          </div>
        </form>
      ) : null}

      <section className="glass-panel overflow-hidden rounded-lg border-sky-500/25">
        <div className="border-b border-white/10 px-4 py-3 text-[11px] text-neutral-500">
          {registryQuery.isLoading ? "Loading..." : `${registered.length} registered drone${registered.length === 1 ? "" : "s"} · ${onlineCount} live now`}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-white/10 text-[9px] uppercase tracking-wide text-neutral-500">
                <th className="px-4 py-3">Sysid</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Registration</th>
                <th className="px-4 py-3">Model</th>
                {isPlatformAdmin ? <th className="px-4 py-3">Company</th> : null}
                <th className="px-4 py-3">Operator</th>
                <th className="px-4 py-3">Live</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Added</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {registryQuery.isLoading ? (
                <tr>
                  <td className="px-4 py-10 text-center text-neutral-500" colSpan={isPlatformAdmin ? 10 : 9}>Loading drones...</td>
                </tr>
              ) : registered.length ? (
                registered.map((drone) => {
                  const liveState = liveBySysid.get(Number(drone.sysid));
                  return (
                    <tr className="border-b border-white/5 hover:bg-white/[0.03]" key={drone.sysid}>
                      <td className="px-4 py-3 font-mono text-[11px] text-sky-400">{drone.sysid}</td>
                      <td className="px-4 py-3">{drone.name || <Muted />}</td>
                      <td className="px-4 py-3 font-mono text-[11px]">{drone.registration || <Muted />}</td>
                      <td className="px-4 py-3">{drone.model || <Muted />}</td>
                      {isPlatformAdmin ? (
                        <td className="px-4 py-3">{drone.organization_name || <span className="text-neutral-700">Unassigned</span>}</td>
                      ) : null}
                      <td className="px-4 py-3">{drone.operator || <Muted />}</td>
                      <td className="px-4 py-3">
                        {liveState?.online ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[9px] font-bold text-sky-400">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" /> LIVE
                          </span>
                        ) : liveState ? (
                          <span className="text-[10px] text-neutral-500">{liveState.age_sec}s ago</span>
                        ) : (
                          <Muted />
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold ${drone.active ? "border-sky-500/30 bg-sky-500/10 text-sky-400" : "border-white/10 bg-white/5 text-neutral-500"}`}>
                          {drone.active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[11px] text-neutral-600">{formatDate(drone.created_at)}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          {canManageDrones ? (
                            <button className="rounded border border-white/10 px-2 py-1 text-[10px] text-neutral-500 hover:border-sky-400 hover:text-sky-400" onClick={() => openEdit(drone)}>
                              Edit
                            </button>
                          ) : null}
                          {isPlatformAdmin ? (
                            <button className="inline-flex items-center gap-1 rounded border border-red-500/20 px-2 py-1 text-[10px] text-red-400/70 hover:border-ops-red hover:text-ops-red" onClick={() => {
                              if (window.confirm(`Remove drone sysid ${drone.sysid}?`)) deleteMutation.mutate(drone.sysid);
                            }}>
                              <Trash2 size={11} /> Remove
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td className="px-4 py-12 text-center text-neutral-500" colSpan={isPlatformAdmin ? 10 : 9}>
                    <Plane className="mx-auto mb-2" size={28} /> No drones registered yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {toast ? (
        <div className="fixed bottom-6 left-1/2 z-[999] -translate-x-1/2 rounded-md border border-sky-500/40 bg-black px-4 py-2 text-xs text-neutral-100">
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
        {label} {required ? <span className="text-sky-400">*</span> : null}
      </span>
      {children}
    </label>
  );
}

function Muted() {
  return <span className="text-neutral-700">-</span>;
}
