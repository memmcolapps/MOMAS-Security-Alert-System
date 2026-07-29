import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveRadioUrl } from "./live-radio-url.js";

test("preserves a gateway path prefix", () => {
  assert.equal(
    buildLiveRadioUrl(
      "https://memmcolapps.memmserve.com/epailsecurity",
      "https://momas.example",
    ).toString(),
    "wss://memmcolapps.memmserve.com/epailsecurity/api/pocstars/radio/live",
  );
});

test("works with an origin-only API base", () => {
  assert.equal(
    buildLiveRadioUrl("http://localhost:5050", "http://localhost:5173").toString(),
    "ws://localhost:5050/api/pocstars/radio/live",
  );
});

test("resolves a relative API base against the browser origin", () => {
  assert.equal(
    buildLiveRadioUrl("/epailsecurity/", "https://memmcolapps.memmserve.com").toString(),
    "wss://memmcolapps.memmserve.com/epailsecurity/api/pocstars/radio/live",
  );
});
