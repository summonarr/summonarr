// Unit tests for the chunked backup-restore upload pipeline:
//   • src/lib/import-session.ts — the server-side in-memory chunk assembler
//     behind /api/setup/import-chunk and /api/admin/backup/db-import-chunk.
//     It guards a DESTRUCTIVE single-shot restore, so ordering, duplicate
//     rejection, size caps, short-upload detection, the single global slot,
//     and stale-session reclamation must all fail closed — a corrupted or
//     partial assembly would be fed straight into TRUNCATE+INSERT.
//   • src/lib/chunked-upload.ts — the client-side uploader. It must send
//     chunks in order with consistent headers, stop on the server's
//     `complete` flag, detect auth-gate redirects (non-JSON responses), and
//     fire the DELETE cancel on every abort path so the server slot frees.
// No network: fetch is replaced with a scripted mock. No DB: import-session
// only touches a mkdtemp directory, which every test cleans up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import {
  startSession,
  appendChunk,
  getSessionStream,
  clearSession,
} from "../src/lib/import-session.ts";
import { MAX_CIPHERTEXT_BYTES } from "../src/lib/backup-import.ts";
import { DEFAULT_CHUNK_SIZE, uploadInChunks } from "../src/lib/chunked-upload.ts";
import type { ChunkedUploadProgress } from "../src/lib/chunked-upload.ts";

// backup-import transitively loads prisma + token-crypto; both read env
// lazily and neither connects at import time. Point them at nothing real.
process.env.NEXTAUTH_SECRET ??= "unit-test-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const parts: Buffer[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

async function dirGone(dir: string): Promise<boolean> {
  try {
    await fs.stat(dir);
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// import-session: server-side chunk assembly
// ---------------------------------------------------------------------------

test("startSession fails closed on malformed ids/sizes and the ciphertext cap, claiming no slot", async () => {
  const bad = await startSession({ uploadId: "not-a-uuid", totalSize: 10, totalChunks: 1 });
  if (bad.ok) assert.fail("non-UUID id must be rejected");
  assert.deepEqual(bad.error, { kind: "invalid-id" });

  for (const totalSize of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = await startSession({ uploadId: crypto.randomUUID(), totalSize, totalChunks: 1 });
    if (r.ok) assert.fail(`totalSize=${totalSize} must be rejected`);
    assert.deepEqual(r.error, { kind: "invalid-size" });
  }

  const zeroChunks = await startSession({ uploadId: crypto.randomUUID(), totalSize: 10, totalChunks: 0 });
  if (zeroChunks.ok) assert.fail("totalChunks=0 must be rejected");
  assert.deepEqual(zeroChunks.error, { kind: "invalid-size" });

  const tooLarge = await startSession({
    uploadId: crypto.randomUUID(),
    totalSize: MAX_CIPHERTEXT_BYTES + 1,
    totalChunks: 1,
  });
  if (tooLarge.ok) assert.fail("size above MAX_CIPHERTEXT_BYTES must be rejected");
  assert.deepEqual(tooLarge.error, { kind: "size-too-large", max: MAX_CIPHERTEXT_BYTES });

  // None of the rejections claimed the single global slot.
  const append = await appendChunk(crypto.randomUUID(), 0, bytes("x"));
  if (append.ok) assert.fail("no session should be active after rejected starts");
  assert.deepEqual(append.error, { kind: "no-session" });
});

test("single global slot: a second uploadId gets in-progress; the same uploadId resumes its session", async () => {
  const idA = crypto.randomUUID();
  const idB = crypto.randomUUID();
  try {
    const a1 = await startSession({ uploadId: idA, totalSize: 10, totalChunks: 2 });
    if (!a1.ok) assert.fail("first start must succeed");

    const b = await startSession({ uploadId: idB, totalSize: 10, totalChunks: 2 });
    if (b.ok) assert.fail("second concurrent uploadId must be refused");
    assert.deepEqual(b.error, { kind: "in-progress" });

    // Restarting with the same id is an idempotent resume of the same session.
    const a2 = await startSession({ uploadId: idA, totalSize: 10, totalChunks: 2 });
    if (!a2.ok) assert.fail("same-id restart must succeed");
    assert.equal(a2.session, a1.session);
    assert.equal(a2.session.filePath, a1.session.filePath);
  } finally {
    await clearSession(idA);
  }
});

test("ordered assembly: exact counters per chunk, finalize on the last chunk, stream returns the assembled bytes", async () => {
  const id = crypto.randomUUID();
  const chunks = ["hello ", "chunked ", "world"];
  const totalSize = chunks.join("").length;
  const started = await startSession({ uploadId: id, totalSize, totalChunks: 3 });
  if (!started.ok) assert.fail("start must succeed");
  const { tempDir } = started.session;
  try {
    const r0 = await appendChunk(id, 0, bytes(chunks[0]));
    if (!r0.ok) assert.fail("chunk 0 must append");
    assert.deepEqual(r0, { ok: true, received: 1, total: 3, bytesWritten: 6, complete: false });

    const r1 = await appendChunk(id, 1, bytes(chunks[1]));
    if (!r1.ok) assert.fail("chunk 1 must append");
    assert.deepEqual(r1, { ok: true, received: 2, total: 3, bytesWritten: 14, complete: false });

    const r2 = await appendChunk(id, 2, bytes(chunks[2]));
    if (!r2.ok) assert.fail("chunk 2 must append");
    assert.deepEqual(r2, { ok: true, received: 3, total: 3, bytesWritten: totalSize, complete: true });

    const stream = getSessionStream(id);
    assert.ok(stream, "completed session must be streamable");
    assert.equal((await collect(stream)).toString("utf8"), "hello chunked world");
  } finally {
    await clearSession(id);
  }
  // clearSession removed the unpredictable temp directory and freed the slot.
  assert.equal(await dirGone(tempDir), true);
  assert.equal(getSessionStream(id), null);
});

test("duplicate, out-of-order, and wrong-session chunks are rejected without corrupting the assembly", async () => {
  const id = crypto.randomUUID();
  const started = await startSession({ uploadId: id, totalSize: 8, totalChunks: 2 });
  if (!started.ok) assert.fail("start must succeed");
  try {
    const first = await appendChunk(id, 0, bytes("aaaa"));
    if (!first.ok) assert.fail("chunk 0 must append");

    // Duplicate resend of chunk 0 → out-of-order (the dedup story).
    const dup = await appendChunk(id, 0, bytes("aaaa"));
    if (dup.ok) assert.fail("duplicate chunk must be rejected");
    assert.deepEqual(dup.error, { kind: "out-of-order", expected: 1 });

    // Skipping ahead is also rejected with the expected index.
    const skip = await appendChunk(id, 2, bytes("cccc"));
    if (skip.ok) assert.fail("skipped chunk must be rejected");
    assert.deepEqual(skip.error, { kind: "out-of-order", expected: 1 });

    // A different uploadId cannot write into the active session.
    const stranger = await appendChunk(crypto.randomUUID(), 1, bytes("evil"));
    if (stranger.ok) assert.fail("foreign uploadId must be rejected");
    assert.deepEqual(stranger.error, { kind: "session-mismatch" });

    // The correct next chunk still lands and the bytes contain no duplicates.
    const second = await appendChunk(id, 1, bytes("bbbb"));
    if (!second.ok) assert.fail("chunk 1 must append after rejections");
    assert.equal(second.complete, true);
    const stream = getSessionStream(id);
    assert.ok(stream);
    assert.equal((await collect(stream)).toString("utf8"), "aaaabbbb");
  } finally {
    await clearSession(id);
  }
});

test("size overflow is rejected without consuming the chunk slot; a corrected retry completes", async () => {
  const id = crypto.randomUUID();
  const started = await startSession({ uploadId: id, totalSize: 10, totalChunks: 2 });
  if (!started.ok) assert.fail("start must succeed");
  try {
    const r0 = await appendChunk(id, 0, bytes("123456"));
    if (!r0.ok) assert.fail("chunk 0 must append");

    const overflow = await appendChunk(id, 1, bytes("78901234")); // 6 + 8 > 10
    if (overflow.ok) assert.fail("overflowing chunk must be rejected");
    assert.deepEqual(overflow.error, { kind: "size-overflow", max: 10 });

    // The rejected chunk did not advance receivedChunks — index 1 is still open.
    const retry = await appendChunk(id, 1, bytes("7890"));
    if (!retry.ok) assert.fail("corrected retry must append");
    assert.deepEqual(retry, { ok: true, received: 2, total: 2, bytesWritten: 10, complete: true });
    const stream = getSessionStream(id);
    assert.ok(stream);
    assert.equal((await collect(stream)).toString("utf8"), "1234567890");
  } finally {
    await clearSession(id);
  }
});

test("a short upload (declared size not reached on the final chunk) destroys the session and its files", async () => {
  const id = crypto.randomUUID();
  const started = await startSession({ uploadId: id, totalSize: 10, totalChunks: 2 });
  if (!started.ok) assert.fail("start must succeed");
  const { tempDir } = started.session;

  const r0 = await appendChunk(id, 0, bytes("aaaa"));
  if (!r0.ok) assert.fail("chunk 0 must append");
  const short = await appendChunk(id, 1, bytes("bbbb")); // 8 !== declared 10
  if (short.ok) assert.fail("short final chunk must be rejected");
  assert.deepEqual(short.error, { kind: "size-mismatch", expected: 10, received: 8 });

  // The incomplete ciphertext can never reach the importer: session is gone.
  const after = await appendChunk(id, 2, bytes("cc"));
  if (after.ok) assert.fail("destroyed session must not accept chunks");
  assert.deepEqual(after.error, { kind: "no-session" });
  assert.equal(getSessionStream(id), null);
  assert.equal(await dirGone(tempDir), true);

  // …and the single slot is free for the next restore.
  const next = await startSession({ uploadId: crypto.randomUUID(), totalSize: 4, totalChunks: 1 });
  if (!next.ok) assert.fail("slot must be free after a size-mismatch teardown");
  await clearSession(next.session.uploadId);
});

test("an expired idle session is reclaimed by the next startSession and its temp dir removed", async () => {
  const idOld = crypto.randomUUID();
  const idNew = crypto.randomUUID();
  const old = await startSession({ uploadId: idOld, totalSize: 10, totalChunks: 2 });
  if (!old.ok) assert.fail("start must succeed");
  old.session.expiresAt = Date.now() - 1; // simulate the 10-minute idle TTL lapsing
  try {
    const fresh = await startSession({ uploadId: idNew, totalSize: 4, totalChunks: 1 });
    if (!fresh.ok) assert.fail("expired slot must be reclaimable");
    assert.equal(await dirGone(old.session.tempDir), true);

    const r = await appendChunk(idNew, 0, bytes("data"));
    if (!r.ok) assert.fail("reclaimed slot must accept the new session's chunks");
    assert.equal(r.complete, true);
  } finally {
    await clearSession(idNew);
  }
});

test("appendChunk on an expired session fails closed with `expired` and frees the slot", async () => {
  const id = crypto.randomUUID();
  const started = await startSession({ uploadId: id, totalSize: 10, totalChunks: 2 });
  if (!started.ok) assert.fail("start must succeed");
  const r0 = await appendChunk(id, 0, bytes("aaaa"));
  if (!r0.ok) assert.fail("chunk 0 must append");
  started.session.expiresAt = Date.now() - 1;

  const late = await appendChunk(id, 1, bytes("bbbb"));
  if (late.ok) assert.fail("chunk after expiry must be rejected");
  assert.deepEqual(late.error, { kind: "expired" });
  assert.equal(await dirGone(started.session.tempDir), true);

  const after = await appendChunk(id, 1, bytes("bbbb"));
  if (after.ok) assert.fail("slot must be empty after expiry teardown");
  assert.deepEqual(after.error, { kind: "no-session" });
});

test("every accepted chunk slides the idle-expiry window forward (~10 minutes)", async () => {
  const id = crypto.randomUUID();
  const started = await startSession({ uploadId: id, totalSize: 8, totalChunks: 2 });
  if (!started.ok) assert.fail("start must succeed");
  try {
    started.session.expiresAt = Date.now() + 1_000; // artificially near-expired, but not expired
    const r = await appendChunk(id, 0, bytes("aaaa"));
    if (!r.ok) assert.fail("chunk must append");
    // Bumped back to now+TTL (10 min); assert with a wide margin so it can't flake.
    assert.ok(
      started.session.expiresAt - Date.now() > 9 * 60 * 1000,
      "accepted chunk must re-arm the idle TTL",
    );
  } finally {
    await clearSession(id);
  }
});

test("an in-flight import pins the slot: getSessionStream marks importing and expiry cannot reclaim it", async () => {
  const id = crypto.randomUUID();
  const started = await startSession({ uploadId: id, totalSize: 4, totalChunks: 1 });
  if (!started.ok) assert.fail("start must succeed");
  try {
    const r = await appendChunk(id, 0, bytes("data"));
    if (!r.ok) assert.fail("chunk must append");
    const stream = getSessionStream(id);
    assert.ok(stream);
    await collect(stream); // consume fully so the fd closes
    assert.equal(started.session.importing, true);

    // Even a lapsed idle TTL must not let another start rm the file mid-import.
    started.session.expiresAt = Date.now() - 1;
    const other = await startSession({ uploadId: crypto.randomUUID(), totalSize: 4, totalChunks: 1 });
    if (other.ok) assert.fail("importing session must not be reclaimed");
    assert.deepEqual(other.error, { kind: "in-progress" });
  } finally {
    await clearSession(id); // the importer's finally in production
  }
  // After clearSession the slot is genuinely free again.
  const next = await startSession({ uploadId: crypto.randomUUID(), totalSize: 4, totalChunks: 1 });
  if (!next.ok) assert.fail("slot must free once the import clears the session");
  await clearSession(next.session.uploadId);
});

test("getSessionStream and clearSession ignore a non-matching uploadId", async () => {
  assert.equal(getSessionStream(crypto.randomUUID()), null); // no active session at all

  const id = crypto.randomUUID();
  const started = await startSession({ uploadId: id, totalSize: 4, totalChunks: 1 });
  if (!started.ok) assert.fail("start must succeed");
  try {
    assert.equal(getSessionStream(crypto.randomUUID()), null);
    assert.notEqual(started.session.importing, true, "a rejected stream request must not mark importing");

    await clearSession(crypto.randomUUID()); // wrong id: must be a no-op
    const stillHeld = await startSession({ uploadId: crypto.randomUUID(), totalSize: 4, totalChunks: 1 });
    if (stillHeld.ok) assert.fail("session must survive a wrong-id clearSession");
    assert.deepEqual(stillHeld.error, { kind: "in-progress" });
  } finally {
    await clearSession(id);
  }
});

test("concurrent duplicate first chunks serialize through the append queue: exactly one wins", async () => {
  const id = crypto.randomUUID();
  const started = await startSession({ uploadId: id, totalSize: 8, totalChunks: 2 });
  if (!started.ok) assert.fail("start must succeed");
  try {
    // Two chunk-0 POSTs racing (client retry). The per-session queue chains
    // them in call order, so the outcome is deterministic: first ok, second
    // rejected — never two interleaved "w"-mode writes corrupting the file.
    const [w, l] = await Promise.all([appendChunk(id, 0, bytes("aaaa")), appendChunk(id, 0, bytes("aaaa"))]);
    if (!w.ok) assert.fail("first racer must win");
    assert.equal(w.received, 1);
    if (l.ok) assert.fail("second racer must lose");
    assert.deepEqual(l.error, { kind: "out-of-order", expected: 1 });

    const done = await appendChunk(id, 1, bytes("bbbb"));
    if (!done.ok) assert.fail("chunk 1 must append");
    assert.equal(done.complete, true);
    const stream = getSessionStream(id);
    assert.ok(stream);
    assert.equal((await collect(stream)).toString("utf8"), "aaaabbbb"); // chunk 0 written exactly once
  } finally {
    await clearSession(id);
  }
});

test("concurrent startSession races serialize through the mutex: exactly one claims the slot", async () => {
  const idA = crypto.randomUUID();
  const idB = crypto.randomUUID();
  try {
    const [a, b] = await Promise.all([
      startSession({ uploadId: idA, totalSize: 4, totalChunks: 1 }),
      startSession({ uploadId: idB, totalSize: 4, totalChunks: 1 }),
    ]);
    if (!a.ok) assert.fail("first racer must claim the slot");
    if (b.ok) assert.fail("second racer must be refused");
    assert.deepEqual(b.error, { kind: "in-progress" });
  } finally {
    await clearSession(idA);
  }
});

// ---------------------------------------------------------------------------
// chunked-upload: client-side uploader (scripted fetch mock, no network)
// ---------------------------------------------------------------------------

type FetchArgs = Parameters<typeof fetch>;
type Recorded = { method: string; headers: Record<string, string>; body: Blob | null };
type MockResponse = {
  ok: boolean;
  status: number;
  redirected: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
};

let fetchImpl: ((...args: FetchArgs) => Promise<Response>) | null = null;
globalThis.fetch = ((...args: FetchArgs) => {
  if (!fetchImpl) throw new Error("unexpected fetch: no mock installed");
  return fetchImpl(...args);
}) as unknown as typeof fetch;

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  opts: { redirected?: boolean; contentType?: string | null } = {},
): MockResponse {
  const contentType = opts.contentType === undefined ? "application/json" : opts.contentType;
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: opts.redirected ?? false,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
    json: () => Promise.resolve(body),
  };
}

// Installs a fetch mock: POST n is answered by respond(n); DELETE (the cancel
// path) always succeeds. Requests are recorded synchronously at call time so
// the fire-and-forget cancel is captured before uploadInChunks returns; POSTs
// and DELETEs also land in `events` to pin their ordering against progress.
function scriptFetch(
  events: string[],
  respond: (postIndex: number, req: Recorded) => MockResponse,
): Recorded[] {
  const calls: Recorded[] = [];
  let postCount = 0;
  fetchImpl = (_input, init) => {
    const method = init?.method ?? "GET";
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const rec: Recorded = { method, headers, body: (init?.body as Blob | undefined) ?? null };
    calls.push(rec);
    if (method === "DELETE") {
      events.push("DELETE");
      return Promise.resolve(jsonResponse(200, {}) as unknown as Response);
    }
    events.push(`POST:${headers["X-Chunk-Index"]}`);
    const index = postCount++;
    return Promise.resolve()
      .then(() => respond(index, rec))
      .then((r) => r as unknown as Response);
  };
  return calls;
}

function progressRecorder(events: string[]): (p: ChunkedUploadProgress) => void {
  return (p) => events.push(`progress:${p.phase}:${p.uploaded}/${p.total}`);
}

test("DEFAULT_CHUNK_SIZE is 16MB and a small file defaults to a single chunk", async () => {
  assert.equal(DEFAULT_CHUNK_SIZE, 16 * 1024 * 1024);

  const events: string[] = [];
  const calls = scriptFetch(events, () => jsonResponse(200, { complete: true, ok: true }));
  const outcome = await uploadInChunks({ file: new File(["hello"], "dump.enc"), endpoint: "/api/x" });
  assert.deepEqual(outcome, { kind: "complete", ok: true, data: { complete: true, ok: true } });
  assert.equal(calls.length, 1); // one POST, no cancel
  assert.equal(calls[0].headers["X-Chunk-Total"], "1");
  assert.equal(calls[0].headers["X-File-Size"], "5");
});

test("multi-chunk happy path: ordered slices, consistent headers, progress phases, complete passthrough", async () => {
  const events: string[] = [];
  const calls = scriptFetch(events, (n) =>
    n < 2
      ? jsonResponse(200, { ok: true, received: n + 1 })
      : jsonResponse(200, { complete: true, ok: true, imported: 42 }),
  );
  const outcome = await uploadInChunks({
    file: new File(["0123456789"], "dump.enc"),
    endpoint: "/api/x",
    chunkSize: 4,
    onProgress: progressRecorder(events),
  });
  assert.deepEqual(outcome, {
    kind: "complete",
    ok: true,
    data: { complete: true, ok: true, imported: 42 },
  });

  // The "import" phase fires BEFORE the final POST (the long server-side
  // import happens inside that request), and no cancel is sent on success.
  assert.deepEqual(events, [
    "progress:upload:0/10",
    "POST:0",
    "progress:upload:4/10",
    "POST:1",
    "progress:upload:8/10",
    "progress:import:10/10",
    "POST:2",
  ]);

  assert.equal(calls.length, 3);
  const uploadId = calls[0].headers["X-Upload-Id"];
  assert.match(uploadId, UUID_RE);
  for (const [i, call] of calls.entries()) {
    assert.equal(call.method, "POST");
    assert.equal(call.headers["Content-Type"], "application/octet-stream");
    assert.equal(call.headers["X-Upload-Id"], uploadId); // one session id across all chunks
    assert.equal(call.headers["X-Chunk-Index"], String(i));
    assert.equal(call.headers["X-Chunk-Total"], "3");
    assert.equal(call.headers["X-File-Size"], "10");
  }
  assert.ok(calls[0].body && calls[1].body && calls[2].body);
  assert.equal(await calls[0].body.text(), "0123");
  assert.equal(await calls[1].body.text(), "4567");
  assert.equal(await calls[2].body.text(), "89"); // final partial chunk
});

test("an early server-side complete stops the loop without sending remaining chunks", async () => {
  const events: string[] = [];
  const calls = scriptFetch(events, () => jsonResponse(200, { complete: true, ok: true }));
  const outcome = await uploadInChunks({
    file: new File(["0123456789"], "dump.enc"),
    endpoint: "/api/x",
    chunkSize: 4,
  });
  assert.equal(outcome.kind, "complete");
  assert.deepEqual(events, ["POST:0"]); // chunks 1 and 2 never sent, no DELETE
  assert.equal(calls.length, 1);
});

test("outcome.ok is true only when the server said exactly ok:true", async () => {
  const events: string[] = [];
  scriptFetch(events, () => jsonResponse(200, { complete: true }));
  const missing = await uploadInChunks({ file: new File(["x"], "a"), endpoint: "/api/x" });
  assert.deepEqual(missing, { kind: "complete", ok: false, data: { complete: true } });

  scriptFetch(events, () => jsonResponse(200, { complete: true, ok: "true" }));
  const stringy = await uploadInChunks({ file: new File(["x"], "a"), endpoint: "/api/x" });
  assert.equal(stringy.kind, "complete");
  if (stringy.kind === "complete") assert.equal(stringy.ok, false); // string "true" is not true
});

test("an HTTP error surfaces the server's error string and fires the DELETE cancel with the same uploadId", async () => {
  const events: string[] = [];
  const calls = scriptFetch(events, (n) =>
    n === 0 ? jsonResponse(200, { ok: true }) : jsonResponse(413, { error: "too big" }),
  );
  const outcome = await uploadInChunks({
    file: new File(["0123456789"], "dump.enc"),
    endpoint: "/api/x",
    chunkSize: 4,
  });
  assert.deepEqual(outcome, { kind: "error", status: 413, error: "too big" });
  assert.deepEqual(events, ["POST:0", "POST:1", "DELETE"]); // chunk 2 never sent
  const cancel = calls[calls.length - 1];
  assert.equal(cancel.method, "DELETE");
  assert.equal(cancel.headers["X-Upload-Id"], calls[0].headers["X-Upload-Id"]);
});

test("an HTTP error without a server error string falls back to the chunk-position message", async () => {
  const events: string[] = [];
  scriptFetch(events, () => jsonResponse(500, {}));
  const outcome = await uploadInChunks({
    file: new File(["0123456789"], "dump.enc"),
    endpoint: "/api/x",
    chunkSize: 4,
  });
  assert.deepEqual(outcome, { kind: "error", status: 500, error: "Chunk 1/3 failed" });
});

test("a non-JSON response (auth-gate HTML, or no content-type) aborts with the redirect explanation", async () => {
  for (const contentType of ["text/html; charset=utf-8", null]) {
    const events: string[] = [];
    scriptFetch(events, () => jsonResponse(200, {}, { contentType }));
    const outcome = await uploadInChunks({ file: new File(["x"], "a"), endpoint: "/api/x" });
    assert.equal(outcome.kind, "error");
    if (outcome.kind === "error") {
      assert.equal(outcome.status, 200); // fetch followed the redirect to a 200 page
      assert.match(outcome.error, /non-JSON response/);
      assert.match(outcome.error, /\/api\/x/);
    }
    assert.equal(events[events.length - 1], "DELETE");
  }
});

test("a redirected response is rejected even when the final page serves JSON", async () => {
  const events: string[] = [];
  scriptFetch(events, () => jsonResponse(200, { complete: true, ok: true }, { redirected: true }));
  const outcome = await uploadInChunks({ file: new File(["x"], "a"), endpoint: "/api/x" });
  assert.equal(outcome.kind, "error");
  assert.equal(events[events.length - 1], "DELETE");
});

test("all chunks accepted but no complete flag → error with null status, plus the cancel", async () => {
  const events: string[] = [];
  scriptFetch(events, () => jsonResponse(200, { ok: true, received: 1 }));
  const outcome = await uploadInChunks({ file: new File(["x"], "a"), endpoint: "/api/x" });
  assert.deepEqual(outcome, {
    kind: "error",
    status: null,
    error: "Upload finished without a server-side completion.",
  });
  assert.deepEqual(events, ["POST:0", "DELETE"]);
});

test("a thrown network error becomes an error outcome with the message, and still cancels", async () => {
  const events: string[] = [];
  scriptFetch(events, () => {
    throw new Error("boom: connection reset");
  });
  const outcome = await uploadInChunks({ file: new File(["x"], "a"), endpoint: "/api/x" });
  assert.deepEqual(outcome, { kind: "error", status: null, error: "boom: connection reset" });
  assert.deepEqual(events, ["POST:0", "DELETE"]);
});

test("an empty file sends zero chunks and reports no-completion (pins current behavior)", async () => {
  // ceil(0 / chunkSize) = 0 → the loop never runs, so a 0-byte file can never
  // complete; the server-side startSession would reject totalSize 0 anyway.
  const events: string[] = [];
  const calls = scriptFetch(events, () => jsonResponse(200, { complete: true, ok: true }));
  const outcome = await uploadInChunks({
    file: new File([], "empty.enc"),
    endpoint: "/api/x",
    onProgress: progressRecorder(events),
  });
  assert.deepEqual(outcome, {
    kind: "error",
    status: null,
    error: "Upload finished without a server-side completion.",
  });
  assert.deepEqual(events, ["progress:upload:0/0", "DELETE"]);
  assert.equal(calls.length, 1); // only the cancel DELETE, no POSTs
});
