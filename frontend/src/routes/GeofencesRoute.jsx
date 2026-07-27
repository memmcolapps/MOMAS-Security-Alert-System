import L from "leaflet";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Circle, MapPinned, Pencil, Plus, Radio, Save, Shield, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteGeofence,
  getDroneRegistry,
  getMe,
  listDevices,
  listGeofences,
  listOrganizations,
  saveGeofence,
} from "../lib/api";

const EMPTY = {
  id: null,
  organization_id: "",
  name: "",
  shape_type: "polygon",
  points: [],
  center_lat: null,
  center_lon: null,
  radius_m: 500,
  buffer_m: 30,
  confirmations_required: 3,
  active: true,
  assignments: [],
};

function samePoint(a, b) {
  return a && b && Number(a[0]) === Number(b[0]) && Number(a[1]) === Number(b[1]);
}

function toForm(fence) {
  const ring = fence.geometry?.coordinates?.[0] || [];
  const points = ring.length > 1 && samePoint(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring;
  return {
    id: fence.id,
    organization_id: String(fence.organization_id || ""),
    name: fence.name || "",
    shape_type: fence.shape_type,
    points,
    center_lat: fence.center_lat == null ? null : Number(fence.center_lat),
    center_lon: fence.center_lon == null ? null : Number(fence.center_lon),
    radius_m: Number(fence.radius_m) || 500,
    buffer_m: Number(fence.buffer_m) || 30,
    confirmations_required: Number(fence.confirmations_required) || 3,
    active: fence.active !== false,
    assignments: (fence.assignments || []).map(({ asset_type, asset_id }) => ({
      asset_type,
      asset_id: String(asset_id),
    })),
  };
}

function FenceEditorMap({ fences, form, onMapClick }) {
  const nodeRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const clickRef = useRef(onMapClick);
  clickRef.current = onMapClick;

  useEffect(() => {
    if (!nodeRef.current || mapRef.current) return;
    const map = L.map(nodeRef.current).setView([9, 8.5], 6);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap &copy; CARTO",
      maxZoom: 20,
    }).addTo(map);
    const layer = L.layerGroup().addTo(map);
    map.on("click", (event) => clickRef.current?.(event.latlng));
    mapRef.current = map;
    layerRef.current = layer;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const drawFence = (fence, active) => {
      const style = {
        color: active ? "#fb7185" : "#64748b",
        weight: active ? 3 : 1.5,
        fillColor: active ? "#ef4444" : "#334155",
        fillOpacity: active ? 0.14 : 0.07,
      };
      if (fence.shape_type === "circle" && fence.center_lat != null && Number.isFinite(Number(fence.center_lat))) {
        L.circle([Number(fence.center_lat), Number(fence.center_lon)], {
          ...style,
          radius: Number(fence.radius_m),
        }).bindTooltip(fence.name || "Draft fence").addTo(layer);
      } else {
        const ring = active ? fence.points : fence.geometry?.coordinates?.[0];
        if (ring?.length) {
          L.polygon(ring.map(([lon, lat]) => [lat, lon]), style)
            .bindTooltip(fence.name || "Draft fence")
            .addTo(layer);
        }
      }
    };
    fences.filter((fence) => Number(fence.id) !== Number(form.id)).forEach((fence) => drawFence(fence, false));
    drawFence(form, true);
  }, [fences, form]);

  return <div className="h-[560px] w-full rounded-lg" ref={nodeRef} />;
}

export function GeofencesRoute() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [feedback, setFeedback] = useState(null);

  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const fencesQuery = useQuery({ queryKey: ["geofences"], queryFn: listGeofences, refetchInterval: 30_000 });
  const devicesQuery = useQuery({ queryKey: ["devices"], queryFn: listDevices });
  const dronesQuery = useQuery({ queryKey: ["drone-registry"], queryFn: getDroneRegistry });
  const isAdmin = meQuery.data?.user?.platform_role === "admin";
  const membership = meQuery.data?.user?.active_membership || meQuery.data?.user?.memberships?.[0];
  const canManage = isAdmin || ["org_owner", "org_admin", "unit_admin", "admin"].includes(membership?.role);
  const organizationsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: listOrganizations,
    enabled: isAdmin,
  });

  const fences = fencesQuery.data?.geofences || [];
  const organizations = organizationsQuery.data?.organizations || [];
  const selectedOrgId = form.organization_id || String(membership?.organization_id || "");
  const devices = (devicesQuery.data?.devices || []).filter(
    (device) => !selectedOrgId || String(device.organization_id) === String(selectedOrgId),
  );
  const drones = (dronesQuery.data?.drones || []).filter(
    (drone) => !selectedOrgId || String(drone.organization_id) === String(selectedOrgId),
  );

  const selectedKeys = useMemo(
    () => new Set(form.assignments.map((item) => `${item.asset_type}:${item.asset_id}`)),
    [form.assignments],
  );

  const saveMutation = useMutation({
    mutationFn: saveGeofence,
    onSuccess: async () => {
      setFeedback("Geofence saved and monitoring is active.");
      setEditing(false);
      setForm(EMPTY);
      await queryClient.invalidateQueries({ queryKey: ["geofences"] });
    },
    onError: (error) => setFeedback(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteGeofence,
    onSuccess: async () => {
      setFeedback("Geofence removed.");
      await queryClient.invalidateQueries({ queryKey: ["geofences"] });
    },
    onError: (error) => setFeedback(error.message),
  });

  function startNew() {
    setForm({
      ...EMPTY,
      organization_id: String(membership?.organization_id || organizations[0]?.id || ""),
    });
    setEditing(true);
    setFeedback(null);
  }

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function handleMapClick(latlng) {
    if (!editing) return;
    if (form.shape_type === "circle") {
      setForm((current) => ({ ...current, center_lat: latlng.lat, center_lon: latlng.lng }));
    } else {
      setForm((current) => ({ ...current, points: [...current.points, [latlng.lng, latlng.lat]] }));
    }
  }

  function toggleAssignment(assetType, assetId) {
    const key = `${assetType}:${assetId}`;
    setForm((current) => ({
      ...current,
      assignments: selectedKeys.has(key)
        ? current.assignments.filter((item) => `${item.asset_type}:${item.asset_id}` !== key)
        : [...current.assignments, { asset_type: assetType, asset_id: String(assetId) }],
    }));
  }

  function submit(event) {
    event.preventDefault();
    if (form.shape_type === "polygon" && form.points.length < 3) {
      setFeedback("Click at least three points on the map to create the polygon.");
      return;
    }
    if (form.shape_type === "circle" && form.center_lat == null) {
      setFeedback("Click the map to place the centre of the circle.");
      return;
    }
    const closed = form.points.length ? [...form.points, form.points[0]] : [];
    saveMutation.mutate({
      id: form.id,
      organization_id: Number(selectedOrgId),
      name: form.name,
      shape_type: form.shape_type,
      geometry: form.shape_type === "polygon" ? { type: "Polygon", coordinates: [closed] } : null,
      center_lat: form.center_lat,
      center_lon: form.center_lon,
      radius_m: Number(form.radius_m),
      buffer_m: Number(form.buffer_m),
      confirmations_required: Number(form.confirmations_required),
      active: form.active,
      assignments: form.assignments,
    });
  }

  return (
    <main className="min-h-screen bg-ops-bg px-4 pb-10 pt-20 text-neutral-200 md:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-red-400">
            <MapPinned size={21} /> Geofences
          </h1>
          <p className="mt-1 text-[11px] text-neutral-500">
            Monitoring-only allowed areas for registered radios and drones.
          </p>
        </div>
        {canManage ? (
          <button className="inline-flex items-center gap-2 rounded-md bg-red-400 px-4 py-2 text-xs font-bold text-black" onClick={startNew}>
            <Plus size={14} /> New geofence
          </button>
        ) : null}
      </header>

      {feedback ? <div className="mb-4 rounded-md border border-red-400/25 bg-red-500/[0.07] px-3 py-2 text-[11px] text-red-200">{feedback}</div> : null}

      <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <section className="space-y-3">
          {editing ? (
            <form className="glass-panel rounded-lg p-4" onSubmit={submit}>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-bold text-neutral-100">{form.id ? "Edit geofence" : "New geofence"}</h2>
                <button type="button" aria-label="Close editor" className="text-neutral-500" onClick={() => setEditing(false)}><X size={16} /></button>
              </div>

              {isAdmin ? (
                <label className="mb-3 block text-[10px] text-neutral-500">
                  Organization
                  <select className="field-input mt-1" value={selectedOrgId} onChange={(event) => update("organization_id", event.target.value)} disabled={Boolean(form.id)}>
                    <option value="">Select organization</option>
                    {organizations.map((org) => <option value={org.id} key={org.id}>{org.name}</option>)}
                  </select>
                </label>
              ) : null}

              <label className="mb-3 block text-[10px] text-neutral-500">
                Name
                <input className="field-input mt-1" value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Allowed operations area" required />
              </label>

              <div className="mb-3 grid grid-cols-2 gap-2">
                {["polygon", "circle"].map((shape) => (
                  <button
                    type="button"
                    key={shape}
                    className={`rounded-md border px-3 py-2 text-[10px] font-bold ${form.shape_type === shape ? "border-red-400 bg-red-500/15 text-red-300" : "border-white/10 text-neutral-500"}`}
                    onClick={() => setForm((current) => ({ ...current, shape_type: shape, points: [], center_lat: null, center_lon: null }))}
                  >
                    {shape === "polygon" ? <Shield size={13} className="mr-1 inline" /> : <Circle size={13} className="mr-1 inline" />}
                    {shape}
                  </button>
                ))}
              </div>

              <div className="mb-3 rounded-md border border-white/10 bg-white/[0.025] p-3 text-[10px] text-neutral-500">
                {form.shape_type === "polygon"
                  ? `Click the map to add corners. ${form.points.length} point${form.points.length === 1 ? "" : "s"} added.`
                  : form.center_lat == null
                    ? "Click the map to place the circle centre."
                    : `Centre: ${form.center_lat.toFixed(5)}, ${form.center_lon.toFixed(5)}`}
                {form.shape_type === "polygon" && form.points.length ? (
                  <button type="button" className="ml-2 text-red-300" onClick={() => update("points", form.points.slice(0, -1))}><Undo2 size={12} className="inline" /> Undo</button>
                ) : null}
              </div>

              {form.shape_type === "circle" ? (
                <label className="mb-3 block text-[10px] text-neutral-500">
                  Radius (metres)
                  <input className="field-input mt-1" type="number" min="10" value={form.radius_m} onChange={(event) => update("radius_m", event.target.value)} />
                </label>
              ) : null}

              <div className="mb-3 grid grid-cols-2 gap-2">
                <label className="text-[10px] text-neutral-500">
                  GPS buffer (m)
                  <input className="field-input mt-1" type="number" min="0" value={form.buffer_m} onChange={(event) => update("buffer_m", event.target.value)} />
                </label>
                <label className="text-[10px] text-neutral-500">
                  Confirmations
                  <input className="field-input mt-1" type="number" min="1" max="10" value={form.confirmations_required} onChange={(event) => update("confirmations_required", event.target.value)} />
                </label>
              </div>

              <div className="mb-3 max-h-48 overflow-y-auto rounded-md border border-white/10 p-2">
                <div className="mb-2 text-[9px] font-bold uppercase tracking-wide text-neutral-600">Assigned assets</div>
                {[...devices.map((asset) => ({ type: "radio", id: asset.device_id, name: asset.name })), ...drones.map((asset) => ({ type: "drone", id: asset.sysid, name: asset.name }))].map((asset) => {
                  const key = `${asset.type}:${asset.id}`;
                  return (
                    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[10px] hover:bg-white/5" key={key}>
                      <input type="checkbox" checked={selectedKeys.has(key)} onChange={() => toggleAssignment(asset.type, asset.id)} />
                      {asset.type === "radio" ? <Radio size={12} className="text-green-400" /> : <span className="text-sky-400">✈</span>}
                      <span>{asset.name || `${asset.type} ${asset.id}`}</span>
                      <span className="ml-auto font-mono text-neutral-700">{asset.id}</span>
                    </label>
                  );
                })}
                {!devices.length && !drones.length ? <p className="p-2 text-[10px] text-neutral-600">No registered assets in this scope.</p> : null}
              </div>

              <label className="mb-4 flex items-center gap-2 text-[10px] text-neutral-400">
                <input type="checkbox" checked={form.active} onChange={(event) => update("active", event.target.checked)} />
                Monitoring active
              </label>

              <button className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-red-400 px-4 py-2.5 text-xs font-bold text-black disabled:opacity-40" disabled={saveMutation.isPending}>
                <Save size={14} /> Save geofence
              </button>
            </form>
          ) : null}

          {fences.map((fence) => (
            <article className="glass-panel rounded-lg p-4" key={fence.id}>
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 grid h-8 w-8 place-items-center rounded-md ${fence.active ? "bg-red-500/15 text-red-300" : "bg-white/5 text-neutral-600"}`}>
                  <MapPinned size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-[12px] font-bold text-neutral-100">{fence.name}</h2>
                  <p className="mt-1 text-[9px] text-neutral-600">
                    {fence.shape_type} · {fence.assignments?.length || 0} assets · {fence.confirmations_required} confirmations
                  </p>
                </div>
                {canManage ? (
                  <div className="flex gap-1">
                    <button aria-label={`Edit ${fence.name}`} className="rounded p-1.5 text-neutral-500 hover:bg-white/5 hover:text-neutral-100" onClick={() => { setForm(toForm(fence)); setEditing(true); }}><Pencil size={13} /></button>
                    <button aria-label={`Delete ${fence.name}`} className="rounded p-1.5 text-neutral-500 hover:bg-red-500/10 hover:text-red-300" onClick={() => window.confirm(`Remove ${fence.name}?`) && deleteMutation.mutate(fence.id)}><Trash2 size={13} /></button>
                  </div>
                ) : null}
              </div>
            </article>
          ))}
          {!fencesQuery.isLoading && !fences.length ? <div className="glass-panel rounded-lg p-8 text-center text-xs text-neutral-600">No geofences configured.</div> : null}
        </section>

        <section className="glass-panel overflow-hidden rounded-lg p-2">
          <FenceEditorMap fences={fences} form={form} onMapClick={handleMapClick} />
        </section>
      </div>
    </main>
  );
}
