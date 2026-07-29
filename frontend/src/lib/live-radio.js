import BenzAMRRecorder from "benz-amr-recorder";
import { useCallback, useEffect, useRef, useState } from "react";
import { config } from "./app-config";
import { getActiveOrganizationId, getAuthToken } from "./api";
import { buildLiveRadioUrl } from "./live-radio-url";

const AMR_HEADER = new Uint8Array([35, 33, 65, 77, 82, 10]);

function joinFloat32(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const joined = new Float32Array(length + 1);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

function liveRadioUrl() {
  const url = buildLiveRadioUrl(config.apiBase, window.location.origin);
  const token = getAuthToken();
  const organizationId = getActiveOrganizationId();
  if (token) url.searchParams.set("access_token", token);
  if (organizationId) url.searchParams.set("organization_id", organizationId);
  return url.toString();
}

class BrowserRadioAudio {
  constructor(sendAudio) {
    this.sendAudio = sendAudio;
    this.context = null;
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.silentGain = null;
    this.transmitting = false;
    this.capture = [];
    this.captureLength = 0;
    this.encodeQueue = Promise.resolve();
    this.decoder = new BenzAMRRecorder();
    this.incoming = [];
    this.incomingTimer = null;
    this.playhead = 0;
    this.closed = false;
  }

  async prepare({ microphone = false } = {}) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      throw new Error("This browser cannot use live radio audio.");
    }
    if (!this.context) this.context = new AudioContext();
    await this.context.resume();
    if (!microphone || this.stream) return;
    if (!window.navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot use a microphone for live radio.");
    }
    this.stream = await window.navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.silentGain = this.context.createGain();
    this.silentGain.gain.value = 0;
    this.processor.onaudioprocess = (event) => {
      if (!this.transmitting) return;
      const samples = new Float32Array(event.inputBuffer.getChannelData(0));
      this.capture.push(samples);
      this.captureLength += samples.length;
      if (this.captureLength >= this.context.sampleRate * 0.1) this.flushCapture();
    };
    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.context.destination);
  }

  setTransmitting(value) {
    this.transmitting = value;
    if (!value) this.flushCapture();
  }

  flushCapture() {
    if (!this.captureLength) return;
    const samples = joinFloat32(this.capture);
    const sampleRate = this.context.sampleRate;
    const decoder = this.decoder;
    this.capture = [];
    this.captureLength = 0;
    if (!decoder) return;
    this.encodeQueue = this.encodeQueue.then(async () => {
      const encoded = await decoder.encodeAMRAsync(samples, sampleRate);
      if (encoded?.length > AMR_HEADER.length) {
        this.sendAudio(encoded.subarray(AMR_HEADER.length));
      }
    }).catch(() => {});
  }

  receive(frame) {
    this.incoming.push(new Uint8Array(frame));
    if (this.incomingTimer) return;
    this.incomingTimer = window.setTimeout(() => {
      this.incomingTimer = null;
      void this.playIncoming();
    }, 120);
  }

  async playIncoming() {
    const context = this.context;
    const decoder = this.decoder;
    if (!this.incoming.length || !context || !decoder) return;
    const length = this.incoming.reduce((total, frame) => total + frame.length, AMR_HEADER.length);
    const amr = new Uint8Array(length);
    amr.set(AMR_HEADER);
    let offset = AMR_HEADER.length;
    for (const frame of this.incoming.splice(0)) {
      amr.set(frame, offset);
      offset += frame.length;
    }
    const pcm = await decoder.decodeAMRAsync(amr);
    if (!pcm?.length || this.closed || context.state === "closed") return;
    await context.resume();
    const buffer = context.createBuffer(1, pcm.length, 8000);
    buffer.copyToChannel(pcm, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const start = Math.max(context.currentTime + 0.025, this.playhead);
    source.start(start);
    this.playhead = start + buffer.duration;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.incomingTimer) window.clearTimeout(this.incomingTimer);
    this.incomingTimer = null;
    this.capture = [];
    this.captureLength = 0;
    this.incoming = [];
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close().catch(() => {});
    // benz-amr-recorder 1.1.5 throws in destroy() when no playback source
    // exists. Dropping the reference lets the browser reclaim it safely.
    this.decoder = null;
    this.stream = null;
    this.context = null;
  }
}

export function useLiveRadio(deviceId) {
  const socketRef = useRef(null);
  const audioRef = useRef(null);
  const heldRef = useRef(false);
  const modeRef = useRef(null);
  const [callState, setCallState] = useState("idle");
  const [mode, setMode] = useState(null);
  const [pttState, setPttState] = useState("idle");
  const [speakerUid, setSpeakerUid] = useState(null);
  const [configured, setConfigured] = useState(null);
  const [error, setError] = useState("");

  const disconnect = useCallback(() => {
    heldRef.current = false;
    audioRef.current?.setTransmitting(false);
    if (socketRef.current?.readyState === window.WebSocket.OPEN) {
      if (modeRef.current === "private") {
        socketRef.current.send(JSON.stringify({ type: "ptt.stop" }));
        socketRef.current.send(JSON.stringify({ type: "call.end" }));
      } else if (modeRef.current === "monitor") {
        socketRef.current.send(JSON.stringify({ type: "monitor.end" }));
      }
    }
    socketRef.current?.close();
    socketRef.current = null;
    audioRef.current?.close();
    audioRef.current = null;
    modeRef.current = null;
    setMode(null);
    setCallState("idle");
    setPttState("idle");
    setSpeakerUid(null);
  }, []);

  useEffect(() => disconnect, [deviceId, disconnect]);

  const connect = useCallback(async (requestedMode = "private") => {
    if (!deviceId || callState !== "idle") return;
    modeRef.current = requestedMode;
    setMode(requestedMode);
    setError("");
    setCallState("connecting");
    try {
      let socket = null;
      const audio = new BrowserRadioAudio((data) => {
        if (socket?.readyState === window.WebSocket.OPEN) socket.send(data);
      });
      audioRef.current = audio;
      await audio.prepare({ microphone: requestedMode === "private" });
      socket = new window.WebSocket(liveRadioUrl());
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      socket.onmessage = async (event) => {
        if (typeof event.data !== "string") {
          audio.receive(event.data);
          return;
        }
        const message = JSON.parse(event.data);
        if (message.type === "ready") {
          setConfigured(Boolean(message.configured));
          if (!message.configured) {
            setError("Live radio is not configured on this MOMAS server.");
            socket.close();
            return;
          }
          try {
            socket.send(JSON.stringify({
              type: requestedMode === "monitor" ? "monitor.start" : "call.start",
              deviceId,
            }));
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Live radio audio could not be prepared.");
            socket.close();
          }
        }
        if (message.type === "call.state") setCallState(message.state);
        if (message.type === "monitor.state") setCallState(message.state);
        if (message.type === "ptt.state") {
          setPttState(message.state);
          audio.setTransmitting(message.state === "granted" && heldRef.current);
        }
        if (message.type === "speaker") {
          setSpeakerUid(message.speaking ? message.uid : null);
        }
        if (message.type === "error") {
          setError(message.message || "Live radio failed.");
          const startFailed = (
            message.code === "pocstars_call_failed"
            || message.code === "pocstars_monitor_failed"
            || message.code === "live_radio_not_configured"
            || message.code === "division_not_mapped"
            || message.code === "radio_console_busy"
            || message.code === "forbidden"
            || message.code === "invalid_radio_uid"
            || message.code === "invalid_group_id"
          );
          if (startFailed) {
            setCallState("idle");
            socket.close();
          }
        }
      };
      socket.onerror = () => {
        setCallState("idle");
        setError("The live-radio connection could not be opened.");
      };
      socket.onclose = () => {
        setCallState("idle");
        setPttState("idle");
        setMode(null);
        modeRef.current = null;
        audio.setTransmitting(false);
        audio.close();
        if (audioRef.current === audio) audioRef.current = null;
        if (socketRef.current === socket) socketRef.current = null;
      };
    } catch (reason) {
      setCallState("idle");
      setError(reason instanceof Error ? reason.message : "Live radio could not be started.");
      disconnect();
    }
  }, [callState, deviceId, disconnect]);

  const callRadio = useCallback(() => connect("private"), [connect]);
  const listenToDivision = useCallback(() => connect("monitor"), [connect]);

  const startPtt = useCallback(() => {
    if (modeRef.current !== "private" || callState !== "connected" || socketRef.current?.readyState !== window.WebSocket.OPEN) return;
    heldRef.current = true;
    socketRef.current.send(JSON.stringify({ type: "ptt.start" }));
  }, [callState]);

  const stopPtt = useCallback(() => {
    heldRef.current = false;
    audioRef.current?.setTransmitting(false);
    if (socketRef.current?.readyState === window.WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "ptt.stop" }));
    }
  }, []);

  return {
    callState,
    pttState,
    speakerUid,
    configured,
    mode,
    error,
    connect: callRadio,
    callRadio,
    listenToDivision,
    disconnect,
    startPtt,
    stopPtt,
  };
}
