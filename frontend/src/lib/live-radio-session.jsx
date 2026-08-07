import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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

export function LiveRadioProvider({ children }) {
  const socketRef = useRef(null);
  const audioRef = useRef(null);
  const heldRef = useRef(false);
  const modeRef = useRef(null);
  const resumeChannelRef = useRef(null);
  const startingRef = useRef(false);
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

  // Send the leave frames and close the socket. Ref/state cleanup is left to
  // the socket's onclose so there is exactly one place that resets state.
  const teardown = useCallback(() => {
    heldRef.current = false;
    audioRef.current?.setTransmitting(false);
    const socket = socketRef.current;
    if (socket?.readyState === window.WebSocket.OPEN) {
      if (modeRef.current === "private") {
        socket.send(JSON.stringify({ type: "ptt.stop" }));
        socket.send(JSON.stringify({ type: "call.end" }));
      } else if (modeRef.current === "monitor") {
        socket.send(JSON.stringify({ type: "monitor.end" }));
      }
    }
    socket?.close();
  }, []);

  const start = useCallback(async ({ nextMode, nextChannel, nextDevice }) => {
    if (startingRef.current) return;
    startingRef.current = true;
    setError("");
    setBusyBy(null);
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
      setCallState("connecting");

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
            setCondition("Live radio is not configured on this MOMAS server.");
            socket.close();
            return;
          }
          setCondition("");
          socket.send(JSON.stringify(
            nextMode === "monitor"
              ? { type: "monitor.start", channelId: nextChannel.id }
              : { type: "call.start", deviceId: nextDevice.device_id },
          ));
        }
        if (message.type === "call.state" || message.type === "monitor.state") {
          setCallState(message.state);
        }
        if (message.type === "ptt.state") {
          setPttState(message.state);
          audio.setTransmitting(message.state === "granted" && heldRef.current);
        }
        if (message.type === "speaker") {
          setSpeaker(message.speaking ? { uid: message.uid, name: message.name } : null);
        }
        if (message.type === "error") {
          setError(message.message || "Live radio failed.");
          if (message.busyBy) setBusyBy(message.busyBy);
          if (START_FAIL_CODES.has(message.code)) {
            resumeChannelRef.current = null;
            socket.close();
          }
        }
      };
      socket.onerror = () => {
        if (sessionIdRef.current === mySession) {
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
        const closedMode = modeRef.current;
        modeRef.current = null;
        const resume = resumeChannelRef.current;
        if (closedMode === "private" && resume) {
          resumeChannelRef.current = null;
          resetVisibleState();
          setTimeout(() => {
            void startRef.current({ nextMode: "monitor", nextChannel: resume });
          }, 400);
        } else {
          resetVisibleState();
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
  }, [resetVisibleState, teardown]);

  const startRef = useRef(start);
  startRef.current = start;

  const listenToChannel = useCallback((nextChannel) => {
    if (!nextChannel?.id) return;
    resumeChannelRef.current = null;
    void start({ nextMode: "monitor", nextChannel });
  }, [start]);

  const stopListening = useCallback(() => {
    resumeChannelRef.current = null;
    teardown();
  }, [teardown]);

  const callRadio = useCallback((device) => {
    if (!device?.device_id) return;
    if (modeRef.current === "monitor") resumeChannelRef.current = channel;
    void start({ nextMode: "private", nextDevice: device });
  }, [channel, start]);

  const endCall = useCallback(() => {
    teardown();
  }, [teardown]);

  const startPtt = useCallback(() => {
    if (modeRef.current !== "private" || socketRef.current?.readyState !== window.WebSocket.OPEN) return;
    heldRef.current = true;
    socketRef.current.send(JSON.stringify({ type: "ptt.start" }));
  }, []);

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
    endCall,
    startPtt,
    stopPtt,
  }), [
    mode, callState, pttState, speaker, configured, error, busyBy, micBlocked, condition, channel, callDevice,
    listenToChannel, stopListening, callRadio, endCall, startPtt, stopPtt,
  ]);

  return <LiveRadioContext.Provider value={value}>{children}</LiveRadioContext.Provider>;
}

export function useLiveRadioSession() {
  const context = useContext(LiveRadioContext);
  if (!context) throw new Error("useLiveRadioSession requires a LiveRadioProvider.");
  return context;
}
