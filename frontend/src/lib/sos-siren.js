// The SOS siren: a fast rising "yelp" sweep, the sound people already read as
// an emergency vehicle rather than a notification.
//
// One cycle is rendered once into a buffer and played back with loop=true.
// The previous tone was re-triggered from setInterval, and browsers throttle
// timers in background tabs down to once a minute, so a console left on
// another tab rang about as often as a doorbell. A looping buffer source runs
// in the audio thread and keeps its pace whatever the tab is doing.
//
// Browsers also refuse to play sound until someone has clicked or pressed a
// key on the page. A wall screen nobody has touched is therefore silent, which
// is why the state is published: the console shows a prompt while sound is
// blocked instead of failing quietly on the night it matters.

const SWEEPS = 6;
const SWEEP_SECONDS = 0.28;
const CYCLE_SECONDS = SWEEPS * SWEEP_SECONDS;

let ctx = null;
let output = null;
let buffer = null;
let rendering = null;
let source = null;
let wanted = false;
const listeners = new Set();

function notify() {
  listeners.forEach((listener) => listener());
}

function audioContextClass() {
  return window.AudioContext || window.webkitAudioContext || null;
}

function ensureContext() {
  if (ctx) return ctx;
  const AudioContext = audioContextClass();
  if (!AudioContext) return null;
  ctx = new AudioContext();
  ctx.onstatechange = notify;
  // Gain into a compressor: loud enough to cut through a busy room without
  // the square/sawtooth mix clipping into mush.
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.ratio.value = 6;
  output = ctx.createGain();
  output.gain.value = 0.8;
  output.connect(compressor);
  compressor.connect(ctx.destination);
  return ctx;
}

function addVoice(offline, type, start, end, fromHz, toHz, level) {
  const osc = offline.createOscillator();
  const gain = offline.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(fromHz, start);
  osc.frequency.exponentialRampToValueAtTime(toHz, end);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(level, start + 0.01);
  gain.gain.setValueAtTime(level, end - 0.015);
  gain.gain.linearRampToValueAtTime(0, end);
  osc.connect(gain);
  gain.connect(offline.destination);
  osc.start(start);
  osc.stop(end);
}

async function renderCycle(sampleRate) {
  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offline = new OfflineContext(1, Math.ceil(CYCLE_SECONDS * sampleRate), sampleRate);
  for (let i = 0; i < SWEEPS; i += 1) {
    const start = i * SWEEP_SECONDS;
    const end = start + SWEEP_SECONDS - 0.01;
    // Two slightly detuned voices beat against each other, which is what
    // gives a siren its rasp.
    addVoice(offline, "sawtooth", start, end, 650, 1500, 0.22);
    addVoice(offline, "square", start, end, 655, 1512, 0.12);
  }
  return offline.startRendering();
}

function loadBuffer() {
  if (buffer) return Promise.resolve(buffer);
  if (!rendering) {
    rendering = renderCycle(ctx.sampleRate)
      .then((rendered) => {
        buffer = rendered;
        return rendered;
      })
      .finally(() => {
        rendering = null;
      });
  }
  return rendering;
}

/** "unsupported", "blocked" (needs a click first) or "ready". */
export function sirenState() {
  if (!audioContextClass()) return "unsupported";
  if (!ctx) return "blocked";
  return ctx.state === "running" ? "ready" : "blocked";
}

export function subscribeSiren(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Create the audio context and try to resume it; must run on a user gesture to succeed. */
export function armSiren() {
  if (!ensureContext()) return Promise.resolve();
  notify();
  return ctx.resume().catch(() => {});
}

export async function startSiren() {
  wanted = true;
  if (source || !ensureContext()) return;
  // While the context is still suspended this schedules nothing audible; the
  // loop starts the moment anyone clicks, because the source is already set.
  void ctx.resume().catch(() => {});
  const cycle = await loadBuffer().catch(() => null);
  if (!cycle || !wanted || source) return;
  source = ctx.createBufferSource();
  source.buffer = cycle;
  source.loop = true;
  source.connect(output);
  source.start();
}

export function stopSiren() {
  wanted = false;
  if (!source) return;
  try {
    source.stop();
  } catch {
    // Already stopped.
  }
  source.disconnect();
  source = null;
}

// The three levels are all alarms, of falling urgency:
//   red    — the siren above, without a break, until answered.
//   amber  — a fire-alarm style triple beep, round again every 1.5 s, until answered.
//   yellow — a two-tone warning burst (hi-lo, twice), round again every 4 s, until answered.
// Both are rendered like the siren, so a background tab keeps the pace.

/** A beep at one pitch: two slightly detuned square waves, for the same rasp as the siren. */
function addBeep(offline, hz, start, length, level) {
  addVoice(offline, "square", start, start + length, hz, hz, level);
  addVoice(offline, "square", start, start + length, hz * 1.006, hz * 1.006, level * 0.5);
}

function renderPattern(sampleRate, seconds, draw) {
  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offline = new OfflineContext(1, Math.ceil(seconds * sampleRate), sampleRate);
  draw(offline);
  return offline.startRendering();
}

const AMBER_CYCLE_SECONDS = 1.5;
const renderAmber = (sampleRate) =>
  renderPattern(sampleRate, AMBER_CYCLE_SECONDS, (offline) => {
    for (let i = 0; i < 3; i += 1) addBeep(offline, 1050, i * 0.24, 0.16, 0.2);
  });

// The burst takes 1.4 s; the rest of the cycle is quiet, so it is the least pressing of the three.
const YELLOW_SECONDS = 4;
const renderYellow = (sampleRate) =>
  renderPattern(sampleRate, YELLOW_SECONDS, (offline) => {
    [880, 660, 880, 660].forEach((hz, i) => addBeep(offline, hz, i * 0.36, 0.32, 0.16));
  });

const rendered = new Map();
function loadPattern(name, render) {
  if (!rendered.has(name)) {
    const promise = render(ctx.sampleRate);
    // A failed render is tried again next time instead of being remembered.
    promise.catch(() => rendered.delete(name));
    rendered.set(name, promise);
  }
  return rendered.get(name);
}

let amberSource = null;
let amberWanted = false;

/** Amber: the triple beep repeats until stopped. Same first-click arming as the siren. */
export async function startAmberAlarm() {
  amberWanted = true;
  if (amberSource || !ensureContext()) return;
  void ctx.resume().catch(() => {});
  const cycle = await loadPattern("amber", renderAmber).catch(() => null);
  if (!cycle || !amberWanted || amberSource) return;
  amberSource = ctx.createBufferSource();
  amberSource.buffer = cycle;
  amberSource.loop = true;
  amberSource.connect(output);
  amberSource.start();
}

export function stopAmberAlarm() {
  amberWanted = false;
  if (!amberSource) return;
  try {
    amberSource.stop();
  } catch {
    // Already stopped.
  }
  amberSource.disconnect();
  amberSource = null;
}

let yellowSource = null;
let yellowWanted = false;

/** Yellow: the hi-lo burst, round again every few seconds until stopped. */
export async function startYellowAlarm() {
  yellowWanted = true;
  if (yellowSource || !ensureContext()) return;
  void ctx.resume().catch(() => {});
  const cycle = await loadPattern("yellow", renderYellow).catch(() => null);
  if (!cycle || !yellowWanted || yellowSource) return;
  yellowSource = ctx.createBufferSource();
  yellowSource.buffer = cycle;
  yellowSource.loop = true;
  yellowSource.connect(output);
  yellowSource.start();
}

export function stopYellowAlarm() {
  yellowWanted = false;
  if (!yellowSource) return;
  try {
    yellowSource.stop();
  } catch {
    // Already stopped.
  }
  yellowSource.disconnect();
  yellowSource = null;
}
