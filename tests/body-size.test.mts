// Unit tests for the capped JSON body readers (src/lib/body-size.ts) — the
// guardrail-30 helper every non-upload JSON route must use. next.config.ts's
// proxyClientMaxBodySize (50 MB) is only a backstop, so these helpers are the
// real memory/CPU DoS boundary: the Content-Length fast path must reject
// BEFORE reading the body, the post-read byte check must catch
// Transfer-Encoding: chunked bypasses (no Content-Length header at all), and
// the tolerant readJsonCappedOr variant must still enforce the 413 cap while
// preserving its "no body = defaults" fallback contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";
import {
  checkBodySize,
  assertBodyBytesUnderCap,
  readJsonCapped,
  readJsonCappedOr,
} from "../src/lib/body-size.ts";

const ENDPOINT = "http://localhost/api/test";
const KB = 1024;
const MB = 1024 * 1024;

function postJson(body: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(ENDPOINT, { method: "POST", body, headers });
}

async function errorBody(res: NextResponse): Promise<{ error: string }> {
  return (await res.json()) as { error: string };
}

test("checkBodySize passes a request with no Content-Length header", () => {
  const req = new NextRequest(ENDPOINT, { method: "POST" });
  assert.equal(req.headers.get("content-length"), null);
  assert.equal(checkBodySize(req, 16 * KB), null);
});

test("checkBodySize passes when Content-Length is at or under the cap", () => {
  const cap = 16 * KB;
  assert.equal(checkBodySize(postJson("{}", { "content-length": String(cap) }), cap), null);
  assert.equal(checkBodySize(postJson("{}", { "content-length": "1" }), cap), null);
});

test("checkBodySize 413s when Content-Length exceeds the cap", async () => {
  const cap = 16 * KB;
  const res = checkBodySize(postJson("{}", { "content-length": String(cap + 1) }), cap);
  assert.ok(res instanceof NextResponse);
  assert.equal(res.status, 413);
  assert.deepEqual(await errorBody(res), { error: "Request body too large (max 16KB)" });
});

test("checkBodySize ignores a non-numeric Content-Length (post-read check must cover it)", () => {
  // parseInt("chunked") is NaN — the header-only fast path deliberately passes,
  // deferring to assertBodyBytesUnderCap after the read.
  assert.equal(checkBodySize(postJson("{}", { "content-length": "chunked" }), 1), null);
});

test("413 message formats KB under 1 MiB, MB at/above, and never renders 0KB/0MB", async () => {
  const oversized = { byteLength: Number.MAX_SAFE_INTEGER };
  const cases: Array<[number, string]> = [
    [16 * KB, "16KB"], // typical single-object cap
    [64 * KB, "64KB"],
    [MB - 1, "1024KB"], // last KB-branch value: unit switches exactly at 1 MiB
    [MB, "1MB"],
    [50 * MB, "50MB"], // the ARR-sized backstop
    [100, "1KB"], // sub-KB cap must not render "0KB"
    [512, "1KB"],
  ];
  for (const [cap, label] of cases) {
    const res = assertBodyBytesUnderCap(oversized, cap);
    assert.ok(res instanceof NextResponse);
    assert.equal(res.status, 413);
    assert.deepEqual(await errorBody(res), {
      error: `Request body too large (max ${label})`,
    });
  }
});

test("assertBodyBytesUnderCap: at-cap passes, one byte over 413s", () => {
  const cap = 16 * KB;
  assert.equal(assertBodyBytesUnderCap({ byteLength: cap }, cap), null);
  assert.equal(assertBodyBytesUnderCap({ byteLength: 0 }, cap), null);
  const res = assertBodyBytesUnderCap({ byteLength: cap + 1 }, cap);
  assert.ok(res instanceof NextResponse);
  assert.equal(res.status, 413);
});

test("readJsonCapped parses a valid body under the cap", async () => {
  const req = postJson(JSON.stringify({ title: "Dune", tmdbId: 438631, is4k: true }));
  const result = await readJsonCapped<{ title: string; tmdbId: number; is4k: boolean }>(
    req,
    16 * KB,
  );
  assert.ok(!(result instanceof NextResponse));
  assert.deepEqual(result, { title: "Dune", tmdbId: 438631, is4k: true });
});

test("readJsonCapped: Content-Length over cap → 413 fast path without reading the body", async () => {
  const req = postJson("{}", { "content-length": String(MB) });
  const result = await readJsonCapped(req, 16 * KB);
  assert.ok(result instanceof NextResponse);
  assert.equal(result.status, 413);
  assert.equal(req.bodyUsed, false); // rejected on the header alone — no parse work done
});

test("readJsonCapped: oversized chunked body (no Content-Length) still 413s post-read", async () => {
  const cap = 1 * KB;
  const req = postJson(JSON.stringify({ pad: "x".repeat(5 * KB) }));
  // A string-body Request carries no Content-Length header — this IS the
  // chunked-encoding bypass shape the post-read assertion exists for.
  assert.equal(req.headers.get("content-length"), null);
  const result = await readJsonCapped(req, cap);
  assert.ok(result instanceof NextResponse);
  assert.equal(result.status, 413);
  assert.deepEqual(await errorBody(result), { error: "Request body too large (max 1KB)" });
});

test("readJsonCapped: malformed JSON → 400 Invalid request body", async () => {
  const result = await readJsonCapped(postJson("{not json"), 16 * KB);
  assert.ok(result instanceof NextResponse);
  assert.equal(result.status, 400);
  assert.deepEqual(await errorBody(result), { error: "Invalid request body" });
});

test("readJsonCapped: empty body → 400 (strict variant has no fallback)", async () => {
  const result = await readJsonCapped(new NextRequest(ENDPOINT, { method: "POST" }), 16 * KB);
  assert.ok(result instanceof NextResponse);
  assert.equal(result.status, 400);
});

test("readJsonCapped: body exactly at the cap parses", async () => {
  const body = JSON.stringify({ ok: true });
  const result = await readJsonCapped<{ ok: boolean }>(postJson(body), Buffer.byteLength(body));
  assert.ok(!(result instanceof NextResponse));
  assert.deepEqual(result, { ok: true });
});

test("readJsonCappedOr returns the parsed body when present and valid", async () => {
  const fallback = { full: false };
  const result = await readJsonCappedOr(postJson(JSON.stringify({ full: true })), 16 * KB, fallback);
  assert.ok(!(result instanceof NextResponse));
  assert.deepEqual(result, { full: true });
});

test("readJsonCappedOr falls back on an empty body (no body = defaults contract)", async () => {
  const fallback = { full: false };
  const result = await readJsonCappedOr(
    new NextRequest(ENDPOINT, { method: "POST" }),
    16 * KB,
    fallback,
  );
  assert.equal(result, fallback); // the exact fallback reference, not a 400
});

test("readJsonCappedOr falls back on a malformed body", async () => {
  const fallback = { full: false };
  assert.equal(await readJsonCappedOr(postJson("{not json"), 16 * KB, fallback), fallback);
  assert.equal(await readJsonCappedOr(postJson("   "), 16 * KB, fallback), fallback);
});

test("readJsonCappedOr still 413s over the cap — tolerance never disables the DoS bound", async () => {
  const fallback = { full: false };
  // Header fast path.
  const viaHeader = await readJsonCappedOr(
    postJson("{}", { "content-length": String(MB) }),
    16 * KB,
    fallback,
  );
  assert.ok(viaHeader instanceof NextResponse);
  assert.equal(viaHeader.status, 413);
  // Chunked bypass: oversized AND malformed — the cap must win over the fallback.
  const viaBody = await readJsonCappedOr(postJson("not json ".repeat(1024)), 1 * KB, fallback);
  assert.ok(viaBody instanceof NextResponse);
  assert.equal(viaBody.status, 413);
});
