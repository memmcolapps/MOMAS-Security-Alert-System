import L from "leaflet";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bell,
  ChevronDown,
  Circle,
  Crosshair,
  MapPinned,
  Pencil,
  Plus,
  Radio,
  Save,
  Search,
  Shield,
  Tag,
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
import { DARK_TILES, IMAGERY_LABEL_TILES, SATELLITE_TILES } from "../lib/basemaps";
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

// The editor walks the operator through the task in the order the task happens:
// name it, say who it watches, put it somewhere, then decide how it alarms.
// Placement tools need the assets, so assets come first.
const SECTION_DEFAULTS = { name: true, assets: true, area: true, alarm: false };

// Satellite is how someone who does not read maps recognises a real place —
// they see their own buildings. It carries no labels of its own, so it gets a
// transparent label layer stacked on top.
const BASEMAPS = {
  satellite: {
    label: "Satellite",
    url: SATELLITE_TILES.url,
    options: SATELLITE_TILES.options,
    labels: IMAGERY_LABEL_TILES,
  },
  streets: {
    label: "Streets",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: { maxZoom: 21, maxNativeZoom: 19, attribution: "&copy; OpenStreetMap" },
  },
  dark: {
    label: "Dark",
    url: DARK_TILES.url,
    options: DARK_TILES.options,
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
    const map = L.map(nodeRef.current, { zoomControl: false }).setView([9, 8.5], 6);
    // The top-left corner belongs to the place search now, so the zoom buttons
    // move out of its way.
    L.control.zoom({ position: "bottomright" }).addTo(map);
    // A scale bar is the cheapest orientation aid there is: it turns an
    // abstract shape into "that is about 800 metres across".
    L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
    map.on("click", (event) => clickRef.current?.(event.latlng));
    shapeRef.current = L.layerGroup().addTo(map);
    assetRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // The map now takes its size from the layout rather than a fixed height,
    // so Leaflet has to be told whenever that size changes — otherwise half
    // the tiles never load.
    const observer = new window.ResizeObserver(() => map.invalidateSize());
    observer.observe(nodeRef.current);

    return () => {
      observer.disconnect();
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
      ? L.tileLayer(config.labels.url, config.labels.options).addTo(map)
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
    <div className="absolute inset-0">
      <div className="h-full w-full" ref={nodeRef} />
      {/* Above Leaflet's own controls, which sit at z-index 1000. */}
      <div className="absolute right-3 top-3 z-[1000] flex overflow-hidden rounded-md border border-white/15 bg-black/75 backdrop-blur">
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
      <MapLegend />
    </div>
  );
}

/**
 * The map speaks in five colours and two line styles. Nothing on screen said
 * what any of them meant, so the buffer ring in particular read as decoration.
 */
function MapLegend() {
  const swatch = (style, label) => (
    <div className="flex items-center gap-1.5" key={label}>
      <span style={style} />
      <span>{label}</span>
    </div>
  );
  const dot = (colour) => ({
    display: "block",
    width: "8px",
    height: "8px",
    borderRadius: "9999px",
    background: colour,
    flex: "none",
  });
  const line = (colour, dashed) => ({
    display: "block",
    width: "14px",
    height: "0",
    borderTop: `2px ${dashed ? "dashed" : "solid"} ${colour}`,
    flex: "none",
  });

  return (
    <div className="absolute right-3 top-12 z-[1000] rounded-md border border-white/15 bg-black/75 px-2.5 py-2 text-[9px] text-neutral-400 backdrop-blur">
      <div className="space-y-1">
        {swatch(line("#fb7185", false), "This fence")}
        {swatch(line("#fbbf24", true), "Alarm line")}
        {swatch(line("#94a3b8", false), "Other fences")}
      </div>
      <div className="mt-1.5 space-y-1 border-t border-white/10 pt-1.5">
        {swatch(dot(ASSET_COLOURS.inside), "Inside")}
        {swatch(dot(ASSET_COLOURS.outside), "Outside")}
        {swatch(dot(ASSET_COLOURS.unknown), "Not reporting")}
      </div>
    </div>
  );
}

/**
 * Lives over the map, because that is all it does: move the view. On the form
 * it needed a caption explaining it did not place anything.
 */
function PlaceSearch({ value, onChange, results, onPick }) {
  return (
    <div className="absolute left-3 top-3 z-[1001] w-[min(260px,calc(100%-24px))]">
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
        <input
          className="w-full rounded-md border border-white/15 bg-black/75 py-2 pl-8 pr-3 text-[11px] text-neutral-200 outline-none backdrop-blur placeholder:text-neutral-500 focus:border-white/30"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Find a town or state"
          aria-label="Search for a place"
        />
      </div>
      {results.length ? (
        <ul className="mt-1 max-h-56 overflow-y-auto rounded-md border border-white/15 bg-[#0b0b0b]/95 py-1 shadow-xl backdrop-blur">
          {results.map((place) => (
            <li key={`${place.name}-${place.state}`}>
              <button
                className="block w-full px-3 py-1.5 text-left text-[11px] text-neutral-300 hover:bg-white/5"
                onClick={() => onPick(place)}
                type="button"
              >
                {place.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * One step of the editor. Collapsed, it still answers its own question — the
 * summary line is the setting, so nothing is hidden by closing a section.
 */
function Section({ icon: Icon, title, summary, open, onToggle, complete, children }) {
  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.02]">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        onClick={onToggle}
        type="button"
      >
        <Icon className={complete ? "text-green-400" : "text-neutral-600"} size={13} />
        <span className="text-[11px] font-bold text-neutral-200">{title}</span>
        <span className="ml-auto truncate pl-2 text-[10px] text-neutral-500">{open ? "" : summary}</span>
        <ChevronDown className={`shrink-0 text-neutral-600 transition-transform ${open ? "" : "-rotate-90"}`} size={13} />
      </button>
      {open ? <div className="border-t border-white/10 p-3">{children}</div> : null}
    </section>
  );
}

/** An error belongs beside the control that caused it, not at the top of a page. */
function FieldError({ message }) {
  if (!message) return null;
  return <p className="mt-2 rounded border border-red-400/25 bg-red-500/[0.07] px-2 py-1.5 text-[10px] text-red-200">{message}</p>;
}

export function GeofencesRoute() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [feedback, setFeedback] = useState(null);
  const [errors, setErrors] = useState({});
  const [sections, setSections] = useState(SECTION_DEFAULTS);
  const [basemap, setBasemap] = useState("satellite");
  const [fitToken, setFitToken] = useState(null);
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeResults, setPlaceResults] = useState([]);
  const [margin, setMargin] = useState(200);
  const [assetFilter, setAssetFilter] = useState("");
  const [fenceFilter, setFenceFilter] = useState("");
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

  const fences = useMemo(() => fencesQuery.data?.geofences || [], [fencesQuery.data]);
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

  const visibleAssets = useMemo(() => {
    const needle = assetFilter.trim().toLowerCase();
    if (!needle) return assetChoices;
    return assetChoices.filter(
      (asset) => asset.name.toLowerCase().includes(needle) || asset.asset_id.toLowerCase().includes(needle),
    );
  }, [assetChoices, assetFilter]);

  const visibleFences = useMemo(() => {
    const needle = fenceFilter.trim().toLowerCase();
    if (!needle) return fences;
    return fences.filter((fence) => (fence.name || "").toLowerCase().includes(needle));
  }, [fences, fenceFilter]);

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
      closeEditor();
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

  function toggleSection(key) {
    setSections((current) => ({ ...current, [key]: !current[key] }));
  }

  /** Editor chrome only — the feedback banner outlives the editor, since a save
      closes it and the result has to survive into the list. */
  function resetEditorChrome() {
    setSections(SECTION_DEFAULTS);
    setErrors({});
    setAssetFilter("");
    setSuppressExisting(true);
  }

  function closeEditor() {
    setEditing(false);
    setForm(EMPTY);
    resetEditorChrome();
  }

  function startNew() {
    setForm({
      ...EMPTY,
      organization_id: String(membership?.organization_id || organizations[0]?.id || ""),
    });
    setEditing(true);
    resetEditorChrome();
    setFeedback(null);
  }

  function startEdit(fence) {
    const next = toForm(fence);
    setForm(next);
    setEditing(true);
    resetEditorChrome();
    setFeedback(null);
    focusFence(fence);
  }

  /** Takes the map to a fence without opening it — the list is a way to look around. */
  function focusFence(fence) {
    if (fence.shape_type === "circle" && fence.center_lat != null) {
      setFitToken({ centre: { lat: Number(fence.center_lat), lon: Number(fence.center_lon) }, zoom: 15, key: Date.now() });
      return;
    }
    const ring = fence.geometry?.coordinates?.[0] || fence.points || [];
    if (ring.length) fitToPoints(ring.map(([lon, lat]) => ({ lat, lon })));
  }

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function setError(key, message) {
    setErrors((current) => ({ ...current, [key]: message }));
  }

  function clearError(key) {
    setErrors((current) => (current[key] ? { ...current, [key]: null } : current));
  }

  function handleMapClick(latlng) {
    if (!editing) return;
    clearError("area");
    if (form.shape_type === "circle") {
      setForm((current) => ({ ...current, center_lat: latlng.lat, center_lon: latlng.lng }));
    } else {
      setForm((current) => ({ ...current, points: [...current.points, [latlng.lng, latlng.lat]] }));
    }
  }

  function toggleAssignment(assetType, assetId) {
    const key = `${assetType}:${assetId}`;
    clearError("assets");
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
      setError("area", "That asset has not reported a position yet.");
      return;
    }
    clearError("area");
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
      setError("area", "None of the assigned assets have reported a position yet.");
      return;
    }
    clearError("area");
    if (form.shape_type === "circle") {
      const circle = circleAroundAssets(assignedPositions, Number(margin));
      setForm((current) => ({ ...current, ...circle, points: [] }));
    } else {
      const points = polygonAroundAssets(assignedPositions, Number(margin));
      setForm((current) => ({ ...current, points, center_lat: null, center_lon: null }));
    }
    fitToPoints(assignedPositions);
  }

  function submit(event) {
    event.preventDefault();
    if (!form.name.trim()) {
      setError("name", "Give the fence a name.");
      setSections((current) => ({ ...current, name: true }));
      return;
    }
    if (form.shape_type === "polygon" && form.points.length < 3) {
      setError("area", "A polygon needs at least three points. Build it from your assets, or click the map.");
      setSections((current) => ({ ...current, area: true }));
      return;
    }
    if (form.shape_type === "circle" && form.center_lat == null) {
      setError("area", "Place the centre of the circle first.");
      setSections((current) => ({ ...current, area: true }));
      return;
    }
    setErrors({});
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
  const alarmDelayLabel =
    timeToAlarmSec < 60 ? `${timeToAlarmSec} seconds` : `${Math.round(timeToAlarmSec / 60)} minutes`;
  const orgName = organizations.find((org) => String(org.id) === String(selectedOrgId))?.name;
  const metrics = preview?.metrics || null;
  const areaSummary = placed
    ? `${form.shape_type === "circle" ? formatDistance(Number(form.radius_m)) + " radius" : `${form.points.length} corners`}`
    : "Not placed yet";

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-ops-bg pt-[var(--ops-chrome)] text-neutral-200">
      {/* Map on top below xl so it is never pushed off-screen by the panel. */}
      <div className="flex min-h-0 flex-1 flex-col-reverse xl:flex-row">
        <aside className="flex min-h-0 flex-1 flex-col border-white/10 xl:w-[380px] xl:flex-none xl:border-r">
          {editing ? (
            <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
              <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
                <button
                  aria-label="Back to geofence list"
                  className="rounded p-1 text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
                  onClick={closeEditor}
                  type="button"
                >
                  <ArrowLeft size={15} />
                </button>
                <h1 className="text-[12px] font-bold text-neutral-100">{form.id ? "Edit geofence" : "New geofence"}</h1>
              </header>

              {feedback ? <Banner feedback={feedback} onDismiss={() => setFeedback(null)} /> : null}

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                <Section
                  complete={Boolean(form.name.trim())}
                  icon={Tag}
                  onToggle={() => toggleSection("name")}
                  open={sections.name}
                  summary={form.name || "Unnamed"}
                  title="Name"
                >
                  <input
                    className="field-input"
                    onChange={(event) => {
                      clearError("name");
                      update("name", event.target.value);
                    }}
                    placeholder="Allowed operations area"
                    value={form.name}
                  />
                  <FieldError message={errors.name} />
                  {isAdmin ? (
                    <label className="mt-3 block text-[10px] text-neutral-500">
                      Organization
                      <select
                        className="field-input mt-1"
                        disabled={Boolean(form.id)}
                        onChange={(event) => update("organization_id", event.target.value)}
                        value={selectedOrgId}
                      >
                        <option value="">Select organization</option>
                        {organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
                      </select>
                    </label>
                  ) : null}
                </Section>

                <Section
                  complete={form.assignments.length > 0}
                  icon={Users}
                  onToggle={() => toggleSection("assets")}
                  open={sections.assets}
                  summary={form.assignments.length ? `${form.assignments.length} assigned` : "None yet"}
                  title="Assets it watches"
                >
                  {assetChoices.length > 6 ? (
                    <div className="relative mb-2">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-600" size={12} />
                      <input
                        aria-label="Filter assets"
                        className="field-input pl-8"
                        onChange={(event) => setAssetFilter(event.target.value)}
                        placeholder={`Filter ${assetChoices.length} assets`}
                        value={assetFilter}
                      />
                    </div>
                  ) : null}
                  <div className="max-h-56 overflow-y-auto rounded-md border border-white/10">
                    {visibleAssets.map((asset) => {
                      const key = `${asset.asset_type}:${asset.asset_id}`;
                      const hasPosition = livePositions.has(key);
                      return (
                        <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[10px] hover:bg-white/5" key={key}>
                          <input
                            checked={selectedKeys.has(key)}
                            onChange={() => toggleAssignment(asset.asset_type, asset.asset_id)}
                            type="checkbox"
                          />
                          {asset.asset_type === "radio" ? <Radio className="text-green-400" size={12} /> : <span className="text-sky-400">✈</span>}
                          <span className="truncate">{asset.name}</span>
                          <span className={`ml-auto shrink-0 ${hasPosition ? "text-neutral-700" : "text-amber-500/70"}`}>
                            {hasPosition ? <span className="font-mono">{asset.asset_id}</span> : "no position"}
                          </span>
                        </label>
                      );
                    })}
                    {!visibleAssets.length ? (
                      <p className="p-3 text-[10px] text-neutral-600">
                        {assetChoices.length ? "No assets match that filter." : "No registered assets in this scope."}
                      </p>
                    ) : null}
                  </div>
                  <FieldError message={errors.assets} />
                </Section>

                <Section
                  complete={placed}
                  icon={Crosshair}
                  onToggle={() => toggleSection("area")}
                  open={sections.area}
                  summary={areaSummary}
                  title="Area"
                >
                  <div className="grid grid-cols-2 gap-2">
                    {["polygon", "circle"].map((shape) => (
                      <button
                        className={`rounded-md border px-3 py-2 text-[10px] font-bold capitalize ${form.shape_type === shape ? "border-red-400 bg-red-500/15 text-red-300" : "border-white/10 text-neutral-500"}`}
                        key={shape}
                        onClick={() => setForm((current) => ({ ...current, shape_type: shape, points: [], center_lat: null, center_lon: null }))}
                        type="button"
                      >
                        {shape === "polygon" ? <Shield className="mr-1 inline" size={13} /> : <Circle className="mr-1 inline" size={13} />}
                        {shape}
                      </button>
                    ))}
                  </div>

                  <div className="mt-3 flex items-end gap-2">
                    <button
                      className="flex-1 rounded-md border border-white/15 bg-white/[0.04] px-3 py-2 text-[10px] font-bold text-neutral-200 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={!form.assignments.length}
                      onClick={fitAroundAssets}
                      title={form.assignments.length ? "" : "Assign assets first"}
                      type="button"
                    >
                      <Users className="mr-1.5 inline" size={12} />
                      {form.assignments.length
                        ? `Fit around the ${form.assignments.length} asset${form.assignments.length === 1 ? "" : "s"}`
                        : "Fit around assigned assets"}
                    </button>
                    <label className="w-20 shrink-0 text-[10px] text-neutral-500">
                      Margin (m)
                      <input
                        className="field-input mt-1"
                        min="0"
                        onChange={(event) => setMargin(event.target.value)}
                        step="50"
                        type="number"
                        value={margin}
                      />
                    </label>
                  </div>

                  <label className="mt-2 block text-[10px] text-neutral-500">
                    Or centre on one asset
                    <select
                      className="field-input mt-1"
                      onChange={(event) => event.target.value && centreOnAsset(event.target.value)}
                      value=""
                    >
                      <option value="">Choose an asset…</option>
                      {assetChoices.map((asset) => {
                        const key = `${asset.asset_type}:${asset.asset_id}`;
                        return (
                          <option disabled={!livePositions.has(key)} key={key} value={key}>
                            {asset.name}{livePositions.has(key) ? "" : " (no position)"}
                          </option>
                        );
                      })}
                    </select>
                  </label>

                  {form.shape_type === "circle" ? (
                    <label className="mt-2 block text-[10px] text-neutral-500">
                      Radius (metres)
                      <input
                        className="field-input mt-1"
                        min="10"
                        onChange={(event) => update("radius_m", event.target.value)}
                        type="number"
                        value={form.radius_m}
                      />
                    </label>
                  ) : null}

                  <div className="mt-2 flex items-center justify-between text-[10px] text-neutral-500">
                    <span>
                      {form.shape_type === "polygon"
                        ? `Or click the map to add corners — ${form.points.length} placed.`
                        : form.center_lat == null
                          ? "Or click the map to drop the centre."
                          : `Centre: ${Number(form.center_lat).toFixed(5)}, ${Number(form.center_lon).toFixed(5)}`}
                    </span>
                    {form.shape_type === "polygon" && form.points.length ? (
                      <button className="shrink-0 text-red-300" onClick={() => update("points", form.points.slice(0, -1))} type="button">
                        <Undo2 className="inline" size={12} /> Undo
                      </button>
                    ) : null}
                  </div>

                  <FieldError message={errors.area} />

                  {placed && metrics ? (
                    <p className="mt-2 rounded border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[10px] text-neutral-400">
                      {formatDistance(Math.max(metrics.width_m, metrics.height_m))} across ·{" "}
                      {formatArea(metrics.area_sq_m)}
                      {preview?.place ? <span className="block text-neutral-500">{preview.place.label}</span> : null}
                    </p>
                  ) : null}
                </Section>

                <Section
                  complete
                  icon={Bell}
                  onToggle={() => toggleSection("alarm")}
                  open={sections.alarm}
                  summary={`${alarmDelayLabel} · ${form.buffer_m} m drift${form.active ? "" : " · off"}`}
                  title="Alarm"
                >
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[10px] text-neutral-500">
                      Allow GPS drift (m)
                      <input
                        className="field-input mt-1"
                        min="0"
                        onChange={(event) => update("buffer_m", event.target.value)}
                        type="number"
                        value={form.buffer_m}
                      />
                    </label>
                    <label className="text-[10px] text-neutral-500">
                      Confirmations
                      <input
                        className="field-input mt-1"
                        max="10"
                        min="1"
                        onChange={(event) => update("confirmations_required", event.target.value)}
                        type="number"
                        value={form.confirmations_required}
                      />
                    </label>
                  </div>
                  <p className="mt-2 text-[9px] text-neutral-600">
                    An asset must read outside {form.confirmations_required} times before an alarm is raised — about{" "}
                    {alarmDelayLabel} at the current 15-second position poll. The dashed ring on the map is where a breach
                    actually fires.
                  </p>
                  <label className="mt-3 flex items-center gap-2 text-[10px] text-neutral-400">
                    <input checked={form.active} onChange={(event) => update("active", event.target.checked)} type="checkbox" />
                    Monitoring active
                  </label>
                </Section>
              </div>

              <VerifyFooter
                error={previewQuery.error}
                loading={previewQuery.isFetching}
                onSuppressChange={setSuppressExisting}
                placed={placed}
                preview={preview}
                saving={saveMutation.isPending}
                suppress={suppressExisting}
              />
            </form>
          ) : (
            <>
              <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
                <MapPinned className="text-red-400" size={16} />
                <h1 className="text-[12px] font-bold text-neutral-100">Geofences</h1>
                <span className="text-[10px] text-neutral-600">{fences.length}</span>
                {canManage ? (
                  <button
                    className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-red-400 px-2.5 py-1.5 text-[10px] font-bold text-black"
                    onClick={startNew}
                    type="button"
                  >
                    <Plus size={12} /> New
                  </button>
                ) : null}
              </header>

              {feedback ? <Banner feedback={feedback} onDismiss={() => setFeedback(null)} /> : null}

              {fences.length > 6 ? (
                <div className="relative border-b border-white/10 px-3 py-2">
                  <Search className="absolute left-[22px] top-1/2 -translate-y-1/2 text-neutral-600" size={12} />
                  <input
                    aria-label="Filter geofences"
                    className="field-input pl-8"
                    onChange={(event) => setFenceFilter(event.target.value)}
                    placeholder="Filter fences"
                    value={fenceFilter}
                  />
                </div>
              ) : null}

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                <p className="px-1 pb-1 text-[10px] text-neutral-600">
                  Monitoring-only allowed areas for registered radios and drones.
                </p>
                {visibleFences.map((fence) => (
                  <article
                    className="group rounded-lg border border-white/10 bg-white/[0.02] p-3 hover:border-white/20"
                    key={fence.id}
                  >
                    <div className="flex items-start gap-2.5">
                      <button
                        className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                        onClick={() => focusFence(fence)}
                        title="Show on map"
                        type="button"
                      >
                        <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md ${fence.active ? "bg-red-500/15 text-red-300" : "bg-white/5 text-neutral-600"}`}>
                          <MapPinned size={15} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-bold text-neutral-100">{fence.name}</span>
                          <span className="mt-1 block text-[9px] text-neutral-600">
                            {fence.shape_type} · {fence.assignments?.length || 0} assets
                            {fence.active ? "" : " · monitoring off"}
                          </span>
                        </span>
                      </button>
                      {canManage ? (
                        <div className="flex shrink-0 gap-1">
                          <button
                            aria-label={`Edit ${fence.name}`}
                            className="rounded p-2 text-neutral-500 hover:bg-white/5 hover:text-neutral-100"
                            onClick={() => startEdit(fence)}
                            type="button"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            aria-label={`Delete ${fence.name}`}
                            className="rounded p-2 text-neutral-500 hover:bg-red-500/10 hover:text-red-300"
                            onClick={() =>
                              window.confirm(
                                `Remove ${fence.name}? ${fence.assignments?.length || 0} asset${(fence.assignments?.length || 0) === 1 ? "" : "s"} will stop being monitored by it.`,
                              ) && deleteMutation.mutate(fence.id)
                            }
                            type="button"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </article>
                ))}
                {!fencesQuery.isLoading && !visibleFences.length ? (
                  <div className="rounded-lg border border-white/10 p-8 text-center text-xs text-neutral-600">
                    {fences.length ? "No fences match that filter." : "No geofences configured."}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </aside>

        <section className="relative h-[45vh] shrink-0 overflow-hidden xl:h-auto xl:flex-1">
          <FenceEditorMap
            assets={mappedAssets}
            basemap={basemap}
            fences={fences}
            fitToken={fitToken}
            form={form}
            onBasemapChange={setBasemap}
            onMapClick={handleMapClick}
          />
          <PlaceSearch onChange={setPlaceQuery} onPick={goToPlace} results={placeResults} value={placeQuery} />
        </section>
      </div>
    </main>
  );
}

/** Save outcomes only. Anything a single control caused is reported at that control. */
function Banner({ feedback, onDismiss }) {
  return (
    <div
      className={`flex items-start gap-2 border-b px-3 py-2 text-[10px] ${
        feedback.type === "error"
          ? "border-red-400/25 bg-red-500/[0.07] text-red-200"
          : "border-green-400/25 bg-green-400/[0.07] text-green-200"
      }`}
      role="status"
    >
      <span className="flex-1">{feedback.message}</span>
      <button aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100" onClick={onDismiss} type="button">
        <X size={12} />
      </button>
    </div>
  );
}

/**
 * Pinned under the editor so the verdict and the save button are always on
 * screen. The asset tally is the part that matters: it catches a fence placed
 * in the wrong spot without the operator having to interpret the map at all.
 */
function VerifyFooter({ error, loading, onSuppressChange, placed, preview, saving, suppress }) {
  const summary = preview?.summary;

  let verdict = null;
  if (!placed) {
    verdict = <span className="text-neutral-500"><Crosshair className="mr-1 inline" size={11} />Place the fence to see what it covers.</span>;
  } else if (error) {
    verdict = <span className="text-red-200">{error.message}</span>;
  } else if (!preview) {
    verdict = <span className="text-neutral-500">{loading ? "Checking what this fence covers…" : "Summary unavailable for this shape."}</span>;
  } else if (!summary.total) {
    verdict = <span className="text-neutral-500">No assets assigned — this fence will monitor nothing.</span>;
  } else {
    verdict = (
      <span className={`font-bold ${summary.outside ? "text-amber-300" : "text-green-300"}`}>
        {summary.inside} of {summary.total} asset{summary.total === 1 ? "" : "s"} inside right now
        {summary.outside ? ` · ${summary.outside} outside` : ""}
        {summary.unknown ? ` · ${summary.unknown} not reporting` : ""}
      </span>
    );
  }

  return (
    <footer className="border-t border-white/10 bg-black/40 p-3">
      <p className="text-[10px] leading-relaxed">{verdict}</p>

      {summary?.outside ? (
        <label className="mt-2 flex cursor-pointer items-start gap-2 rounded border border-amber-400/25 bg-amber-400/[0.06] p-2 text-[10px] text-amber-200">
          <input checked={suppress} className="mt-0.5" onChange={(event) => onSuppressChange(event.target.checked)} type="checkbox" />
          <span>
            Do not alarm on the {summary.outside} already outside.
            <span className="mt-0.5 block text-amber-100/60">
              They are recorded as outside without raising an alarm, and will alarm normally the next time they leave.
            </span>
          </span>
        </label>
      ) : null}

      <button
        className="mt-2.5 inline-flex w-full items-center justify-center gap-2 rounded-md bg-red-400 px-4 py-2.5 text-xs font-bold text-black disabled:opacity-40"
        disabled={saving}
        type="submit"
      >
        <Save size={14} /> {saving ? "Saving…" : "Save geofence"}
      </button>
    </footer>
  );
}
