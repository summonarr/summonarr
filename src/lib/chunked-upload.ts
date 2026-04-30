// Client-side helper for the two chunked-restore endpoints
// (/api/setup/import-chunk and /api/admin/backup/db-import-chunk). Each
// chunk stays under next.config.ts proxyClientMaxBodySize (currently 50MB);
// 16MB is the default and leaves comfortable headroom for headers and proxy
// framing while keeping the chunk count bounded for typical 100MB–500MB dumps.

export const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;

export type ChunkedUploadProgress = {
  uploaded: number;
  total: number;
  phase: "upload" | "import";
};

export type ChunkedUploadOutcome =
  | { kind: "complete"; ok: boolean; data: Record<string, unknown> }
  | { kind: "error"; status: number | null; error: string };

export async function uploadInChunks(opts: {
  file: File;
  endpoint: string;
  chunkSize?: number;
  onProgress?: (p: ChunkedUploadProgress) => void;
}): Promise<ChunkedUploadOutcome> {
  const { file, endpoint, chunkSize = DEFAULT_CHUNK_SIZE, onProgress } = opts;
  const uploadId = crypto.randomUUID();
  const totalChunks = Math.ceil(file.size / chunkSize);
  onProgress?.({ uploaded: 0, total: file.size, phase: "upload" });

  const cancel = () => {
    fetch(endpoint, { method: "DELETE", headers: { "X-Upload-Id": uploadId } }).catch(() => {});
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

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Upload-Id": uploadId,
          "X-Chunk-Index": String(index),
          "X-Chunk-Total": String(totalChunks),
          "X-File-Size": String(file.size),
        },
        body: chunk,
      });

      // A redirect (auth gate, etc.) returns 200 + HTML after fetch follows
      // it; res.json() then silently falls back to {} and the loop would run
      // to completion with no `complete` flag. Catch that explicitly.
      if (res.redirected || !res.headers.get("content-type")?.includes("application/json")) {
        cancel();
        return {
          kind: "error",
          status: res.status,
          error:
            "Server returned a non-JSON response — the request was likely redirected (e.g. to a login page). " +
            `Endpoint: ${endpoint}`,
        };
      }

      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      if (!res.ok) {
        cancel();
        return {
          kind: "error",
          status: res.status,
          error: typeof data.error === "string" ? data.error : `Chunk ${index + 1}/${totalChunks} failed`,
        };
      }

      if (data.complete) {
        return { kind: "complete", ok: data.ok === true, data };
      }

      onProgress?.({ uploaded: end, total: file.size, phase: "upload" });
    }
    cancel();
    return { kind: "error", status: null, error: "Upload finished without a server-side completion." };
  } catch (err) {
    cancel();
    return { kind: "error", status: null, error: (err as Error).message };
  }
}
