export function buildLiveRadioUrl(apiBase, browserOrigin) {
  const origin = browserOrigin || globalThis.location?.origin;
  if (!origin) throw new Error("A browser origin is required to build the live-radio URL.");

  const configuredBase = String(apiBase || origin).replace(/\/+$/, "");
  const base = new URL(`${configuredBase}/`, origin);
  const url = new URL("api/pocstars/radio/live", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}
