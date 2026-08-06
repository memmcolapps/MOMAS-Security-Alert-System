import { useQuery } from "@tanstack/react-query";
import { Headphones, Phone, Square, Volume2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { alertsEventsUrl, getRadioChannels } from "../lib/api";
import { useLiveRadioSession } from "../lib/live-radio-session";

// Persistent radio channel bar under the app header. Pick a division to
// monitor its POCSTARS group audio from any page; shows who is speaking and,
// when an SOS lands in another division, offers a one-click channel switch
// (never automatic).
export function LiveRadioBar() {
  const radio = useLiveRadioSession();
  const [selectedId, setSelectedId] = useState("");
  const [sosPrompt, setSosPrompt] = useState(null);
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
  const currentValue = listening && radio.channel ? String(radio.channel.id) : selectedId;

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
    <div className="border-b border-white/10 bg-black/60 backdrop-blur">
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
          <option value="">{inCall ? "In a private call" : "Not listening"}</option>
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

        {connecting ? <span className="text-neutral-500">Connecting…</span> : null}

        {inCall && radio.callDevice ? (
          <span className="flex items-center gap-1.5 text-ops-green">
            <Phone size={11} /> Call with {radio.callDevice.name || radio.callDevice.device_id}
            <button
              className="inline-flex items-center gap-1 rounded border border-red-500/25 px-2 py-0.5 text-red-300 hover:bg-red-500/10"
              onClick={radio.endCall}
            >
              End
            </button>
          </span>
        ) : null}

        {radio.speaker ? (
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
    </div>
  );
}
