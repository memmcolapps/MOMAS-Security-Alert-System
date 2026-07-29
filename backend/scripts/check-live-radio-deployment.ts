export {};

const base = String(process.argv[2] || "").replace(/\/+$/, "");

if (!base || !/^https?:\/\//.test(base)) {
  console.error("Usage: bun scripts/check-live-radio-deployment.ts https://your-api-host");
  process.exit(2);
}

const healthUrl = `${base}/api/health`;
const response = await fetch(healthUrl, {
  signal: AbortSignal.timeout(10_000),
}).catch((error) => {
  throw new Error(`Could not reach ${healthUrl}: ${error.message}`);
});

const contentType = response.headers.get("content-type") || "";
const body = await response.text();
let json: any = null;
try {
  json = JSON.parse(body);
} catch {
  // Reported below.
}

if (!response.ok || json?.runtime !== "bun") {
  console.error(JSON.stringify({
    ok: false,
    problem: "The public API host is not routed to the MOMAS Bun backend.",
    status: response.status,
    contentType,
    response: json || body.slice(0, 200),
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  healthUrl,
  runtime: json.runtime,
  note: "HTTP routing is correct. Verify the authenticated WebSocket separately.",
}, null, 2));
