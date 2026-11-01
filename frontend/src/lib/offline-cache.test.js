import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_AGE_MS, canRestore } from "./offline-cache.js";

const now = 1_800_000_000_000;
const saved = { owner: "abc", savedAt: now - 60_000, state: { queries: [] } };

test("restores a recent copy for the same sign-in", () => {
  assert.equal(canRestore(saved, "abc", now), true);
});

test("never restores another sign-in's copy", () => {
  assert.equal(canRestore(saved, "other", now), false);
  assert.equal(canRestore(saved, null, now), false);
});

test("drops a copy older than a day", () => {
  assert.equal(canRestore({ ...saved, savedAt: now - MAX_AGE_MS }, "abc", now), false);
});

test("ignores a malformed copy", () => {
  assert.equal(canRestore(undefined, "abc", now), false);
  assert.equal(canRestore({ owner: "abc", savedAt: now }, "abc", now), false);
  assert.equal(canRestore({ ...saved, savedAt: "yesterday" }, "abc", now), false);
});
