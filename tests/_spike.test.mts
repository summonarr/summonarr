// Unit tests for native client/version negotiation (src/lib/api-version.ts) — the
// parser + the 426 force-upgrade gate. Fail-soft behaviour (never block on an
// unidentifiable client) is the security-relevant property, so it's tested here.
//
// NOTE: this file should be renamed to `api-version.test.mts`; it was created as
// `_spike.test.mts` and the authoring sandbox could not delete/rename files.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNativeClient,
  isClientBelowMinimum,
  MIN_CLIENT,
  API_VERSION,
  MIN_API_VERSION,
} from "../src/lib/api-version.ts";

test("parseNativeClient parses the full header shape", () => {
  assert.deepEqual(parseNativeClient("ios; build=42; api=1"), { platform: "ios", build: 42, api: 1 });
  // Order-independent, case-normalized platform.
  assert.deepEqual(parseNativeClient("iOS; api=2; build=7"), { platform: "ios", build: 7, api: 2 });
});

test("parseNativeClient is tolerant: null/empty/legacy/garbage → soft nulls", () => {
  assert.equal(parseNativeClient(null), null);
  assert.equal(parseNativeClient(""), null);
  // Legacy bare "ios" — no build/api fields.
  assert.deepEqual(parseNativeClient("ios"), { platform: "ios", build: null, api: null });
  // Unparseable numbers are ignored (stay null), never throw.
  assert.deepEqual(parseNativeClient("ios; build=abc"), { platform: "ios", build: null, api: null });
});

test("isClientBelowMinimum fails soft — only blocks a positively-stale build", () => {
  assert.equal(isClientBelowMinimum(null), false); // no header
  assert.equal(isClientBelowMinimum({ platform: "android", build: 0, api: 1 }), false); // ungated platform
  assert.equal(isClientBelowMinimum({ platform: "ios", build: null, api: 1 }), false); // unknown build
  // Gate arms only below the floor.
  const min = MIN_CLIENT.ios;
  assert.equal(isClientBelowMinimum({ platform: "ios", build: min - 1, api: 1 }), true);
  assert.equal(isClientBelowMinimum({ platform: "ios", build: min, api: 1 }), false);
  assert.equal(isClientBelowMinimum({ platform: "ios", build: min + 5, api: 1 }), false);
});

test("contract version constants are coherent", () => {
  assert.equal(Number.isInteger(API_VERSION), true);
  assert.equal(Number.isInteger(MIN_API_VERSION), true);
  assert.equal(MIN_API_VERSION <= API_VERSION, true);
});
