"use client";

// The History tab's JSON export. The CSV export is a plain download link, but
// the JSON answer says whether it was cut at the row cap in a response header
// (X-Export-Truncated), which a browser download never shows — so the JSON is
// fetched here, saved as a file, and the header read.

import { useCallback, useEffect, useRef, useState } from "react";
import { LONG_RUN_TIMEOUT_MS, timedFetch } from "@/lib/client/fetch-json";
import { readApiError } from "@/lib/client/api-error";
import { filenameFromDisposition, saveBlob } from "@/lib/client/blob-download";
import { useT } from "@/components/i18n/i18n-provider";

export const EXPORT_TRUNCATED_HEADER = "X-Export-Truncated";
export const EXPORT_MAX_ROWS_HEADER = "X-Export-Max-Rows";

export type ExportNotice = { kind: "truncated"; max: number } | { kind: "failed"; message: string } | null;

/** `url` is the full export URL (base path included). */
export function useHistoryJsonExport() {
  const t = useT();
  const [notice, setNotice] = useState<ExportNotice>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => () => ctrlRef.current?.abort(), []);

  const exportJson = useCallback(
    async (url: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setNotice(null);
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      try {
        const res = await timedFetch(url, { signal: ctrl.signal }, LONG_RUN_TIMEOUT_MS);
        if (!res.ok) {
          setNotice({ kind: "failed", message: await readApiError(res, t("adminActivity.history.exportFailed")) });
          return;
        }
        const blob = await res.blob();
        saveBlob(blob, filenameFromDisposition(res.headers.get("Content-Disposition"), "play-history.json"));
        if (res.headers.get(EXPORT_TRUNCATED_HEADER) === "true") {
          const max = Number(res.headers.get(EXPORT_MAX_ROWS_HEADER));
          setNotice({ kind: "truncated", max: Number.isFinite(max) && max > 0 ? max : 0 });
        }
      } catch {
        if (!ctrl.signal.aborted) setNotice({ kind: "failed", message: t("adminActivity.history.exportFailed") });
      } finally {
        busyRef.current = false;
        if (!ctrl.signal.aborted) setBusy(false);
      }
    },
    [t],
  );

  return { notice, busy, exportJson };
}
