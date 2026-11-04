import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Headphones, Plus, Search, Square, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  createOrgChannel,
  deleteOrgChannel,
  listOrgChannelDevices,
  setOrgChannelDevice,
  updateOrgChannel,
} from "../../lib/api";
import { useLiveRadioSession } from "../../lib/live-radio-session";
import { Empty, Field, List, PanelSection, SidePanel, SkeletonRows, plural } from "./shared";

// Channels are the organization's talk groups: the radios on one hear each
// other. A row opens the channel panel, the one place its radios are picked.
export function ChannelsTab({ ctx, channels, devices, units, loading }) {
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const open = channels.find((channel) => String(channel.id) === String(openId)) || null;
  const sorted = useMemo(
    () => [...channels].sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || a.name.localeCompare(b.name)),
    [channels],
  );

  return (
    <section className="space-y-4">
      {creating ? <NewChannelForm ctx={ctx} units={units} onDone={() => setCreating(false)} /> : null}

      <List
        title={loading ? "Loading channels…" : plural(channels.filter((channel) => channel.active).length, "channel")}
        action={ctx.canManage && !creating ? (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-ops-red px-3 py-1.5 text-[11px] font-bold text-black hover:opacity-85"
            onClick={() => setCreating(true)}
          >
            <Plus size={12} /> New channel
          </button>
        ) : null}
      >
        {loading ? <SkeletonRows count={4} /> : null}
        {sorted.map((channel) => (
          <div key={channel.id} className={`flex items-center gap-3 px-4 py-3 ${channel.active ? "" : "opacity-50"}`}>
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => setOpenId(channel.id)}
            >
              <span className="block truncate text-sm text-neutral-100 hover:underline">{channel.name}</span>
              <span className="block truncate text-[11px] text-neutral-500">
                {channel.unit_name ? `${channel.unit_name} only` : "Whole organization"}
                {" · "}{plural(Number(channel.device_count) || 0, "radio")}
                {" · "}{Number(channel.online_count) || 0} online
                {channel.provision_state === "pending" ? " · not live yet" : ""}
                {channel.active ? "" : " · removed"}
              </span>
            </button>
            {channel.active && channel.provision_state !== "pending" ? <ListenButton channel={channel} /> : null}
          </div>
        ))}
        {!loading && !channels.length ? (
          <Empty>No channels yet. Create one to group radios that should hear each other.</Empty>
        ) : null}
      </List>

      {open ? (
        <ChannelPanel ctx={ctx} channel={open} devices={devices} onClose={() => setOpenId(null)} />
      ) : null}
    </section>
  );
}

function NewChannelForm({ ctx, units, onDone }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: "", unit_id: "" });
  const [warning, setWarning] = useState("");
  const mutation = useMutation({
    mutationFn: () => createOrgChannel({ name: form.name.trim(), unit_id: form.unit_id || null }, ctx.orgId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ctx.channelsKey });
      if (result?.warning) setWarning(result.warning);
      else onDone();
    },
  });

  return (
    <form
      className="glass-panel rounded-lg p-5"
      onSubmit={(event) => {
        event.preventDefault();
        setWarning("");
        mutation.mutate();
      }}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-bold text-neutral-100">New channel</h2>
          <p className="mt-1 text-[11px] text-neutral-500">
            It goes live on the radio network straight away. Limit it to a unit to control who can listen.
          </p>
        </div>
        <button type="button" aria-label="Cancel" className="rounded p-1 text-neutral-500 hover:text-neutral-100" onClick={onDone}>
          <X size={15} />
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name">
          <input
            autoFocus
            className="field-input"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="e.g. Lagos Patrol"
          />
        </Field>
        <Field label="Who can listen">
          <select className="field-input" value={form.unit_id} onChange={(event) => setForm({ ...form, unit_id: event.target.value })}>
            <option value="">Whole organization</option>
            {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name} only</option>)}
          </select>
        </Field>
      </div>
      {mutation.error ? <p className="mt-3 text-xs text-ops-red">{mutation.error.message}</p> : null}
      {warning ? <p className="mt-3 text-xs text-amber-300/90">{warning}</p> : null}
      <button
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-ops-red px-4 py-2 text-xs font-bold text-black hover:opacity-85 disabled:opacity-50"
        disabled={mutation.isPending || !form.name.trim()}
      >
        <Plus size={14} /> {mutation.isPending ? "Creating…" : "Create channel"}
      </button>
    </form>
  );
}

// Opens the channel in the radio bar, which is where talking and cutting in
// happen, so it keeps playing while the operator moves to another page.
export function ListenButton({ channel }) {
  const radio = useLiveRadioSession();
  const current = radio.mode === "monitor" && String(radio.channel?.id) === String(channel.id);
  if (current) {
    return (
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-500/25 px-2.5 py-1 text-[11px] text-red-300 hover:bg-red-500/10"
        onClick={radio.stopListening}
      >
        <Square size={10} /> Stop
      </button>
    );
  }
  return (
    <button
      type="button"
      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-ops-green px-2.5 py-1 text-[11px] font-bold text-black hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
      disabled={radio.mode === "private" || radio.callState === "connecting"}
      title={radio.mode === "private" ? "End the call first" : "Listen, and hold to talk, from the radio bar"}
      onClick={() => radio.listenToChannel({ id: channel.id, name: channel.name })}
    >
      <Headphones size={11} /> Listen
    </button>
  );
}

// One channel: its name, who is on it, and the controls that change those.
export function ChannelPanel({ ctx, channel, devices, onClose }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(channel.name);
  const [search, setSearch] = useState("");
  const membersKey = ["org-channel-devices", ctx.orgId ?? "mine", channel.id];
  const membersQuery = useQuery({ queryKey: membersKey, queryFn: () => listOrgChannelDevices(channel.id, ctx.orgId) });
  const memberIds = useMemo(
    () => new Set((membersQuery.data?.devices || []).map((device) => String(device.device_id))),
    [membersQuery.data?.devices],
  );

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ctx.channelsKey });
    queryClient.invalidateQueries({ queryKey: ctx.orgKey });
  };

  // Ticks move at once; the radio network catches up, and a refusal puts the
  // list back as it was.
  const toggleMutation = useMutation({
    mutationFn: ({ deviceId, member }) => setOrgChannelDevice(channel.id, deviceId, member, ctx.orgId),
    onMutate: async ({ deviceId, member }) => {
      await queryClient.cancelQueries({ queryKey: membersKey });
      const previous = queryClient.getQueryData(membersKey);
      queryClient.setQueryData(membersKey, (data) => {
        const current = data?.devices || [];
        const next = member
          ? [...current, devices.find((device) => String(device.device_id) === String(deviceId))].filter(Boolean)
          : current.filter((device) => String(device.device_id) !== String(deviceId));
        return { ...(data || {}), devices: next };
      });
      return { previous };
    },
    onError: (_error, _vars, context) => queryClient.setQueryData(membersKey, context?.previous),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: membersKey });
      refresh();
    },
  });
  const renameMutation = useMutation({
    mutationFn: () => updateOrgChannel(channel.id, { name: name.trim() }, ctx.orgId),
    onSuccess: refresh,
  });
  const removeMutation = useMutation({
    mutationFn: () => deleteOrgChannel(channel.id, ctx.orgId),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });

  const term = search.trim().toLowerCase();
  const radios = devices
    .filter((device) => device.active)
    .filter((device) => !term || `${device.name || ""} ${device.device_id}`.toLowerCase().includes(term))
    .sort((a, b) =>
      Number(memberIds.has(String(b.device_id))) - Number(memberIds.has(String(a.device_id)))
      || String(a.name || "").localeCompare(String(b.name || "")));
  const editable = ctx.canManage && channel.active;

  return (
    <SidePanel
      title={channel.name}
      subtitle={`${channel.unit_name ? `${channel.unit_name} only` : "Whole organization"} · ${plural(memberIds.size, "radio")}`}
      onClose={onClose}
    >
      {channel.active && channel.provision_state !== "pending" ? (
        <PanelSection title="Live">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-neutral-500">Listen here, then hold to talk from the radio bar.</p>
            <ListenButton channel={channel} />
          </div>
        </PanelSection>
      ) : null}

      {editable ? (
        <PanelSection title="Name">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && name.trim() !== channel.name) renameMutation.mutate();
            }}
          >
            <input className="field-input flex-1" value={name} onChange={(event) => setName(event.target.value)} />
            {name.trim() && name.trim() !== channel.name ? (
              <button className="rounded-md bg-ops-green px-3 text-[11px] font-bold text-black hover:opacity-85 disabled:opacity-50" disabled={renameMutation.isPending}>
                {renameMutation.isPending ? "Saving…" : "Save"}
              </button>
            ) : null}
          </form>
          {renameMutation.error ? <p className="mt-2 text-[11px] text-ops-red">{renameMutation.error.message}</p> : null}
        </PanelSection>
      ) : null}

      <PanelSection title={`Radios on this channel · ${memberIds.size}`}>
        <label className="mb-2 flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
          <Search size={12} className="text-neutral-500" />
          <input
            className="flex-1 bg-transparent text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
            placeholder="Find a radio"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {membersQuery.isLoading ? <SkeletonRows count={4} /> : (
          <ul className="space-y-0.5">
            {radios.map((device) => {
              const checked = memberIds.has(String(device.device_id));
              return (
                <li key={device.device_id}>
                  <label className={`flex items-center gap-2 rounded px-2 py-1.5 text-[12px] ${editable ? "cursor-pointer hover:bg-white/[0.04]" : ""}`}>
                    <input
                      type="checkbox"
                      className="accent-green-500"
                      checked={checked}
                      disabled={!editable}
                      onChange={() => toggleMutation.mutate({ deviceId: device.device_id, member: !checked })}
                    />
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${device.pocstars_online ? "bg-ops-green" : "bg-neutral-600"}`} />
                    <span className="flex-1 truncate text-neutral-200">{device.name || `Radio ${device.device_id}`}</span>
                    <span className="font-mono text-[10px] text-neutral-600">{device.device_id}</span>
                  </label>
                </li>
              );
            })}
            {!radios.length ? (
              <li className="px-2 py-3 text-[11px] text-neutral-500">
                {devices.length ? "No radio matches." : "This organization has no radios yet."}
              </li>
            ) : null}
          </ul>
        )}
        {toggleMutation.error ? <p className="mt-2 text-[11px] text-ops-red">{toggleMutation.error.message}</p> : null}
      </PanelSection>

      {editable ? (
        <PanelSection title="Remove">
          <p className="mb-2 text-[11px] text-neutral-500">
            Its radios stop hearing each other on it. Recordings and alarm history are kept.
          </p>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-red-500/30 px-3 py-1.5 text-[11px] font-bold text-red-300 hover:bg-red-500/10 disabled:opacity-50"
            disabled={removeMutation.isPending}
            onClick={() => {
              if (window.confirm(`Remove ${channel.name}?`)) removeMutation.mutate();
            }}
          >
            <Trash2 size={12} /> {removeMutation.isPending ? "Removing…" : "Remove channel"}
          </button>
          {removeMutation.error ? <p className="mt-2 text-[11px] text-ops-red">{removeMutation.error.message}</p> : null}
        </PanelSection>
      ) : null}
    </SidePanel>
  );
}
