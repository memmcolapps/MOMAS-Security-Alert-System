import L from "leaflet";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Circle,
  Crosshair,
  Layers,
  MapPinned,
  Pencil,
  Plus,
  Radio,
  Save,
  Search,
  Shield,
  Trash2,
  Undo2,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteGeofence,
  getDronePositions,
  getDroneRegistry,
  getLocations,
  getMe,
  listDevices,
  listGeofences,
  listOrganizations,
  previewGeofence,
  saveGeofence,
  searchPlaces,
} from "../lib/api";
import { isPlatformOperator, isPlatformStaff } from "../lib/platform-roles";
import {
  bufferRing,
  circleAroundAssets,
  formatArea,
  formatDistance,
  polygonAroundAssets,
} from "../lib/fence-placement";

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

// Satellite is how someone who does not read maps recognises a real place —
// they see their own buildings. It carries no labels of its own, so it gets a
// transparent label layer stacked on top.
const BASEMAPS = {
  satellite: {
    label: "Satellite",
    url: "https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: { maxZoom: 21, maxNativeZoom: 19, attribution: "Tiles &copy; Esri Clarity" },
    labels: "https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png",
  },
  streets: {
    label: "Streets",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: { maxZoom: 21, maxNativeZoom: 19, attribution: "&copy; OpenStreetMap" },
  },
  dark: {
    label: "Dark",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    options: { maxZoom: 21, maxNativeZoom: 20, attribution: "&copy; OpenStreetMap &copy; CARTO" },
  },
};

const ASSET_COLOURS = { inside: "#22c55e", outside: "#f59e0b", unknown: "#64748b" };

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

/** The shape as the API wants it, or null while it is still incomplete. */
function toGeometry(form) {
  if (form.shape_type !== "polygon") return null;
  if (form.points.length < 3) return null;
  return { type: "Polygon", coordinates: [[...form.points, form.points[0]]] };
}

function isPlaced(form) {
  return form.shape_type === "polygon" ? form.points.length >= 3 : form.center_lat != null;
}

function FenceEditorMap({ fences, form, assets, basemap, onBasemapChange, onMapClick, fitToken }) {
  const nodeRef = useRef(null);
  const mapRef = useRef(null);
  const baseRef = useRef(null);
  const labelRef = useRef(null);
  const shapeRef = useRef(null);
  const assetRef = useRef(null);
  const clickRef = useRef(onMapClick);
  clickRef.current = onMapClick;

  useEffect(() => {
    if (!nodeRef.current || mapRef.current) return undefined;
    const map = L.map(nodeRef.current).setView([9, 8.5], 6);
    // A scale bar is the cheapest orientation aid there is: it turns an
    // abstract shape into "that is about 800 metres across".
    L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
    map.on("click", (event) => clickRef.current?.(event.latlng));
    shapeRef.current = L.layerGroup().addTo(map);
    assetRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      baseRef.current = null;
      labelRef.current = null;
      shapeRef.current = null;
      assetRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const config = BASEMAPS[basemap] || BASEMAPS.satellite;
    baseRef.current?.remove();
    labelRef.current?.remove();
    baseRef.current = L.tileLayer(config.url, config.options).addTo(map);
    labelRef.current = config.labels
      ? L.tileLayer(config.labels, { maxZoom: 21, maxNativeZoom: 20, opacity: 0.9 }).addTo(map)
      : null;
    baseRef.current.bringToBack();
  }, [basemap]);

  useEffect(() => {
    const layer = shapeRef.current;
    if (!layer) return;
    layer.clearLayers();

    const drawFence = (fence, active) => {
      const style = {
        color: active ? "#fb7185" : "#94a3b8",
        weight: active ? 3 : 1.5,
        fillColor: active ? "#ef4444" : "#475569",
        fillOpacity: active ? 0.14 : 0.07,
      };
      // The dashed ring is where a breach actually fires. Without it the buffer
      // is an invisible number that silently decides every alarm.
      const bufferStyle = { color: "#fbbf24", weight: 1.5, dashArray: "6 6", fill: false };
      if (fence.shape_type === "circle") {
        const lat = Number(fence.center_lat);
        const lon = Number(fence.center_lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        L.circle([lat, lon], { ...style, radius: Number(fence.radius_m) })
          .bindTooltip(fence.name || "New fence")
          .addTo(layer);
        if (active && Number(fence.buffer_m) > 0) {
          L.circle([lat, lon], { ...bufferStyle, radius: Number(fence.radius_m) + Number(fence.buffer_m) }).addTo(layer);
        }
        return;
      }
      const ring = active ? fence.points : fence.geometry?.coordinates?.[0];
      if (!ring?.length) return;
      L.polygon(ring.map(([lon, lat]) => [lat, lon]), style)
        .bindTooltip(fence.name || "New fence")
        .addTo(layer);
      if (active && Number(fence.buffer_m) > 0 && ring.length >= 3) {
        const outer = bufferRing(ring, Number(fence.buffer_m));
        if (outer) L.polygon(outer.map(([lon, lat]) => [lat, lon]), bufferStyle).addTo(layer);
      }
    };

    fences.filter((fence) => Number(fence.id) !== Number(form.id)).forEach((fence) => drawFence(fence, false));
    drawFence(form, true);
  }, [fences, form]);

  useEffect(() => {
    const layer = assetRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const asset of assets) {
      const colour = ASSET_COLOURS[asset.state] || ASSET_COLOURS.unknown;
      L.marker([asset.lat, asset.lon], {
        icon: L.divIcon({
          className: "",
          html: `<span style="display:block;width:11px;height:11px;border-radius:9999px;background:${colour};border:2px solid #0b0b0b;box-shadow:0 0 0 3px ${colour}44"></span>`,
          iconSize: [11, 11],
          iconAnchor: [5.5, 5.5],
        }),
      })
        .bindTooltip(`${asset.name} · ${asset.state === "outside" ? "outside" : asset.state === "inside" ? "inside" : "position unknown"}`)
        .addTo(layer);
    }
  }, [assets]);

  // Takes the map to whatever the operator just did — placed a shape, searched
  // a place, or opened an existing fence for editing.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitToken) return;
    if (fitToken.bounds) map.fitBounds(fitToken.bounds, { padding: [40, 40], maxZoom: 17 });
    else if (fitToken.centre) map.setView([fitToken.centre.lat, fitToken.centre.lon], fitToken.zoom || 15);
  }, [fitToken]);

  return (
    <div className="relative">
      <div className="h-[560px] w-full rounded-lg" ref={nodeRef} />
      {/* Above Leaflet's own controls, which sit at z-index 1000. */}
      <div className="absolute right-3 top-3 z-[1100] flex overflow-hidden rounded-md border border-white/15 bg-black/75 backdrop-blur">
        {Object.entries(BASEMAPS).map(([key, config]) => (
          <button
            className={`px-2.5 py-1.5 text-[10px] font-bold ${basemap === key ? "bg-white/15 text-neutral-100" : "text-neutral-400 hover:text-neutral-100"}`}
            key={key}
            onClick={() => onBasemapChange(key)}
            type="button"
          >
            {config.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function GeofencesRoute() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [feedback, setFeedback] = useState(null);
  const [basemap, setBasemap] = useState("satellite");
  const [fitToken, setFitToken] = useState(null);
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeResults, setPlaceResults] = useState([]);
  const [margin, setMargin] = useState(200);
  const [suppressExisting, setSuppressExisting] = useState(true);

  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const fencesQuery = useQuery({ queryKey: ["geofences"], queryFn: listGeofences, refetchInterval: 30_000 });
  const devicesQuery = useQuery({ queryKey: ["devices"], queryFn: listDevices });
  const dronesQuery = useQuery({ queryKey: ["drone-registry"], queryFn: getDroneRegistry });
  const isAdmin = isPlatformStaff(meQuery.data?.user);
  const membership = meQuery.data?.user?.active_membership || meQuery.data?.user?.memberships?.[0];
  const canManage = isPlatformOperator(meQuery.data?.user) || ["org_owner", "org_admin", "unit_admin", "admin"].includes(membership?.role);
  const organizationsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: listOrganizations,
    enabled: isAdmin,
  });

  // Live positions are what make asset-anchored placement possible; they only
  // matter while the editor is open.
  const radioPositionsQuery = useQuery({
    queryKey: ["locations"],
    queryFn: () => getLocations(),
    refetchInterval: 30_000,
    enabled: editing,
  });
  const dronePositionsQuery = useQuery({
    queryKey: ["drone-positions"],
    queryFn: getDronePositions,
    refetchInterval: 10_000,
    enabled: editing,
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

  const livePositions = useMemo(() => {
    const positions = new Map();
    for (const row of radioPositionsQuery.data?.data || []) {
      const lat = Number(row.Lat);
      const lon = Number(row.Lng ?? row.Lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
      positions.set(`radio:${row.Uid}`, { lat, lon });
    }
    for (const drone of dronePositionsQuery.data?.drones || []) {
      const lat = Number(drone.lat);
      const lon = Number(drone.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
      positions.set(`drone:${drone.sysid}`, { lat, lon });
    }
    return positions;
  }, [radioPositionsQuery.data, dronePositionsQuery.data]);

  const assetChoices = useMemo(
    () => [
      ...devices.map((asset) => ({ asset_type: "radio", asset_id: String(asset.device_id), name: asset.name || `Radio ${asset.device_id}` })),
      ...drones.map((asset) => ({ asset_type: "drone", asset_id: String(asset.sysid), name: asset.name || `Drone ${asset.sysid}` })),
    ],
    [devices, drones],
  );

  const geometry = toGeometry(form);
  const placed = isPlaced(form);

  const previewQuery = useQuery({
    queryKey: [
      "geofence-preview",
      selectedOrgId,
      form.shape_type,
      form.radius_m,
      form.buffer_m,
      JSON.stringify(form.points),
      form.center_lat,
      form.center_lon,
      JSON.stringify(form.assignments),
    ],
    queryFn: () =>
      previewGeofence({
        organization_id: Number(selectedOrgId),
        name: form.name || "Preview",
        shape_type: form.shape_type,
        geometry,
        center_lat: form.center_lat,
        center_lon: form.center_lon,
        radius_m: Number(form.radius_m),
        buffer_m: Number(form.buffer_m),
        confirmations_required: Number(form.confirmations_required),
        assignments: form.assignments,
      }),
    enabled: editing && placed && Boolean(selectedOrgId),
    staleTime: 5_000,
  });

  const preview = previewQuery.data || null;

  // Asset dots on the map: the server's verdict once a preview exists, live
  // positions before that so the map is still useful while placing.
  const mappedAssets = useMemo(() => {
    if (preview?.assets?.length) {
      return preview.assets
        .filter((asset) => Number.isFinite(Number(asset.lat)) && Number.isFinite(Number(asset.lon)))
        .map((asset) => ({ ...asset, lat: Number(asset.lat), lon: Number(asset.lon) }));
    }
    return form.assignments
      .map((assignment) => {
        const position = livePositions.get(`${assignment.asset_type}:${assignment.asset_id}`);
        if (!position) return null;
        const choice = assetChoices.find(
          (item) => item.asset_type === assignment.asset_type && item.asset_id === assignment.asset_id,
        );
        return { ...position, state: "unknown", name: choice?.name || assignment.asset_id };
      })
      .filter(Boolean);
  }, [preview, form.assignments, livePositions, assetChoices]);

  const assignedPositions = useMemo(
    () =>
      form.assignments
        .map((assignment) => livePositions.get(`${assignment.asset_type}:${assignment.asset_id}`))
        .filter(Boolean),
    [form.assignments, livePositions],
  );

  useEffect(() => {
    if (!placeQuery.trim() || placeQuery.trim().length < 2) {
      setPlaceResults([]);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      searchPlaces(placeQuery.trim())
        .then((data) => setPlaceResults(data.places || []))
        .catch(() => setPlaceResults([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [placeQuery]);

  const saveMutation = useMutation({
    mutationFn: saveGeofence,
    onSuccess: async (data) => {
      const suppressed = Number(data?.suppressed) || 0;
      setFeedback({
        type: "success",
        message: suppressed
          ? `Geofence saved. ${suppressed} asset${suppressed === 1 ? "" : "s"} already outside were recorded without raising an alarm.`
          : "Geofence saved and monitoring is active.",
      });
      setEditing(false);
      setForm(EMPTY);
      await queryClient.invalidateQueries({ queryKey: ["geofences"] });
    },
    onError: (error) => setFeedback({ type: "error", message: error.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteGeofence,
    onSuccess: async () => {
      setFeedback({ type: "success", message: "Geofence removed." });
      await queryClient.invalidateQueries({ queryKey: ["geofences"] });
    },
    onError: (error) => setFeedback({ type: "error", message: error.message }),
  });

  const fitToPoints = useCallback((points) => {
    if (!points.length) return;
    const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lon]));
    setFitToken({ bounds: bounds.pad(0.3), key: Date.now() });
  }, []);

  function startNew() {
    setForm({
      ...EMPTY,
      organization_id: String(membership?.organization_id || organizations[0]?.id || ""),
    });
    setEditing(true);
    setSuppressExisting(true);
    setFeedback(null);
  }

  function startEdit(fence) {
    const next = toForm(fence);
    setForm(next);
    setEditing(true);
    setSuppressExisting(true);
    setFeedback(null);
    // Opening a fence used to leave the map showing the whole country.
    if (next.shape_type === "circle" && next.center_lat != null) {
      setFitToken({ centre: { lat: next.center_lat, lon: next.center_lon }, zoom: 15, key: Date.now() });
    } else if (next.points.length) {
      fitToPoints(next.points.map(([lon, lat]) => ({ lat, lon })));
    }
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

  function goToPlace(place) {
    setPlaceQuery("");
    setPlaceResults([]);
    setFitToken({ centre: { lat: place.lat, lon: place.lon }, zoom: 13, key: Date.now() });
  }

  /** Centres the fence on one asset's current position — no map reading needed. */
  function centreOnAsset(key) {
    const position = livePositions.get(key);
    if (!position) {
      setFeedback({ type: "error", message: "That asset has not reported a position yet." });
      return;
    }
    setForm((current) => ({
      ...current,
      shape_type: "circle",
      center_lat: position.lat,
      center_lon: position.lon,
      points: [],
    }));
    setFitToken({ centre: position, zoom: 16, key: Date.now() });
  }

  /** Builds the shape from where the assigned assets actually are right now. */
  function fitAroundAssets() {
    if (assignedPositions.length < 1) {
      setFeedback({ type: "error", message: "None of the assigned assets have reported a position yet." });
      return;
    }
    if (form.shape_type === "circle") {
      const circle = circleAroundAssets(assignedPositions, Number(margin));
      setForm((current) => ({ ...current, ...circle, points: [] }));
    } else {
      const points = polygonAroundAssets(assignedPositions, Number(margin));
      setForm((current) => ({ ...current, points, center_lat: null, center_lon: null }));
    }
    setFeedback(null);
    fitToPoints(assignedPositions);
  }

  function submit(event) {
    event.preventDefault();
    if (form.shape_type === "polygon" && form.points.length < 3) {
      setFeedback({ type: "error", message: "A polygon needs at least three points. Place it from your assets, or click the map." });
      return;
    }
    if (form.shape_type === "circle" && form.center_lat == null) {
      setFeedback({ type: "error", message: "Place the centre of the circle first." });
      return;
    }
    saveMutation.mutate({
      id: form.id,
      organization_id: Number(selectedOrgId),
      name: form.name,
      shape_type: form.shape_type,
      geometry,
      center_lat: form.center_lat,
      center_lon: form.center_lon,
      radius_m: Number(form.radius_m),
      buffer_m: Number(form.buffer_m),
      confirmations_required: Number(form.confirmations_required),
      active: form.active,
      assignments: form.assignments,
      suppress_existing_breaches: suppressExisting,
    });
  }

  const timeToAlarmSec = Number(form.confirmations_required) * 15;

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

      {feedback ? (
        <div
          className={`mb-4 rounded-md border px-3 py-2 text-[11px] ${
            feedback.type === "error"
              ? "border-red-400/25 bg-red-500/[0.07] text-red-200"
              : "border-green-400/25 bg-green-400/[0.07] text-green-200"
          }`}
          role="status"
        >
          {feedback.message}
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[400px_minmax(0,1fr)]">
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
                    className={`rounded-md border px-3 py-2 text-[10px] font-bold capitalize ${form.shape_type === shape ? "border-red-400 bg-red-500/15 text-red-300" : "border-white/10 text-neutral-500"}`}
                    onClick={() => setForm((current) => ({ ...current, shape_type: shape, points: [], center_lat: null, center_lon: null }))}
                  >
                    {shape === "polygon" ? <Shield size={13} className="mr-1 inline" /> : <Circle size={13} className="mr-1 inline" />}
                    {shape}
                  </button>
                ))}
              </div>

              <fieldset className="mb-3 rounded-md border border-white/10 bg-white/[0.025] p-3">
                <legend className="px-1 text-[9px] font-bold uppercase tracking-wide text-neutral-500">Place it</legend>

                <div className="relative">
                  <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-600" />
                  <input
                    className="field-input pl-8 text-[11px]"
                    value={placeQuery}
                    onChange={(event) => setPlaceQuery(event.target.value)}
                    placeholder="Search a town or state"
                    aria-label="Search for a place"
                  />
                  {placeResults.length ? (
                    <ul className="absolute z-[600] mt-1 max-h-44 w-full overflow-y-auto rounded-md border border-white/15 bg-[#0b0b0b] py-1 shadow-xl">
                      {placeResults.map((place) => (
                        <li key={`${place.name}-${place.state}`}>
                          <button
                            className="block w-full px-3 py-1.5 text-left text-[11px] text-neutral-300 hover:bg-white/5"
                            onClick={() => goToPlace(place)}
                            type="button"
                          >
                            {place.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                <p className="mt-2 text-[9px] text-neutral-600">
                  Search moves the map only. To place the fence itself, build it from your assets:
                </p>

                <label className="mt-2 block text-[10px] text-neutral-500">
                  Centre on one asset
                  <select
                    className="field-input mt-1 text-[11px]"
                    value=""
                    onChange={(event) => event.target.value && centreOnAsset(event.target.value)}
                  >
                    <option value="">Choose an asset…</option>
                    {assetChoices.map((asset) => {
                      const key = `${asset.asset_type}:${asset.asset_id}`;
                      return (
                        <option key={key} value={key} disabled={!livePositions.has(key)}>
                          {asset.name}{livePositions.has(key) ? "" : " (no position)"}
                        </option>
                      );
                    })}
                  </select>
                </label>

                <div className="mt-2 flex items-end gap-2">
                  <label className="flex-1 text-[10px] text-neutral-500">
                    Margin (m)
                    <input className="field-input mt-1" type="number" min="0" step="50" value={margin} onChange={(event) => setMargin(event.target.value)} />
                  </label>
                  <button
                    className="inline-flex items-center gap-1.5 rounded-md border border-white/15 px-3 py-2 text-[10px] font-bold text-neutral-300 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!form.assignments.length}
                    onClick={fitAroundAssets}
                    title={form.assignments.length ? "" : "Assign assets first"}
                    type="button"
                  >
                    <Users size={12} /> Fit around assigned
                  </button>
                </div>

                <div className="mt-2 flex items-center justify-between text-[10px] text-neutral-500">
                  <span>
                    {form.shape_type === "polygon"
                      ? `Or click the map to add corners — ${form.points.length} placed.`
                      : form.center_lat == null
                        ? "Or click the map to drop the centre."
                        : `Centre: ${form.center_lat.toFixed(5)}, ${form.center_lon.toFixed(5)}`}
                  </span>
                  {form.shape_type === "polygon" && form.points.length ? (
                    <button type="button" className="text-red-300" onClick={() => update("points", form.points.slice(0, -1))}>
                      <Undo2 size={12} className="inline" /> Undo
                    </button>
                  ) : null}
                </div>
              </fieldset>

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
              <p className="mb-3 text-[9px] text-neutral-600">
                An asset must read outside {form.confirmations_required} times before an alarm is raised — about{" "}
                {timeToAlarmSec < 60 ? `${timeToAlarmSec} seconds` : `${Math.round(timeToAlarmSec / 60)} minutes`} at the current
                15-second position poll. The dashed ring on the map is where a breach actually fires.
              </p>

              <div className="mb-3 max-h-48 overflow-y-auto rounded-md border border-white/10 p-2">
                <div className="mb-2 text-[9px] font-bold uppercase tracking-wide text-neutral-600">Assigned assets</div>
                {assetChoices.map((asset) => {
                  const key = `${asset.asset_type}:${asset.asset_id}`;
                  return (
                    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[10px] hover:bg-white/5" key={key}>
                      <input type="checkbox" checked={selectedKeys.has(key)} onChange={() => toggleAssignment(asset.asset_type, asset.asset_id)} />
                      {asset.asset_type === "radio" ? <Radio size={12} className="text-green-400" /> : <span className="text-sky-400">✈</span>}
                      <span>{asset.name}</span>
                      <span className="ml-auto font-mono text-neutral-700">{asset.asset_id}</span>
                    </label>
                  );
                })}
                {!assetChoices.length ? <p className="p-2 text-[10px] text-neutral-600">No registered assets in this scope.</p> : null}
              </div>

              <SaveSummary
                error={previewQuery.error}
                form={form}
                placed={placed}
                preview={preview}
                loading={previewQuery.isFetching}
                suppress={suppressExisting}
                onSuppressChange={setSuppressExisting}
              />

              <label className="mb-4 mt-3 flex items-center gap-2 text-[10px] text-neutral-400">
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
                    <button aria-label={`Edit ${fence.name}`} className="rounded p-1.5 text-neutral-500 hover:bg-white/5 hover:text-neutral-100" onClick={() => startEdit(fence)}><Pencil size={13} /></button>
                    <button aria-label={`Delete ${fence.name}`} className="rounded p-1.5 text-neutral-500 hover:bg-red-500/10 hover:text-red-300" onClick={() => window.confirm(`Remove ${fence.name}?`) && deleteMutation.mutate(fence.id)}><Trash2 size={13} /></button>
                  </div>
                ) : null}
              </div>
            </article>
          ))}
          {!fencesQuery.isLoading && !fences.length ? <div className="glass-panel rounded-lg p-8 text-center text-xs text-neutral-600">No geofences configured.</div> : null}
        </section>

        <section className="glass-panel overflow-hidden rounded-lg p-2">
          <FenceEditorMap
            assets={mappedAssets}
            basemap={basemap}
            fences={fences}
            fitToken={fitToken}
            form={form}
            onBasemapChange={setBasemap}
            onMapClick={handleMapClick}
          />
        </section>
      </div>
    </main>
  );
}

/**
 * Says in words what was drawn and checks it against reality. The asset tally
 * is the part that matters: it catches a fence placed in the wrong spot without
 * the operator having to interpret the map at all.
 */
function SaveSummary({ error, form, placed, preview, loading, suppress, onSuppressChange }) {
  if (!placed) {
    return (
      <p className="rounded-md border border-white/10 bg-white/[0.025] px-3 py-2.5 text-[10px] text-neutral-500">
        <Crosshair size={11} className="mr-1 inline" />
        Place the fence to see what it covers.
      </p>
    );
  }
  if (error) {
    return (
      <p className="rounded-md border border-red-400/25 bg-red-500/[0.07] px-3 py-2.5 text-[10px] text-red-200">
        {error.message}
      </p>
    );
  }
  if (!preview) {
    return (
      <p className="rounded-md border border-white/10 bg-white/[0.025] px-3 py-2.5 text-[10px] text-neutral-500">
        {loading ? "Checking what this fence covers…" : "Summary unavailable for this shape."}
      </p>
    );
  }

  const { summary, metrics, place } = preview;
  const size = metrics ? formatDistance(Math.max(metrics.width_m, metrics.height_m)) : "—";
  const shapeLine = form.shape_type === "circle" ? `Circle · ${formatDistance(Number(form.radius_m))} radius` : "Polygon";

  return (
    <div className="rounded-md border border-white/10 bg-white/[0.025] p-3 text-[10px]">
      <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wide text-neutral-500">
        <Layers size={11} /> Before you save
      </div>
      <p className="mt-2 text-neutral-300">
        {shapeLine} · {size} across · {metrics ? formatArea(metrics.area_sq_m) : "—"}
      </p>
      <p className="mt-1 text-neutral-400">{place ? place.label : "Location not recognised"}</p>

      {summary.total ? (
        <p className={`mt-2 font-bold ${summary.outside ? "text-amber-300" : "text-green-300"}`}>
          {summary.inside} of {summary.total} assigned asset{summary.total === 1 ? "" : "s"} {summary.total === 1 ? "is" : "are"} inside right now
          {summary.outside ? ` · ${summary.outside} outside` : ""}
          {summary.unknown ? ` · ${summary.unknown} not reporting` : ""}
        </p>
      ) : (
        <p className="mt-2 text-neutral-500">No assets assigned yet — this fence will monitor nothing.</p>
      )}

      {summary.outside ? (
        <label className="mt-2 flex cursor-pointer items-start gap-2 rounded border border-amber-400/25 bg-amber-400/[0.06] p-2 text-amber-200">
          <input className="mt-0.5" type="checkbox" checked={suppress} onChange={(event) => onSuppressChange(event.target.checked)} />
          <span>
            Do not alarm on the {summary.outside} asset{summary.outside === 1 ? "" : "s"} already outside.
            <span className="mt-0.5 block text-amber-100/60">
              They are recorded as outside without raising an alarm, and will alarm normally the next time they leave.
              Untick to be alerted about them now.
            </span>
          </span>
        </label>
      ) : null}
    </div>
  );
}
