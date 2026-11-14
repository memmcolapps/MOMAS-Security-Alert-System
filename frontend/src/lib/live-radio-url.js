/** A WebSocket URL for an API path, on the same base the REST calls use. */
export function buildSocketUrl(apiBase, browserOrigin, path) {
  const origin = browserOrigin || globalThis.location?.origin;
  if (!origin) throw new Error("A browser origin is required to build a socket URL.");

  const configuredBase = String(apiBase || origin).replace(/\/+$/, "");
  const base = new URL(`${configuredBase}/`, origin);
  const url = new URL(path, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

export function buildLiveRadioUrl(apiBase, browserOrigin) {
  return buildSocketUrl(apiBase, browserOrigin, "api/pocstars/radio/live");
}
