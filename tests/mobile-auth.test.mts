// Unit tests for the native-client auth helpers (src/lib/mobile-auth.ts).
// parseBearerToken feeds every bearer-first session reader (proxy, api-auth,
// /api/auth/me, sign-out) — its strictness ("Bearer" scheme only, non-empty
// token) is what keeps a Basic header or a bare secret from being treated as
// a session token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBearerToken, hasNativeClientHeader, NATIVE_CLIENT_HEADER } from "../src/lib/mobile-auth.ts";

test("extracts the token from a well-formed Bearer header", () => {
  assert.equal(parseBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
});

test("scheme is case-insensitive and tolerates extra padding", () => {
  assert.equal(parseBearerToken("bearer tok"), "tok");
  assert.equal(parseBearerToken("BEARER tok"), "tok");
  assert.equal(parseBearerToken("  Bearer   tok  "), "tok");
  assert.equal(parseBearerToken("Bearer\ttok"), "tok");
});

test("non-Bearer schemes and malformed headers → null", () => {
  assert.equal(parseBearerToken(null), null);
  assert.equal(parseBearerToken(""), null);
  assert.equal(parseBearerToken("Basic dXNlcjpwYXNz"), null);
  assert.equal(parseBearerToken("Bearer"), null); // no token at all
  assert.equal(parseBearerToken("Bearer "), null); // blank token
  assert.equal(parseBearerToken("Bearertok"), null); // no separator
});

test("hasNativeClientHeader requires a non-blank value", () => {
  assert.equal(hasNativeClientHeader("ios; build=42; api=1"), true);
  assert.equal(hasNativeClientHeader("x"), true);
  assert.equal(hasNativeClientHeader("   "), false);
  assert.equal(hasNativeClientHeader(""), false);
  assert.equal(hasNativeClientHeader(null), false);
});

test("header name constant is lowercase (Headers.get canonical form)", () => {
  assert.equal(NATIVE_CLIENT_HEADER, "x-summonarr-client");
});

// Behavior pin: duplicate Authorization headers. Fetch-spec Headers.get joins
// repeated headers with ", ", so a proxy that appends a second Authorization
// yields "Bearer aaa, Bearer bbb". parseBearerToken returns the verbatim
// remainder after the first scheme ("aaa, Bearer bbb") — NOT null and NOT the
// first token. That garbage is safe only because every caller feeds it to
// verifySessionJwt, which rejects anything we didn't sign. If this pin breaks,
// re-audit the callers before changing the contract.
test("comma-joined duplicate Authorization headers → verbatim garbage token", () => {
  const headers = new Headers();
  headers.append("authorization", "Bearer aaa");
  headers.append("authorization", "Bearer bbb");
  const joined = headers.get("authorization");
  assert.equal(joined, "Bearer aaa, Bearer bbb"); // fetch-spec join semantics
  assert.equal(parseBearerToken(joined), "aaa, Bearer bbb");
});

// Behavior pin: the module's documented contract is "returned verbatim, not
// verified here" — internal whitespace is preserved, not treated as malformed.
// A real session JWT can never contain a space, so downstream verification
// rejects it; parseBearerToken itself stays a dumb extractor.
test("token with internal whitespace is returned verbatim", () => {
  assert.equal(parseBearerToken("Bearer tok en"), "tok en");
  assert.equal(parseBearerToken("  Bearer tok en  "), "tok en"); // outer trim only
});
