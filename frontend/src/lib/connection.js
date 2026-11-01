import { useSyncExternalStore } from "react";

// Whether this console can reach the MOMAS server, and when it last could.
// The browser's own online flag only knows about the local network: a laptop
// on working Wi-Fi with the VPS down still says "online". So every API call
// reports in here, and two network failures in a row with no success between
// them count as the server being out of reach. One failure alone is usually a
// blip and the next poll a few seconds later clears it.
const UNREACHABLE_AFTER = 2;

let state = {
  online: window.navigator.onLine,
  serverReachable: true,
  lastSyncAt: null,
};
let failures = 0;
const listeners = new Set();

function set(next) {
  if (Object.keys(next).every((key) => state[key] === next[key])) return;
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

window.addEventListener("online", () => set({ online: true }));
window.addEventListener("offline", () => set({ online: false }));

export function noteServerReached() {
  failures = 0;
  set({ serverReachable: true, lastSyncAt: Date.now() });
}

export function noteServerUnreachable() {
  failures += 1;
  if (failures >= UNREACHABLE_AFTER) set({ serverReachable: false });
}

// Seeded from the saved copy of the data on startup, so a console opened with
// no network can still say how old what it shows is.
export function noteRestoredAt(savedAt) {
  if (savedAt && !state.lastSyncAt) set({ lastSyncAt: savedAt });
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConnection() {
  return useSyncExternalStore(subscribe, () => state);
}
