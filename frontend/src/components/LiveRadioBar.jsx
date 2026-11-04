import { useQuery } from "@tanstack/react-query";
import { Headphones, Mic, Phone, Search, Square, UsersRound, Volume2, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { alertsEventsUrl, getRadioChannels, listDevices } from "../lib/api";
import { useLiveRadioSession } from "../lib/live-radio-session";

// Persistent radio channel bar under the app header. Pick a channel to listen
// to from any page and hold to talk on it; start a quick group call; see who is
// speaking and cut in on them. When an SOS lands in another channel it offers a
// one-click switch (never automatic).
export function LiveRadioBar() {
  const radio = useLiveRadioSession();
  const [selectedId, setSelectedId] = useState("");
  const [sosPrompt, setSosPrompt] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const sosTimerRef = useRef(null);

  const channelsQuery = useQuery({
    queryKey: ["radio-channels"],
    queryFn: getRadioChannels,
    staleTime: 5 * 60 * 1000,
  });
  const channels = useMemo(() => channelsQuery.data?.channels || [], [channelsQuery.data?.channels]);
  const showOrgNames = useMemo(
    () => new Set(channels.map((unit) => unit.organization_id)).size > 1,
    [channels],
  );
  const channelLabel = (unit) => (showOrgNames ? `${unit.organization_name} · ${unit.name}` : unit.name);

  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const radioRef = useRef(radio);
  radioRef.current = radio;

  const hasChannels = channels.length > 0;
  useEffect(() => {
    if (!hasChannels) return undefined;
    const source = new window.EventSource(alertsEventsUrl());
    const onAlert = (event) => {
      try {
        const alert = JSON.parse(event.data);
        if (alert?.source !== "pocstars" || !alert.pocstars_group_id) return;
        const target = channelsRef.current.find(
          (unit) => String(unit.pocstars_group_id) === String(alert.pocstars_group_id),
        );
        if (!target) return;
        const current = radioRef.current;
        if (current.mode === "monitor" && current.channel?.id === target.id) return;
        setSosPrompt({ channel: target, deviceName: alert.device_name || alert.dev_name || null });
        if (sosTimerRef.current) window.clearTimeout(sosTimerRef.current);
        sosTimerRef.current = window.setTimeout(() => setSosPrompt(null), 30_000);
      } catch { /* malformed SSE payload — ignore */ }
    };
    source.addEventListener("alert_new", onAlert);
    return () => {
      source.close();
      if (sosTimerRef.current) window.clearTimeout(sosTimerRef.current);
    };
  }, [hasChannels]);

  if (!channelsQuery.isLoading && !channels.length) return null;

  const listening = radio.mode === "monitor";
  const inCall = radio.mode === "private";
  const connecting = radio.callState === "connecting";
  const reconnecting = radio.callState === "reconnecting";
  const currentValue = listening && radio.channel ? String(radio.channel.id) : selectedId;
  const connected = radio.callState === "connected";
  const canTalk = connected && (listening || inCall) && !radio.micBlocked;
  const talking = radio.pttState === "granted";
  // Someone else holds the channel. Cutting in is the dispatcher's priority.
  const otherTalking = Boolean(radio.speaker) && !talking;

  const pickChannel = (value) => {
    setSelectedId(value);
    const unit = channels.find((item) => String(item.id) === value);
    if (unit) radio.listenToChannel(unit);
  };

  const switchToSos = () => {
    if (!sosPrompt) return;
    setSelectedId(String(sosPrompt.channel.id));
    radio.listenToChannel(sosPrompt.channel);
    setSosPrompt(null);
  };

  return (
    <div className="relative border-b border-white/10 bg-black/60 backdrop-blur">
      <div className="flex h-8 items-center gap-3 px-4 text-[11px]">
        <span className="flex items-center gap-1.5 font-bold uppercase tracking-wide text-neutral-500">
          <Headphones size={12} className={listening ? "text-ops-green" : ""} /> Channel
        </span>
        <select
          className="h-6 max-w-56 rounded border border-white/10 bg-black/40 px-1.5 text-[11px] text-neutral-200 focus:outline-none"
          value={currentValue}
          disabled={connecting || inCall}
          onChange={(event) => pickChannel(event.target.value)}
        >
          <option value="">{inCall ? (radio.callDevice?.group ? "In a group call" : "In a private call") : "Not listening"}</option>
          {channels.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {channelLabel(unit)}{unit.online_count ? ` (${unit.online_count} online)` : ""}
            </option>
          ))}
        </select>

        {listening ? (
          <button
            className="inline-flex items-center gap-1 rounded border border-red-500/25 px-2 py-0.5 text-red-300 hover:bg-red-500/10"
            onClick={() => { setSelectedId(""); radio.stopListening(); }}
          >
            <Square size={10} /> Stop
          </button>
        ) : null}

        {!inCall && !connecting ? (
          <button
            className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-neutral-300 hover:border-ops-green/50 hover:text-ops-green"
            data-group-call-toggle
            onClick={() => setPickerOpen((open) => !open)}
            aria-expanded={pickerOpen}
          >
            <UsersRound size={11} /> Group call
          </button>
        ) : null}

        {connecting ? <span className="text-neutral-500">Connecting…</span> : null}

        {canTalk ? (
          <HoldButton
            onStart={radio.startPtt}
            onStop={radio.stopPtt}
            className={talking
              ? "bg-ops-red text-black"
              : radio.pttState === "requesting"
                ? "bg-ops-green/60 text-black"
                : "bg-ops-green text-black hover:opacity-85"}
          >
            <Mic size={11} />
            {talking ? "Talking · release" : radio.pttState === "requesting" ? "Requesting…" : "Hold to talk"}
          </HoldButton>
        ) : null}

        {canTalk && otherTalking ? (
          <HoldButton
            onStart={radio.cutIn}
            onStop={radio.stopPtt}
            title={`Cut off ${radio.speaker.name || "the current talker"} and talk`}
            className="border border-amber-400/50 text-amber-200 hover:bg-amber-500/15"
          >
            <Zap size={11} /> Cut in
          </HoldButton>
        ) : null}

        {connected && (listening || inCall) && radio.micBlocked ? (
          <span className="text-amber-300/90">Listening only</span>
        ) : null}

        {inCall && radio.callDevice ? (
          <span className="flex items-center gap-1.5 text-ops-green">
            {radio.callDevice.group ? <UsersRound size={11} /> : <Phone size={11} />}
            {radio.callDevice.group ? "Group call with " : "Call with "}
            {radio.callDevice.name || radio.callDevice.device_id}
            <button
              className="inline-flex items-center gap-1 rounded border border-red-500/25 px-2 py-0.5 text-red-300 hover:bg-red-500/10"
              onClick={radio.endCall}
            >
              End
            </button>
          </span>
        ) : null}

        {reconnecting ? (
          <span className="text-amber-300/90">Connection to {radio.channel?.name} lost. Reconnecting…</span>
        ) : radio.speaker ? (
          <span className="flex items-center gap-1.5 text-ops-green">
            <Volume2 size={12} className="animate-pulse" /> {radio.speaker.name || `Radio ${radio.speaker.uid}`} speaking
          </span>
        ) : listening ? (
          <span className="text-neutral-600">Listening to {radio.channel?.name} — channel quiet</span>
        ) : null}

        {radio.error && radio.busyBy ? (
          <span className="text-amber-300/90">
            Console in use by {radio.busyBy.operator}{radio.busyBy.division ? ` (${radio.busyBy.division})` : ""}
          </span>
        ) : radio.error ? (
          <span className="truncate text-red-300/90">{radio.error}</span>
        ) : null}

        {sosPrompt ? (
          <span className="ml-auto flex items-center gap-2 rounded border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-red-200">
            SOS in {sosPrompt.channel.name}{sosPrompt.deviceName ? ` · ${sosPrompt.deviceName}` : ""}
            <button className="rounded bg-ops-red px-2 py-0.5 font-bold text-black hover:opacity-85" onClick={switchToSos}>
              Switch channel
            </button>
            <button className="text-red-300/70 hover:text-red-200" onClick={() => setSosPrompt(null)} aria-label="Dismiss">
              <X size={11} />
            </button>
          </span>
        ) : null}
      </div>
      {pickerOpen && !inCall ? (
        <GroupCallPicker
          onClose={() => setPickerOpen(false)}
          onCall={(devices) => {
            setPickerOpen(false);
            radio.callGroup(devices);
          }}
        />
      ) : null}
    </div>
  );
}

// Push-to-talk needs press and release, and keeps the pointer captured so a
// drag off the button still releases the microphone.
function HoldButton({ onStart, onStop, className, title, children }) {
  return (
    <button
      title={title}
      className={`inline-flex h-6 touch-none select-none items-center gap-1 rounded px-2.5 font-bold transition ${className}`}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        onStart();
      }}
      onPointerUp={onStop}
      onPointerCancel={onStop}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          onStart();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") onStop();
      }}
    >
      {children}
    </button>
  );
}

// Pick online radios and call them all at once. The radio network builds a
// temporary group for the call and drops it when the call ends. Radios from
// different organizations never share a call, the same rule as channels.
function GroupCallPicker({ onClose, onCall }) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState(() => new Map());
  const panelRef = useRef(null);
  const devicesQuery = useQuery({ queryKey: ["devices"], queryFn: listDevices, staleTime: 30_000 });

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    const onClick = (event) => {
      // The bar's own toggle closes it on click; closing here too would
      // reopen it straight away.
      if (event.target.closest?.("[data-group-call-toggle]")) return;
      if (!panelRef.current?.contains(event.target)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);

  const online = useMemo(
    () => (devicesQuery.data?.devices || [])
      .filter((device) => device.active && device.pocstars_online)
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))),
    [devicesQuery.data?.devices],
  );
  const showOrgNames = useMemo(() => new Set(online.map((device) => device.organization_id)).size > 1, [online]);
  const term = search.trim().toLowerCase();
  const shown = term
    ? online.filter((device) =>
      `${device.name || ""} ${device.device_id} ${device.organization_name || ""}`.toLowerCase().includes(term))
    : online;
  const pickedOrg = picked.size ? [...picked.values()][0].organization_id : undefined;

  const toggle = (device) => {
    setPicked((current) => {
      const next = new Map(current);
      if (next.has(device.device_id)) next.delete(device.device_id);
      else next.set(device.device_id, device);
      return next;
    });
  };

  return (
    <div
      ref={panelRef}
      className="absolute left-4 top-full mt-1 w-80 overflow-hidden rounded-lg border border-white/10 bg-black/95 shadow-2xl backdrop-blur"
    >
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <h2 className="text-xs font-bold text-neutral-100">Group call</h2>
        <button className="rounded p-0.5 text-neutral-500 hover:text-neutral-100" onClick={onClose} aria-label="Close">
          <X size={13} />
        </button>
      </div>
      <label className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-neutral-500">
        <Search size={12} />
        <input
          autoFocus
          className="w-full bg-transparent text-[11px] text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
          placeholder="Find an online radio"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div className="max-h-72 overflow-y-auto py-1">
        {devicesQuery.isLoading
          ? [0, 1, 2, 3].map((key) => (
            <div key={key} className="mx-3 my-2 h-4 animate-pulse rounded bg-white/[0.06]" />
          ))
          : null}
        {!devicesQuery.isLoading && !shown.length ? (
          <p className="px-3 py-4 text-[11px] text-neutral-500">
            {online.length ? "No online radio matches." : "No radios are online right now."}
          </p>
        ) : null}
        {shown.map((device) => {
          const checked = picked.has(device.device_id);
          const otherOrg = pickedOrg !== undefined && device.organization_id !== pickedOrg;
          return (
            <label
              key={device.device_id}
              className={`flex items-center gap-2 px-3 py-1.5 text-[11px] ${
                otherOrg ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-white/[0.05]"
              }`}
            >
              <input
                type="checkbox"
                className="accent-green-500"
                checked={checked}
                disabled={otherOrg}
                onChange={() => toggle(device)}
              />
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ops-green" />
              <span className="min-w-0 flex-1 truncate text-neutral-200">{device.name || `Radio ${device.device_id}`}</span>
              {showOrgNames ? (
                <span className="max-w-24 shrink-0 truncate text-[10px] text-neutral-500">{device.organization_name}</span>
              ) : null}
            </label>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-white/10 px-3 py-2">
        <span className="text-[10px] text-neutral-500">
          {picked.size ? `${picked.size} selected` : "Only online radios are listed"}
        </span>
        <button
          className="inline-flex items-center gap-1.5 rounded-md bg-ops-green px-3 py-1 text-[11px] font-bold text-black hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!picked.size}
          onClick={() => onCall([...picked.values()])}
        >
          <Phone size={11} /> Call {picked.size || ""} {picked.size === 1 ? "radio" : "radios"}
        </button>
      </div>
    </div>
  );
}
