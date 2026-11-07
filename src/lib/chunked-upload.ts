// Client-side helper for the two chunked-restore endpoints
// (/api/setup/import-chunk and /api/admin/backup/db-import-chunk). Each
// chunk stays under the routes' 20 MiB MAX_CHUNK_BYTES (and next.config.ts
// proxyClientMaxBodySize above it); 16MB is the default and leaves headroom
// while keeping the chunk count bounded for typical 100MB–500MB dumps.

import type { Translator } from "./i18n/translate";

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
    case "cancelled":
      return t("shared.upload.cancelled");
    case "server":
    case "network":
      return t("shared.upload.network");
  }
}

// crypto.randomUUID only exists in secure contexts, so a plain-HTTP LAN or
// local-only deployment has none. getRandomValues is available everywhere;
// build the same v4 shape the import-session UUID_RE accepts.
function newUploadId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Non-final chunks are retried after a transient failure — the network
// dropped, the per-chunk timeout fired, or a proxy answered 502/503/504 with
// no JSON — waiting these delays in turn. The FINAL chunk is never retried or
// timed out: it runs the destructive TRUNCATE+INSERT on the server, which can
// outlast any client timeout and must not run twice.
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000];
// Generous on purpose: a 16 MB chunk over a slow uplink takes minutes, and the
// server's idle window between chunks is 10 minutes.
const CHUNK_TIMEOUT_MS = 5 * 60 * 1000;

const GATEWAY_STATUSES = new Set([502, 503, 504]);

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

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
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
    retryDelaysMs = RETRY_DELAYS_MS,
    chunkTimeoutMs = CHUNK_TIMEOUT_MS,
  } = opts;
  const uploadId = newUploadId();
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
      const chunk = file.slice(start, end);
      const isLast = index === totalChunks - 1;

      if (isLast) {
        onProgress?.({ uploaded: file.size, total: file.size, phase: "import" });
      }

      const send = (sig: AbortSignal | undefined) =>
        fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Upload-Id": uploadId,
            "X-Chunk-Index": String(index),
            "X-Chunk-Total": String(totalChunks),
            "X-File-Size": String(file.size),
          },
          body: chunk,
          signal: sig,
        });

      let res: Response | undefined;
      // The body, when the retry check below already read it.
      let parsed: Record<string, unknown> | undefined;
      let landed = false;
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) return aborted();
        const canRetry = !isLast && attempt < retryDelaysMs.length;
        try {
          if (isLast) {
            res = await send(signal);
          } else {
            const a = attemptSignal(signal, chunkTimeoutMs);
            try {
              res = await send(a.signal);
            } finally {
              a.done();
            }
          }
        } catch (err) {
          if (signal?.aborted) return aborted();
          if (!canRetry) throw err;
          await wait(retryDelaysMs[attempt], signal);
          continue;
        }
        if (canRetry && GATEWAY_STATUSES.has(res.status) && !isJson(res)) {
          await wait(retryDelaysMs[attempt], signal);
          continue;
        }
        // A retried chunk the server already holds: the attempt that "failed"
        // landed before its answer was lost, so the server now expects the next one.
        if (attempt > 0 && res.status === 409 && !res.redirected && isJson(res)) {
          parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          landed = parsed.expected === index + 1;
        }
        break;
      }
      if (landed) {
        onProgress?.({ uploaded: end, total: file.size, phase: "upload" });
        continue;
      }
      if (!res) throw new Error(`Chunk ${index + 1}/${totalChunks} failed`);

      // Still a gateway error after the retries (or on the final chunk, which
      // is never retried): name it, rather than the redirect explanation below.
      if (GATEWAY_STATUSES.has(res.status) && !isJson(res)) {
        cancel();
        return { kind: "error", status: res.status, code: "chunkFailed", chunk: index + 1, total: totalChunks };
      }

      // A redirect (auth gate, etc.) returns 200 + HTML after fetch follows
      // it; res.json() then silently falls back to {} and the loop would run
      // to completion with no `complete` flag. Catch that explicitly.
      if (res.redirected || !isJson(res)) {
        cancel();
        return { kind: "error", status: res.status, code: "nonJson" };
      }

      const data = parsed ?? ((await res.json().catch(() => ({}))) as Record<string, unknown>);

      if (!res.ok) {
        cancel();
        return typeof data.error === "string" && data.error
          ? { kind: "error", status: res.status, code: "server", error: data.error }
          : { kind: "error", status: res.status, code: "chunkFailed", chunk: index + 1, total: totalChunks };
      }

      if (data.complete) {
        return { kind: "complete", ok: data.ok === true, data };
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
