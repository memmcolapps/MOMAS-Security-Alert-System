import { useSyncExternalStore } from "react";

// The service worker (sw/service-worker.js) keeps the app's own files on this
// device so the console opens with no network. A new deploy installs in the
// background and then waits: switching versions under an operator mid-call
// would cut their audio, so they choose when with the Reload button.

const HOUR_MS = 60 * 60 * 1000;

let waiting = null;
let reloadRequested = false;
const listeners = new Set();

function setWaiting(worker) {
  waiting = worker;
  listeners.forEach((listener) => listener());
}

export function registerServiceWorker() {
  const { serviceWorker } = window.navigator;
  if (!import.meta.env.PROD || !serviceWorker) return;

  // The first install also takes control of the page, which fires this; only
  // an update the operator asked for should reload.
  serviceWorker.addEventListener("controllerchange", () => {
    if (reloadRequested) window.location.reload();
  });

  serviceWorker.register("/sw.js").then((registration) => {
    const watch = (worker) => {
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && serviceWorker.controller) setWaiting(worker);
      });
    };
    if (registration.waiting && serviceWorker.controller) setWaiting(registration.waiting);
    watch(registration.installing);
    registration.addEventListener("updatefound", () => watch(registration.installing));
    // Consoles stay open for whole shifts and rarely navigate, which is when
    // the browser would otherwise look for a new version.
    window.setInterval(() => registration.update().catch(() => {}), HOUR_MS);
  }).catch(() => {});
}

export function applyUpdate() {
  if (!waiting) return;
  reloadRequested = true;
  waiting.postMessage({ type: "skip-waiting" });
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUpdateReady() {
  return useSyncExternalStore(subscribe, () => Boolean(waiting));
}
