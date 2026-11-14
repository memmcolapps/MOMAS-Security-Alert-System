// Radio sounds, the way a real handset sounds:
//
//   "on"   - you got the channel: a short key-up click with a little crackle.
//   "tail" - a transmission ended (yours or someone else's): the "kssshh"
//            burst of static as the squelch closes.
//
// Both are made from filtered static rather than tones, so they read as
// "radio" and never as an alarm or a phone ring. Kept short and quiet so a
// busy channel does not fill the room with noise.

let ctx = null;

function context() {
  if (ctx) return ctx;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;
  ctx = new AudioContext();
  return ctx;
}

/** Call from the press itself, so the browser lets the sound play later. */
export function unlockChirps() {
  void context()?.resume().catch(() => {});
}

// White noise with crackle: every few milliseconds the level jumps at random,
// which is what turns a smooth hiss into the rough "krr" of a radio.
function staticBuffer(audio, seconds, crackle) {
  const rate = audio.sampleRate;
  const buffer = audio.createBuffer(1, Math.ceil(rate * seconds), rate);
  const data = buffer.getChannelData(0);
  const grain = Math.round(rate * 0.004);
  let level = 1;
  for (let i = 0; i < data.length; i += 1) {
    if (i % grain === 0) level = 1 - crackle + crackle * Math.random() * 1.6;
    data[i] = (Math.random() * 2 - 1) * level;
  }
  return buffer;
}

function burst(audio, destination, at, { length, level, crackle, centre, decay }) {
  const source = audio.createBufferSource();
  source.buffer = staticBuffer(audio, length, crackle);
  // A radio's speaker and voice filter: no deep rumble, no fizzy top.
  const band = audio.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = centre;
  band.Q.value = 0.7;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(level, at + 0.004);
  if (decay) {
    gain.gain.setValueAtTime(level, at + length * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  } else {
    gain.gain.setValueAtTime(level, at + length - 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  }
  source.connect(band);
  band.connect(gain);
  gain.connect(destination);
  source.start(at);
  source.stop(at + length + 0.01);
}

/**
 * Schedule one sound onto any audio context - the live one, or an offline
 * one when rendering a sample to listen to.
 */
export function playSound(kind, audio, destination, at = audio.currentTime + 0.01) {
  if (kind === "on") {
    // Key-up: a sharp click, then a brief rough crackle.
    burst(audio, destination, at, { length: 0.012, level: 0.5, crackle: 0.2, centre: 2600 });
    burst(audio, destination, at + 0.014, { length: 0.07, level: 0.16, crackle: 0.85, centre: 1900, decay: true });
  } else {
    // Squelch tail: "kssshh", loud at first and dying away.
    burst(audio, destination, at, { length: 0.26, level: 0.22, crackle: 0.6, centre: 2200, decay: true });
  }
}

export function chirp(kind) {
  const audio = context();
  if (!audio || audio.state !== "running") return;
  playSound(kind, audio, audio.destination);
}

/** A short buzz on phones that support it (Android; iPhones do not). */
export function buzz(ms = 35) {
  try {
    window.navigator.vibrate?.(ms);
  } catch {
    // Not supported.
  }
}
