import { dehydrate, hydrate } from "@tanstack/react-query";

// A copy of the console's data kept on this device, so the app opens straight
// onto the last map, fleet and alarms instead of a blank screen - and still
// opens with no network at all. Live updates replace it within seconds.
//
// It is security data on what may be a shared machine, so it is tied to one
// sign-in: the copy carries a hash of the session token and organization, and
// is only restored for that same pair. Signing out deletes it.

const DB_NAME = "momas-offline";
const STORE = "cache";
const KEY = "queries";
const SAVE_DELAY_MS = 5_000;
// Restoring must never hold up the first paint for long.
const RESTORE_TIMEOUT_MS = 400;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Large and only useful in the moment: replays, tracks and evidence are
// fetched again when somebody opens them.
const SKIP = new Set([
  "radio-replay",
  "fleet-replay",
  "radio-track",
  "radio-coverage",
  "incident-evidence",
  "follow-radio",
]);

let dbPromise = null;
let saveTimer = null;
// Saving waits for the restore to finish, even one that ran past the startup
// timeout, so a slow restore is never overwritten by the half-empty cache of
// the first few seconds.
let restoring = Promise.resolve();

function openDb() {
  if (!window.indexedDB) return Promise.reject(new Error("IndexedDB unavailable"));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

async function run(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function ownerOf({ token, organizationId }) {
  if (!token || !window.crypto?.subtle) return null;
  const bytes = new window.TextEncoder().encode(`${token}\n${organizationId || ""}`);
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether a saved copy may be shown to this sign-in right now. */
export function canRestore(saved, owner, now = Date.now()) {
  return Boolean(
    saved?.state
      && owner
      && saved.owner === owner
      && Number.isFinite(saved.savedAt)
      && now - saved.savedAt < MAX_AGE_MS,
  );
}

/**
 * Put the saved copy back into the query cache. Resolves with when it was
 * saved, or null when there was nothing usable. Never throws.
 */
export async function restoreQueryCache(queryClient, session) {
  // Late is still useful: hydrate never replaces data newer than its own.
  const attempt = (async () => {
    const owner = await ownerOf(session);
    if (!owner) return null;
    const saved = await run("readonly", (store) => store.get(KEY));
    if (!canRestore(saved, owner)) return null;
    hydrate(queryClient, saved.state);
    return saved.savedAt;
  })().catch(() => null);
  restoring = attempt;
  const timeout = new Promise((resolve) => window.setTimeout(() => resolve(null), RESTORE_TIMEOUT_MS));
  return Promise.race([attempt, timeout]);
}

async function save(queryClient, getSession) {
  await restoring;
  const owner = await ownerOf(getSession());
  if (!owner) return;
  // Offline, every refetch fails and marks its query "error" while it still
  // holds the last good data. That data is exactly what needs keeping, so it
  // is saved as the success it was; dataUpdatedAt still says how old it is.
  const state = dehydrate(queryClient, {
    shouldDehydrateQuery: (query) => query.state.data !== undefined && !SKIP.has(query.queryKey[0]),
  });
  state.queries = state.queries.map((query) => (query.state.status === "error"
    ? { ...query, state: { ...query.state, status: "success", error: null, fetchFailureCount: 0, fetchFailureReason: null } }
    : query));
  // Nothing worth keeping (the login screen, a page that has not loaded yet):
  // leave the last copy alone. Signing out is what deletes it.
  if (!state.queries.length) return;
  // When the newest of it was fetched, not when it was written: saves go on
  // while offline, and "data from" has to keep telling the truth.
  const savedAt = Math.max(...state.queries.map((query) => query.state.dataUpdatedAt || 0));
  await run("readwrite", (store) => store.put({ owner, savedAt, state }, KEY));
}

/**
 * Keep the saved copy current: a few seconds after data changes (batched, so
 * a burst of polls is one write), and whenever the tab is hidden or closed.
 */
export function persistQueryCache(queryClient, getSession) {
  const flush = () => {
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = null;
    save(queryClient, getSession).catch(() => {});
  };
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action?.type !== "success") return;
    if (!saveTimer) saveTimer = window.setTimeout(flush, SAVE_DELAY_MS);
  });
  const onHidden = () => {
    if (window.document.visibilityState === "hidden") flush();
  };
  window.document.addEventListener("visibilitychange", onHidden);
  return () => {
    unsubscribe();
    window.document.removeEventListener("visibilitychange", onHidden);
  };
}

export function clearOfflineCache() {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = null;
  run("readwrite", (store) => store.delete(KEY)).catch(() => {});
}
