// Unit tests for TMDB auth shaping (src/lib/tmdb-auth.ts). The v4 read token
// must travel ONLY as an Authorization bearer header — never in the query
// string — so the credential can't leak into upstream access logs or the
// Referer header. And tmdbAuth() must fail closed (null) when no token is
// configured, so callers skip TMDB instead of sending unauthenticated requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmdbAuth } from "../src/lib/tmdb-auth.ts";

test("returns null when TMDB_READ_TOKEN is unset (fail closed)", () => {
  delete process.env.TMDB_READ_TOKEN;
  assert.equal(tmdbAuth(), null);
});

test("returns null when TMDB_READ_TOKEN is the empty string", () => {
  process.env.TMDB_READ_TOKEN = "";
  assert.equal(tmdbAuth(), null);
});

test("shapes the token as a Bearer Authorization header — exact value, no extra headers", () => {
  process.env.TMDB_READ_TOKEN = "eyJhbGciOi.test-read-token.abc123";
  const auth = tmdbAuth();
  assert.ok(auth);
  // deepEqual on the whole map: Authorization is the ONLY header emitted.
  assert.deepEqual(auth.headers, { Authorization: "Bearer eyJhbGciOi.test-read-token.abc123" });
});

test("query params are empty — the token never rides the URL", () => {
  process.env.TMDB_READ_TOKEN = "secret-read-token";
  const auth = tmdbAuth();
  assert.ok(auth);
  assert.deepEqual(auth.query, {});
  // The token is present in the headers…
  assert.equal(auth.headers.Authorization.includes("secret-read-token"), true);
  // …but never anywhere in the query map (the part that would end up in the URL).
  assert.equal(JSON.stringify(auth.query).includes("secret-read-token"), false);
});

test("env is read per call, not captured at module load", () => {
  process.env.TMDB_READ_TOKEN = "first-token";
  assert.deepEqual(tmdbAuth()?.headers, { Authorization: "Bearer first-token" });
  process.env.TMDB_READ_TOKEN = "second-token";
  assert.deepEqual(tmdbAuth()?.headers, { Authorization: "Bearer second-token" });
  delete process.env.TMDB_READ_TOKEN;
  assert.equal(tmdbAuth(), null); // removing the token flips back to fail-closed
});
