// Keeps the console's own files on the device so it opens with no network.
// The build prepends VERSION and PRECACHE (every file it emitted) - see the
// serviceWorker plugin in vite.config.js. API data is not handled here: the
// app saves its own copy (src/lib/offline-cache.js).

const SHELL = `momas-shell-${VERSION}`;
const CDN = "momas-cdn";
const CDN_HOSTS = new Set(["cdnjs.cloudflare.com"]);

// Built files are named by their content hash, so one already held from the
// previous version is the same file: reuse it rather than download every
// chunk again on each deploy. The page itself ("/") is always fetched fresh.
async function precache() {
  const cache = await caches.open(SHELL);
  await Promise.all(PRECACHE.map(async (path) => {
    const held = path === "/" ? null : await caches.match(path, { ignoreVary: true });
    if (held) return cache.put(path, held);
    const response = await fetch(new Request(path, { cache: "reload" }));
    if (!response.ok) throw new Error(`precache ${path}: ${response.status}`);
    return cache.put(path, response);
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith("momas-shell-") && name !== SHELL)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

// Sent by the page's Reload button (src/lib/service-worker.js).
self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") self.skipWaiting();
});

// ignoreVary: some hosts send "Vary: Origin", and a lazily imported chunk is
// requested with an Origin header the precache request did not have, so a
// strict match misses and the chunk fails to load offline. The files are named
// by content hash, so a match on the URL alone is always the right file.
async function cacheFirst(request, cacheName) {
  const held = await caches.match(request, { ignoreVary: true });
  if (held) return held;
  const response = await fetch(request);
  // Opaque (no-cors) responses are the CDN stylesheet; their status is hidden.
  if (response.ok || response.type === "opaque") {
    const copy = response.clone();
    caches.open(cacheName).then((cache) => cache.put(request, copy)).catch(() => {});
  }
  return response;
}

// Every screen is the same index.html. Serving the held copy first is what
// makes the console open instantly, and it always matches the held scripts;
// a new deploy arrives as a new service worker and the Reload prompt.
async function appShell(request) {
  const held = await caches.match("/", { cacheName: SHELL, ignoreVary: true });
  if (held) return held;
  return fetch(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/api/")) return;
    if (request.mode === "navigate") event.respondWith(appShell(request));
    else if (url.pathname.startsWith("/assets/")) event.respondWith(cacheFirst(request, SHELL));
    return;
  }
  if (CDN_HOSTS.has(url.hostname)) event.respondWith(cacheFirst(request, CDN));
});
