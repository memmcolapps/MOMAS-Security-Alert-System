import { useMutation, useQuery } from "@tanstack/react-query";
import { GripHorizontal, MapPin, Mic, Phone, PhoneOff, Radio, Send, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { reverseGeocode, sendRadioMessage } from "../lib/api";
import { useLiveRadioSession } from "../lib/live-radio-session";

function formatRadioTime(value) {
  if (!value) return "Unknown time";
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// "how stale is this" reads faster than a timestamp when you are deciding
// whether a position is worth acting on.
function relativeAge(value) {
  if (!value) return null;
  const stamp = new Date(value).getTime();
  if (!Number.isFinite(stamp)) return null;
  const seconds = Math.max(0, Math.round((Date.now() - stamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

function coordsOf(location) {
  const lat = Number(location?.Lat);
  const lon = Number(location?.Lng);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/**
 * Everything you can know about, or do to, one handset. Rendered inside a
 * floating card on the map and docked in the device registry, so it carries no
 * assumptions about its container - including its own message state, which is
 * what lets several of these be open at once without sharing a composer.
 */
export function RadioConsole({ device, location, onShowOnMap }) {
  const liveRadio = useLiveRadioSession();
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState([]);
  const [notice, setNotice] = useState("");

  const draftBytes = new window.TextEncoder().encode(draft.trim()).length;
  const coords = coordsOf(location);
  const online = device.pocstars_online;

  // The gazetteer answers "near where", which is the useful question for a
  // handset in the field. Coordinates are rounded for the key so ordinary GPS
  // jitter does not refetch a label that will not change.
  const placeQuery = useQuery({
    queryKey: ["reverse-geocode", coords ? coords.lat.toFixed(3) : null, coords ? coords.lon.toFixed(3) : null],
    queryFn: () => reverseGeocode(coords.lat, coords.lon),
    enabled: Boolean(coords),
    staleTime: 10 * 60 * 1000,
  });

  const messageMutation = useMutation({
    mutationFn: sendRadioMessage,
    onSuccess: (result, variables) => {
      setSent((current) => [
        ...current,
        {
          id: result.deliveryId || `${Date.now()}`,
          message: variables.message,
          sentAt: result.acceptedAt || new Date().toISOString(),
        },
      ]);
      setDraft("");
      setNotice("");
    },
    onError: (error) => setNotice(error.message),
  });

  const inCallWithThis =
    liveRadio.mode === "private" &&
    String(liveRadio.callDevice?.device_id ?? "") === String(device.device_id);
  const inCallWithOther = liveRadio.mode === "private" && !inCallWithThis;

  function submitMessage(event) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || draftBytes > 200) return;
    messageMutation.mutate({ device_id: device.device_id, message });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-[11px] font-bold text-neutral-200">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-ops-green" : "bg-neutral-600"}`}
              />
              {online ? "Online" : "Offline"}
            </span>
            <span className="text-[10px] text-neutral-500">
              {online
                ? "on the radio network"
                : device.pocstars_last_seen_at
                  ? `last seen ${relativeAge(device.pocstars_last_seen_at)}`
                  : "never seen online"}
            </span>
          </div>

          <div className="mt-3 border-t border-white/5 pt-3">
            {coords ? (
              <>
                <p className="flex items-start gap-2 text-[11px] text-neutral-200">
                  <MapPin size={12} className="mt-0.5 shrink-0 text-ops-green" />
                  <span>
                    {placeQuery.isLoading
                      ? "Locating…"
                      : placeQuery.data?.label || "Location outside the gazetteer"}
                    {placeQuery.data?.distance_km != null ? (
                      <span className="text-neutral-500"> · {placeQuery.data.distance_km} km</span>
                    ) : null}
                  </span>
                </p>
                <p className="mt-1 pl-5 font-mono text-[10px] text-neutral-500">
                  {coords.lat.toFixed(5)}, {coords.lon.toFixed(5)}
                  {location?.GpsTime ? ` · fix ${relativeAge(location.GpsTime)}` : ""}
                </p>
                {onShowOnMap ? (
                  <button
                    className="mt-2 ml-5 text-[10px] font-bold text-ops-green hover:underline"
                    onClick={() => onShowOnMap(coords)}
                  >
                    Centre the map here
                  </button>
                ) : null}
              </>
            ) : (
              <p className="flex items-center gap-2 text-[11px] text-neutral-500">
                <MapPin size={12} className="shrink-0" /> No position reported
              </p>
            )}
          </div>

          {(device.channels || []).length ? (
            <p className="mt-3 border-t border-white/5 pt-3 text-[10px] text-neutral-500">
              On {device.channels.map((channel) => channel.name).join(", ")}
            </p>
          ) : null}
        </section>

        <section className="rounded-lg border border-green-500/25 bg-green-500/[0.04] p-3">
          <div className="flex items-start justify-between gap-3">
            <h3 className="flex items-center gap-2 text-xs font-bold text-neutral-100">
              <Radio size={14} className="text-ops-green" /> Private call
            </h3>
            <span
              className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase ${
                inCallWithThis && liveRadio.callState === "connected"
                  ? "border-green-500/30 bg-green-500/10 text-ops-green"
                  : "border-white/10 text-neutral-500"
              }`}
            >
              {inCallWithThis ? liveRadio.callState : "idle"}
            </span>
          </div>

          {liveRadio.error && liveRadio.mode !== "monitor" ? (
            <p className="mt-2 rounded bg-red-500/10 px-2 py-1.5 text-[10px] text-red-300">{liveRadio.error}</p>
          ) : null}
          {inCallWithThis && liveRadio.speaker ? (
            <p className="mt-2 flex items-center gap-2 text-[10px] text-ops-green">
              <Volume2 size={12} className="animate-pulse" />
              {liveRadio.speaker.name || `Radio ${liveRadio.speaker.uid}`} is speaking
            </p>
          ) : null}

          <div className="mt-3">
            {liveRadio.configured === false ? (
              <button className="w-full rounded-md border border-red-500/20 px-3 py-2 text-[11px] text-red-300/70" disabled>
                Live radio unavailable
              </button>
            ) : inCallWithOther ? (
              <div className="space-y-2">
                <p className="rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-200">
                  In a call with {liveRadio.callDevice.name || liveRadio.callDevice.device_id}. End it before
                  calling this radio.
                </p>
                <button
                  className="inline-flex w-full items-center justify-center gap-2 rounded border border-red-500/25 px-3 py-1.5 text-[10px] text-red-300 hover:bg-red-500/10"
                  onClick={liveRadio.endCall}
                >
                  <PhoneOff size={12} /> End that call
                </button>
              </div>
            ) : !inCallWithThis ? (
              <div className="space-y-2">
                <button
                  className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-ops-green px-3 py-2 text-xs font-bold text-black hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={liveRadio.callState === "connecting" || !online}
                  onClick={() => liveRadio.callRadio(device)}
                >
                  <Phone size={15} /> Call this radio
                </button>
                {/* Calling an offline handset used to be an available button
                    that simply timed out; the state is known, so say it. */}
                {!online ? (
                  <p className="text-[10px] text-neutral-500">
                    This radio is offline. It has to be on the network to take a call.
                  </p>
                ) : liveRadio.mode === "monitor" ? (
                  <p className="text-[10px] text-neutral-500">
                    Channel listening pauses during the call and resumes when it ends.
                  </p>
                ) : null}
              </div>
            ) : liveRadio.callState === "connected" ? (
              <div className="space-y-2">
                <button
                  className={`flex min-h-20 w-full touch-none select-none flex-col items-center justify-center gap-1.5 rounded-lg border text-xs font-black uppercase tracking-wider transition ${
                    liveRadio.pttState === "granted"
                      ? "border-red-400 bg-red-500/25 text-red-200 shadow-[0_0_28px_rgba(239,68,68,0.18)]"
                      : "border-green-500/40 bg-green-500/10 text-ops-green hover:bg-green-500/15"
                  }`}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    liveRadio.startPtt();
                  }}
                  onPointerUp={liveRadio.stopPtt}
                  onPointerCancel={liveRadio.stopPtt}
                  onKeyDown={(event) => {
                    if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                      event.preventDefault();
                      liveRadio.startPtt();
                    }
                  }}
                  onKeyUp={(event) => {
                    if (event.key === " " || event.key === "Enter") liveRadio.stopPtt();
                  }}
                >
                  <Mic size={20} />
                  {liveRadio.pttState === "granted"
                    ? "Speaking · release to stop"
                    : liveRadio.pttState === "requesting"
                      ? "Requesting microphone…"
                      : "Hold to talk"}
                </button>
                <button
                  className="inline-flex w-full items-center justify-center gap-2 rounded border border-red-500/25 px-3 py-1.5 text-[10px] text-red-300 hover:bg-red-500/10"
                  onClick={liveRadio.endCall}
                >
                  <PhoneOff size={12} /> End call
                </button>
              </div>
            ) : (
              <button className="w-full rounded-md border border-white/10 px-3 py-2 text-[11px] text-neutral-500" disabled>
                Connecting the call…
              </button>
            )}
          </div>
        </section>

        {sent.length ? (
          <section>
            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wide text-neutral-500">Sent this session</h3>
            <div className="space-y-2">
              {sent.map((item) => (
                <article className="ml-8 rounded-lg border border-green-500/20 bg-green-500/[0.07] px-3 py-2" key={item.id}>
                  <p className="text-xs text-neutral-200">{item.message}</p>
                  <p className="mt-1 text-right text-[9px] text-neutral-600">
                    {formatRadioTime(item.sentAt)} · MOMAS Command
                  </p>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <form className="border-t border-white/10 bg-black/25 p-3" onSubmit={submitMessage}>
        <textarea
          className="field-input min-h-[60px] resize-none"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`Message ${device.name || device.device_id}`}
        />
        {notice ? <p className="mt-1.5 text-[10px] text-red-300">{notice}</p> : null}
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className={`text-[9px] ${draftBytes > 200 ? "text-red-400" : "text-neutral-600"}`}>
            {draftBytes}/200 bytes
          </span>
          <button
            type="submit"
            disabled={!draft.trim() || draftBytes > 200 || messageMutation.isPending}
            className="inline-flex items-center gap-2 rounded bg-ops-green px-3 py-1.5 text-[11px] font-bold text-black disabled:opacity-40"
          >
            <Send size={12} /> {messageMutation.isPending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}

const CARD_WIDTH = 320;

/**
 * A radio console that floats over the map rather than covering it. Non-modal
 * on purpose: no backdrop, no focus trap, the map stays live underneath, and
 * several can be open at once so two radios can be worked side by side.
 */
export function FloatingRadioCard({ device, location, position, zIndex, onFocus, onMove, onClose, onShowOnMap }) {
  const cardRef = useRef(null);
  const dragRef = useRef(null);

  const clamp = useCallback((x, y) => {
    // Cards sit above the chrome in stacking order, so they have to be kept
    // below it by position instead - and the chrome's height is measured, not
    // assumed, because the radio bar wraps on narrow screens.
    const chrome =
      Number.parseInt(
        window.getComputedStyle(window.document.documentElement).getPropertyValue("--ops-chrome"),
        10,
      ) || 48;
    const top = chrome + 8;
    return {
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - CARD_WIDTH - 8)),
      y: Math.min(Math.max(top, y), Math.max(top, window.innerHeight - 120)),
    };
  }, []);

  // Dragging is bound to the header alone. Making the whole card a drag surface
  // would fight the push-to-talk button, which holds a pointer capture of its
  // own for as long as someone is speaking.
  function startDrag(event) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { dx: event.clientX - position.x, dy: event.clientY - position.y };
    onFocus?.();
  }

  function onDrag(event) {
    if (!dragRef.current) return;
    onMove(clamp(event.clientX - dragRef.current.dx, event.clientY - dragRef.current.dy));
  }

  function endDrag(event) {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A card parked off-screen after a resize is a card you cannot reach.
  useEffect(() => {
    const onResize = () => onMove(clamp(position.x, position.y));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp, onMove, position.x, position.y]);

  return (
    <aside
      ref={cardRef}
      onPointerDown={onFocus}
      style={{ left: position.x, top: position.y, width: CARD_WIDTH, zIndex }}
      className="radio-card fixed flex max-h-[min(560px,calc(100vh-96px))] flex-col overflow-hidden rounded-xl border border-green-500/25 bg-[#090d0b]/95 shadow-2xl backdrop-blur"
    >
      <header
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="flex cursor-grab items-start justify-between gap-2 border-b border-white/10 px-3 py-2.5 active:cursor-grabbing"
      >
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[8px] font-bold uppercase tracking-[0.18em] text-ops-green">
            <GripHorizontal size={11} className="opacity-50" /> Radio console
          </p>
          <h2 className="mt-0.5 truncate text-sm font-bold text-neutral-100">
            {device.name || `Radio ${device.device_id}`}
          </h2>
          <p className="truncate font-mono text-[9px] text-neutral-500">
            UID {device.device_id}
            {device.operator ? ` · ${device.operator}` : ""}
          </p>
        </div>
        <button
          aria-label="Close radio console"
          className="shrink-0 rounded p-1 text-neutral-500 hover:bg-white/5 hover:text-neutral-100"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      <RadioConsole device={device} location={location} onShowOnMap={onShowOnMap} />
    </aside>
  );
}
