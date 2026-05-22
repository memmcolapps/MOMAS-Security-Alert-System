import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Download,
  Pause,
  Play,
  Radio,
  RefreshCw,
  SatelliteDish,
  SkipForward,
  Siren,
  Tv,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OperationsMap, devicePopup, dronePopup, incidentPopup, sosPopup } from "../components/OperationsMap";
import {
  acknowledgeSos,
  getDronePositions,
  getIncidents,
  getLocations,
  getMe,
  getSosLog,
  listDevices,
  resolveSos,
  triggerScrape,
} from "../lib/api";
import { config } from "../lib/app-config";
import {
  NIGERIAN_STATES,
  rangeForMode,
  relativeDate,
  severityColors,
  severityLabels,
  todayISO,
  typeIcons,
} from "../lib/domain";

const modes = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["7d", "7d"],
  ["30d", "30d"],
  ["90d", "90d"],
  ["ytd", "YTD"],
  ["all", "All Time"],
];

const LAYER_LABELS = {
  live: "Live Alerts",
  heat: "Heatmap",
  devices: "Devices",
  drones: "Drones",
};

function iconForType(type) {
  return typeIcons[type] || "fa-circle-exclamation";
}

function toCSV(rows) {
  const headers = ["date", "state", "location", "type", "severity", "fatalities", "victims", "title", "source_url"];
  const esc = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return [headers.join(","), ...rows.map((row) => headers.map((key) => esc(row[key])).join(","))].join("\n");
}

function downloadCSV(rows) {
  const blob = new Blob([toCSV(rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `momas-incidents-${todayISO()}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function OperationsRoute() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const orgName = meQuery.data?.user?.memberships?.[0]?.name;
  const opsLabel = orgName ? `EPAIL Intelligence · ${orgName}` : "EPAIL Intelligence";
  const today = todayISO();
  const [[from, to], setRange] = useState(() => rangeForMode("today", today));
  const [activeMode, setActiveMode] = useState("today");
  const [filters, setFilters] = useState({ severity: "", type: "", state: "" });
  const [panelOpen, setPanelOpen] = useState(true);
  const [statsMinimized, setStatsMinimized] = useState(false);
  const [basemap, setBasemap] = useState("dark");
  const [activeLayers, setActiveLayers] = useState({ live: true, heat: false, devices: true, drones: true });
  const [sosSoundMuted, setSosSoundMuted] = useState(false);
  const [focusTarget, setFocusTarget] = useState(null);
  const knownSosIdsRef = useRef(null);
  const ringingSosIdsRef = useRef(new Set());
  const pendingSosFocusIdsRef = useRef(new Set());
  const audioCtxRef = useRef(null);
  const alarmTimerRef = useRef(null);

  const incidentQuery = useQuery({
    queryKey: ["incidents", from, to],
    queryFn: () => getIncidents({ limit: config.maxMarkers, from, to }),
    refetchInterval: config.refreshMs,
  });

  const devicesQuery = useQuery({
    queryKey: ["devices"],
    queryFn: listDevices,
    refetchInterval: 60000,
  });

  const locationsQuery = useQuery({
    queryKey: ["locations"],
    queryFn: () => getLocations(),
    refetchInterval: 30000,
  });

  const sosQuery = useQuery({
    queryKey: ["sos-log"],
    queryFn: getSosLog,
    refetchInterval: 15000,
  });

  const dronesQuery = useQuery({
    queryKey: ["drone-positions"],
    queryFn: getDronePositions,
    refetchInterval: 3000,
  });

  const scrapeMutation = useMutation({
    mutationFn: triggerScrape,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["incidents"] }),
  });

  const ackMutation = useMutation({
    mutationFn: acknowledgeSos,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sos-log"] }),
  });

  const resolveMutation = useMutation({
    mutationFn: resolveSos,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sos-log"] }),
  });

  const incidents = incidentQuery.data?.incidents || [];
  const devices = devicesQuery.data?.devices || [];
  const locations = locationsQuery.data?.data || [];
  const sosAlerts = sosQuery.data?.alerts || [];
  const drones = dronesQuery.data?.drones || [];
  const latestDeviceLocations = useMemo(
    () => new Map(locations.map((location) => [String(location.Uid), location])),
    [locations],
  );
  const activeSos = useMemo(
    () =>
      sosAlerts
        .filter((alert) => Number(alert.status) < 2)
        .map((alert) => {
          const sosLat = Number(alert.location_lat);
          const sosLon = Number(alert.location_lon);
          if (Number.isFinite(sosLat) && Number.isFinite(sosLon)) {
            return { ...alert, map_lat: sosLat, map_lon: sosLon, map_location_source: "sos" };
          }

          const deviceLocation = latestDeviceLocations.get(String(alert.device_id));
          const deviceLat = Number(deviceLocation?.Lat);
          const deviceLon = Number(deviceLocation?.Lng);
          if (Number.isFinite(deviceLat) && Number.isFinite(deviceLon)) {
            return { ...alert, map_lat: deviceLat, map_lon: deviceLon, map_location_source: "device" };
          }

          return alert;
        }),
    [sosAlerts, latestDeviceLocations],
  );

  const ensureAudioContext = useCallback(() => {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  }, []);

  const playSosTone = useCallback(() => {
    if (sosSoundMuted) return;
    const ctx = ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();

    for (let i = 0; i < 3; i += 1) {
      const start = ctx.currentTime + i * 0.34;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(880, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.24);
    }
  }, [ensureAudioContext, sosSoundMuted]);

  useEffect(() => {
    const activeIds = activeSos.map((alert) => String(alert.sos_msg_id)).filter(Boolean);
    if (!knownSosIdsRef.current) {
      knownSosIdsRef.current = new Set(activeIds);
      return;
    }

    const newIds = activeIds.filter((id) => !knownSosIdsRef.current.has(id));
    activeIds.forEach((id) => knownSosIdsRef.current.add(id));
    newIds.forEach((id) => ringingSosIdsRef.current.add(id));
    newIds.forEach((id) => pendingSosFocusIdsRef.current.add(id));
    const focusAlert = activeSos.find(
      (alert) =>
        pendingSosFocusIdsRef.current.has(String(alert.sos_msg_id)) &&
        Number.isFinite(Number(alert.map_lat)) &&
        Number.isFinite(Number(alert.map_lon)),
    );
    if (focusAlert) {
      pendingSosFocusIdsRef.current.delete(String(focusAlert.sos_msg_id));
      setFocusTarget({
        kind: "sos",
        id: `sos-${focusAlert.sos_msg_id}`,
        key: `sos-${focusAlert.sos_msg_id}-${Date.now()}`,
        lat: Number(focusAlert.map_lat),
        lon: Number(focusAlert.map_lon),
        zoom: 15,
        label: focusAlert.dev_name || focusAlert.device_name || `Device ${focusAlert.device_id}`,
        popupHtml: sosPopup(focusAlert),
      });
    }

    const activeSet = new Set(activeIds);
    ringingSosIdsRef.current.forEach((id) => {
      if (!activeSet.has(id)) ringingSosIdsRef.current.delete(id);
    });
    pendingSosFocusIdsRef.current.forEach((id) => {
      if (!activeSet.has(id)) pendingSosFocusIdsRef.current.delete(id);
    });
  }, [activeSos]);

  useEffect(() => {
    if (alarmTimerRef.current) {
      window.clearInterval(alarmTimerRef.current);
      alarmTimerRef.current = null;
    }
    if (sosSoundMuted || !ringingSosIdsRef.current.size) return undefined;

    playSosTone();
    alarmTimerRef.current = window.setInterval(playSosTone, 1800);
    return () => {
      if (alarmTimerRef.current) {
        window.clearInterval(alarmTimerRef.current);
        alarmTimerRef.current = null;
      }
    };
  }, [activeSos, playSosTone, sosSoundMuted]);

  useEffect(() => {
    const unlockAudio = () => {
      const ctx = ensureAudioContext();
      void ctx?.resume?.();
    };
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
  }, [ensureAudioContext]);

  function toggleSosSound() {
    setSosSoundMuted((value) => !value);
  }

  const visibleIncidents = useMemo(
    () =>
      incidents.filter(
        (incident) =>
          (!filters.severity || incident.severity === filters.severity) &&
          (!filters.type || incident.type === filters.type) &&
          (!filters.state || incident.state === filters.state),
      ),
    [incidents, filters],
  );

  const stats = useMemo(() => {
    const states = new Set(incidents.map((item) => item.state).filter(Boolean));
    const killed = incidents.reduce((sum, item) => sum + Number(item.fatalities || item.killed || 0), 0);
    const abducted = incidents.reduce((sum, item) => sum + Number(item.victims || item.abducted || 0), 0);
    const critical = incidents.filter((item) => item.severity === "RED").length;
    return { states: states.size, killed, abducted, critical };
  }, [incidents]);

  function setMode(mode) {
    setActiveMode(mode);
    setRange(rangeForMode(mode, today));
  }

  function setManualRange(nextRange) {
    setActiveMode("");
    setRange(nextRange);
  }

  // ── Live Mode (auto tour) ──
  const [liveMode, setLiveMode] = useState(false);
  const [tourPaused, setTourPaused] = useState(false);
  const [tourIndex, setTourIndex] = useState(0);

  const tourStops = useMemo(() => {
    const incidentStops = visibleIncidents
      .filter((incident) => Number.isFinite(Number(incident.lat)) && Number.isFinite(Number(incident.lon)))
      .slice()
      .sort((a, b) => {
        const ad = new Date(a.date || a.created_at || 0).getTime();
        const bd = new Date(b.date || b.created_at || 0).getTime();
        return bd - ad;
      })
      .map((incident) => ({
        kind: "incident",
        id: `inc-${incident.id || `${incident.date}-${incident.title}`}`,
        lat: Number(incident.lat),
        lon: Number(incident.lon),
        label: incident.title || incident.type || "Incident",
        popupHtml: incidentPopup(incident),
      }));
    const registry = new Map(devices.map((device) => [String(device.device_id), device]));
    const deviceStops = locations
      .filter((location) => {
        const reg = registry.get(String(location.Uid));
        return reg?.active && Number.isFinite(Number(location.Lat)) && Number.isFinite(Number(location.Lng));
      })
      .map((location) => ({
        kind: "device",
        id: `dev-${location.Uid}`,
        lat: Number(location.Lat),
        lon: Number(location.Lng),
        label: registry.get(String(location.Uid))?.name || location.Uid,
        popupHtml: devicePopup(location, registry),
      }));
    const droneStops = drones
      .filter((drone) => Number.isFinite(Number(drone.lat)) && Number.isFinite(Number(drone.lon)))
      .map((drone) => ({
        kind: "drone",
        id: `drone-${drone.sysid}`,
        lat: Number(drone.lat),
        lon: Number(drone.lon),
        label: drone.name || `Drone ${drone.sysid}`,
        popupHtml: dronePopup(drone),
      }));
    return [...incidentStops, ...deviceStops, ...droneStops];
  }, [visibleIncidents, devices, locations, drones]);

  useEffect(() => {
    if (!liveMode || tourPaused || !tourStops.length) return undefined;
    const stop = tourStops[tourIndex % tourStops.length];
    setFocusTarget({ ...stop, key: `${stop.id}-${Date.now()}` });
    const timer = window.setTimeout(() => {
      setTourIndex((idx) => (idx + 1) % tourStops.length);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [liveMode, tourPaused, tourIndex, tourStops]);

  useEffect(() => {
    if (liveMode && tourIndex >= tourStops.length) setTourIndex(0);
  }, [liveMode, tourStops.length, tourIndex]);

  function startLiveMode() {
    setTourIndex(0);
    setTourPaused(false);
    setLiveMode(true);
  }
  function stopLiveMode() {
    setLiveMode(false);
    setTourPaused(false);
    setFocusTarget(null);
  }
  function skipTour() {
    setTourIndex((idx) => (idx + 1) % Math.max(tourStops.length, 1));
  }
  const currentStop = tourStops.length ? tourStops[tourIndex % tourStops.length] : null;

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-ops-bg text-neutral-200">
      <OperationsMap
        incidents={visibleIncidents}
        devices={devices}
        locations={locations}
        sosAlerts={activeSos}
        drones={drones}
        activeLayers={activeLayers}
        basemap={basemap}
        focusTarget={focusTarget}
      />

      {liveMode ? (
        <section className="glass-panel absolute left-1/2 top-16 z-[1000] flex -translate-x-1/2 items-center gap-3 rounded-md border border-ops-red/40 px-3 py-2 text-[11px] text-neutral-200">
          <span className="inline-flex items-center gap-1.5 font-bold text-ops-red">
            <span className="live-dot" /> LIVE
          </span>
          <span className="max-w-[220px] truncate text-neutral-300">
            {currentStop?.label || "—"}
          </span>
          <span className="text-[10px] text-neutral-500">
            {tourStops.length ? `${(tourIndex % tourStops.length) + 1} / ${tourStops.length}` : "0 / 0"}
          </span>
          <div className="ml-2 flex items-center gap-1">
            <button onClick={() => setTourPaused((value) => !value)} className="rounded p-1 text-neutral-400 hover:text-neutral-100" title={tourPaused ? "Resume" : "Pause"}>
              {tourPaused ? <Play size={13} /> : <Pause size={13} />}
            </button>
            <button onClick={skipTour} className="rounded p-1 text-neutral-400 hover:text-neutral-100" title="Skip">
              <SkipForward size={13} />
            </button>
            <button onClick={stopLiveMode} className="rounded p-1 text-neutral-400 hover:text-ops-red" title="Exit live mode">
              <X size={13} />
            </button>
          </div>
        </section>
      ) : null}

      <section className="glass-panel absolute left-16 top-16 z-[1000] max-w-[260px] rounded-md px-3 py-2">
        <div className="inline-flex items-center gap-1 rounded border border-ops-red bg-red-500/10 px-1.5 py-0.5 text-[8px] font-bold tracking-widest text-ops-red">
          <span className="live-dot" /> LIVE MONITORING
        </div>
        <div className="mt-1 text-[9px] tracking-wide text-neutral-500">
          <span className="font-bold text-ops-red">{stats.critical}</span> CRITICAL ·{" "}
          <span className="font-bold text-ops-red">{incidents.length}</span> TOTAL ·{" "}
          <span className="font-bold text-orange-400">{stats.killed}</span> KILLED
        </div>
      </section>

      <section
        className={`glass-panel absolute top-16 z-[1000] hidden max-w-[210px] rounded-lg p-3 text-[10px] lg:block ${
          panelOpen ? "right-[400px]" : "right-5"
        }`}
      >
        <h2 className="mb-2 text-xs font-bold text-ops-red">Alert Key</h2>
        {Object.entries(severityLabels).map(([key, label]) => (
          <div className="my-1 flex items-center gap-2 text-neutral-400" key={key}>
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: severityColors[key] }} />
            <span className="rounded bg-white/5 px-1 text-[9px] font-bold" style={{ color: severityColors[key] }}>
              {label}
            </span>
            {key === "RED" ? "Critical" : key === "ORANGE" ? "Serious" : key === "YELLOW" ? "Moderate" : "Low"}
          </div>
        ))}
        <div className="mt-3 border-t border-white/10 pt-2">
          <div className="mb-1 text-[9px] uppercase tracking-wide text-neutral-600">Devices</div>
          <div className="flex items-center gap-2 text-neutral-400">
            <Radio size={12} className="text-ops-green" /> Reporting
          </div>
          <div className="flex items-center gap-2 text-neutral-400">
            <Siren size={12} className="text-ops-red" /> SOS alarm
          </div>
        </div>
      </section>

      <aside
        className={`glass-panel absolute right-0 top-12 z-[1000] flex h-[calc(100vh-3rem)] w-[380px] max-w-[calc(100vw-32px)] flex-col border-r-0 transition-transform ${
          panelOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="border-b border-white/10 p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-bold text-ops-red">
              <SatelliteDish size={14} /> Live Intelligence Feed
            </div>
            <div className="flex items-center gap-1">
              <button
                className={`rounded p-1 ${sosSoundMuted ? "text-neutral-500 hover:text-neutral-100" : "text-ops-red"}`}
                onClick={toggleSosSound}
                title={sosSoundMuted ? "Unmute SOS sound" : "Mute SOS sound"}
              >
                <Bell size={15} />
              </button>
              <button className="rounded p-1 text-neutral-500 hover:text-neutral-100" onClick={() => setPanelOpen(false)}>
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <select className="min-w-[90px] flex-1 rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px]" value={filters.severity} onChange={(event) => setFilters({ ...filters, severity: event.target.value })}>
              <option value="">All Severities</option>
              <option value="RED">AMBER - Critical</option>
              <option value="ORANGE">ORANGE - Serious</option>
              <option value="YELLOW">TEAL - Moderate</option>
              <option value="BLUE">BLUE - Low</option>
            </select>
            <select className="min-w-[90px] flex-1 rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px]" value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value })}>
              <option value="">All Types</option>
              <option value="bombing">Bombing / IED</option>
              <option value="kidnapping">Kidnapping</option>
              <option value="massacre">Massacre</option>
              <option value="banditry">Banditry / Raid</option>
              <option value="terrorism">Terrorism</option>
              <option value="armed_attack">Armed Attack</option>
              <option value="displacement">Displacement</option>
            </select>
            <select className="min-w-[90px] flex-1 rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px]" value={filters.state} onChange={(event) => setFilters({ ...filters, state: event.target.value })}>
              <option value="">All States</option>
              {NIGERIAN_STATES.map((state) => (
                <option value={state} key={state}>
                  {state}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-neutral-500">
            <span>{visibleIncidents.length} incidents</span>
            <span>{incidentQuery.isFetching ? "Refreshing..." : "Live"}</span>
          </div>
        </div>

        <div className="scrollbar-thin flex-1 overflow-y-auto">
          {incidentQuery.isLoading ? (
            <div className="flex h-28 items-center justify-center gap-2 text-xs text-neutral-500">
              <RefreshCw size={14} className="animate-spin" /> Loading...
            </div>
          ) : visibleIncidents.length ? (
            visibleIncidents.map((incident) => (
              <article className="cursor-default border-b border-white/5 px-3.5 py-2.5 hover:bg-white/[0.04]" key={incident.id || `${incident.date}-${incident.title}`}>
                <div className="mb-1 flex items-start gap-2">
                  <i className={`fas ${iconForType(incident.type)} mt-0.5 text-xs`} style={{ color: severityColors[incident.severity] || "#aaa" }} />
                  <h3 className="flex-1 text-[11px] font-semibold leading-snug text-neutral-200">{incident.title || incident.type || "Incident"}</h3>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-neutral-500">
                  <span>{[incident.location, incident.state].filter(Boolean).join(", ") || "Nigeria"}</span>
                  <span className="ml-auto">{relativeDate(incident.date)}</span>
                </div>
                {incident.description ? <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-neutral-600">{incident.description}</p> : null}
              </article>
            ))
          ) : (
            <div className="flex h-56 flex-col items-center justify-center px-6 text-center text-xs text-neutral-600">
              <SatelliteDish size={28} className="mb-2" />
              No incidents match this period and filter set.
            </div>
          )}
        </div>

        <div className="border-t border-white/10 p-3.5">
          <button
            className="flex w-full items-center justify-center gap-2 rounded border border-ops-line bg-red-500/10 p-2 text-[10px] font-bold text-ops-red hover:bg-red-500/20 disabled:opacity-40"
            disabled={scrapeMutation.isPending}
            onClick={() => scrapeMutation.mutate()}
          >
            <RefreshCw size={13} className={scrapeMutation.isPending ? "animate-spin" : ""} />
            Trigger Manual Scrape
          </button>
        </div>
      </aside>

      <button
        className={`glass-panel absolute top-1/2 z-[1001] flex h-12 w-7 -translate-y-1/2 items-center justify-center rounded-l-md text-ops-red transition-[right] ${
          panelOpen ? "right-[380px]" : "right-0"
        }`}
        onClick={() => setPanelOpen(!panelOpen)}
      >
        {panelOpen ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>

      {activeSos.length ? (
        <section className="glass-panel absolute right-3 top-3 z-[1001] w-[300px] rounded-lg border-red-500/50">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
            <div className="flex items-center gap-2 text-[11px] font-bold text-red-400">
              <Siren size={14} /> SOS Alerts <span className="rounded-full bg-red-500 px-1.5 text-[9px] text-white">{activeSos.length}</span>
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {activeSos.map((alert) => (
              <div className="border-b border-white/5 px-3 py-2 text-[10px]" key={alert.sos_msg_id}>
                <div className="flex justify-between">
                  <strong className="text-red-300">{alert.dev_name || alert.device_name || `Device ${alert.device_id}`}</strong>
                  <span className="text-neutral-600">{relativeDate(alert.triggered_at)}</span>
                </div>
                <div className="mt-1 text-neutral-500">
                  {Number.isFinite(Number(alert.map_lat)) && Number.isFinite(Number(alert.map_lon))
                    ? `${Number(alert.map_lat).toFixed(5)}, ${Number(alert.map_lon).toFixed(5)}${alert.map_location_source === "device" ? " · latest device" : ""}`
                    : "Location unknown"}
                </div>
                <div className="mt-2 flex gap-2">
                  <button className="rounded border border-red-500/50 px-2 py-1 font-bold text-red-300" onClick={() => ackMutation.mutate(alert.sos_msg_id)}>
                    Ack
                  </button>
                  <button className="rounded border border-white/10 px-2 py-1 text-neutral-400" onClick={() => resolveMutation.mutate(alert.sos_msg_id)}>
                    Resolve
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section
        className={`glass-panel absolute bottom-3 z-[1000] min-w-[560px] rounded-lg px-3.5 py-2 transition-transform ${
          panelOpen ? "left-1/2 -translate-x-[calc(50%+190px)]" : "left-1/2 -translate-x-1/2"
        }`}
      >
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[11px] font-bold text-ops-red">{opsLabel}</span>
          <span className="text-[10px] text-neutral-500">{from || "All"} to {to || "present"}</span>
          <button className="text-neutral-600 hover:text-neutral-300" onClick={() => setStatsMinimized(!statsMinimized)}>
            {statsMinimized ? "▴" : "▾"}
          </button>
        </div>
        {!statsMinimized ? (
          <>
            <div className="grid grid-cols-6 border-b border-white/10 pb-2 text-center">
              <Metric value={devices.length} label="Total Devices" green />
              <Metric value={locations.length} label="Reporting" green />
              <Metric value={incidents.length} label="Incidents" />
              <Metric value={stats.states} label="States" />
              <Metric value={stats.killed} label="Killed" />
              <Metric value={stats.abducted} label="Abducted" />
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-white/10 py-2">
              <span className="text-[9px] font-bold uppercase tracking-wide text-neutral-600">Period</span>
              {modes.map(([mode, label]) => (
                <button className={`rounded border px-2 py-1 text-[10px] font-bold ${activeMode === mode ? "border-ops-red bg-ops-red text-black" : "border-white/10 bg-white/5 text-neutral-400 hover:border-ops-red hover:text-ops-red"}`} key={mode} onClick={() => setMode(mode)}>
                  {label}
                </button>
              ))}
              <input className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px]" type="date" value={from} onChange={(event) => setManualRange([event.target.value, to])} />
              <span className="text-neutral-600">→</span>
              <input className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px]" type="date" value={to} onChange={(event) => setManualRange([from, event.target.value])} />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
              <span className="text-[9px] font-bold uppercase tracking-wide text-neutral-600">Basemap</span>
              <select className="rounded border border-ops-line bg-white/5 px-2 py-1 text-[10px]" value={basemap} onChange={(event) => setBasemap(event.target.value)}>
                <option value="dark">Dark</option>
                <option value="streets">Streets</option>
                <option value="satellite">Satellite</option>
              </select>
              {Object.keys(LAYER_LABELS).map((key) => (
                <button className={`rounded border px-2 py-1 text-[10px] font-bold ${activeLayers[key] ? "border-ops-red bg-ops-red text-black" : "border-ops-line bg-red-500/10 text-ops-red"}`} key={key} onClick={() => setActiveLayers({ ...activeLayers, [key]: !activeLayers[key] })}>
                  {LAYER_LABELS[key]}
                </button>
              ))}
              <button
                className="rounded border border-ops-line bg-red-500/10 px-2 py-1 text-[10px] font-bold text-ops-red hover:bg-red-500/20 disabled:opacity-50"
                onClick={liveMode ? stopLiveMode : startLiveMode}
                disabled={!liveMode && !tourStops.length}
                title={tourStops.length ? `Tour ${tourStops.length} pins` : "No pins to tour"}
              >
                <Tv size={12} className="mr-1 inline" /> {liveMode ? "Exit Live" : "Live Mode"}
              </button>
              <button className="rounded border border-ops-line bg-red-500/10 px-2 py-1 text-[10px] font-bold text-ops-red hover:bg-red-500/20" onClick={() => downloadCSV(visibleIncidents)}>
                <Download size={12} className="mr-1 inline" /> Export CSV
              </button>
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}

function Metric({ value, label, green }) {
  return (
    <div>
      <div className={`text-[15px] font-bold ${green ? "text-ops-green" : "text-ops-red"}`}>{value}</div>
      <div className="mt-0.5 text-[8px] uppercase tracking-wide text-neutral-500">{label}</div>
    </div>
  );
}
