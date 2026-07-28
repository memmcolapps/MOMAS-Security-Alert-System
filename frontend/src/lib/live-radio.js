import BenzAMRRecorder from "benz-amr-recorder";
import { useCallback, useEffect, useRef, useState } from "react";
import { config } from "./app-config";
import { getActiveOrganizationId, getAuthToken } from "./api";

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
  const base = config.apiBase || window.location.origin;
  const url = new URL("/api/pocstars/radio/live", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
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
  }

  async prepare() {
    if (this.stream) {
      await this.context?.resume();
      return;
    }
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext || !window.navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot use live radio audio.");
    }
    this.context = new AudioContext();
    await this.context.resume();
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
    this.capture = [];
    this.captureLength = 0;
    this.encodeQueue = this.encodeQueue.then(async () => {
      const encoded = await this.decoder.encodeAMRAsync(samples, sampleRate);
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
    if (!this.incoming.length || !this.context) return;
    const length = this.incoming.reduce((total, frame) => total + frame.length, AMR_HEADER.length);
    const amr = new Uint8Array(length);
    amr.set(AMR_HEADER);
    let offset = AMR_HEADER.length;
    for (const frame of this.incoming.splice(0)) {
      amr.set(frame, offset);
      offset += frame.length;
    }
    const pcm = await this.decoder.decodeAMRAsync(amr);
    if (!pcm?.length) return;
    await this.context.resume();
    const buffer = this.context.createBuffer(1, pcm.length, 8000);
    buffer.copyToChannel(pcm, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const start = Math.max(this.context.currentTime + 0.025, this.playhead);
    source.start(start);
    this.playhead = start + buffer.duration;
  }

  close() {
    if (this.incomingTimer) window.clearTimeout(this.incomingTimer);
    this.incomingTimer = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.decoder?.destroy();
    this.stream = null;
    this.context = null;
  }
}

export function useLiveRadio(deviceId) {
  const socketRef = useRef(null);
  const audioRef = useRef(null);
  const heldRef = useRef(false);
  const [callState, setCallState] = useState("idle");
  const [pttState, setPttState] = useState("idle");
  const [speakerUid, setSpeakerUid] = useState(null);
  const [configured, setConfigured] = useState(null);
  const [error, setError] = useState("");

  const disconnect = useCallback(() => {
    heldRef.current = false;
    audioRef.current?.setTransmitting(false);
    if (socketRef.current?.readyState === window.WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "ptt.stop" }));
      socketRef.current.send(JSON.stringify({ type: "call.end" }));
    }
    socketRef.current?.close();
    socketRef.current = null;
    audioRef.current?.close();
    audioRef.current = null;
    setCallState("idle");
    setPttState("idle");
    setSpeakerUid(null);
  }, []);

  useEffect(() => disconnect, [deviceId, disconnect]);

  const connect = useCallback(async () => {
    if (!deviceId || callState !== "idle") return;
    setError("");
    setCallState("connecting");
    try {
      const socket = new window.WebSocket(liveRadioUrl());
      socket.binaryType = "arraybuffer";
      const audio = new BrowserRadioAudio((data) => {
        if (socket.readyState === window.WebSocket.OPEN) socket.send(data);
      });
      audioRef.current = audio;
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
            await audio.prepare();
            socket.send(JSON.stringify({ type: "call.start", deviceId }));
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Microphone access was not granted.");
            socket.close();
          }
        }
        if (message.type === "call.state") setCallState(message.state);
        if (message.type === "ptt.state") {
          setPttState(message.state);
          audio.setTransmitting(message.state === "granted" && heldRef.current);
        }
        if (message.type === "speaker") {
          setSpeakerUid(message.speaking ? message.uid : null);
        }
        if (message.type === "error") {
          setError(message.message || "Live radio failed.");
          if (message.code === "pocstars_call_failed" || message.code === "live_radio_not_configured") {
            setCallState("idle");
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
        audio.setTransmitting(false);
      };
    } catch (reason) {
      setCallState("idle");
      setError(reason instanceof Error ? reason.message : "Microphone access was not granted.");
      disconnect();
    }
  }, [callState, deviceId, disconnect]);

  const startPtt = useCallback(() => {
    if (callState !== "connected" || socketRef.current?.readyState !== window.WebSocket.OPEN) return;
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
    error,
    connect,
    disconnect,
    startPtt,
    stopPtt,
  };
}
