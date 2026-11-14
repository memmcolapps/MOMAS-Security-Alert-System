import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { config } from "./app-config";
import { getActiveOrganizationId, getAuthToken } from "./api";
import { callQuality, endNotice, failNotice, readStats } from "./call-logic";
import { startTone, stopTone, unlockTones } from "./call-tones";
import { setRadioDuck } from "./live-radio";
import { reconnectDelay, useLiveRadioSession } from "./live-radio-session";
import { buildSocketUrl } from "./live-radio-url";
import { isAlarmSounding } from "./sos-siren";

// Console-to-console calls. The server (api/calls/live) says who is online,
// rings people and passes connection details between the two browsers; the
// voice itself goes browser to browser over WebRTC, encrypted end to end.
//
// Only the caller ever makes an offer - including when the connection has to
// be rebuilt after a network change - so the two sides never talk over each
// other while setting up.

const CallsContext = createContext(null);

// A connection reported "disconnected" often recovers by itself within a few
// seconds; after this long it is rebuilt, and after the longer one given up.
const RESTART_AFTER_MS = 4_000;
const GIVE_UP_AFTER_MS = 30_000;
const NOTICE_MS = 7_000;
const PING_MS = 25_000;

function callsUrl() {
  const url = buildSocketUrl(config.apiBase, window.location.origin, "api/calls/live");
  const token = getAuthToken();
  const organizationId = getActiveOrganizationId();
  if (token) url.searchParams.set("access_token", token);
  if (organizationId) url.searchParams.set("organization_id", organizationId);
  return url.toString();
}

function micErrorText(error) {
  if (error?.name === "NotFoundError" || error?.name === "OverconstrainedError") {
    return "This screen has no microphone, so it can't make calls.";
  }
  if (error?.name === "NotAllowedError") return "Microphone access is blocked for this site. Allow it in the browser to make calls.";
  if (error?.name === "NotReadableError") return "The microphone is in use by another application.";
  return "The microphone couldn't be opened.";
}

export function CallsProvider({ enabled, sessionKey, children }) {
  const radio = useLiveRadioSession();
  const onRadio = radio.mode === "monitor" || radio.mode === "private";

  const [connected, setConnected] = useState(false);
  const [canStart, setCanStart] = useState(false);
  const [people, setPeople] = useState([]);
  const [call, setCall] = useState(null);
  const [notice, setNotice] = useState(null);
  const [missed, setMissed] = useState([]);
  // Phones show a call full screen; "back to map" shrinks it to the strip.
  const [minimized, setMinimized] = useState(false);

  const socketRef = useRef(null);
  const iceRef = useRef([]);
  const callRef = useRef(null);
  const pcRef = useRef(null);
  const micRef = useRef(null);
  const audioRef = useRef(null);
  const pendingCandidatesRef = useRef([]);
  const statsRef = useRef({ timer: null, previous: null });
  const recoveryRef = useRef({ restart: null, giveUp: null });
  const wakeRef = useRef(null);
  const notificationRef = useRef(null);
  const onRadioRef = useRef(onRadio);
  onRadioRef.current = onRadio;

  const send = useCallback((message) => {
    const socket = socketRef.current;
    if (socket?.readyState === 1) socket.send(JSON.stringify(message));
  }, []);

  const update = useCallback((patch) => {
    // A late callback (a stats check, a timer) must never bring an ended call
    // back to life: only a patch that starts a call (it names a role) may
    // create one.
    if (patch !== null && !callRef.current && !patch.role) return;
    const next = patch === null ? null : { ...(callRef.current || {}), ...patch };
    if (!callRef.current && next) setMinimized(false);
    callRef.current = next;
    setCall(next);
  }, []);

  const showNotice = useCallback((value) => {
    if (!value) return;
    setNotice({ ...value, at: Date.now() });
    if (value.missed && value.peer) {
      setMissed((list) => [{ peer: value.peer, at: Date.now() }, ...list].slice(0, 10));
    }
  }, []);

  const clearRecovery = () => {
    clearTimeout(recoveryRef.current.restart);
    clearTimeout(recoveryRef.current.giveUp);
    recoveryRef.current = { restart: null, giveUp: null };
  };

  const teardownMedia = useCallback(() => {
    window.clearInterval(statsRef.current.timer);
    statsRef.current = { timer: null, previous: null };
    clearRecovery();
    const pc = pcRef.current;
    pcRef.current = null;
    if (pc) {
      pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = null;
      pc.close();
    }
    micRef.current?.getTracks().forEach((track) => track.stop());
    micRef.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    pendingCandidatesRef.current = [];
    void wakeRef.current?.release?.().catch(() => {});
    wakeRef.current = null;
    notificationRef.current?.close?.();
    notificationRef.current = null;
  }, []);

  const finish = useCallback((value) => {
    teardownMedia();
    stopTone();
    const peer = callRef.current?.peer;
    update(null);
    if (value) showNotice({ ...value, peer });
  }, [showNotice, teardownMedia, update]);

  // Browsers only play audio started from a click. Doing this on the click
  // that places or answers the call means the other side is heard at once.
  const unlockAudio = useCallback(() => {
    unlockTones();
    if (!audioRef.current) {
      const element = new window.Audio();
      element.autoplay = true;
      element.playsInline = true;
      audioRef.current = element;
    }
    audioRef.current.play().catch(() => {});
  }, []);

  const getMic = useCallback(async () => {
    if (micRef.current) return micRef.current;
    const stream = await window.navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    micRef.current = stream;
    return stream;
  }, []);

  const signal = useCallback((data) => {
    const id = callRef.current?.id;
    if (id) send({ type: "call.signal", callId: id, data });
  }, [send]);

  const makeOffer = useCallback(async (options) => {
    const pc = pcRef.current;
    if (!pc) return;
    const offer = await pc.createOffer(options);
    await pc.setLocalDescription(offer);
    signal({ description: pc.localDescription });
  }, [signal]);

  const restartConnection = useCallback(() => {
    const pc = pcRef.current;
    if (!pc) return;
    if (callRef.current?.role === "caller") {
      pc.restartIce?.();
      void makeOffer({ iceRestart: true }).catch(() => {});
    } else {
      signal({ restart: true });
    }
  }, [makeOffer, signal]);

  const startStats = useCallback(() => {
    if (statsRef.current.timer) return;
    statsRef.current.timer = window.setInterval(async () => {
      const pc = pcRef.current;
      if (!pc) return;
      const current = readStats(await pc.getStats().catch(() => new Map()));
      if (pcRef.current !== pc || !callRef.current) return;
      const quality = callQuality(statsRef.current.previous, current);
      statsRef.current.previous = current;
      if (quality && quality !== callRef.current?.quality) update({ quality });
    }, 2_000);
  }, [update]);

  const keepAwake = useCallback(() => {
    if (wakeRef.current || !window.navigator.wakeLock) return;
    window.navigator.wakeLock.request("screen").then((lock) => {
      wakeRef.current = lock;
      lock.addEventListener?.("release", () => {
        if (wakeRef.current === lock) wakeRef.current = null;
      });
    }).catch(() => {});
  }, []);

  const createPeer = useCallback(() => {
    if (pcRef.current) return pcRef.current;
    const pc = new window.RTCPeerConnection({ iceServers: iceRef.current });
    pcRef.current = pc;
    const mic = micRef.current;
    if (mic) mic.getTracks().forEach((track) => pc.addTrack(track, mic));
    else pc.addTransceiver("audio", { direction: "recvonly" });
    pc.onicecandidate = (event) => {
      if (event.candidate) signal({ candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      const element = audioRef.current || new window.Audio();
      audioRef.current = element;
      element.srcObject = event.streams[0] || new window.MediaStream([event.track]);
      element.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pcRef.current !== pc) return;
      const state = pc.connectionState;
      if (state === "connected") {
        clearRecovery();
        update({ phase: "active", reconnecting: false, answeredAt: callRef.current?.answeredAt || Date.now() });
        startStats();
        keepAwake();
        return;
      }
      if (state !== "disconnected" && state !== "failed") return;
      update({ reconnecting: true, quality: "poor" });
      const recovery = recoveryRef.current;
      if (state === "failed") {
        clearTimeout(recovery.restart);
        recovery.restart = null;
        restartConnection();
      } else if (!recovery.restart) {
        recovery.restart = setTimeout(() => {
          recoveryRef.current.restart = null;
          restartConnection();
        }, RESTART_AFTER_MS);
      }
      if (!recovery.giveUp) {
        recovery.giveUp = setTimeout(() => {
          const id = callRef.current?.id;
          if (id) send({ type: "call.end", callId: id });
          finish({ text: "Call dropped: the connection was lost" });
        }, GIVE_UP_AFTER_MS);
      }
    };
    return pc;
  }, [finish, keepAwake, restartConnection, send, signal, startStats, update]);

  const onSignal = useCallback(async (data) => {
    const pc = pcRef.current;
    if (!pc || !data) return;
    try {
      if (data.description) {
        await pc.setRemoteDescription(data.description);
        for (const candidate of pendingCandidatesRef.current.splice(0)) {
          await pc.addIceCandidate(candidate).catch(() => {});
        }
        if (data.description.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          signal({ description: pc.localDescription });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else pendingCandidatesRef.current.push(data.candidate);
      } else if (data.restart && callRef.current?.role === "caller") {
        restartConnection();
      }
    } catch {
      // A bad description from the other side: the recovery timers handle it.
    }
  }, [restartConnection, signal]);

  // ── messages from the server ─────────────────────────────────────────
  const onMessage = useCallback((message) => {
    const current = callRef.current;
    const isThisCall = current && message.callId && current.id === message.callId;
    switch (message.type) {
      case "ready":
        iceRef.current = message.iceServers || [];
        setCanStart(Boolean(message.canStart));
        setConnected(true);
        send({ type: "status", onRadio: onRadioRef.current });
        if (current?.id && (current.phase === "active" || current.phase === "connecting")) {
          send({ type: "call.resume", callId: current.id });
        } else if (current) {
          // A call still ringing when the connection dropped was cancelled
          // by the server.
          finish({ text: "Call ended" });
        }
        return;
      case "presence":
        setPeople(Array.isArray(message.people) ? message.people : []);
        return;
      case "call.outgoing":
        if (current?.role !== "caller" || current.id) return;
        if (current.cancelled) {
          send({ type: "call.cancel", callId: message.callId });
          callRef.current = null;
          return;
        }
        update({ id: message.callId, peer: message.peer || current.peer });
        return;
      case "call.failed":
        if (current?.role === "caller" && !current.id) {
          finish(current.cancelled ? null : { text: failNotice(message.reason, current.peer?.name) });
        }
        return;
      case "call.incoming": {
        if (current) return;
        update({ id: message.callId, role: "callee", peer: message.peer, phase: "ringing", muted: false });
        if (window.document.hidden && window.Notification?.permission === "granted") {
          try {
            const note = new window.Notification("Incoming call", {
              body: message.peer?.name || "A colleague is calling",
              tag: `call-${message.callId}`,
              requireInteraction: true,
            });
            note.onclick = () => {
              window.focus();
              note.close();
            };
            notificationRef.current = note;
          } catch {
            // Notifications unavailable; the ring and the card still work.
          }
        }
        return;
      }
      case "call.accepted":
        if (!isThisCall) return;
        stopTone();
        update({ phase: "connecting" });
        createPeer();
        if (message.role === "caller") void makeOffer().catch(() => {});
        return;
      case "call.signal":
        if (isThisCall) void onSignal(message.data);
        return;
      case "call.ended":
        if (isThisCall) finish(endNotice(message.reason, current.role, current.peer?.name));
        return;
      case "call.peer_away":
        if (isThisCall) update({ peerAway: true });
        return;
      case "call.peer_back":
        if (isThisCall) update({ peerAway: false });
        return;
      case "call.resumed":
        if (!isThisCall) return;
        update({ peerAway: false });
        if (pcRef.current && pcRef.current.connectionState !== "connected") restartConnection();
        return;
    }
  }, [createPeer, finish, makeOffer, onSignal, restartConnection, send, update]);

  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  // ── the control connection ───────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !window.WebSocket || !window.RTCPeerConnection) return undefined;
    let stopped = false;
    let attempt = 0;
    let retryTimer = null;
    let pingTimer = null;

    const open = () => {
      if (stopped) return;
      let socket;
      try {
        socket = new window.WebSocket(callsUrl());
      } catch {
        retryTimer = setTimeout(open, reconnectDelay(attempt++));
        return;
      }
      socketRef.current = socket;
      socket.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "ready") attempt = 0;
        onMessageRef.current(message);
      };
      socket.onopen = () => {
        window.clearInterval(pingTimer);
        pingTimer = window.setInterval(() => {
          if (socket.readyState === 1) socket.send(JSON.stringify({ type: "ping" }));
        }, PING_MS);
      };
      socket.onclose = (event) => {
        window.clearInterval(pingTimer);
        if (socketRef.current === socket) socketRef.current = null;
        setConnected(false);
        if (stopped || event.code === 4003) return;
        retryTimer = setTimeout(open, reconnectDelay(attempt++));
      };
    };
    open();

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      window.clearInterval(pingTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      teardownMedia();
      stopTone();
      callRef.current = null;
      setCall(null);
      setPeople([]);
      setConnected(false);
      setMissed([]);
    };
  }, [enabled, sessionKey, teardownMedia]);

  useEffect(() => {
    if (connected) send({ type: "status", onRadio });
  }, [connected, onRadio, send]);

  // Ring while an incoming call waits - silently while an alarm is sounding,
  // so the SOS siren is never muddied by a phone ring.
  const ringing = call?.phase === "ringing";
  const [silentRing, setSilentRing] = useState(false);
  useEffect(() => {
    if (!ringing) {
      setSilentRing(false);
      return undefined;
    }
    const tick = () => {
      const alarm = isAlarmSounding();
      setSilentRing(alarm);
      if (alarm) stopTone();
      else startTone("incoming");
    };
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => {
      window.clearInterval(timer);
      stopTone();
    };
  }, [ringing]);

  // The radio keeps playing during a call, quieter.
  const talking = call?.phase === "active" || call?.phase === "connecting";
  useEffect(() => {
    setRadioDuck(talking ? 0.3 : 1);
    return () => setRadioDuck(1);
  }, [talking]);

  // The screen lock is dropped whenever the tab is hidden; take it back.
  useEffect(() => {
    if (call?.phase !== "active") return undefined;
    const onVisible = () => {
      if (!window.document.hidden) keepAwake();
    };
    window.document.addEventListener("visibilitychange", onVisible);
    return () => window.document.removeEventListener("visibilitychange", onVisible);
  }, [call?.phase, keepAwake]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // ── actions ──────────────────────────────────────────────────────────
  const startCall = useCallback(async (person) => {
    if (callRef.current || !person) return;
    unlockAudio();
    update({ id: null, role: "caller", peer: person, phase: "calling", muted: false });
    try {
      await getMic();
    } catch (error) {
      finish({ text: micErrorText(error) });
      return;
    }
    if (!callRef.current || callRef.current.cancelled) {
      finish(null);
      return;
    }
    send({ type: "call.invite", to: person.userId });
    startTone("ringback");
  }, [finish, getMic, send, unlockAudio, update]);

  const answer = useCallback(async () => {
    const current = callRef.current;
    if (current?.phase !== "ringing") return;
    unlockAudio();
    stopTone();
    update({ phase: "connecting" });
    let noMic = false;
    try {
      await getMic();
    } catch (error) {
      // Answer anyway: a wall screen without a microphone can still listen.
      noMic = true;
      showNotice({ text: `${micErrorText(error)} They won't hear you.` });
    }
    if (callRef.current?.id !== current.id) {
      micRef.current?.getTracks().forEach((track) => track.stop());
      micRef.current = null;
      return;
    }
    update({ noMic });
    send({ type: "call.accept", callId: current.id });
  }, [getMic, send, showNotice, unlockAudio, update]);

  const decline = useCallback(() => {
    const current = callRef.current;
    if (current?.phase !== "ringing") return;
    send({ type: "call.decline", callId: current.id });
    finish(null);
  }, [finish, send]);

  const hangUp = useCallback(() => {
    const current = callRef.current;
    if (!current) return;
    if (current.role === "caller" && !current.id) {
      // The server has not named the call yet; cancel it the moment it does.
      update({ cancelled: true });
      teardownMedia();
      stopTone();
      setCall(null);
      return;
    }
    send({ type: current.phase === "calling" ? "call.cancel" : "call.end", callId: current.id });
    finish(null);
  }, [finish, send, teardownMedia, update]);

  const toggleMute = useCallback(() => {
    const current = callRef.current;
    if (!current || !micRef.current) return;
    const muted = !current.muted;
    micRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    update({ muted });
  }, [update]);

  const clearMissed = useCallback(() => setMissed([]), []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const value = useMemo(() => ({
    available: Boolean(enabled && typeof window !== "undefined" && window.RTCPeerConnection),
    connected,
    canStart,
    people,
    call,
    silentRing,
    notice,
    missed,
    minimized,
    setMinimized,
    startCall,
    answer,
    decline,
    hangUp,
    toggleMute,
    clearMissed,
    dismissNotice,
  }), [
    enabled, connected, canStart, people, call, silentRing, notice, missed, minimized,
    startCall, answer, decline, hangUp, toggleMute, clearMissed, dismissNotice,
  ]);

  return <CallsContext.Provider value={value}>{children}</CallsContext.Provider>;
}

export function useCalls() {
  const context = useContext(CallsContext);
  if (!context) throw new Error("useCalls requires a CallsProvider.");
  return context;
}
