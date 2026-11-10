// Client-side helper for the two chunked-restore endpoints
// (/api/setup/import-chunk and /api/admin/backup/db-import-chunk). Each
// chunk stays under the routes' 20 MiB MAX_CHUNK_BYTES (and next.config.ts
// proxyClientMaxBodySize above it); 16MB is the default and leaves headroom
// while keeping the chunk count bounded for typical 100MB–500MB dumps.

import type { Translator } from "./i18n/translate";
import { randomUuid } from "./random-id";
import { isGatewayStatus } from "./gateway-status";
import { abortableSleep } from "./abortable-sleep";

export const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;

export type ChunkedUploadProgress = {
  uploaded: number;
  total: number;
  phase: "upload" | "import";
};

// An error outcome carries a CODE, never English prose: the caller translates
// it (chunkedUploadErrorMessage). `error` is set only for text that is already
// fit to show, the server's own (translated) refusal.
export type ChunkedUploadErrorCode =
  | "server"
  | "chunkFailed"
  | "nonJson"
  | "noCompletion"
  | "empty"
  | "network"
  | "cancelled";

export type ChunkedUploadError = {
  kind: "error";
  status: number | null;
  code: ChunkedUploadErrorCode;
  error?: string;
  chunk?: number;
  total?: number;
};

export type ChunkedUploadOutcome =
  | { kind: "complete"; ok: boolean; data: Record<string, unknown> }
  | ChunkedUploadError;

// The text to show for an error outcome. The keys live in the `shared` area,
// which every client is sent (guardrail 40b): the setup page and the admin
// backup page both show these.
export function chunkedUploadErrorMessage(outcome: ChunkedUploadError, t: Translator): string {
  if (outcome.error) return outcome.error;
  switch (outcome.code) {
    case "chunkFailed":
      return t("shared.upload.chunkFailed", {
        chunk: outcome.chunk ?? 0,
        total: outcome.total ?? 0,
        status: outcome.status ?? 0,
      });
    case "nonJson":
      return t("shared.upload.nonJson");
    case "noCompletion":
      return t("shared.upload.noCompletion");
    case "empty":
      return t("shared.upload.empty");
    case "cancelled":
      return t("shared.upload.cancelled");
    case "server":
    case "network":
      return t("shared.upload.network");
  }
}


// Non-final chunks are retried after a transient failure — the network
// dropped, the per-chunk timeout fired, or a proxy answered 502/503/504 with
// no JSON — waiting these delays in turn. The FINAL chunk is never retried or
// timed out: it runs the destructive TRUNCATE+INSERT on the server, which can
// outlast any client timeout (a multi-GB restore takes over an hour) and must
// not run twice. A client deadline there would report a failure for a restore
// that then commits; Cancel is the way out.
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000];
// Generous on purpose: a 16 MB chunk over a slow uplink takes minutes, and the
// server's idle window between chunks is 10 minutes.
const CHUNK_TIMEOUT_MS = 5 * 60 * 1000;

function isJson(res: Response): boolean {
  return !!res.headers.get("content-type")?.includes("application/json");
}

// The caller's signal plus a per-attempt timeout. AbortSignal.any/timeout are
// avoided for older browsers.
function attemptSignal(outer: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(outer?.reason);
  if (outer?.aborted) ctrl.abort(outer.reason);
  else outer?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new Error("Chunk upload timed out")), timeoutMs);
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
  };
}

type ChunkRequest = {
  endpoint: string;
  uploadId: string;
  index: number;
  totalChunks: number;
  fileSize: number;
  body: Blob;
  // Extra request headers sent with every chunk (the setup restore's
  // X-Restore-Keep-Sessions).
  extraHeaders?: Record<string, string>;
};

function sendChunk(req: ChunkRequest, signal: AbortSignal | undefined): Promise<Response> {
  return fetch(req.endpoint, {
    method: "POST",
    headers: {
      ...req.extraHeaders,
      "Content-Type": "application/octet-stream",
      "X-Upload-Id": req.uploadId,
      "X-Chunk-Index": String(req.index),
      "X-Chunk-Total": String(req.totalChunks),
      "X-File-Size": String(req.fileSize),
    },
    body: req.body,
    signal,
  });
}

// How one chunk's sending ended: the server's answer (with its body, when the
// landed check already read it), "landed" when a retried chunk turns out to
// have arrived already, or "aborted" by the caller. Throws when the network
// failed past the retries.
type ChunkSendResult =
  | { kind: "answer"; res: Response; parsed?: Record<string, unknown> }
  | { kind: "landed" }
  | { kind: "aborted" };

async function sendChunkWithRetry(
  req: ChunkRequest,
  opts: { isLast: boolean; signal?: AbortSignal; retryDelaysMs: readonly number[]; chunkTimeoutMs: number },
): Promise<ChunkSendResult> {
  const { isLast, signal, retryDelaysMs, chunkTimeoutMs } = opts;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) return { kind: "aborted" };
    const canRetry = !isLast && attempt < retryDelaysMs.length;
    let res: Response;
    try {
      if (isLast) {
        res = await sendChunk(req, signal);
      } else {
        const a = attemptSignal(signal, chunkTimeoutMs);
        try {
          res = await sendChunk(req, a.signal);
        } finally {
          a.done();
        }
      }
    } catch (err) {
      if (signal?.aborted) return { kind: "aborted" };
      if (!canRetry) throw err;
      await abortableSleep(retryDelaysMs[attempt], signal);
      continue;
    }
    if (canRetry && isGatewayStatus(res.status) && !isJson(res)) {
      await abortableSleep(retryDelaysMs[attempt], signal);
      continue;
    }
    // A retried chunk the server already holds: the attempt that "failed"
    // landed before its answer was lost, so the server now expects the next one.
    if (attempt > 0 && res.status === 409 && !res.redirected && isJson(res)) {
      const parsed = await jsonObject(res);
      if (parsed.expected === req.index + 1) return { kind: "landed" };
      return { kind: "answer", res, parsed };
    }
    return { kind: "answer", res };
  }
}

// A JSON object answer, or {} for anything else (null, an array, a scalar, bad JSON).
async function jsonObject(res: Response): Promise<Record<string, unknown>> {
  const value: unknown = await res.json().catch(() => null);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// One chunk's answer: the upload's outcome when it ends here, null to go on.
async function chunkAnswerOutcome(
  res: Response,
  parsed: Record<string, unknown> | undefined,
  index: number,
  totalChunks: number,
): Promise<ChunkedUploadOutcome | null> {
  // Still a gateway error after the retries (or on the final chunk, which
  // is never retried): name it, rather than the redirect explanation below.
  if (isGatewayStatus(res.status) && !isJson(res)) {
    return { kind: "error", status: res.status, code: "chunkFailed", chunk: index + 1, total: totalChunks };
  }
  // A redirect (auth gate, etc.) returns 200 + HTML after fetch follows
  // it; res.json() then silently falls back to {} and the loop would run
  // to completion with no `complete` flag. Catch that explicitly.
  if (res.redirected || !isJson(res)) {
    return { kind: "error", status: res.status, code: "nonJson" };
  }
  const data = parsed ?? (await jsonObject(res));
  if (!res.ok) {
    return typeof data.error === "string" && data.error
      ? { kind: "error", status: res.status, code: "server", error: data.error }
      : { kind: "error", status: res.status, code: "chunkFailed", chunk: index + 1, total: totalChunks };
  }
  if (data.complete) return { kind: "complete", ok: data.ok === true, data };
  return null;
}

export async function uploadInChunks(opts: {
  file: File;
  endpoint: string;
  chunkSize?: number;
  onProgress?: (p: ChunkedUploadProgress) => void;
  // Aborting stops the upload and cancels the server session. Once the final
  // chunk is in flight the server is already restoring; aborting then only
  // stops waiting for the answer.
  signal?: AbortSignal;
  // Headers added to every chunk's request.
  extraHeaders?: Record<string, string>;
  // Tuning seams (tests): the waits before each retry, and the per-chunk timeout.
  retryDelaysMs?: readonly number[];
  chunkTimeoutMs?: number;
}): Promise<ChunkedUploadOutcome> {
  const {
    file,
    endpoint,
    chunkSize = DEFAULT_CHUNK_SIZE,
    onProgress,
    signal,
    extraHeaders,
    retryDelaysMs = RETRY_DELAYS_MS,
    chunkTimeoutMs = CHUNK_TIMEOUT_MS,
  } = opts;
  // Nothing to send: no session is opened, so there is nothing to cancel.
  if (file.size === 0) return { kind: "error", status: null, code: "empty" };

  const uploadId = randomUuid();
  const totalChunks = Math.ceil(file.size / chunkSize);
  onProgress?.({ uploaded: 0, total: file.size, phase: "upload" });

  const cancel = () => {
    fetch(endpoint, { method: "DELETE", headers: { "X-Upload-Id": uploadId } }).catch(() => {});
  };
  const aborted = (): ChunkedUploadOutcome => {
    cancel();
    return { kind: "error", status: null, code: "cancelled" };
  };

  try {
    for (let index = 0; index < totalChunks; index++) {
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const isLast = index === totalChunks - 1;
      // fetch reports no upload progress, and the final request is both the
      // last bytes and the whole restore, so it reads as "restoring" from the
      // moment it is sent.
      if (isLast) onProgress?.({ uploaded: file.size, total: file.size, phase: "import" });

      const req: ChunkRequest = { endpoint, uploadId, index, totalChunks, fileSize: file.size, body: file.slice(start, end), extraHeaders };
      const sent = await sendChunkWithRetry(req, { isLast, signal, retryDelaysMs, chunkTimeoutMs });
      if (sent.kind === "aborted") return aborted();
      if (sent.kind === "answer") {
        const outcome = await chunkAnswerOutcome(sent.res, sent.parsed, index, totalChunks);
        if (outcome) {
          if (outcome.kind === "error") cancel();
          return outcome;
        }
      }
      onProgress?.({ uploaded: end, total: file.size, phase: "upload" });
    }
    cancel();
    return { kind: "error", status: null, code: "noCompletion" };
  } catch {
    if (signal?.aborted) return aborted();
    cancel();
    return { kind: "error", status: null, code: "network" };
  }
}
