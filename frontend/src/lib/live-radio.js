import BenzAMRRecorder from "benz-amr-recorder";
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

export function liveRadioUrl() {
  const url = buildLiveRadioUrl(config.apiBase, window.location.origin);
  const token = getAuthToken();
  const organizationId = getActiveOrganizationId();
  if (token) url.searchParams.set("access_token", token);
  if (organizationId) url.searchParams.set("organization_id", organizationId);
  return url.toString();
}

export class BrowserRadioAudio {
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
    // getUserMedia reports all of these as a bare DOMException, and the browser
    // wording for "this machine has no microphone" is "Requested device not
    // found" - which reads on a radio console as though the *radio* was not
    // found. On a wall-mounted command screen with no mic that is exactly the
    // wrong thing to tell an operator.
    try {
      this.stream = await window.navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      const failure = new Error(
        error?.name === "NotFoundError" || error?.name === "OverconstrainedError"
          ? "This screen has no microphone, so you cannot transmit from it."
          : error?.name === "NotAllowedError"
            ? "Microphone access is blocked for this site, so you cannot transmit."
            : error?.name === "NotReadableError"
              ? "The microphone is already in use by another application."
              : `The microphone could not be opened: ${error?.message || error}`,
      );
      failure.code = "microphone_unavailable";
      throw failure;
    }
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
    // Clamp the scheduling cursor to a small jitter window ahead of the clock.
    // Without this, playhead only ever grows: audio arriving faster than
    // real-time (bursts, bridge buffering) pushes it seconds into the future
    // and it never recovers across the silence between speakers, so a busy
    // channel appears to hang after the first talk-spurt.
    const now = context.currentTime;
    if (this.playhead < now + 0.025 || this.playhead > now + 0.5) {
      this.playhead = now + 0.05;
    }
    source.start(this.playhead);
    this.playhead += buffer.duration;
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
