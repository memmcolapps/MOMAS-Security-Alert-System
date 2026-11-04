import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getAuthToken } from "./api";
import { BrowserRadioAudio, liveRadioUrl } from "./live-radio";

// One live-radio session for the whole app. The listen bar monitors a division
// through it and the radio console places private calls through it, so audio
// keeps playing while the operator moves between pages. POCSTARS allows a
// single live session globally; when a private call starts while monitoring,
// the channel is remembered and resumed after the call ends.
const LiveRadioContext = createContext(null);

const START_FAIL_CODES = new Set([
  "pocstars_call_failed",
  "pocstars_monitor_failed",
  "live_radio_not_configured",
  "division_not_mapped",
  "radio_console_busy",
  "forbidden",
  "invalid_radio_uid",
  "invalid_group_id",
]);

// While a dropped channel is reconnecting, these can be our own ghost: the
// server only notices a vanished connection after its idle timeout (about two
// minutes), and until then the old session still holds the console seat or
// the radio network. They are retried for this long, then given up.
const RETRYABLE_CODES = new Set(["pocstars_monitor_failed", "radio_console_busy"]);
const RETRYABLE_FOR_MS = 3 * 60_000;
const MAX_RETRY_DELAY_MS = 30_000;

// 1s, 2s, 4s ... capped at 30s, each spread ±30% so a room of consoles that
// all lost the server together do not all come back in the same instant.
export function reconnectDelay(attempt, random = Math.random) {
  const base = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** attempt);
  return Math.round(base * (0.7 + random() * 0.6));
}

// The radio network allows one login per dispatcher account. Being evicted
// means someone else is using it now; reconnecting would evict them in turn.
function isKickout(message) {
  return message.code === "pocstars_kicked" || /used somewhere else/i.test(message.message || "");
}

export function LiveRadioProvider({ children }) {
  const socketRef = useRef(null);
  const audioRef = useRef(null);
  const heldRef = useRef(false);
  const modeRef = useRef(null);
  const resumeChannelRef = useRef(null);
  const startingRef = useRef(false);
  // The channel the operator asked to monitor. A monitor that drops for any
  // reason other than the operator stopping it is reconnected to this.
  const wantedChannelRef = useRef(null);
  // The socket teardown() closed on purpose, so its close is not a drop.
  const closingRef = useRef(null);
  const retryRef = useRef({ attempt: 0, since: 0, timer: null, onOnline: null });
  // Each start() bumps this. A socket's handlers capture their own id, so a
  // superseded (replaced) socket's late onclose is ignored, while the current
  // socket's onclose remains the single authority for resetting state.
  const sessionIdRef = useRef(0);

  const [mode, setMode] = useState(null);
  const [callState, setCallState] = useState("idle");
  const [pttState, setPttState] = useState("idle");
  const [speaker, setSpeaker] = useState(null);
  const [configured, setConfigured] = useState(null);
  const [error, setError] = useState("");
  const [busyBy, setBusyBy] = useState(null);
  const [channel, setChannel] = useState(null);
  const [callDevice, setCallDevice] = useState(null);
  // Set when this machine cannot transmit; the call still connects listen-only.
  const [micBlocked, setMicBlocked] = useState("");
  // A standing condition holds until the thing it describes changes; `error` is
  // a moment and clears itself. Carrying both in one string meant neither could
  // have the right lifetime.
  const [condition, setCondition] = useState("");

  // Transient failures announce themselves and go. One still on screen a minute
  // later cannot be told apart from a live one, and once an operator has been
  // caught out by a stale message they stop trusting all of them.
  useEffect(() => {
    if (!error) return undefined;
    const timer = window.setTimeout(() => setError(""), 8000);
    return () => window.clearTimeout(timer);
  }, [error]);

  // Nothing used to clear an error once a later attempt actually worked, so a
  // rejected call stayed on screen through the successful one that followed.
  useEffect(() => {
    if (callState === "connected") setError("");
  }, [callState]);

  const resetVisibleState = useCallback(() => {
    setMode(null);
    setCallState("idle");
    setPttState("idle");
    setSpeaker(null);
    setChannel(null);
    setCallDevice(null);
  }, []);

  const clearRetryTimer = useCallback(() => {
    const retry = retryRef.current;
    if (retry.timer) window.clearTimeout(retry.timer);
    if (retry.onOnline) window.removeEventListener("online", retry.onOnline);
    retry.timer = null;
    retry.onOnline = null;
  }, []);

  const cancelReconnect = useCallback(() => {
    clearRetryTimer();
    retryRef.current.attempt = 0;
    retryRef.current.since = 0;
  }, [clearRetryTimer]);

  useEffect(() => cancelReconnect, [cancelReconnect]);

  // Send the leave frames and close the socket. Ref/state cleanup is left to
  // the socket's onclose so there is exactly one place that resets state.
  const teardown = useCallback(() => {
    heldRef.current = false;
    audioRef.current?.setTransmitting(false);
    const socket = socketRef.current;
    closingRef.current = socket;
    if (socket?.readyState === window.WebSocket.OPEN) {
      if (modeRef.current === "private") {
        socket.send(JSON.stringify({ type: "ptt.stop" }));
        socket.send(JSON.stringify({ type: "call.end" }));
      } else if (modeRef.current === "monitor") {
        socket.send(JSON.stringify({ type: "ptt.stop" }));
        socket.send(JSON.stringify({ type: "monitor.end" }));
      }
    }
    socket?.close();
  }, []);

  // Keep the channel on screen as "reconnecting" and try again after a backoff.
  // With the browser offline there is no point counting down: wait for it to
  // come back, then go almost at once.
  const scheduleReconnect = useCallback((channel) => {
    const retry = retryRef.current;
    clearRetryTimer();
    if (!retry.since) retry.since = Date.now();
    setMode("monitor");
    setChannel(channel);
    setCallState("reconnecting");
    setPttState("idle");
    setSpeaker(null);
    const fire = () => {
      clearRetryTimer();
      if (wantedChannelRef.current !== channel || !getAuthToken()) {
        cancelReconnect();
        resetVisibleState();
        return;
      }
      void startRef.current({ nextMode: "monitor", nextChannel: channel, retry: true });
    };
    retry.onOnline = () => {
      if (retry.timer) window.clearTimeout(retry.timer);
      retry.timer = window.setTimeout(fire, reconnectDelay(0) / 2);
    };
    window.addEventListener("online", retry.onOnline);
    if (window.navigator.onLine) retry.timer = window.setTimeout(fire, reconnectDelay(retry.attempt));
    retry.attempt += 1;
  }, [cancelReconnect, clearRetryTimer, resetVisibleState]);

  // nextDevices makes a private call a quick group call: the radio network
  // builds a temporary group around them and pulls them all straight in.
  const start = useCallback(async ({ nextMode, nextChannel, nextDevice, nextDevices, retry = false }) => {
    if (startingRef.current) return;
    startingRef.current = true;
    if (retry) clearRetryTimer();
    else {
      cancelReconnect();
      setError("");
    }
    setBusyBy(null);
    wantedChannelRef.current = nextMode === "monitor" ? nextChannel : null;
    const mySession = (sessionIdRef.current += 1);
    try {
      const previous = socketRef.current;
      if (previous) {
        teardown();
        // POCSTARS allows one login per dispatcher account and evicts the older
        // session, so the previous socket must be fully closed before the
        // replacement connects — otherwise switching channels kicks itself.
        // Wait for the real close rather than guessing a delay.
        await new Promise((resolve) => {
          if (previous.readyState === window.WebSocket.CLOSED) return resolve();
          const done = () => resolve();
          previous.addEventListener("close", done, { once: true });
          setTimeout(done, 3000);
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      modeRef.current = nextMode;
      setMode(nextMode);
      setChannel(nextChannel || null);
      setCallDevice(nextDevice || null);
      setSpeaker(null);
      setCallState(retry ? "reconnecting" : "connecting");

      let socket = null;
      const audio = new BrowserRadioAudio((data) => {
        if (socket?.readyState === window.WebSocket.OPEN) socket.send(data);
      });
      audioRef.current = audio;
      // A screen with no microphone can still hear the call. Failing the whole
      // connection over it left a command screen unable to take a call at all,
      // when listening is most of the value - so the call goes ahead and only
      // push-to-talk is withheld.
      setMicBlocked("");
      try {
        await audio.prepare({ microphone: nextMode === "private" });
      } catch (error) {
        if (error?.code !== "microphone_unavailable") throw error;
        setMicBlocked(error.message);
        await audio.prepare({ microphone: false });
      }
      socket = new window.WebSocket(liveRadioUrl());
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      socket.onmessage = (event) => {
        if (typeof event.data !== "string") {
          audio.receive(event.data);
          return;
        }
        const message = JSON.parse(event.data);
        if (message.type === "ready") {
          setConfigured(Boolean(message.configured));
          if (!message.configured) {
            wantedChannelRef.current = null;
            setCondition("Live radio is not configured on this MOMAS server.");
            socket.close();
            return;
          }
          setCondition("");
          socket.send(JSON.stringify(
            nextMode === "monitor"
              ? { type: "monitor.start", channelId: nextChannel.id }
              : nextDevices
                ? { type: "group.start", deviceIds: nextDevices.map((device) => device.device_id) }
                : { type: "call.start", deviceId: nextDevice.device_id },
          ));
        }
        if (message.type === "call.state" || message.type === "monitor.state") {
          setCallState(message.state);
          if (message.state === "connected") cancelReconnect();
        }
        if (message.type === "ptt.state") {
          setPttState(message.state);
          audio.setTransmitting(message.state === "granted" && heldRef.current);
        }
        if (message.type === "speaker") {
          setSpeaker(message.speaking ? { uid: message.uid, name: message.name } : null);
        }
        if (message.type === "error") {
          if (isKickout(message)) {
            setError(message.message || "This radio session was ended because the account was used somewhere else.");
            wantedChannelRef.current = null;
            resumeChannelRef.current = null;
            socket.close();
            return;
          }
          // The server's link to the radio network died but this socket is
          // still open, which used to leave the bar saying "listening" over
          // silence. Closing it brings the channel back through a reconnect.
          if (message.code === "pocstars_voice_error" && modeRef.current === "monitor") {
            socket.close();
            return;
          }
          if (START_FAIL_CODES.has(message.code)) {
            const since = retryRef.current.since;
            const retrying = since && RETRYABLE_CODES.has(message.code) && Date.now() - since < RETRYABLE_FOR_MS;
            if (!retrying) {
              wantedChannelRef.current = null;
              resumeChannelRef.current = null;
              setError(message.message || "Live radio failed.");
              if (message.busyBy) setBusyBy(message.busyBy);
            }
            socket.close();
            return;
          }
          setError(message.message || "Live radio failed.");
          if (message.busyBy) setBusyBy(message.busyBy);
        }
      };
      socket.onerror = () => {
        // A monitor that fails to connect retries quietly; the bar already
        // says it is reconnecting.
        if (sessionIdRef.current === mySession && !wantedChannelRef.current) {
          setError("The live-radio connection could not be opened.");
        }
      };
      socket.onclose = () => {
        audio.setTransmitting(false);
        audio.close();
        if (audioRef.current === audio) audioRef.current = null;
        // A newer start() has superseded this socket — leave its state alone.
        if (sessionIdRef.current !== mySession) return;
        if (socketRef.current === socket) socketRef.current = null;
        const intended = closingRef.current === socket;
        if (intended) closingRef.current = null;
        const closedMode = modeRef.current;
        modeRef.current = null;
        const resume = resumeChannelRef.current;
        const wanted = wantedChannelRef.current;
        if (closedMode === "private" && resume) {
          resumeChannelRef.current = null;
          resetVisibleState();
          setTimeout(() => {
            void startRef.current({ nextMode: "monitor", nextChannel: resume });
          }, 400);
        } else if (!intended && wanted && getAuthToken()) {
          scheduleReconnect(wanted);
        } else {
          resetVisibleState();
          if (!intended && closedMode === "private") setError("The call dropped.");
        }
      };
    } catch (reason) {
      if (sessionIdRef.current === mySession) {
        setError(reason instanceof Error ? reason.message : "Live radio could not be started.");
        resetVisibleState();
      }
      teardown();
    } finally {
      startingRef.current = false;
    }
  }, [cancelReconnect, clearRetryTimer, resetVisibleState, scheduleReconnect, teardown]);

  const startRef = useRef(start);
  startRef.current = start;

  const listenToChannel = useCallback((nextChannel) => {
    if (!nextChannel?.id) return;
    resumeChannelRef.current = null;
    void start({ nextMode: "monitor", nextChannel });
  }, [start]);

  const stopListening = useCallback(() => {
    resumeChannelRef.current = null;
    wantedChannelRef.current = null;
    cancelReconnect();
    // Between reconnect attempts there is no socket whose close would reset
    // the bar, so it is done here.
    if (!socketRef.current) resetVisibleState();
    teardown();
  }, [cancelReconnect, resetVisibleState, teardown]);

  const callRadio = useCallback((device) => {
    if (!device?.device_id) return;
    // Covers a channel that is mid-reconnect too, not only one that is live.
    if (wantedChannelRef.current) resumeChannelRef.current = wantedChannelRef.current;
    void start({ nextMode: "private", nextDevice: device });
  }, [start]);

  const callGroup = useCallback((devices) => {
    const picked = (devices || []).filter((device) => device?.device_id);
    if (!picked.length) return;
    if (wantedChannelRef.current) resumeChannelRef.current = wantedChannelRef.current;
    void start({
      nextMode: "private",
      nextDevice: {
        device_id: `group:${picked.map((device) => device.device_id).join(",")}`,
        name: picked.length === 1 ? picked[0].name : `${picked.length} radios`,
        group: picked,
      },
      nextDevices: picked,
    });
  }, [start]);

  const endCall = useCallback(() => {
    teardown();
  }, [teardown]);

  // A channel is opened listen-only, so the microphone is only asked for the
  // first time the operator talks on it. takeover cuts off whoever is talking.
  const sendPtt = useCallback(async (type) => {
    const mode = modeRef.current;
    if (!mode || socketRef.current?.readyState !== window.WebSocket.OPEN) return;
    heldRef.current = true;
    if (mode === "monitor") {
      try {
        await audioRef.current?.prepare({ microphone: true });
      } catch (reason) {
        heldRef.current = false;
        setMicBlocked(reason instanceof Error ? reason.message : "The microphone could not be opened.");
        return;
      }
      // Released while the browser was still asking for the microphone.
      if (!heldRef.current) return;
    }
    socketRef.current?.send(JSON.stringify({ type }));
  }, []);

  const startPtt = useCallback(() => void sendPtt("ptt.start"), [sendPtt]);
  const cutIn = useCallback(() => void sendPtt("ptt.takeover"), [sendPtt]);

  const stopPtt = useCallback(() => {
    heldRef.current = false;
    audioRef.current?.setTransmitting(false);
    if (socketRef.current?.readyState === window.WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "ptt.stop" }));
    }
  }, []);

  const value = useMemo(() => ({
    mode,
    callState,
    pttState,
    speaker,
    configured,
    error,
    busyBy,
    micBlocked,
    condition,
    channel,
    callDevice,
    listenToChannel,
    stopListening,
    callRadio,
    callGroup,
    endCall,
    startPtt,
    stopPtt,
    cutIn,
  }), [
    mode, callState, pttState, speaker, configured, error, busyBy, micBlocked, condition, channel, callDevice,
    listenToChannel, stopListening, callRadio, callGroup, endCall, startPtt, stopPtt, cutIn,
  ]);

  return <LiveRadioContext.Provider value={value}>{children}</LiveRadioContext.Provider>;
}

export function useLiveRadioSession() {
  const context = useContext(LiveRadioContext);
  if (!context) throw new Error("useLiveRadioSession requires a LiveRadioProvider.");
  return context;
}
