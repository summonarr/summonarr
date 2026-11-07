// Complementary unit tests for src/lib/import-session.ts — the single-slot
// chunked-upload assembler feeding the DESTRUCTIVE backup restore.
//
// The primary behavioral suite lives in tests/chunked-upload.test.mts (ordering,
// duplicate rejection, size caps, short-upload teardown, slot reclamation, race
// serialization). This file pins the BOUNDARY and edge behaviors that suite does
// not touch: non-integer/infinite totalChunks validation, the exact
// MAX_CIPHERTEXT_BYTES boundary, uploadId case handling, same-id restart after
// expiry, the strict-greater overflow guard, pipelined in-order concurrent
// appends, clearSession idempotency, and the never-reclaim-while-importing
// guarantee for a retry carrying the SAME uploadId (regression test — the
// same-id path used to fall through to the expiry cleanup and rm the tempDir
// out from under the in-flight import read).
// No network, no DB: import-session only touches a mkdtemp directory, which
// every test removes via clearSession.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  startSession,
  appendChunk,
  getSessionStream,
  clearSession,
  cancelSession,
} from "../src/lib/import-session.ts";
import { MAX_CIPHERTEXT_BYTES } from "../src/lib/backup-import.ts";

// backup-import transitively loads prisma + token-crypto; both read env lazily
// and neither connects at import time. Point them at nothing real.
process.env.NEXTAUTH_SECRET ??= "unit-test-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";

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

test("non-integer-ish totalChunks values (NaN, negative, Infinity) are rejected without claiming the slot", async () => {
  for (const totalChunks of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const r = await startSession({ uploadId: crypto.randomUUID(), totalSize: 10, totalChunks });
    if (r.ok) assert.fail(`totalChunks=${totalChunks} must be rejected`);
    assert.deepEqual(r.error, { kind: "invalid-size" });
  }
  // None of the rejections left an active session behind.
  const probe = await appendChunk(crypto.randomUUID(), 0, bytes("x"));
  if (probe.ok) assert.fail("no session should be active after rejected starts");
  assert.deepEqual(probe.error, { kind: "no-session" });
});

test("totalSize exactly at MAX_CIPHERTEXT_BYTES is accepted (the cap is inclusive) and the temp dir uses the documented prefix", async () => {
  const id = crypto.randomUUID();
  const r = await startSession({ uploadId: id, totalSize: MAX_CIPHERTEXT_BYTES, totalChunks: 1 });
  if (!r.ok) assert.fail("size == MAX_CIPHERTEXT_BYTES must be accepted (only > is rejected)");
  try {
    assert.equal(r.session.totalSize, MAX_CIPHERTEXT_BYTES);
    assert.equal(r.session.receivedChunks, 0);
    assert.equal(r.session.bytesWritten, 0);
    // mkdtemp under os.tmpdir() with the summonarr-upload- prefix; the suffix is
    // the unpredictable part, the location is the contract.
    const prefix = path.join(os.tmpdir(), "summonarr-upload-");
    assert.ok(r.session.tempDir.startsWith(prefix), `tempDir must live under ${prefix}`);
    assert.equal(r.session.filePath, path.join(r.session.tempDir, "upload.bin"));
  } finally {
    await clearSession(id);
  }
});

test("uploadId is case-insensitively validated but exact-match bound: an uppercase session rejects its lowercase twin", async () => {
  const upper = crypto.randomUUID().toUpperCase();
  const started = await startSession({ uploadId: upper, totalSize: 4, totalChunks: 1 });
  if (!started.ok) assert.fail("uppercase UUID must pass the case-insensitive format check");
  try {
    // Session binding is exact string comparison — a client that changes case
    // mid-upload does not reach the active session.
    const mismatch = await appendChunk(upper.toLowerCase(), 0, bytes("data"));
    if (mismatch.ok) assert.fail("lowercased id must not match the uppercase session");
    assert.deepEqual(mismatch.error, { kind: "session-mismatch" });

    const exact = await appendChunk(upper, 0, bytes("data"));
    if (!exact.ok) assert.fail("the exact original id must still append");
    assert.equal(exact.complete, true);
    assert.equal(getSessionStream(upper.toLowerCase()), null);
  } finally {
    await clearSession(upper);
  }
});

test("restarting the SAME uploadId after idle expiry yields a fresh session (reset counters, new temp dir), not a resume", async () => {
  const id = crypto.randomUUID();
  const first = await startSession({ uploadId: id, totalSize: 8, totalChunks: 2 });
  if (!first.ok) assert.fail("start must succeed");
  const r0 = await appendChunk(id, 0, bytes("aaaa"));
  if (!r0.ok) assert.fail("chunk 0 must append");
  first.session.expiresAt = Date.now() - 1; // idle TTL lapses between chunks

  const second = await startSession({ uploadId: id, totalSize: 8, totalChunks: 2 });
  if (!second.ok) assert.fail("same-id restart after expiry must succeed");
  try {
    assert.notEqual(second.session, first.session, "expired session must not be resumed");
    assert.notEqual(second.session.tempDir, first.session.tempDir);
    assert.equal(second.session.receivedChunks, 0);
    assert.equal(second.session.bytesWritten, 0);
    assert.equal(await dirGone(first.session.tempDir), true, "expired temp dir must be removed");

    // The fresh session starts over at chunk 0 — the pre-expiry bytes are gone.
    const again = await appendChunk(id, 0, bytes("bbbb"));
    if (!again.ok) assert.fail("fresh session must accept chunk 0");
    assert.deepEqual(again, { ok: true, received: 1, total: 2, bytesWritten: 4, complete: false });
  } finally {
    await clearSession(id);
  }
});

test("overflow guard is strict-greater: an exact fill mid-upload is allowed and a zero-byte final chunk completes", async () => {
  // Pins current behavior: completion requires BOTH receivedChunks == totalChunks
  // and bytesWritten == totalSize; reaching totalSize early is not an overflow,
  // and the (degenerate) empty final chunk satisfies the size equality.
  const id = crypto.randomUUID();
  const started = await startSession({ uploadId: id, totalSize: 8, totalChunks: 2 });
  if (!started.ok) assert.fail("start must succeed");
  try {
    const full = await appendChunk(id, 0, bytes("12345678")); // fills totalSize on chunk 1 of 2
    if (!full.ok) assert.fail("exact fill must not trip the overflow guard");
    assert.deepEqual(full, { ok: true, received: 1, total: 2, bytesWritten: 8, complete: false });

    const one = await appendChunk(id, 1, bytes("x")); // any further byte overflows
    if (one.ok) assert.fail("a single extra byte past totalSize must be rejected");
    assert.deepEqual(one.error, { kind: "size-overflow", max: 8 });

    const empty = await appendChunk(id, 1, new Uint8Array(0));
    if (!empty.ok) assert.fail("zero-byte final chunk must append");
    assert.deepEqual(empty, { ok: true, received: 2, total: 2, bytesWritten: 8, complete: true });

    const stream = getSessionStream(id);
    assert.ok(stream);
    assert.equal((await collect(stream)).toString("utf8"), "12345678");
  } finally {
    await clearSession(id);
  }
});

test("pipelined sequential chunks fired concurrently serialize in call order through the append queue", async () => {
  // tests/chunked-upload.test.mts covers the duplicate-chunk race; this pins the
  // complementary property — correctly-indexed chunks issued in the same tick
  // (a pipelining client) all land, in order, with no interleaved writes.
  const id = crypto.randomUUID();
  const started = await startSession({ uploadId: id, totalSize: 12, totalChunks: 3 });
  if (!started.ok) assert.fail("start must succeed");
  try {
    const [r0, r1, r2] = await Promise.all([
      appendChunk(id, 0, bytes("aaaa")),
      appendChunk(id, 1, bytes("bbbb")),
      appendChunk(id, 2, bytes("cccc")),
    ]);
    if (!r0.ok || !r1.ok || !r2.ok) assert.fail("all pipelined chunks must append");
    assert.equal(r0.received, 1);
    assert.equal(r1.received, 2);
    assert.deepEqual(r2, { ok: true, received: 3, total: 3, bytesWritten: 12, complete: true });

    const stream = getSessionStream(id);
    assert.ok(stream);
    assert.equal((await collect(stream)).toString("utf8"), "aaaabbbbcccc");
  } finally {
    await clearSession(id);
  }
});

test("clearSession is idempotent: a double clear is a no-op and the slot stays free", async () => {
  const id = crypto.randomUUID();
  const started = await startSession({ uploadId: id, totalSize: 4, totalChunks: 1 });
  if (!started.ok) assert.fail("start must succeed");

  await clearSession(id);
  await clearSession(id); // second clear: active is null → returns without touching disk
  assert.equal(await dirGone(started.session.tempDir), true);

  const next = await startSession({ uploadId: crypto.randomUUID(), totalSize: 4, totalChunks: 1 });
  if (!next.ok) assert.fail("slot must be free after (double) clear");
  await clearSession(next.session.uploadId);
});

test("an importing-but-expired session is NEVER reclaimed — not even by a retry with the SAME uploadId", async () => {
  // Regression test: the `importing` guard used to apply only when
  // `active.uploadId !== opts.uploadId`, so a retried chunk-0 POST carrying the
  // SAME uploadId, arriving after the idle TTL lapsed while the import was
  // still reading the file, fell through to the expired-cleanup — the temp dir
  // was rm'd out from under the in-flight read and a fresh empty session took
  // the slot. Both startSession and the appendChunk expiry branch must now
  // refuse to touch an importing session; the importer's finally
  // (clearSession) is the only thing that frees it.
  const id = crypto.randomUUID();
  const first = await startSession({ uploadId: id, totalSize: 4, totalChunks: 1 });
  if (!first.ok) assert.fail("start must succeed");
  const r = await appendChunk(id, 0, bytes("data"));
  if (!r.ok) assert.fail("chunk must append");
  const stream = getSessionStream(id);
  assert.ok(stream);
  assert.equal(first.session.importing, true);
  first.session.expiresAt = Date.now() - 1; // idle TTL lapses mid-import

  try {
    // A same-id restart is refused outright (409 upstream), leaving the
    // session and its temp dir untouched for the in-flight read.
    const retry = await startSession({ uploadId: id, totalSize: 4, totalChunks: 1 });
    if (retry.ok) assert.fail("same-id restart must not reclaim an importing session");
    assert.deepEqual(retry.error, { kind: "in-progress" });

    // A retried chunk must not trigger the expiry cleanup either: it falls
    // through to the index check (out-of-order) and touches nothing on disk.
    const late = await appendChunk(id, 0, bytes("data"));
    if (late.ok) assert.fail("no chunk may land on an importing session");
    assert.deepEqual(late.error, { kind: "out-of-order", expected: 1 });

    assert.equal(await dirGone(first.session.tempDir), false, "the importing session's dir must survive");
    // The in-flight read completes intact after both retry attempts.
    assert.equal((await collect(stream)).toString("utf8"), "data");
  } finally {
    await clearSession(id); // the importer's finally — frees the slot
  }

  assert.equal(await dirGone(first.session.tempDir), true, "clearSession removes the dir once the import is done");
  // With the import finished, the same uploadId can start a fresh session again.
  const fresh = await startSession({ uploadId: id, totalSize: 4, totalChunks: 1 });
  if (!fresh.ok) assert.fail("slot must be free after clearSession");
  assert.equal(fresh.session.receivedChunks, 0);
  await clearSession(id);
});

test("totalChunks must be a whole number no larger than the byte count", async () => {
  for (const [totalSize, totalChunks] of [[10, 2.5], [4, 5], [1, 2]] as const) {
    const r = await startSession({ uploadId: crypto.randomUUID(), totalSize, totalChunks });
    if (r.ok) assert.fail(`totalSize=${totalSize} totalChunks=${totalChunks} must be rejected`);
    assert.deepEqual(r.error, { kind: "invalid-size" });
  }
  // The boundary: one byte per chunk is a (silly but) real upload.
  const id = crypto.randomUUID();
  const edge = await startSession({ uploadId: id, totalSize: 4, totalChunks: 4 });
  if (!edge.ok) assert.fail("totalChunks == totalSize must be accepted");
  await clearSession(id);
});

test("the upload slot is process-wide: a second copy of the module sees the same session", async () => {
  // Turbopack copies a lib module into every chunk that imports it; the setup
  // and admin routes must still share one slot (guardrail 27a).
  const specifier = "../src/lib/import-session.ts?chunk=second";
  const other: typeof import("../src/lib/import-session.ts") = await import(specifier);
  const id = crypto.randomUUID();
  const started = await startSession({ uploadId: id, totalSize: 4, totalChunks: 1 });
  if (!started.ok) assert.fail("start must succeed");
  try {
    const rival = await other.startSession({ uploadId: crypto.randomUUID(), totalSize: 4, totalChunks: 1 });
    if (rival.ok) assert.fail("the other copy must see the slot taken");
    assert.deepEqual(rival.error, { kind: "in-progress" });
    assert.equal(other.hasActiveUploadSession(id), true);
  } finally {
    await clearSession(id);
  }
});

test("a client cancel never touches a session that is being imported; the importer's clear still frees it", async () => {
  // The uploader sends DELETE when the final chunk's request fails at a proxy
  // (502/504) while the server is still restoring from the file.
  const id = crypto.randomUUID();
  const started = await startSession({ uploadId: id, totalSize: 4, totalChunks: 1 });
  if (!started.ok) assert.fail("start must succeed");
  const r = await appendChunk(id, 0, bytes("data"));
  if (!r.ok) assert.fail("chunk must append");
  const stream = getSessionStream(id);
  assert.ok(stream);

  await cancelSession(id);
  assert.equal(await dirGone(started.session.tempDir), false, "the file being imported must stay");
  const rival = await startSession({ uploadId: crypto.randomUUID(), totalSize: 4, totalChunks: 1 });
  if (rival.ok) assert.fail("a second upload must not start beside the running restore");
  assert.deepEqual(rival.error, { kind: "in-progress" });
  assert.equal((await collect(stream)).toString("utf8"), "data");

  await clearSession(id); // the importer's finally
  assert.equal(await dirGone(started.session.tempDir), true);
  const next = await startSession({ uploadId: crypto.randomUUID(), totalSize: 4, totalChunks: 1 });
  if (!next.ok) assert.fail("the slot is free once the importer clears it");
  await clearSession(next.session.uploadId);
});

test("a client cancel of an upload that is NOT importing frees the slot", async () => {
  const id = crypto.randomUUID();
  const started = await startSession({ uploadId: id, totalSize: 8, totalChunks: 2 });
  if (!started.ok) assert.fail("start must succeed");
  await cancelSession(crypto.randomUUID()); // another id: a no-op
  assert.equal(await dirGone(started.session.tempDir), false);
  await cancelSession(id);
  assert.equal(await dirGone(started.session.tempDir), true);
  const next = await startSession({ uploadId: crypto.randomUUID(), totalSize: 4, totalChunks: 1 });
  if (!next.ok) assert.fail("slot must be free after the cancel");
  await clearSession(next.session.uploadId);
});

// Holds fs.promises.open (or the handle's close) until released, so a test can
// act while an append is mid-write. import-session reads `fs.open` at call time.
function holdFsStep(step: "open" | "close"): { reached: Promise<void>; release: () => void; restore: () => void } {
  const realOpen = fs.open;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let reached!: () => void;
  const reachedP = new Promise<void>((r) => { reached = r; });
  (fs as { open: typeof fs.open }).open = (async (...args: Parameters<typeof fs.open>) => {
    if (step === "open") {
      reached();
      await gate;
      return realOpen(...args);
    }
    const handle = await realOpen(...args);
    const realClose = handle.close.bind(handle);
    handle.close = async () => {
      reached();
      await gate;
      return realClose();
    };
    return handle;
  }) as typeof fs.open;
  return { reached: reachedP, release, restore: () => { (fs as { open: typeof fs.open }).open = realOpen; } };
}

test("a cancel during an in-flight append waits for it: no crash, no half-removed directory", async () => {
  const id = crypto.randomUUID();
  const started = await startSession({ uploadId: id, totalSize: 8, totalChunks: 2 });
  if (!started.ok) assert.fail("start must succeed");
  const hold = holdFsStep("open");
  try {
    const append = appendChunk(id, 0, bytes("aaaa"));
    await hold.reached; // the append passed its checks and is about to write
    const cancel = cancelSession(id);
    hold.release();
    const r = await append; // must resolve, never throw
    await cancel;
    assert.equal(r.ok, true, `the append that was already writing completes: ${JSON.stringify(r)}`);
    assert.equal(await dirGone(started.session.tempDir), true, "the cancel then removed the session");
    const next = await startSession({ uploadId: crypto.randomUUID(), totalSize: 4, totalChunks: 1 });
    if (!next.ok) assert.fail("the slot is free");
    await clearSession(next.session.uploadId);
  } finally {
    hold.restore();
    await clearSession(id);
  }
});

test("an expired session reclaimed while its append is opening the file: the append reports no-session", async () => {
  const idOld = crypto.randomUUID();
  const idNew = crypto.randomUUID();
  const old = await startSession({ uploadId: idOld, totalSize: 8, totalChunks: 2 });
  if (!old.ok) assert.fail("start must succeed");
  const hold = holdFsStep("open");
  try {
    const append = appendChunk(idOld, 0, bytes("aaaa"));
    await hold.reached;
    old.session.expiresAt = Date.now() - 1; // the idle TTL lapses mid-append
    const fresh = await startSession({ uploadId: idNew, totalSize: 4, totalChunks: 1 });
    if (!fresh.ok) assert.fail("the expired slot is reclaimable");
    hold.release();
    const r = await append; // its directory is gone: ENOENT, reported, not thrown
    assert.deepEqual(r, { ok: false, error: { kind: "no-session" } });
    assert.equal(fresh.session.receivedChunks, 0);
    assert.equal(fresh.session.bytesWritten, 0);
  } finally {
    hold.restore();
    await clearSession(idNew);
    await clearSession(idOld);
  }
});

test("an expired session reclaimed after its append wrote: the counters never move on the new session", async () => {
  const idOld = crypto.randomUUID();
  const idNew = crypto.randomUUID();
  const old = await startSession({ uploadId: idOld, totalSize: 8, totalChunks: 2 });
  if (!old.ok) assert.fail("start must succeed");
  const hold = holdFsStep("close");
  try {
    const append = appendChunk(idOld, 0, bytes("aaaa"));
    await hold.reached; // written, closing
    old.session.expiresAt = Date.now() - 1;
    const fresh = await startSession({ uploadId: idNew, totalSize: 4, totalChunks: 1 });
    if (!fresh.ok) assert.fail("the expired slot is reclaimable");
    hold.release();
    const r = await append;
    assert.deepEqual(r, { ok: false, error: { kind: "no-session" } });
    assert.equal(fresh.session.receivedChunks, 0, "the old append must not count on the new session");
    assert.equal(fresh.session.bytesWritten, 0);
    // The new session's own chunk 0 is still the one it expects.
    const own = await appendChunk(idNew, 0, bytes("bbbb"));
    if (!own.ok) assert.fail(`the new session's chunk 0 must append: ${JSON.stringify(own)}`);
    assert.equal(own.complete, true);
  } finally {
    hold.restore();
    await clearSession(idNew);
    await clearSession(idOld);
  }
});
