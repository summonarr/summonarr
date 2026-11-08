// Unit tests for the capped JSON body readers (src/lib/body-size.ts) — the
// guardrail-30 helper every non-upload JSON route must use. next.config.ts's
// proxyClientMaxBodySize is only a backstop, so these helpers are the
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
  readBodyBytesCapped,
  readJsonCapped,
  readJsonCappedOr,
  readOptionalJsonCapped,
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
    [50 * MB, "50MB"],
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

// ── valid JSON that is not an object ────────────────────────────────────────

test("readJsonCapped 400s a `null` body instead of handing back null", async () => {
  // `null` is VALID JSON, so it parsed cleanly and was returned as if it were the
  // expected object. The caller's very next line reads a property off it, and on
  // null that is a TypeError — an unauthenticated 500 from a 4-byte request body.
  const res = await readJsonCapped(postJson("null"), 16 * KB);
  assert.ok(res instanceof NextResponse);
  assert.equal(res.status, 400);
});

test("readJsonCapped 400s bare primitives too — every consumer types the body as an object", async () => {
  for (const body of ["123", '"hello"', "true"]) {
    const res = await readJsonCapped(postJson(body), 16 * KB);
    assert.ok(res instanceof NextResponse, `${body} should be rejected`);
    assert.equal(res.status, 400, `${body} should be 400`);
  }
});

test("readJsonCapped still accepts an ordinary object", async () => {
  // Guards against the fix turning into a blanket rejection.
  const res = await readJsonCapped<{ a: number }>(postJson('{"a":1}'), 16 * KB);
  assert.ok(!(res instanceof NextResponse));
  assert.deepEqual(res, { a: 1 });
});

test("readJsonCappedOr resolves a `null` body the tolerant way — the fallback, not null", async () => {
  const fallback = { full: false };
  assert.equal(await readJsonCappedOr(postJson("null"), 16 * KB, fallback), fallback);
  assert.equal(await readJsonCappedOr(postJson("42"), 16 * KB, fallback), fallback);
});

// ── top-level arrays are not objects ────────────────────────────────────────

test("readJsonCapped 400s a top-level array — `typeof [] === \"object\"` must not let it through", async () => {
  // A handler reading `body.ids` off `["a"]` got undefined, i.e. its defaults,
  // with no validation error.
  for (const body of ["[1,2]", "[]", '[{"ids":["a"]}]']) {
    const res = await readJsonCapped(postJson(body), 16 * KB);
    assert.ok(res instanceof NextResponse, `${body} should be rejected`);
    assert.equal(res.status, 400);
    assert.deepEqual(await errorBody(res), { error: "Invalid request body" });
  }
});

test("readJsonCappedOr resolves a top-level array to the fallback", async () => {
  const fallback = { full: false };
  assert.equal(await readJsonCappedOr(postJson("[1,2]"), 16 * KB, fallback), fallback);
});

// ── the read stops at the cap ───────────────────────────────────────────────

// A chunked body with no Content-Length, served one chunk per pull, counting the
// pulls — the shape a streaming uploader (or an attacker) sends.
function streamingRequest(chunks: number, chunkBytes: number): { req: NextRequest; pulls: () => number; cancelled: () => boolean } {
  let pulled = 0;
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) { controller.close(); return; }
      pulled++;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
    cancel() { wasCancelled = true; },
  }, { highWaterMark: 0 });
  const req = new NextRequest(ENDPOINT, {
    method: "POST",
    body: stream,
    duplex: "half",
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
  return { req, pulls: () => pulled, cancelled: () => wasCancelled };
}

test("readBodyBytesCapped stops reading as soon as a chunked body passes the cap", async () => {
  const s = streamingRequest(1000, 4 * KB); // ~4 MB offered
  assert.equal(s.req.headers.get("content-length"), null);
  assert.equal(await readBodyBytesCapped(s.req, 16 * KB), null);
  assert.ok(s.pulls() <= 6, `read ${s.pulls()} chunks of a 16KB cap — the whole body was buffered`);
  assert.ok(s.cancelled(), "the rest of the body is cancelled, not drained");
});

test("readBodyBytesCapped returns the whole body at or under the cap, and empty for no body", async () => {
  const s = streamingRequest(4, 4 * KB);
  const bytes = await readBodyBytesCapped(s.req, 16 * KB);
  assert.ok(bytes);
  assert.equal(bytes.byteLength, 16 * KB);
  assert.equal((await readBodyBytesCapped(new NextRequest(ENDPOINT, { method: "POST" }), 1))?.byteLength, 0);
});

test("readJsonCapped and readJsonCappedOr 413 a chunked body without reading past the cap", async () => {
  for (const read of [
    (r: NextRequest) => readJsonCapped(r, 16 * KB),
    (r: NextRequest) => readJsonCappedOr(r, 16 * KB, {}),
    (r: NextRequest) => readOptionalJsonCapped(r, 16 * KB, {}),
  ]) {
    const s = streamingRequest(1000, 4 * KB);
    const res = await read(s.req);
    assert.ok(res instanceof NextResponse);
    assert.equal(res.status, 413);
    assert.ok(s.pulls() <= 6, `read ${s.pulls()} chunks of a 16KB cap`);
  }
});

// ── readOptionalJsonCapped: empty means defaults, anything else must be meant ──

test("readOptionalJsonCapped: an empty or whitespace body is the fallback", async () => {
  const fallback = { all: true };
  assert.equal(await readOptionalJsonCapped(new NextRequest(ENDPOINT, { method: "POST" }), 16 * KB, fallback), fallback);
  assert.equal(await readOptionalJsonCapped(postJson(""), 16 * KB, fallback), fallback);
  assert.equal(await readOptionalJsonCapped(postJson("  \n"), 16 * KB, fallback), fallback);
});

test("readOptionalJsonCapped: a valid object is returned", async () => {
  const res = await readOptionalJsonCapped(postJson('{"ids":["a"]}'), 16 * KB, {});
  assert.deepEqual(res, { ids: ["a"] });
});

test("readOptionalJsonCapped: malformed JSON, arrays and primitives are a 400, never the fallback", async () => {
  for (const body of ["{not json", '["a"]', "null", "42", '"x"']) {
    const res = await readOptionalJsonCapped(postJson(body), 16 * KB, {});
    assert.ok(res instanceof NextResponse, `${body} should be rejected`);
    assert.equal(res.status, 400, body);
    assert.deepEqual(await errorBody(res), { error: "Invalid request body" });
  }
});

test("readOptionalJsonCapped: the Content-Length fast path still 413s", async () => {
  const res = await readOptionalJsonCapped(postJson("{}", { "content-length": String(MB) }), 16 * KB, {});
  assert.ok(res instanceof NextResponse);
  assert.equal(res.status, 413);
});

test("readJsonCapped with a schema returns the checked shape and 400s a body that doesn't fit", async () => {
  const { v } = await import("../src/lib/validate.ts");
  const schema = v.object({ tmdbId: v.int(), title: v.string() });
  const ok = await readJsonCapped(postJson(JSON.stringify({ tmdbId: 1, title: "Dune", extra: true })), 16 * KB, schema);
  assert.ok(!(ok instanceof NextResponse));
  assert.deepEqual(ok, { tmdbId: 1, title: "Dune" }, "only the declared keys come back");

  const bad = await readJsonCapped(postJson(JSON.stringify({ tmdbId: "1", title: "Dune" })), 16 * KB, schema);
  assert.ok(bad instanceof NextResponse);
  assert.equal(bad.status, 400);
});
