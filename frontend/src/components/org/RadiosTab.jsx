import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BatteryFull, BatteryLow, BatteryMedium, Check, Search } from "lucide-react";
import { useMemo, useState } from "react";
import {
  allocateRadioToOrganization,
  assignDeviceUnit,
  getLocations,
  listOrganizations,
  setOrgChannelDevice,
} from "../../lib/api";
import { RadioConsole } from "../RadioConsole";
import {
  Empty,
  FilterChips,
  List,
  PanelSection,
  SidePanel,
  SkeletonRows,
  plural,
  relativeAge,
  unitOptionLabel,
} from "./shared";

const LOW_BATTERY = 20;

const FILTERS = [
  { key: "all", label: "All" },
  { key: "online", label: "Online" },
  { key: "no-channel", label: "On no channel" },
  { key: "low-battery", label: "Low battery" },
];

function matchesFilter(device, filter) {
  if (filter === "online") return Boolean(device.pocstars_online);
  if (filter === "no-channel") return !(device.channels || []).length;
  if (filter === "low-battery") return device.battery_level != null && device.battery_level <= LOW_BATTERY;
  return true;
}

// Every radio this organization holds. A row opens the radio panel, which is
// where a radio is put on channels, given a unit, called or messaged.
export function RadiosTab({ ctx, devices, channels, units, loading }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [openId, setOpenId] = useState(null);

  const radios = useMemo(
    () => devices
      .filter((device) => device.active)
      .sort((a, b) =>
        Number(Boolean(b.pocstars_online)) - Number(Boolean(a.pocstars_online))
        || String(a.name || "").localeCompare(String(b.name || ""))),
    [devices],
  );
  const term = search.trim().toLowerCase();
  const shown = radios.filter((device) =>
    matchesFilter(device, filter)
    && (!term || `${device.name || ""} ${device.device_id} ${device.imei || ""}`.toLowerCase().includes(term)));
  const counts = useMemo(() => Object.fromEntries(
    FILTERS.map((option) => [option.key, radios.filter((device) => matchesFilter(device, option.key)).length]),
  ), [radios]);
  const open = radios.find((device) => String(device.device_id) === String(openId)) || null;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
          <Search size={14} className="text-neutral-500" />
          <input
            className="flex-1 bg-transparent text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
            placeholder="Find a radio by name, ID or IMEI"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <FilterChips
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((option) => ({ ...option, label: `${option.label} (${counts[option.key] ?? 0})` }))}
        />
      </div>

      <List title={loading ? "Loading radios…" : `${shown.length} of ${plural(radios.length, "radio")}`}>
        {loading ? <SkeletonRows /> : null}
        {!loading ? (
          <div className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1.6fr)_minmax(0,1fr)_90px_100px] gap-3 px-4 py-2 text-[10px] uppercase tracking-wide text-neutral-600 md:grid">
            <span>Radio</span>
            <span>Channels</span>
            <span>Unit</span>
            <span>Battery</span>
            <span>Last seen</span>
          </div>
        ) : null}
        {shown.map((device) => (
          <button
            type="button"
            key={device.device_id}
            onClick={() => setOpenId(device.device_id)}
            className="grid w-full grid-cols-1 gap-1 px-4 py-3 text-left text-[12px] transition hover:bg-white/[0.04] md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.6fr)_minmax(0,1fr)_90px_100px] md:items-center md:gap-3"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${device.pocstars_online ? "bg-ops-green" : "bg-neutral-600"}`} />
              <span className="truncate text-neutral-100">{device.name || `Radio ${device.device_id}`}</span>
              <span className="shrink-0 font-mono text-[10px] text-neutral-600">{device.device_id}</span>
            </span>
            <ChannelChips channels={device.channels} />
            <span className="truncate text-[11px] text-neutral-400">{device.unit_name || <span className="text-neutral-600">No unit</span>}</span>
            <Battery level={device.battery_level} />
            <span className="text-[11px] text-neutral-500">
              {device.pocstars_online ? "Online now" : relativeAge(device.pocstars_last_seen_at) || "Never"}
            </span>
          </button>
        ))}
        {!loading && !shown.length ? (
          <Empty>{radios.length ? "No radio matches." : "No radios yet. A platform admin gives radios to the organization."}</Empty>
        ) : null}
      </List>

      {open ? (
        <RadioPanel
          ctx={ctx}
          device={open}
          channels={channels}
          units={units}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </section>
  );
}

function ChannelChips({ channels = [] }) {
  if (!channels.length) return <span className="text-[11px] text-amber-300/80">On no channel</span>;
  const first = channels.slice(0, 2);
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {first.map((channel) => (
        <span key={channel.id} className="truncate rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-neutral-300">
          {channel.name}
        </span>
      ))}
      {channels.length > first.length ? (
        <span className="rounded-full px-1.5 py-0.5 text-[10px] text-neutral-500">+{channels.length - first.length}</span>
      ) : null}
    </span>
  );
}

function Battery({ level }) {
  if (level == null) return <span className="text-[11px] text-neutral-600">—</span>;
  const Icon = level > 60 ? BatteryFull : level > LOW_BATTERY ? BatteryMedium : BatteryLow;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${level <= LOW_BATTERY ? "text-ops-red" : "text-neutral-400"}`}>
      <Icon size={13} /> {level}%
    </span>
  );
}

// One radio, everything about it: where it is arranged (channels, unit, and for
// the platform which organization holds it), then its live console.
export function RadioPanel({ ctx, device, channels, units, onClose }) {
  const queryClient = useQueryClient();
  const live = channels.filter((channel) => channel.active && channel.provision_state !== "pending");
  const [memberOf, setMemberOf] = useState(() => new Set((device.channels || []).map((channel) => String(channel.id))));
  const [unitId, setUnitId] = useState(device.unit_id ? String(device.unit_id) : "");

  const locationsQuery = useQuery({ queryKey: ["locations"], queryFn: () => getLocations(), staleTime: 15_000 });
  const location = (locationsQuery.data?.data || []).find((row) => String(row.Uid) === String(device.device_id));

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ctx.orgKey });
    queryClient.invalidateQueries({ queryKey: ctx.channelsKey });
    queryClient.invalidateQueries({ queryKey: ["devices"] });
  };

  // The tick moves at once; a refusal from the radio network puts it back.
  const channelMutation = useMutation({
    mutationFn: ({ channelId, member }) => setOrgChannelDevice(channelId, device.device_id, member, ctx.orgId),
    onMutate: ({ channelId, member }) => {
      const previous = new Set(memberOf);
      const next = new Set(memberOf);
      if (member) next.add(String(channelId));
      else next.delete(String(channelId));
      setMemberOf(next);
      return { previous };
    },
    onError: (_error, _vars, context) => context?.previous && setMemberOf(context.previous),
    onSettled: refresh,
  });

  const unitMutation = useMutation({
    mutationFn: (next) => assignDeviceUnit(device.device_id, next || null, ctx.orgId),
    onMutate: (next) => {
      const previous = unitId;
      setUnitId(next);
      return { previous };
    },
    onError: (_error, _next, context) => setUnitId(context?.previous ?? ""),
    onSettled: refresh,
  });

  return (
    <SidePanel
      title={device.name || `Radio ${device.device_id}`}
      subtitle={`Radio ${device.device_id}${device.imei ? ` · IMEI ${device.imei}` : ""}`}
      onClose={onClose}
    >
      <PanelSection title="Channels">
        {live.length ? (
          <ul className="space-y-1">
            {live.map((channel) => {
              const checked = memberOf.has(String(channel.id));
              return (
                <li key={channel.id}>
                  <label className={`flex items-center gap-2 rounded px-2 py-1.5 text-[12px] ${ctx.canManage ? "cursor-pointer hover:bg-white/[0.04]" : ""}`}>
                    <input
                      type="checkbox"
                      className="accent-green-500"
                      checked={checked}
                      disabled={!ctx.canManage}
                      onChange={() => channelMutation.mutate({ channelId: channel.id, member: !checked })}
                    />
                    <span className="flex-1 text-neutral-200">{channel.name}</span>
                    <span className="text-[10px] text-neutral-600">{channel.unit_name ? `${channel.unit_name} only` : ""}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[11px] text-neutral-500">This organization has no live channels yet.</p>
        )}
        {channelMutation.error ? <p className="mt-2 text-[11px] text-ops-red">{channelMutation.error.message}</p> : null}
      </PanelSection>

      <PanelSection title="Unit">
        <select
          className="field-input"
          value={unitId}
          disabled={!ctx.canManage || unitMutation.isPending}
          onChange={(event) => unitMutation.mutate(event.target.value)}
        >
          <option value="">No unit</option>
          {units.map((unit) => <option key={unit.id} value={unit.id}>{unitOptionLabel(unit)}</option>)}
        </select>
        {unitMutation.error ? <p className="mt-2 text-[11px] text-ops-red">{unitMutation.error.message}</p> : null}
      </PanelSection>

      {ctx.platform ? <OwnerSection ctx={ctx} device={device} onMoved={() => { refresh(); onClose(); }} /> : null}

      {/* The console is laid out to fill a fixed-height card; in a scrolling
          panel it needs a floor of its own or it collapses to nothing. */}
      <div className="flex min-h-[560px] shrink-0 flex-col">
        <RadioConsole device={device} location={location} />
      </div>
    </SidePanel>
  );
}

// Platform only: which organization holds this handset. Moving it takes it off
// every channel of the old organization; the new one arranges it from there.
function OwnerSection({ ctx, device, onMoved }) {
  const [target, setTarget] = useState(String(device.organization_id ?? ""));
  const orgsQuery = useQuery({ queryKey: ["organizations"], queryFn: listOrganizations, staleTime: 60_000 });
  const organizations = (orgsQuery.data?.organizations || [])
    .filter((org) => org.status !== "discovered" || String(org.id) === String(device.organization_id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const changed = target !== String(device.organization_id ?? "");
  const moveMutation = useMutation({
    mutationFn: () => allocateRadioToOrganization(device.device_id, target ? Number(target) : null, []),
    onSuccess: onMoved,
  });
  const targetName = organizations.find((org) => String(org.id) === target)?.name;

  return (
    <PanelSection title="Organization">
      <div className="flex gap-2">
        <select
          className="field-input flex-1"
          value={target}
          disabled={!ctx.canWrite || moveMutation.isPending}
          onChange={(event) => setTarget(event.target.value)}
        >
          <option value="">Unallocated (pool)</option>
          {organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
        </select>
        {changed ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md bg-ops-green px-3 text-[11px] font-bold text-black hover:opacity-85 disabled:opacity-50"
            disabled={moveMutation.isPending}
            onClick={() => {
              if (window.confirm(`Move ${device.name || device.device_id} to ${targetName || "the pool"}? It leaves all of its current channels.`)) {
                moveMutation.mutate();
              }
            }}
          >
            <Check size={12} /> {moveMutation.isPending ? "Moving…" : "Move"}
          </button>
        ) : null}
      </div>
      {moveMutation.error ? <p className="mt-2 text-[11px] text-ops-red">{moveMutation.error.message}</p> : null}
    </PanelSection>
  );
}
