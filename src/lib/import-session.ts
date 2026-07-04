// Single-session chunked upload state shared by both backup-restore flows
// (setup-mode at /api/setup/import-chunk and admin at /api/admin/backup/
// db-import-chunk). Restore is a destructive, single-shot operation — two
// concurrent runs would race the same transaction — so a single global
// slot is enough. A second open while one is active returns 409.
//
// Each session gets a mkdtemp-generated directory so the path is unpredictable.
// The directory (and its contents) is removed on success, cancel, or expiry.

import { promises as fs, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import os from "node:os";
import { MAX_CIPHERTEXT_BYTES } from "@/lib/backup-import";

// IDLE window: bumped to now+TTL on every chunk (appendChunkUnsafe), so this is the
// allowed gap BETWEEN chunks, not the total upload time. Kept tight so an attacker
// can't pin the single global restore slot by opening a session and walking away
// (the slot frees ~10 min after the last chunk instead of 30); still ample for a slow
// chunk upload. The chunk-0 rate limit bounds how often a new session can be opened.
const SESSION_TTL_MS = 10 * 60 * 1000;
const TEMP_PREFIX = path.join(os.tmpdir(), "summonarr-upload-");

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

let active: Session | null = null;
// Serializes startSession calls so the active-slot check + mkdtemp + assignment
// run atomically. Without this, two concurrent first-chunk POSTs with different
// uploadIds can both pass the `active` check (one synchronous, one before the
// other's mkdtemp resolves), each mkdtemp their own dir, and the loser's tempDir
// is leaked when `active = session` clobbers the winner.
let startMutex: Promise<unknown> = Promise.resolve();

// Per-session chained promise so concurrent appendChunk calls for the same
// session serialize their reads/writes. Without this, two first-chunk POSTs
// can both pass the receivedChunks check and both open the file with "w",
// interleaving writes and corrupting the upload.
const appendQueue = new Map<string, Promise<unknown>>();

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
  if (!Number.isFinite(opts.totalChunks) || opts.totalChunks <= 0) return { ok: false, error: { kind: "invalid-size" } };
  if (opts.totalSize > MAX_CIPHERTEXT_BYTES) {
    return { ok: false, error: { kind: "size-too-large", max: MAX_CIPHERTEXT_BYTES } };
  }

  // Mutex: every concurrent startSession waits for the previous one to finish
  // (whether it claimed the slot or rejected). The earlier check-then-mkdtemp
  // shape let two callers each pass the `active` check before either's mkdtemp
  // resolved, leaving the loser's tempDir orphaned.
  const prev = startMutex;
  let resolveMutex!: () => void;
  startMutex = new Promise<void>((r) => { resolveMutex = r; });
  await prev;

  try {
    if (active && !isExpired(active) && active.uploadId !== opts.uploadId) {
      return { ok: false, error: { kind: "in-progress" } };
    }

    // A session whose file is being read by an in-flight import must never be
    // reclaimed — even if the idle TTL lapsed (a large restore can take longer
    // than the between-chunks window). Reclaiming it here would rm the tempDir
    // mid-read and corrupt the restore. Treat it as still in-progress; the
    // importer's finally always clearSession()s it when done.
    if (active && active.importing && active.uploadId !== opts.uploadId) {
      return { ok: false, error: { kind: "in-progress" } };
    }

    if (active && isExpired(active)) {
      await cleanupSession(active);
      active = null;
    }

    if (active && active.uploadId === opts.uploadId) {
      return { ok: true, session: active };
    }

    const tempDir = await fs.mkdtemp(TEMP_PREFIX);
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
    active = session;
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

async function appendChunkUnsafe(
  uploadId: string,
  chunkIndex: number,
  data: Uint8Array,
): Promise<AppendResult> {
  if (!active) return { ok: false, error: { kind: "no-session" } };
  if (active.uploadId !== uploadId) return { ok: false, error: { kind: "session-mismatch" } };
  if (isExpired(active)) {
    await cleanupSession(active);
    active = null;
    return { ok: false, error: { kind: "expired" } };
  }
  if (chunkIndex !== active.receivedChunks) {
    return { ok: false, error: { kind: "out-of-order", expected: active.receivedChunks } };
  }
  if (active.bytesWritten + data.byteLength > active.totalSize) {
    return { ok: false, error: { kind: "size-overflow", max: active.totalSize } };
  }

  const handle = await fs.open(active.filePath, active.receivedChunks === 0 ? "w" : "a");
  try {
    await handle.write(data);
  } finally {
    await handle.close();
  }
  active.receivedChunks += 1;
  active.bytesWritten += data.byteLength;
  active.expiresAt = Date.now() + SESSION_TTL_MS;

  // On the final declared chunk the assembled file must match the declared
  // size exactly. The overflow guard above rejects too-many bytes; this rejects
  // a SHORT upload (client truncated, or sent fewer/smaller chunks than
  // declared), which would otherwise feed an incomplete ciphertext straight
  // into the importer.
  if (active.receivedChunks === active.totalChunks && active.bytesWritten !== active.totalSize) {
    const expected = active.totalSize;
    const received = active.bytesWritten;
    await cleanupSession(active);
    active = null;
    return { ok: false, error: { kind: "size-mismatch", expected, received } };
  }

  return {
    ok: true,
    received: active.receivedChunks,
    total: active.totalChunks,
    bytesWritten: active.bytesWritten,
    complete: active.receivedChunks === active.totalChunks,
  };
}

export async function appendChunk(
  uploadId: string,
  chunkIndex: number,
  data: Uint8Array,
): Promise<AppendResult> {
  const prev = appendQueue.get(uploadId) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => appendChunkUnsafe(uploadId, chunkIndex, data));
  appendQueue.set(uploadId, next);
  try {
    return await next;
  } finally {
    if (appendQueue.get(uploadId) === next) appendQueue.delete(uploadId);
  }
}

export function getSessionStream(uploadId: string): ReadableStream<Uint8Array> | null {
  if (!active || active.uploadId !== uploadId) return null;
  // Mark the slot as importing so a concurrent startSession can't reclaim + rm
  // its tempDir while this stream is being read. clearSession (always called in
  // the importer's finally) frees the slot afterwards.
  active.importing = true;
  const nodeStream = createReadStream(active.filePath);
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
}

export async function clearSession(uploadId: string): Promise<void> {
  if (!active || active.uploadId !== uploadId) return;
  await cleanupSession(active);
  active = null;
}
