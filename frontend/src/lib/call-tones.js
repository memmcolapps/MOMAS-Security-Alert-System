// Ring tones for console calls. Deliberately a plain telephone ring - two
// soft tones, on and off - so nobody in the room can mistake it for the SOS
// siren's rising sweep.
//
// "incoming" rings out loud; "ringback" is the quieter tone the caller hears
// while waiting. Both loop in the audio thread, so a background tab keeps
// ringing at the right pace.

let ctx = null;
let source = null;
let current = null;

function context() {
  if (ctx) return ctx;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;
  ctx = new AudioContext();
  return ctx;
}

function render(audio, kind) {
  const rate = audio.sampleRate;
  // Incoming: ring 0.4 s, pause 0.2 s, ring 0.4 s, then 2 s quiet (a UK-style
  // double ring). Ringback: one 1 s tone every 3 s, quieter.
  const pattern = kind === "incoming" ? [[0, 0.4], [0.6, 1.0]] : [[0, 1.0]];
  const length = kind === "incoming" ? 3.0 : 3.0;
  const level = kind === "incoming" ? 0.22 : 0.08;
  const buffer = audio.createBuffer(1, Math.round(rate * length), rate);
  const data = buffer.getChannelData(0);
  for (const [start, end] of pattern) {
    const from = Math.round(start * rate);
    const to = Math.round(end * rate);
    for (let i = from; i < to; i += 1) {
      const t = i / rate;
      // Short fades at each edge so the tone does not click.
      const edge = Math.min(1, (i - from) / (0.01 * rate), (to - i) / (0.01 * rate));
      data[i] = level * edge * (Math.sin(2 * Math.PI * 400 * t) + Math.sin(2 * Math.PI * 450 * t)) / 2;
    }
  }
  return buffer;
}

export function startTone(kind) {
  if (current === kind) return;
  stopTone();
  const audio = context();
  if (!audio) return;
  void audio.resume().catch(() => {});
  source = audio.createBufferSource();
  source.buffer = render(audio, kind);
  source.loop = true;
  source.connect(audio.destination);
  source.start();
  current = kind;
}

export function stopTone() {
  current = null;
  if (!source) return;
  try {
    source.stop();
  } catch {
    // Already stopped.
  }
  source.disconnect();
  source = null;
}

/** Call from a click so the browser lets the ring play later. */
export function unlockTones() {
  void context()?.resume().catch(() => {});
}
