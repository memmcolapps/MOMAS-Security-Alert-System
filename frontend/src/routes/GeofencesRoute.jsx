import L from "leaflet";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MapPinned, Minus, MousePointerClick, Plus, Save, Search, Spline, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LEVEL_STYLES } from "../lib/alarm-levels";
import { deleteGeofence, getDronePositions, getGeofenceTargets, getLocations, getMe, listGeofences, listOrganizations, previewGeofence, saveGeofence } from "../lib/api";
import { circleAroundAssets, formatDistance, grownRing, polygonSelfIntersects, simplifyRing } from "../lib/fence-placement";
import { isPlatformOperator, isPlatformStaff } from "../lib/platform-roles";
import { AROUND_MARGIN_M, EMPTY_ZONE, LEVEL_RANK, MAX_STEP_M, expandRule, hasTarget, isPlaced, newRule, toForm, useSettled, useTargetIndex, zonePayload } from "../components/geofences/zone-model";
import { ZoneMap } from "../components/geofences/ZoneMap";
import { DEFAULT_RADIUS, MARGINS, MAX_RADIUS_M, PlaceSearch, SIZES, WherePicker } from "../components/geofences/WherePicker";
import { RuleCard } from "../components/geofences/RuleCard";
import { ZoneCard, zoneSummary } from "../components/geofences/ZoneCard";

export function GeofencesRoute() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [zone, setZone] = useState(EMPTY_ZONE);
  const [rules, setRules] = useState([]);
  const [focusKey, setFocusKey] = useState(null);
  const [drawing, setDrawing] = useState(false);
  const [drawMode, setDrawMode] = useState("tap");
  // What the area was made from: a place's name, and its own border while that
  // is still what's on the map, so Bigger and Smaller can work from it.
  const [area, setArea] = useState(null);
  const [quiet, setQuiet] = useState(true);
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [basemap, setBasemap] = useState("satellite");
  const [fitToken, setFitToken] = useState(null);
  const [filter, setFilter] = useState("");
  const fittedRef = useRef(false);

  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const user = meQuery.data?.user;
  const isAdmin = isPlatformStaff(user);
  const membership = user?.active_membership || user?.memberships?.[0];
  const canManage = isPlatformOperator(user) || ["org_owner", "org_admin", "unit_admin", "admin"].includes(membership?.role);

  const zonesQuery = useQuery({ queryKey: ["geofences"], queryFn: listGeofences, refetchInterval: 30_000 });
  const organizationsQuery = useQuery({ queryKey: ["organizations"], queryFn: listOrganizations, enabled: isAdmin });
  const organizations = organizationsQuery.data?.organizations || [];
  const orgId = zone.organization_id || String(membership?.organization_id || "");

  const zones = useMemo(() => zonesQuery.data?.zones || [], [zonesQuery.data]);

  // Staff see zones from many organizations, so names are loaded for each of
  // them; everyone else has one organization and this is a single request.
  const targetOrgs = useMemo(() => {
    const ids = new Set(orgId ? [orgId] : []);
    if (isAdmin) zones.forEach((item) => ids.add(String(item.organization_id)));
    return [...ids];
  }, [orgId, isAdmin, zones]);
  const targetQueries = useQueries({
    queries: (targetOrgs.length || isAdmin ? targetOrgs : [""]).map((id) => ({
      queryKey: ["geofence-targets", id],
      queryFn: () => getGeofenceTargets(id),
      staleTime: 60_000,
    })),
  });
  const targetsData = targetQueries.map((query) => query.data);
  const targetsKey = targetsData.map((data) => (data ? 1 : 0)).join("") + targetQueries.map((query) => query.dataUpdatedAt).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allTargets = useMemo(() => targetsData.filter(Boolean), [targetsKey]);
  const targets = targetQueries[targetOrgs.indexOf(orgId)]?.data || (!isAdmin ? targetQueries[0]?.data : null);
  const index = useTargetIndex(allTargets);

  // Radios report every 3 s; this map refreshes their positions every 5 s.
  const radiosQuery = useQuery({ queryKey: ["locations"], queryFn: () => getLocations(), refetchInterval: 5_000 });
  const dronesQuery = useQuery({ queryKey: ["drone-positions"], queryFn: getDronePositions, refetchInterval: 10_000 });

  const positions = useMemo(() => {
    const map = new Map();
    for (const row of radiosQuery.data?.data || []) {
      const lat = Number(row.Lat);
      const lon = Number(row.Lng ?? row.Lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
      map.set(`radio:${row.Uid}`, { lat, lon });
    }
    for (const drone of dronesQuery.data?.drones || []) {
      const lat = Number(drone.lat);
      const lon = Number(drone.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
      map.set(`drone:${drone.sysid}`, { lat, lon });
    }
    return map;
  }, [radiosQuery.data, dronesQuery.data]);

  // Only this organization's radios, once we know which those are.
  const radios = useMemo(() => {
    const source = editing ? (targets ? [targets] : []) : allTargets;
    const known = source.length ? new Set(source.flatMap((item) => (item.radios || []).map((radio) => `radio:${radio.device_id}`))) : null;
    const list = [];
    for (const [key, position] of positions) {
      if (!key.startsWith("radio:")) continue;
      if (known && !known.has(key)) continue;
      list.push({ key, id: key.slice(6), name: index.names.get(key) || `Radio ${key.slice(6)}`, ...position });
    }
    return list;
  }, [positions, targets, allTargets, editing, index]);

  // Everyone the rules being edited watch.
  const highlighted = useMemo(() => {
    const keys = new Set();
    if (!editing) return keys;
    for (const rule of rules) {
      for (const target of rule.targets) {
        for (const key of index.members.get(`${target.target_type}:${target.target_id}`) || []) keys.add(key);
      }
    }
    return keys;
  }, [editing, rules, index]);

  const placed = isPlaced(zone);
  const crossed = zone.shape_type === "polygon" && zone.points.length >= 4 && polygonSelfIntersects(zone.points);
  const expanded = useMemo(() => rules.flatMap(expandRule), [rules]);

  const previewInput = useSettled(
    editing && placed && !crossed && !drawing && expanded.length && orgId
      ? JSON.stringify({ organization_id: Number(orgId), ...zonePayload(zone), rules: expanded.map((item) => item.payload) })
      : null,
    300,
  );
  const previewQuery = useQuery({
    queryKey: ["geofence-preview", previewInput],
    queryFn: () => previewGeofence(JSON.parse(previewInput)),
    enabled: Boolean(previewInput),
    staleTime: 5_000,
    placeholderData: (previous) => previous,
  });
  // The server answers per stored rule; each card shows the union of its own,
  // one entry per radio even when a radio is picked and also in a chosen unit.
  const previewFor = previewInput;
  const verdictByKey = useMemo(() => {
    const map = new Map();
    const answers = previewQuery.data?.rules;
    if (!answers) return map;
    const sent = previewFor ? JSON.parse(previewFor).rules : [];
    const cardOf = new Map(expanded.map((item) => [JSON.stringify(item.payload), item]));
    sent.forEach((payload, i) => {
      const item = cardOf.get(JSON.stringify(payload));
      if (!item || !answers[i]) return;
      const entry = map.get(item.cardKey) || { members: new Map(), freshBreach: new Set() };
      for (const member of answers[i].members) {
        const key = `${member.asset_type}:${member.asset_id}`;
        const known = entry.members.get(key);
        // A radio past several steps is shown at the loudest one it is past.
        const louder = member.state === "breach" && (known?.state !== "breach" || LEVEL_RANK[item.level] > LEVEL_RANK[known.level]);
        if (!known || louder) entry.members.set(key, member.state === "breach" ? { ...member, level: item.level } : member);
        if (item.fresh && member.state === "breach") entry.freshBreach.add(key);
      }
      map.set(item.cardKey, entry);
    });
    for (const [key, entry] of map) {
      const members = [...entry.members.values()];
      map.set(key, {
        members,
        freshBreach: entry.freshBreach.size,
        summary: {
          total: members.length,
          ok: members.filter((m) => m.state === "ok").length,
          breach: members.filter((m) => m.state === "breach").length,
          unknown: members.filter((m) => m.state === "unknown").length,
        },
      });
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewQuery.data]);

  const focusRule = rules.find((rule) => rule.key === focusKey) || rules[0] || null;

  // Coloured dots: the server's verdict for the focused rule, else just "watched".
  const members = useMemo(() => {
    const map = new Map();
    if (!editing) return map;
    const verdict = focusRule ? verdictByKey.get(focusRule.key) : null;
    if (verdict && placed) {
      for (const member of verdict.members) {
        const breachWord = focusRule.trigger === "exit" ? "outside" : "too close";
        const okWord = focusRule.trigger === "exit" ? "inside" : "clear";
        map.set(`${member.asset_type}:${member.asset_id}`, {
          ...member,
          label:
            member.state === "breach"
              ? `${breachWord} · ${LEVEL_STYLES[member.level]?.label || "alarm"}`
              : member.state === "ok" ? okWord : "not reporting",
        });
      }
      return map;
    }
    for (const key of highlighted) {
      const position = positions.get(key);
      if (position) map.set(key, { ...position, name: index.names.get(key) || key, state: "pending", label: "watched" });
    }
    return map;
  }, [editing, focusRule, verdictByKey, placed, highlighted, positions, index]);

  // Only new or changed rules are affected by "don't alarm": the rest keep
  // their state, and anyone in breach on them has already alarmed.
  const breachTotal = [...verdictByKey.values()].reduce((sum, verdict) => sum + verdict.freshBreach, 0);

  // First load: frame the zones and radios, so the map opens where the work is.
  useEffect(() => {
    if (fittedRef.current || !zonesQuery.isSuccess || !radiosQuery.isSuccess) return;
    fittedRef.current = true;
    const points = [...radios.map((radio) => [radio.lat, radio.lon])];
    for (const other of zones) {
      if (other.shape_type === "circle") points.push([Number(other.center_lat), Number(other.center_lon)]);
      else for (const [lon, lat] of other.geometry?.coordinates?.[0] || []) points.push([lat, lon]);
    }
    if (points.length) setFitToken({ bounds: L.latLngBounds(points).pad(0.1), key: Date.now() });
  }, [zonesQuery.isSuccess, radiosQuery.isSuccess, radios, zones]);

  const fitTo = useCallback((points, pad = 0.4) => {
    if (!points.length) return;
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon]));
    // One radio, or a tight cluster: show its neighbourhood rather than rooftops.
    const small = bounds.getSouthWest().distanceTo(bounds.getNorthEast()) < 600;
    setFitToken({ bounds: small ? bounds.getCenter().toBounds(1200) : bounds.pad(pad), key: Date.now() });
  }, []);

  // With no zone drawn yet, the map follows whoever has been picked.
  const highlightedKey = [...highlighted].sort().join(",");
  useEffect(() => {
    if (!editing || isPlaced(zone) || !highlightedKey) return;
    fitTo(highlightedKey.split(",").map((key) => positions.get(key)).filter(Boolean));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedKey]);

  function focusZone(target) {
    if (target.shape_type === "circle") {
      const centre = L.latLng(Number(target.center_lat), Number(target.center_lon));
      setFitToken({ bounds: centre.toBounds(Number(target.radius_m) * 2.6), key: Date.now() });
      return;
    }
    fitTo((target.geometry?.coordinates?.[0] || target.points || []).map(([lon, lat]) => ({ lat, lon })), 0.3);
  }

  function openEditor(nextZone, nextRules) {
    setZone(nextZone);
    setRules(nextRules);
    setFocusKey(nextRules[0]?.key || null);
    setDrawing(nextZone.shape_type === "polygon" && nextZone.points.length < 3);
    setDrawMode("tap");
    setArea(null);
    setQuiet(true);
    setError(null);
    setFeedback(null);
    setEditing(true);
  }

  function closeEditor() {
    setEditing(false);
    setDrawing(false);
    setZone(EMPTY_ZONE);
    setRules([]);
    setError(null);
  }

  function startNew() {
    const org = String(membership?.organization_id || organizations[0]?.id || "");
    openEditor({ ...EMPTY_ZONE, organization_id: org }, [newRule()]);
    // Open where this organization's people are, not over the whole country.
    const own = targetQueries[targetOrgs.indexOf(org)]?.data?.radios;
    const keys = own ? new Set(own.map((radio) => `radio:${radio.device_id}`)) : null;
    const points = radios.filter((radio) => !keys || keys.has(radio.key));
    if (points.length) fitTo(points, 0.3);
  }

  function startEdit(target) {
    const form = toForm(target);
    openEditor(form.zone, form.rules.length ? form.rules : [newRule()]);
    focusZone(target);
  }

  /** From a radio on the map: a circle round it and a rule already pointing at it. */
  function startFromRadio(radio, trigger) {
    const org = String(membership?.organization_id || organizations[0]?.id || "");
    const rule = newRule({ targets: [{ target_type: "radio", target_id: radio.id }], trigger });
    openEditor(
      {
        ...EMPTY_ZONE,
        organization_id: org,
        name: trigger === "exit" ? `${radio.name} area` : "",
        center_lat: radio.lat,
        center_lon: radio.lon,
        radius_m: trigger === "exit" ? SIZES[2].radius : DEFAULT_RADIUS,
      },
      [rule],
    );
    setFitToken({ bounds: L.latLng(radio.lat, radio.lon).toBounds(1500), key: Date.now() });
  }

  function onRadioAction(radio, action) {
    // Adds the radio to the rule being worked on, or takes it out again.
    if (action === "watch") {
      const card = focusRule || rules[0];
      if (card) toggleTarget(card.key, "radio", radio.id);
      else setRules([newRule({ targets: [{ target_type: "radio", target_id: radio.id }] })]);
      return;
    }
    if (canManage) startFromRadio(radio, action);
  }

  function updateZone(patch) {
    setError(null);
    setZone((current) => ({ ...current, ...patch }));
  }

  function updateRule(key, patch) {
    setError(null);
    setRules((current) => current.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)));
  }

  function toggleTarget(key, type, id) {
    setError(null);
    setRules((current) =>
      current.map((rule) => {
        if (rule.key !== key) return rule;
        return hasTarget(rule, type, id)
          ? { ...rule, targets: rule.targets.filter((t) => !(t.target_type === type && String(t.target_id) === String(id))) }
          : { ...rule, targets: [...rule.targets, { target_type: type, target_id: String(id) }] };
      }),
    );
  }

  /** A pick from "Where is the place?": a real border, or a point that gets a circle. */
  function placeArea(choice) {
    const name = zone.name.trim() || !choice.label ? {} : { name: choice.label };
    setDrawing(false);
    if (choice.kind === "border") {
      setArea({ label: choice.label, border: choice.points, margin: 0 });
      updateZone({ shape_type: "polygon", points: choice.points, center_lat: null, center_lon: null, ...name });
      fitTo(choice.points.map(([lon, lat]) => ({ lat, lon })), 0.2);
      return;
    }
    setArea({ label: choice.label });
    updateZone({ shape_type: "circle", points: [], center_lat: choice.lat, center_lon: choice.lon, radius_m: choice.radius, ...name });
    setFitToken({ bounds: L.latLng(choice.lat, choice.lon).toBounds(choice.radius * 2.8), key: Date.now() });
  }

  /** Back to the question, with nothing on the map. */
  function changePlace() {
    setArea(null);
    setDrawing(false);
    updateZone({ shape_type: "circle", points: [], center_lat: null, center_lon: null, radius_m: DEFAULT_RADIUS });
  }

  function startDrawing() {
    setArea(null);
    setDrawMode("tap");
    updateZone({ shape_type: "polygon", points: [], center_lat: null, center_lon: null });
    setDrawing(true);
  }

  /** A finished finger trace becomes a shape with a sensible number of corners. */
  function finishTrace(points) {
    const ring = simplifyRing(points, 40);
    if (!ring || ring.length < 3) return;
    updateZone({ points: ring });
    setDrawing(false);
  }

  /** Pushes a place's own border out by a margin; Smaller steps back towards it. */
  function stepMargin(direction) {
    if (!area?.border) return;
    const at = MARGINS.indexOf(area.margin);
    const margin = MARGINS[Math.min(MARGINS.length - 1, Math.max(0, at + direction))];
    const ring = margin ? grownRing(area.border, margin) : area.border;
    if (!ring) return;
    setArea({ ...area, margin });
    updateZone({ points: margin ? simplifyRing(ring, 120) : ring });
  }

  /** Shape changes from the map. Moving a corner by hand ends Bigger/Smaller. */
  function shapeChangedOnMap(patch) {
    if (patch.points && area?.border) setArea({ label: area.label });
    updateZone(patch);
  }

  /** Draws the zone round where the watched people are right now. */
  function drawAround() {
    const points = [...highlighted].map((key) => positions.get(key)).filter(Boolean);
    if (!points.length) {
      setError("None of the chosen radios are reporting a position right now.");
      return;
    }
    setArea({ label: "" });
    updateZone({ shape_type: "circle", points: [], ...circleAroundAssets(points, AROUND_MARGIN_M) });
    setDrawing(false);
    fitTo(points);
  }

  const saveMutation = useMutation({
    mutationFn: saveGeofence,
    onSuccess: async (data) => {
      const quieted = Number(data?.quieted) || 0;
      setFeedback(
        quieted
          ? `Zone saved. ${quieted} already on the wrong side ${quieted === 1 ? "was" : "were"} recorded without an alarm.`
          : "Zone saved. Monitoring is on.",
      );
      closeEditor();
      await queryClient.invalidateQueries({ queryKey: ["geofences"] });
    },
    onError: (err) => setError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteGeofence,
    // Gone from the list at once; put back if the server refuses.
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["geofences"] });
      const previous = queryClient.getQueryData(["geofences"]);
      queryClient.setQueryData(["geofences"], (current) =>
        current ? { ...current, zones: current.zones.filter((item) => Number(item.id) !== Number(id)) } : current,
      );
      return { previous };
    },
    onError: (err, _id, context) => {
      if (context?.previous) queryClient.setQueryData(["geofences"], context.previous);
      setFeedback(err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["geofences"] }),
  });

  function submit(event) {
    event.preventDefault();
    if (!zone.name.trim()) return setError("Give the zone a name.");
    if (!placed) return setError(zone.shape_type === "circle" ? "Draw the circle on the map." : "Finish the shape on the map: at least three corners.");
    if (drawing) return setError("Close the shape: click its first corner, or press Done.");
    if (crossed) return setError("The shape crosses over itself. Drag a corner to untangle it.");
    if (rules.length > 1 && rules.some((rule) => !rule.targets.length)) return setError("A rule has no radios. Choose some, or remove it.");
    const outOfOrder = rules.some((rule) => rule.steps.some((step, i) => i && !(Number(step.distance_m) > Number(rule.steps[i - 1].distance_m))));
    if (outOfOrder) return setError("Each step has to be further from the edge than the one before.");
    if (rules.some((rule) => rule.steps.some((step) => Number(step.distance_m) > MAX_STEP_M))) return setError(`Steps can be at most ${formatDistance(MAX_STEP_M)} from the edge.`);
    if (!orgId) return setError("Choose an organization.");
    saveMutation.mutate({
      id: zone.id,
      organization_id: Number(orgId),
      ...zonePayload(zone),
      rules: expanded.map((item) => item.payload),
      quiet,
    });
  }

  const place = previewQuery.data?.place;
  const summary = zoneSummary(zone, placed && !drawing, area?.label || place?.label, radios);
  const visibleZones = filter.trim()
    ? zones.filter((item) => item.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : zones;

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-ops-bg pt-[var(--ops-chrome)] text-neutral-200">
      <div className="flex min-h-0 flex-1 flex-col-reverse xl:flex-row">
        <aside className="flex min-h-0 flex-1 flex-col border-white/10 xl:w-[380px] xl:flex-none xl:border-r">
          {editing ? (
            <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
              <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
                <button
                  aria-label="Back to zones"
                  className="rounded p-1 text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
                  onClick={closeEditor}
                  type="button"
                >
                  <ArrowLeft size={15} />
                </button>
                <h1 className="text-[12px] font-bold text-neutral-100">{zone.id ? "Edit zone" : "New zone"}</h1>
              </header>

              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
                {isAdmin && !zone.id ? (
                  <select
                    aria-label="Organization"
                    className="field-input"
                    onChange={(event) => {
                      updateZone({ organization_id: event.target.value });
                      setRules([newRule()]);
                    }}
                    value={orgId}
                  >
                    <option value="">Choose organization</option>
                    {organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
                  </select>
                ) : null}

                {!placed && !drawing ? (
                  <WherePicker
                    aroundCount={highlighted.size}
                    onAround={drawAround}
                    onDraw={startDrawing}
                    onPlace={placeArea}
                    radios={radios}
                  />
                ) : (
                  <>
                    <section>
                      <div className="mb-2 flex items-center justify-between">
                        <h2 className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">Area</h2>
                        <button
                          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-bold text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
                          onClick={changePlace}
                          type="button"
                        >
                          <ArrowLeft size={11} /> Change place
                        </button>
                      </div>

                      {drawing ? (
                        <>
                          <div className="grid grid-cols-2 gap-1 rounded-md bg-black/30 p-0.5">
                            {[["tap", MousePointerClick, "Tap corners"], ["trace", Spline, "Trace with finger"]].map(([mode, Icon, label]) => (
                              <button
                                className={`inline-flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[10px] font-bold transition-colors ${drawMode === mode ? "bg-white/[0.12] text-neutral-100 shadow-sm" : "text-neutral-500 hover:text-neutral-300"}`}
                                key={mode}
                                onClick={() => {
                                  setDrawMode(mode);
                                  updateZone({ points: [] });
                                }}
                                type="button"
                              >
                                <Icon size={12} /> {label}
                              </button>
                            ))}
                          </div>
                          <p className="mt-2 rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-2 text-[10px] leading-relaxed text-neutral-400">
                            {drawMode === "trace"
                              ? "Press on the map and draw all the way round the area, then let go. Zoom with the + and − buttons."
                              : `Tap the map at each corner (${zone.points.length} so far). Tap the first corner, or press Done, to close it.`}
                          </p>
                          {drawMode === "tap" && zone.points.length ? (
                            <div className="mt-2 flex gap-2">
                              <button
                                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-white/10 px-3 py-2 text-[10px] font-bold text-neutral-300 hover:bg-white/5"
                                onClick={() => updateZone({ points: zone.points.slice(0, -1) })}
                                type="button"
                              >
                                <Undo2 size={12} /> Undo last corner
                              </button>
                              {zone.points.length >= 3 ? (
                                <button
                                  className="flex-1 rounded-md bg-red-400 px-3 py-2 text-[10px] font-bold text-black hover:opacity-90"
                                  onClick={() => setDrawing(false)}
                                  type="button"
                                >
                                  Done
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </>
                      ) : zone.shape_type === "circle" ? (
                        <>
                          <p className="mb-1.5 text-[11px] font-bold text-neutral-200">How big?</p>
                          <div className="flex flex-wrap gap-1">
                            {SIZES.map((size) => (
                              <button
                                className={`rounded-full border px-2.5 py-1.5 text-[10px] font-bold transition-colors ${Number(zone.radius_m) === size.radius ? "border-red-400 bg-red-400 text-black" : "border-white/10 text-neutral-300 hover:border-white/25 hover:text-neutral-100"}`}
                                key={size.label}
                                onClick={() => {
                                  updateZone({ radius_m: size.radius });
                                  setFitToken({ bounds: L.latLng(zone.center_lat, zone.center_lon).toBounds(size.radius * 2.8), key: Date.now() });
                                }}
                                type="button"
                              >
                                {size.label} <span className="font-normal opacity-70">{formatDistance(size.radius)}</span>
                              </button>
                            ))}
                          </div>
                          {/* Same as an alarm step: type the metres, and the words say what they are measured from. */}
                          <div className="mt-2 flex items-center gap-1.5 text-[10px] text-neutral-400">
                            <span>Radius</span>
                            <input
                              aria-label="Radius in metres"
                              className="field-input w-24 py-1 text-[10px]"
                              max={MAX_RADIUS_M}
                              min="1"
                              onChange={(event) => updateZone({ radius_m: event.target.value === "" ? "" : Math.min(MAX_RADIUS_M, Math.max(0, Number(event.target.value))) })}
                              type="number"
                              value={zone.radius_m === "" ? "" : Math.round(Number(zone.radius_m))}
                            />
                            <span>m from the centre</span>
                          </div>
                          <p className="mt-1.5 text-[10px] text-neutral-500">Or drag the red dot on the map. Drag the white dot to move it.</p>
                        </>
                      ) : (
                        <>
                          {area?.border ? (
                            <div className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-2">
                              <span className="min-w-0 flex-1 text-[11px] text-neutral-300">
                                Border of <span className="font-bold text-neutral-100">{area.label}</span>
                                {area.margin ? <span className="text-neutral-500"> + {formatDistance(area.margin)}</span> : null}
                              </span>
                              <button
                                aria-label="Smaller"
                                className="rounded-md border border-white/10 p-1.5 text-neutral-300 hover:bg-white/5 disabled:opacity-30"
                                disabled={!area.margin}
                                onClick={() => stepMargin(-1)}
                                title="Smaller"
                                type="button"
                              >
                                <Minus size={12} />
                              </button>
                              <button
                                aria-label="Bigger"
                                className="rounded-md border border-white/10 p-1.5 text-neutral-300 hover:bg-white/5 disabled:opacity-30"
                                disabled={area.margin === MARGINS[MARGINS.length - 1]}
                                onClick={() => stepMargin(1)}
                                title="Bigger"
                                type="button"
                              >
                                <Plus size={12} />
                              </button>
                            </div>
                          ) : null}
                          <p className="mt-2 text-[10px] leading-relaxed text-neutral-500">
                            Drag a corner to move it. Drag an edge dot to add a corner. Double-click a corner to remove it.
                          </p>
                        </>
                      )}
                    </section>

                    <section>
                      <input
                        aria-label="Zone name"
                        className="field-input text-[12px] font-bold"
                        onChange={(event) => updateZone({ name: event.target.value })}
                        placeholder="Zone name, e.g. Kaduna base"
                        value={zone.name}
                      />
                    </section>

                    <section>
                      <h2 className="mb-2 text-[10px] font-bold uppercase tracking-wide text-neutral-500">Radios to watch</h2>
                      <div className="space-y-2">
                        {rules.map((rule) => (
                          <RuleCard
                            focused={focusRule?.key === rule.key}
                            index={index}
                            key={rule.key}
                            onChange={(patch) => updateRule(rule.key, patch)}
                            onFocus={() => setFocusKey(rule.key)}
                            onRemove={() => setRules((current) => current.filter((item) => item.key !== rule.key))}
                            onToggle={(type, id) => toggleTarget(rule.key, type, id)}
                            removable={rules.length > 1}
                            rule={rule}
                            targets={targets}
                            verdict={verdictByKey.get(rule.key)}
                          />
                        ))}
                      </div>
                      <button
                        className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-white/15 px-3 py-2 text-[10px] font-bold text-neutral-400 hover:border-white/30 hover:text-neutral-200"
                        onClick={() => {
                          const rule = newRule();
                          setRules((current) => [...current, rule]);
                          setFocusKey(rule.key);
                        }}
                        type="button"
                      >
                        <Plus size={12} /> Add radios with a different alarm
                      </button>
                      <p className="mt-1.5 text-[9px] text-neutral-600">Tip: click radios on the map to add or remove them.</p>
                    </section>
                  </>
                )}
              </div>

              {!placed && !drawing ? null : (
              <footer className="border-t border-white/10 bg-black/40 p-3">
                {summary ? <p className="mb-2 text-[11px] leading-relaxed text-neutral-300">{summary}</p> : null}
                {error ? (
                  <p className="mb-2 rounded border border-red-400/25 bg-red-500/[0.07] px-2 py-1.5 text-[10px] text-red-200">{error}</p>
                ) : null}
                {breachTotal ? (
                  <label className="mb-2 flex cursor-pointer items-start gap-2 rounded border border-amber-400/25 bg-amber-400/[0.06] p-2 text-[10px] text-amber-200">
                    <input checked={quiet} className="mt-0.5" onChange={(event) => setQuiet(event.target.checked)} type="checkbox" />
                    <span>
                      Don&apos;t alarm for the {breachTotal} already on the wrong side.
                      <span className="mt-0.5 block text-amber-100/60">They alarm normally the next time they cross.</span>
                    </span>
                  </label>
                ) : null}
                {!expanded.length ? <p className="mb-2 text-[10px] text-neutral-500">No one is watched yet. The zone will be saved without alarms.</p> : null}
                <button
                  className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-red-400 px-4 py-2.5 text-xs font-bold text-black transition-opacity hover:opacity-90 active:opacity-80 disabled:opacity-40"
                  disabled={saveMutation.isPending}
                  type="submit"
                >
                  <Save size={14} /> {saveMutation.isPending ? "Saving…" : "Save zone"}
                </button>
              </footer>
              )}
            </form>
          ) : (
            <>
              <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
                <MapPinned className="text-red-400" size={16} />
                <h1 className="text-[12px] font-bold text-neutral-100">Geofences</h1>
                <span className="text-[10px] text-neutral-600">{zones.length}</span>
                {canManage ? (
                  <button
                    className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-red-400 px-2.5 py-1.5 text-[10px] font-bold text-black hover:opacity-90 active:opacity-80"
                    onClick={startNew}
                    type="button"
                  >
                    <Plus size={12} /> New zone
                  </button>
                ) : null}
              </header>

              {feedback ? (
                <div className="flex items-start gap-2 border-b border-green-400/25 bg-green-400/[0.07] px-3 py-2 text-[10px] text-green-200" role="status">
                  <span className="flex-1">{feedback}</span>
                  <button aria-label="Dismiss" className="opacity-60 hover:opacity-100" onClick={() => setFeedback(null)} type="button">
                    <X size={12} />
                  </button>
                </div>
              ) : null}

              {zones.length > 6 ? (
                <div className="relative border-b border-white/10 px-3 py-2">
                  <Search className="absolute left-[22px] top-1/2 -translate-y-1/2 text-neutral-600" size={12} />
                  <input
                    aria-label="Filter zones"
                    className="field-input pl-8"
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="Filter zones"
                    value={filter}
                  />
                </div>
              ) : null}

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                {zonesQuery.isLoading
                  ? [0, 1, 2].map((n) => <div className="h-20 animate-pulse rounded-lg bg-white/[0.03]" key={n} />)
                  : null}
                {visibleZones.map((item) => (
                  <ZoneCard
                    canManage={canManage}
                    index={index}
                    key={item.id}
                    onDelete={() =>
                      window.confirm(`Delete ${item.name}? Its alarms stop.`) &&
                      deleteMutation.mutate(item.id)
                    }
                    onEdit={() => startEdit(item)}
                    onFocus={() => focusZone(item)}
                    zone={item}
                  />
                ))}
                {zonesQuery.isSuccess && !visibleZones.length ? (
                  <div className="rounded-lg border border-white/10 p-6 text-center">
                    <p className="text-xs font-bold text-neutral-300">{zones.length ? "No zones match." : "No zones yet"}</p>
                    {!zones.length ? (
                      <p className="mt-1 text-[10px] leading-relaxed text-neutral-500">
                        Draw one with New zone, or click a radio on the map to start from it.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </aside>

        <section className="relative h-[45vh] shrink-0 overflow-hidden xl:h-auto xl:flex-1">
          <ZoneMap
            basemap={basemap}
            drawing={drawing}
            editing={editing}
            fitToken={fitToken}
            cards={rules}
            highlighted={highlighted}
            members={members}
            onAddPoint={(point) => updateZone({ points: [...zone.points, point] })}
            onBasemapChange={setBasemap}
            onFinishPolygon={() => setDrawing(false)}
            onRadioAction={onRadioAction}
            onShapeChange={shapeChangedOnMap}
            onTrace={finishTrace}
            radios={radios}
            tracing={editing && drawing && drawMode === "trace"}
            zone={zone}
            zones={zones}
          />
          {editing ? null : <PlaceSearch onPick={(place) => setFitToken({ centre: { lat: place.lat, lon: place.lon }, zoom: 13, key: Date.now() })} />}
        </section>
      </div>
    </main>
  );
}
