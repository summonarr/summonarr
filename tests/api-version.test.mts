// Unit tests for native client/version negotiation (src/lib/api-version.ts) — the
// parser + the 426 force-upgrade gate. Fail-soft behaviour (never block on an
// unidentifiable client) is the security-relevant property, so it's tested here.
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

test("parseNativeClient normalizes segments: trims whitespace, drops empties", () => {
  // All-empty segments must collapse to null — a regression to a bare split(";")
  // without trim/filter(Boolean) would return non-null info with platform "".
  assert.equal(parseNativeClient(";;;  ;"), null);
  // Whitespace around the platform and segments is stripped; platform lowercased.
  assert.deepEqual(parseNativeClient("  iOS ; build=3"), { platform: "ios", build: 3, api: null });
});

test("parseNativeClient keys are case-insensitive", () => {
  // A regression to case-sensitive key matching would silently yield build=null
  // for any client sending non-lowercase keys — failing SOFT and permanently
  // disarming the 426 kill-switch with no other signal.
  assert.deepEqual(parseNativeClient("ios; BUILD=42"), { platform: "ios", build: 42, api: null });
  assert.deepEqual(parseNativeClient("ios; Build=42; API=2"), { platform: "ios", build: 42, api: 2 });
});

test("parseNativeClient tolerates key-only and empty-value segments", () => {
  // Segment with no "=" is skipped (the eq === -1 continue).
  assert.deepEqual(parseNativeClient("ios; build"), { platform: "ios", build: null, api: null });
  // Empty value: parseInt("") is NaN → skipped, build stays null.
  assert.deepEqual(parseNativeClient("ios; build="), { platform: "ios", build: null, api: null });
});

test("parseNativeClient duplicate keys: last one wins", () => {
  // Observable wire-contract behavior — the loop overwrites on each match.
  assert.deepEqual(parseNativeClient("ios; build=5; build=9"), { platform: "ios", build: 9, api: null });
});

test("negative parsed build arms the gate (below any positive minimum)", () => {
  // parseInt accepts a leading minus, so "build=-5" positively identifies a
  // build below MIN_CLIENT.ios (>= 1) — the one garbage-ish header shape that
  // fires the 426 gate rather than failing soft.
  const info = parseNativeClient("ios; build=-5");
  assert.deepEqual(info, { platform: "ios", build: -5, api: null });
  assert.equal(isClientBelowMinimum(info), true);
});
