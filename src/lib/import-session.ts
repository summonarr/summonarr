// Single-session chunked upload state shared by both backup-restore flows
// (setup-mode at /api/setup/import-chunk and admin at /api/admin/backup/
// db-import-chunk). Restore is a destructive, single-shot operation — two
// concurrent runs would race the same transaction — so a single global
// slot is enough. A second open while one is active returns 409.
//
// Temp file lives under os.tmpdir() and is deleted on success, cancel, or
// session expiry. The route handler holds the only references to the path.

import { promises as fs, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import os from "node:os";
import { MAX_CIPHERTEXT_BYTES } from "@/lib/backup-import";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min — long enough for a slow upload, short enough that a stale temp file can't linger forever
const UPLOAD_DIR = path.join(os.tmpdir(), "summonarr-imports");

type Session = {
  uploadId: string;
  filePath: string;
  totalSize: number;
  totalChunks: number;
  receivedChunks: number;
  bytesWritten: number;
  expiresAt: number;
};

let active: Session | null = null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isExpired(s: Session): boolean {
  return Date.now() > s.expiresAt;
}

async function deleteTempFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
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

  if (active && !isExpired(active) && active.uploadId !== opts.uploadId) {
    return { ok: false, error: { kind: "in-progress" } };
  }

  if (active && isExpired(active)) {
    await deleteTempFile(active.filePath);
    active = null;
  }

  if (active && active.uploadId === opts.uploadId) {
    return { ok: true, session: active };
  }

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const filePath = path.join(UPLOAD_DIR, `${opts.uploadId}.bin`);
  await deleteTempFile(filePath); // wipe any stragglers before starting

  const session: Session = {
    uploadId: opts.uploadId,
    filePath,
    totalSize: opts.totalSize,
    totalChunks: opts.totalChunks,
    receivedChunks: 0,
    bytesWritten: 0,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  active = session;
  return { ok: true, session };
}

export type AppendError =
  | { kind: "no-session" }
  | { kind: "session-mismatch" }
  | { kind: "expired" }
  | { kind: "out-of-order"; expected: number }
  | { kind: "size-overflow"; max: number };

export async function appendChunk(
  uploadId: string,
  chunkIndex: number,
  data: Uint8Array,
): Promise<{ ok: true; received: number; total: number; bytesWritten: number; complete: boolean } | { ok: false; error: AppendError }> {
  if (!active) return { ok: false, error: { kind: "no-session" } };
  if (active.uploadId !== uploadId) return { ok: false, error: { kind: "session-mismatch" } };
  if (isExpired(active)) {
    await deleteTempFile(active.filePath);
    active = null;
    return { ok: false, error: { kind: "expired" } };
  }
  if (chunkIndex !== active.receivedChunks) {
    return { ok: false, error: { kind: "out-of-order", expected: active.receivedChunks } };
  }
  if (active.bytesWritten + data.byteLength > active.totalSize) {
    return { ok: false, error: { kind: "size-overflow", max: active.totalSize } };
  }

  const handle = await fs.open(active.filePath, active.receivedChunks === 0 ? "ax" : "a");
  try {
    await handle.write(data);
  } finally {
    await handle.close();
  }
  active.receivedChunks += 1;
  active.bytesWritten += data.byteLength;
  active.expiresAt = Date.now() + SESSION_TTL_MS;

  return {
    ok: true,
    received: active.receivedChunks,
    total: active.totalChunks,
    bytesWritten: active.bytesWritten,
    complete: active.receivedChunks === active.totalChunks,
  };
}

export function getSessionStream(uploadId: string): ReadableStream<Uint8Array> | null {
  if (!active || active.uploadId !== uploadId) return null;
  const nodeStream = createReadStream(active.filePath);
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
}

export async function clearSession(uploadId: string): Promise<void> {
  if (!active || active.uploadId !== uploadId) return;
  await deleteTempFile(active.filePath);
  active = null;
}
