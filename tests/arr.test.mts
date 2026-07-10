// Unit tests for the pure surface of the Radarr/Sonarr client (src/lib/arr.ts).
// ArrResponseError's status/body fields drive the webhook confirm paths and the
// duplicate/path-collision retry logic, and arrErrorMessage is what admins see
// when an approve/add fails — so both contracts are pinned exactly. Also pins
// the guardrail-5 constants (30s timeout, 50 MB response cap: libraries with
// >3k movies silently truncated at the old 10 MB cap) via a source-text check,
// since the constants are module-private and arrFetch itself does network.
// Everything DB/network-bound (getCfg, arrFetch, wanted/queue readers) is
// intentionally NOT exercised here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ArrResponseError,
  arrErrorMessage,
  resolveSingleTvdbToTmdb,
} from "../src/lib/arr.ts";

// arr.ts imports @/lib/prisma (client constructed at load, connections/queries
// are lazy) and @/lib/token-crypto (key read lazily). Set the env so an
// incidental lazy read can never throw mid-test; no test below issues a query.
process.env.NEXTAUTH_SECRET ??= "unit-test-session-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";

// ---------------------------------------------------------------------------
// ArrResponseError
// ---------------------------------------------------------------------------

test("ArrResponseError exposes status, body, and the exact message", () => {
  const err = new ArrResponseError(503, '{"message":"Service Unavailable"}');
  assert.equal(err.status, 503);
  assert.equal(err.body, '{"message":"Service Unavailable"}');
  assert.equal(err.message, "Arr service returned a non-200 response (503)");
});

test("ArrResponseError is an Error subclass (instanceof narrowing works)", () => {
  const err: unknown = new ArrResponseError(400, "bad request");
  assert.ok(err instanceof ArrResponseError);
  assert.ok(err instanceof Error);
  // The duplicate/path-collision handlers narrow on instanceof then read the
  // fields — after narrowing both must be reachable and correctly typed.
  if (err instanceof ArrResponseError) {
    assert.equal(err.status, 400);
    assert.equal(err.body, "bad request");
  }
});

test("ArrResponseError preserves an empty body verbatim", () => {
  const err = new ArrResponseError(500, "");
  assert.equal(err.body, "");
  assert.equal(err.message, "Arr service returned a non-200 response (500)");
});

// ---------------------------------------------------------------------------
// arrErrorMessage — the admin-facing mapping of upstream failures
// ---------------------------------------------------------------------------

test("arrErrorMessage: 401/403 map to the API-key hint", () => {
  assert.equal(
    arrErrorMessage(new ArrResponseError(401, "Unauthorized")),
    "Arr authentication failed (401) — check the API key",
  );
  assert.equal(
    arrErrorMessage(new ArrResponseError(403, "Forbidden")),
    "Arr authentication failed (403) — check the API key",
  );
});

test("arrErrorMessage: 404 maps to not-found", () => {
  assert.equal(
    arrErrorMessage(new ArrResponseError(404, "NotFound")),
    "Item not found in arr (404)",
  );
});

test("arrErrorMessage: >=500 maps to server-error (500 is the boundary)", () => {
  assert.equal(
    arrErrorMessage(new ArrResponseError(500, "boom")),
    "Arr server error (500) — check the arr service logs",
  );
  assert.equal(
    arrErrorMessage(new ArrResponseError(503, "unavailable")),
    "Arr server error (503) — check the arr service logs",
  );
  // 499 sits just below the boundary → generic bucket, not server-error.
  assert.equal(arrErrorMessage(new ArrResponseError(499, "x")), "Arr request failed (499)");
});

test("arrErrorMessage: other statuses fall through to the generic bucket", () => {
  assert.equal(arrErrorMessage(new ArrResponseError(400, "validation")), "Arr request failed (400)");
  assert.equal(arrErrorMessage(new ArrResponseError(409, "conflict")), "Arr request failed (409)");
  assert.equal(arrErrorMessage(new ArrResponseError(429, "slow down")), "Arr request failed (429)");
});

test("arrErrorMessage never leaks the upstream response body", () => {
  // Arr error bodies can embed paths/urls from the admin's instance; the
  // user-facing message must stay a status-only summary for every bucket.
  const secret = "X-Api-Key=super-secret /mnt/media/Movies";
  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    const msg = arrErrorMessage(new ArrResponseError(status, secret));
    assert.equal(msg.includes("super-secret"), false, `status ${status} leaked the body`);
    assert.equal(msg.includes("/mnt/media"), false, `status ${status} leaked the body`);
  }
});

test("arrErrorMessage: plain Error passes its message through", () => {
  assert.equal(arrErrorMessage(new Error("fetch failed")), "fetch failed");
  assert.equal(arrErrorMessage(new TypeError("cfg.url is undefined")), "cfg.url is undefined");
});

test("arrErrorMessage: non-Error values get the generic fallback", () => {
  assert.equal(arrErrorMessage("boom"), "Arr request failed");
  assert.equal(arrErrorMessage(undefined), "Arr request failed");
  assert.equal(arrErrorMessage(null), "Arr request failed");
  assert.equal(arrErrorMessage({ status: 500 }), "Arr request failed");
  assert.equal(arrErrorMessage(42), "Arr request failed");
});

// ---------------------------------------------------------------------------
// resolveSingleTvdbToTmdb — the invalid-id fast path
// ---------------------------------------------------------------------------

test("resolveSingleTvdbToTmdb returns null for invalid ids without touching cache/DB", async () => {
  // Only the pure guard is exercised — a *valid* id proceeds to the tmdb-cache
  // and MediaRequest lookups (DB) and must not be called in a unit test. The
  // guard returning null (not throwing) matters: the Sonarr webhook calls this
  // with whatever id the payload carried, and a garbage tvdbId must degrade to
  // "no eviction", never a 500.
  assert.equal(await resolveSingleTvdbToTmdb(0), null);
  assert.equal(await resolveSingleTvdbToTmdb(-1), null);
  assert.equal(await resolveSingleTvdbToTmdb(2.5), null);
  assert.equal(await resolveSingleTvdbToTmdb(NaN), null);
  assert.equal(await resolveSingleTvdbToTmdb(Infinity), null);
  assert.equal(await resolveSingleTvdbToTmdb(-Infinity), null);
});

// ---------------------------------------------------------------------------
// Guardrail 5 pin — 50 MB response cap + 30s timeout, wired into arrFetch
// ---------------------------------------------------------------------------

test("guardrail 5: the 50 MB cap and 30s timeout are pinned and wired into arrFetch", () => {
  // The constants are module-private and arrFetch does real network I/O, so a
  // runtime assertion isn't possible here. Pin the source text instead: this
  // fails the suite if anyone lowers the cap (the old 10 MB cap silently
  // truncated >3k-movie libraries) or detaches it from the safe-fetch call.
  const source = readFileSync(new URL("../src/lib/arr.ts", import.meta.url), "utf8");
  assert.match(source, /const ARR_FETCH_MAX_BYTES = 50 \* 1024 \* 1024;/);
  assert.match(source, /const ARR_FETCH_TIMEOUT_MS = 30_000;/);
  assert.match(source, /maxResponseBytes: ARR_FETCH_MAX_BYTES/);
  assert.match(source, /timeoutMs: ARR_FETCH_TIMEOUT_MS/);
});
