import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Headphones, Mic, Phone, Search, Square, UsersRound, Volume2, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { alertsEventsUrl, getRadioChannels, listDevices } from "../lib/api";
import { useLiveRadioSession } from "../lib/live-radio-session";

function useRadioChannels() {
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
  return { channels, channelLabel, isLoading: channelsQuery.isLoading };
}

// Header button that opens the channel list and the group call picker. It
// takes no room of its own; the strip below the header only shows once
// something is live.
export function ListenControl() {
  const radio = useLiveRadioSession();
  const { channels, channelLabel, isLoading } = useRadioChannels();
  const [view, setView] = useState(null);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!view) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") setView(null);
    };
    const onClick = (event) => {
      if (!rootRef.current?.contains(event.target)) setView(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [view]);

  if (isLoading || !channels.length) return null;

  const listening = radio.mode === "monitor";
  const inCall = radio.mode === "private";
  const connecting = radio.callState === "connecting";
  const locked = connecting || inCall;

  const pick = (unit) => {
    setView(null);
    radio.listenToChannel(unit);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setView((current) => (current ? null : "channels"))}
        aria-expanded={Boolean(view)}
        aria-label={inCall ? "In call" : listening && radio.channel ? `Listening: ${radio.channel.name}` : "Listen"}
        title={inCall ? "In call" : listening && radio.channel ? `Listening: ${radio.channel.name}` : "Listen"}
        className={`inline-flex h-9 items-center gap-1.5 rounded border px-2.5 text-[11px] font-bold transition min-[1180px]:h-auto min-[1180px]:py-1 ${
          listening || inCall
            ? "border-ops-green/40 bg-ops-green/10 text-ops-green hover:bg-ops-green/15"
            : "border-white/10 bg-white/[0.03] text-neutral-300 hover:bg-white/[0.07]"
        }`}
      >
        <Headphones size={13} />
        <span className="hidden max-w-[140px] truncate min-[1180px]:inline">
          {inCall ? "In call" : listening && radio.channel ? radio.channel.name : "Listen"}
        </span>
        <ChevronDown size={12} className="text-neutral-500" />
      </button>

      {view === "channels" ? (
        <div className="absolute right-0 top-full mt-2 w-64 overflow-hidden rounded-lg border border-white/10 bg-black/95 shadow-2xl backdrop-blur">
          <p className="px-3 pb-1 pt-2 text-[9px] font-bold uppercase tracking-wide text-neutral-600">Channels</p>
          <div className="max-h-72 overflow-y-auto pb-1">
            {channels.map((unit) => {
              const current = listening && radio.channel?.id === unit.id;
              return (
                <button
                  key={unit.id}
                  disabled={locked}
                  onClick={() => (current ? radio.stopListening() : pick(unit))}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${
                    current ? "bg-ops-green/10 text-ops-green" : "text-neutral-200 hover:bg-white/[0.06]"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{channelLabel(unit)}</span>
                  {unit.online_count ? (
                    <span className="shrink-0 text-[10px] text-neutral-500">{unit.online_count} online</span>
                  ) : null}
                  {current ? <Check size={12} className="shrink-0" /> : null}
                </button>
              );
            })}
          </div>
          <div className="border-t border-white/10 p-1">
            {listening ? (
              <button
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[11px] text-red-300 hover:bg-red-500/10"
                onClick={() => { setView(null); radio.stopListening(); }}
              >
                <Square size={11} /> Stop listening
              </button>
            ) : null}
            <button
              disabled={locked}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[11px] text-neutral-300 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => setView("group")}
            >
              <UsersRound size={12} /> Group call…
            </button>
          </div>
        </div>
      ) : null}

      {view === "group" ? (
        <GroupCallPicker
          onClose={() => setView(null)}
          onCall={(devices) => {
            setView(null);
            radio.callGroup(devices);
          }}
        />
      ) : null}
    </div>
  );
}

// Strip under the app header while the radio is live: hold to talk, who is
// speaking, cut in, end. Hidden when idle. When an SOS lands in another channel
// it appears to offer a one-click switch (never automatic).
export function LiveRadioBar() {
  const radio = useLiveRadioSession();
  const { channels } = useRadioChannels();
  const [sosPrompt, setSosPrompt] = useState(null);
  const sosTimerRef = useRef(null);

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

  const listening = radio.mode === "monitor";
  const inCall = radio.mode === "private";
  const connecting = radio.callState === "connecting";
  const reconnecting = radio.callState === "reconnecting";
  const connected = radio.callState === "connected";
  const canTalk = connected && (listening || inCall) && !radio.micBlocked;
  const talking = radio.pttState === "granted";
  // Someone else holds the channel. Cutting in is the dispatcher's priority.
  const otherTalking = Boolean(radio.speaker) && !talking;

  if (!listening && !inCall && !connecting && !radio.error && !sosPrompt) return null;

  const switchToSos = () => {
    if (!sosPrompt) return;
    radio.listenToChannel(sosPrompt.channel);
    setSosPrompt(null);
  };

  return (
    <div className="border-b border-white/10 bg-black/60 backdrop-blur">
      <div className="flex h-8 items-center gap-3 px-4 text-[11px]">
        {connecting ? <span className="text-neutral-500">Connecting…</span> : null}

        {listening ? (
          <span className="flex items-center gap-1.5 font-bold text-neutral-300">
            <Headphones size={12} className="text-ops-green" /> {radio.channel?.name}
          </span>
        ) : null}

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
          <span className="text-neutral-600">Channel quiet</span>
        ) : null}

        {radio.error && radio.busyBy ? (
          <span className="text-amber-300/90">
            Console in use by {radio.busyBy.operator}{radio.busyBy.division ? ` (${radio.busyBy.division})` : ""}
          </span>
        ) : radio.error ? (
          <span className="truncate text-red-300/90">{radio.error}</span>
        ) : null}

        {listening ? (
          <button
            className="inline-flex items-center gap-1 rounded border border-red-500/25 px-2 py-0.5 text-red-300 hover:bg-red-500/10"
            onClick={radio.stopListening}
          >
            <Square size={10} /> Stop
          </button>
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
// Escape and outside clicks are handled by ListenControl, which owns it.
function GroupCallPicker({ onClose, onCall }) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState(() => new Map());
  const devicesQuery = useQuery({ queryKey: ["devices"], queryFn: listDevices, staleTime: 30_000 });


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
      className="absolute right-0 top-full mt-2 w-80 overflow-hidden rounded-lg border border-white/10 bg-black/95 shadow-2xl backdrop-blur"
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
