// Single-session chunked upload state shared by both backup-restore flows
// (setup-mode at /api/setup/import-chunk and admin at /api/admin/backup/
// db-import-chunk). Restore is a destructive, single-shot operation — two
// concurrent runs would race the same transaction — so a single global
// slot is enough. A second open while one is active returns 409. The slot is
// process-wide (processSingleton, guardrail 27a): the two routes live in
// different chunks, and a per-chunk slot would give each its own.
//
// Each session gets a mkdtemp-generated directory so the path is unpredictable.
// The directory (and its contents) is removed on success, cancel, or expiry.

import { promises as fs, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { MAX_CIPHERTEXT_BYTES } from "@/lib/backup-import";
import { restoreScratchDir } from "@/lib/restore-scratch";
import { processSingleton } from "@/lib/process-singleton";

// IDLE window: bumped to now+TTL on every chunk (appendChunkUnsafe), so this is the
// allowed gap BETWEEN chunks, not the total upload time. Kept tight so an attacker
// can't pin the single global restore slot by opening a session and walking away
// (the slot frees ~10 min after the last chunk instead of 30); still ample for a slow
// chunk upload. The chunk-0 rate limit bounds how often a new session can be opened.
const SESSION_TTL_MS = 10 * 60 * 1000;
const tempPrefix = async () => path.join(await restoreScratchDir(), "summonarr-upload-");

type Session = {
  uploadId: string;
  tempDir: string;
  filePath: string;
  totalSize: number;
  totalChunks: number;
  receivedChunks: number;
  bytesWritten: number;
  expiresAt: number;
  // Set once the assembled file is handed to the importer (getSessionStream). A
  // slow restore can outlive the idle TTL; without this flag the expiry-cleanup
  // in startSession would rm the tempDir out from under the in-flight read.
  importing?: boolean;
};

const state = processSingleton("import-session:state", () => ({
  active: null as Session | null,
  // Serializes startSession calls so the active-slot check + mkdtemp + assignment
  // run atomically. Without this, two concurrent first-chunk POSTs with different
  // uploadIds can both pass the `active` check (one synchronous, one before the
  // other's mkdtemp resolves), each mkdtemp their own dir, and the loser's tempDir
  // is leaked when `active = session` clobbers the winner.
  startMutex: Promise.resolve() as Promise<unknown>,
  // Per-session chained promise so concurrent appendChunk calls for the same
  // session serialize their reads/writes. Without this, two first-chunk POSTs
  // can both pass the receivedChunks check and both open the file with "w",
  // interleaving writes and corrupting the upload. clearSession and
  // cancelSession wait on it too, so they never remove the file mid-write.
  appendQueue: new Map<string, Promise<unknown>>(),
}));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isExpired(s: Session): boolean {
  return Date.now() > s.expiresAt;
}

async function cleanupSession(s: Session): Promise<void> {
  try {
    await fs.rm(s.tempDir, { recursive: true, force: true });
  } catch {
    // already gone — fine
  }
}

export type SessionStartOpts = {
  uploadId: string;
  totalSize: number;
  totalChunks: number;
};

export type SessionStartError =
  | { kind: "invalid-id" }
  | { kind: "invalid-size" }
  | { kind: "size-too-large"; max: number }
  | { kind: "in-progress" };

export async function startSession(
  opts: SessionStartOpts,
): Promise<{ ok: true; session: Session } | { ok: false; error: SessionStartError }> {
  if (!UUID_RE.test(opts.uploadId)) return { ok: false, error: { kind: "invalid-id" } };
  if (!Number.isFinite(opts.totalSize) || opts.totalSize <= 0) return { ok: false, error: { kind: "invalid-size" } };
  // Every chunk but a (degenerate) empty last one carries at least one byte, so
  // more chunks than bytes is never a real upload.
  if (!Number.isInteger(opts.totalChunks) || opts.totalChunks <= 0 || opts.totalChunks > opts.totalSize) {
    return { ok: false, error: { kind: "invalid-size" } };
  }
  if (opts.totalSize > MAX_CIPHERTEXT_BYTES) {
    return { ok: false, error: { kind: "size-too-large", max: MAX_CIPHERTEXT_BYTES } };
  }

  // Mutex: every concurrent startSession waits for the previous one to finish
  // (whether it claimed the slot or rejected). The earlier check-then-mkdtemp
  // shape let two callers each pass the `active` check before either's mkdtemp
  // resolved, leaving the loser's tempDir orphaned.
  const prev = state.startMutex;
  let resolveMutex!: () => void;
  state.startMutex = new Promise<void>((r) => { resolveMutex = r; });
  await prev;

  try {
    const active = state.active;
    if (active && !isExpired(active) && active.uploadId !== opts.uploadId) {
      return { ok: false, error: { kind: "in-progress" } };
    }

    // A session whose file is being read by an in-flight import must never be
    // reclaimed — even if the idle TTL lapsed (a large restore can take longer
    // than the between-chunks window), and even for a retry carrying the SAME
    // uploadId: reclaiming would rm the tempDir mid-read and corrupt the
    // restore, and resuming would let fresh chunks race the read. Treat it as
    // still in-progress for every caller; the importer's finally always
    // clearSession()s it when done.
    if (active && active.importing) {
      return { ok: false, error: { kind: "in-progress" } };
    }

    if (active && isExpired(active)) {
      // Detach first: an append still writing to it sees the slot change and
      // reports no-session instead of touching whatever comes next.
      if (state.active === active) state.active = null;
      await cleanupSession(active);
    } else if (active && active.uploadId === opts.uploadId) {
      return { ok: true, session: active };
    }

    const tempDir = await fs.mkdtemp(await tempPrefix());
    const filePath = path.join(tempDir, "upload.bin");

    const session: Session = {
      uploadId: opts.uploadId,
      tempDir,
      filePath,
      totalSize: opts.totalSize,
      totalChunks: opts.totalChunks,
      receivedChunks: 0,
      bytesWritten: 0,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    state.active = session;
    return { ok: true, session };
  } finally {
    resolveMutex();
  }
}

export type AppendError =
  | { kind: "no-session" }
  | { kind: "session-mismatch" }
  | { kind: "expired" }
  | { kind: "out-of-order"; expected: number }
  | { kind: "size-overflow"; max: number }
  | { kind: "size-mismatch"; expected: number; received: number };

type AppendResult =
  | { ok: true; received: number; total: number; bytesWritten: number; complete: boolean }
  | { ok: false; error: AppendError };

// Detach the session from the slot (if it still holds it), then remove its files.
async function dropSession(s: Session): Promise<void> {
  if (state.active === s) state.active = null;
  await cleanupSession(s);
}

async function appendChunkUnsafe(
  uploadId: string,
  chunkIndex: number,
  data: Uint8Array,
): Promise<AppendResult> {
  // The session this append works on, captured once: the slot can be cleared
  // or reclaimed (an expired session) while the write below is awaited, and
  // the counters must never move on whatever replaced it.
  const s = state.active;
  if (!s) return { ok: false, error: { kind: "no-session" } };
  if (s.uploadId !== uploadId) return { ok: false, error: { kind: "session-mismatch" } };
  // Same never-reclaim-while-importing rule as startSession: an importing
  // session that outlived the idle TTL must not have its tempDir rm'd out from
  // under the in-flight read by a retried chunk. It falls through to the index
  // check instead (receivedChunks == totalChunks once importing, so any retry
  // reads as out-of-order and touches nothing).
  if (isExpired(s) && !s.importing) {
    await dropSession(s);
    return { ok: false, error: { kind: "expired" } };
  }
  if (chunkIndex !== s.receivedChunks) {
    return { ok: false, error: { kind: "out-of-order", expected: s.receivedChunks } };
  }
  if (s.bytesWritten + data.byteLength > s.totalSize) {
    return { ok: false, error: { kind: "size-overflow", max: s.totalSize } };
  }

  try {
    const handle = await fs.open(s.filePath, s.receivedChunks === 0 ? "w" : "a");
    try {
      await handle.write(data);
    } finally {
      await handle.close();
    }
  } catch (err) {
    // A half-written chunk must never be resumed: drop the session (fail
    // closed). Its directory gone under it (a concurrent reclaim) is just a
    // session that no longer exists.
    if (state.active !== s || (err as NodeJS.ErrnoException).code === "ENOENT") {
      await dropSession(s);
      return { ok: false, error: { kind: "no-session" } };
    }
    await dropSession(s);
    throw err;
  }
  if (state.active !== s) {
    // Reclaimed while writing: the bytes went to a session that is gone.
    await cleanupSession(s);
    return { ok: false, error: { kind: "no-session" } };
  }
  s.receivedChunks += 1;
  s.bytesWritten += data.byteLength;
  s.expiresAt = Date.now() + SESSION_TTL_MS;

  // On the final declared chunk the assembled file must match the declared
  // size exactly. The overflow guard above rejects too-many bytes; this rejects
  // a SHORT upload (client truncated, or sent fewer/smaller chunks than
  // declared), which would otherwise feed an incomplete ciphertext straight
  // into the importer.
  if (s.receivedChunks === s.totalChunks && s.bytesWritten !== s.totalSize) {
    const expected = s.totalSize;
    const received = s.bytesWritten;
    await dropSession(s);
    return { ok: false, error: { kind: "size-mismatch", expected, received } };
  }

  return {
    ok: true,
    received: s.receivedChunks,
    total: s.totalChunks,
    bytesWritten: s.bytesWritten,
    complete: s.receivedChunks === s.totalChunks,
  };
}

export async function appendChunk(
  uploadId: string,
  chunkIndex: number,
  data: Uint8Array,
): Promise<AppendResult> {
  const prev = state.appendQueue.get(uploadId) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => appendChunkUnsafe(uploadId, chunkIndex, data));
  state.appendQueue.set(uploadId, next);
  try {
    return await next;
  } finally {
    if (state.appendQueue.get(uploadId) === next) state.appendQueue.delete(uploadId);
  }
}

// Resolves once every append queued for `uploadId` so far has finished.
function appendsSettled(uploadId: string): Promise<unknown> {
  const pending = state.appendQueue.get(uploadId);
  return pending ? pending.catch(() => undefined) : Promise.resolve();
}

// Cheap, side-effect-free check for whether `uploadId` owns the current active,
// non-expired session. Lets a caller reject a bogus non-zero-index chunk (one with
// no prior chunk-0) BEFORE doing any expensive work (advisory lock, DB reads), so an
// unauthenticated flood of junk chunks can't amplify into lock contention / DB load.
export function hasActiveUploadSession(uploadId: string): boolean {
  const active = state.active;
  return !!active && active.uploadId === uploadId && !isExpired(active);
}

export function getSessionStream(uploadId: string): ReadableStream<Uint8Array> | null {
  const active = state.active;
  if (!active || active.uploadId !== uploadId) return null;
  // Mark the slot as importing so a concurrent startSession can't reclaim + rm
  // its tempDir while this stream is being read. clearSession (always called in
  // the importer's finally) frees the slot afterwards.
  active.importing = true;
  const nodeStream = createReadStream(active.filePath);
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
}

// Unconditional release, for the server's own paths: the importer's finally
// and the routes' refusals. Waits for any in-flight append of this upload.
export async function clearSession(uploadId: string): Promise<void> {
  await appendsSettled(uploadId);
  const s = state.active;
  if (!s || s.uploadId !== uploadId) return;
  await dropSession(s);
}

// A client's cancel (the routes' DELETE). Same as clearSession, except it never
// touches a session whose file is being imported: the client cancels when the
// final chunk's request fails at a proxy (502/504) while the server is still
// restoring, and removing the file mid-read, or freeing the slot for a second
// upload beside the running restore, is exactly what the importing flag forbids.
// The importer's own clearSession frees it when the restore ends.
export async function cancelSession(uploadId: string): Promise<void> {
  await appendsSettled(uploadId);
  const s = state.active;
  if (!s || s.uploadId !== uploadId || s.importing) return;
  await dropSession(s);
}
