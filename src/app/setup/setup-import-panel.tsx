"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, Loader2, CheckCircle, XCircle, FileCheck, FileX, FileText } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { importResultFrom, type ImportResult, type ImportSummary } from "@/components/admin/backup-import-result";
import { ENCRYPTED_BACKUP_MAGIC, isEncryptedBackupFile } from "@/lib/client/backup-file";
import { chunkedUploadErrorMessage, uploadInChunks, type ChunkedUploadOutcome, type ChunkedUploadProgress } from "@/lib/chunked-upload";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { rich } from "@/components/settings/forms/rich";

const MB = 1024 * 1024;

function formatFileSize(bytes: number): string {
  return bytes > MB ? `${(bytes / MB).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

function percentOf(progress: ChunkedUploadProgress): number {
  if (progress.total <= 0) return 0;
  return Math.round((progress.uploaded / progress.total) * 100);
}

// The panel's state and actions: the picked file and its header check, the
// chunked upload, and its outcome. `onBusyChange` tells the shell an upload is
// running (through the redirect after a successful restore), so it can lock the
// create/restore switch meanwhile.
function useSetupImport(onBusyChange?: (busy: boolean) => void) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [encrypted, setEncrypted] = useState<boolean | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ChunkedUploadProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  // The transfer opt-in (guardrail 6g): off by default, per restore, never stored.
  // It counts only with its acknowledgement, and both reset with the file.
  const [keepSessions, setKeepSessionsState] = useState(false);
  const [keepAck, setKeepAck] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The header check below is async. If the user picks a second file before the
  // first check finishes, this ref lets the stale check see it is out of date
  // and drop its answer instead of overwriting the newer file's state.
  const pickedFileRef = useRef<File | null>(null);
  // Cancel, or an unmount mid-upload, stops it (before the final chunk; once
  // that is sent the server is already restoring and finishes on its own).
  const uploadAbortRef = useRef<AbortController | null>(null);
  // The redirect to /login after a successful restore; an unmount cancels it.
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    uploadAbortRef.current?.abort();
    if (redirectTimerRef.current !== null) clearTimeout(redirectTimerRef.current);
  }, []);

  function setKeepSessions(on: boolean) {
    setKeepSessionsState(on);
    setKeepAck(false);
  }

  async function handleFileChange(f: File | null) {
    pickedFileRef.current = f;
    setFile(f);
    setKeepSessions(false);
    setResult(null);
    setProgress(null);
    setSize(null);
    setEncrypted(null);
    if (!f) return;
    try {
      const isEnc = await isEncryptedBackupFile(f);
      if (pickedFileRef.current !== f) return;
      setEncrypted(isEnc);
      setSize(formatFileSize(f.size));
    } catch {
      if (pickedFileRef.current !== f) return;
      setResult({ ok: false, error: t("auth.restore.error.readFile") });
    }
  }

  async function handleImport() {
    if (!file) return;
    if (!encrypted) {
      setResult({ ok: false, error: t("auth.restore.error.notEncrypted") });
      return;
    }
    // Sent only when ticked AND acknowledged.
    const keep = keepSessions && keepAck;
    setImporting(true);
    onBusyChange?.(true);
    setResult(null);
    setProgress({ uploaded: 0, total: file.size, phase: "upload" });

    const abort = new AbortController();
    uploadAbortRef.current = abort;
    let outcome: ChunkedUploadOutcome;
    try {
      outcome = await uploadInChunks({
        file,
        endpoint: withBasePath("/api/setup/import-chunk"),
        onProgress: setProgress,
        signal: abort.signal,
        extraHeaders: keep ? { "X-Restore-Keep-Sessions": "true" } : undefined,
      });
    } catch {
      // Thrown before the uploader's own try. The exception's own text (a
      // TypeError's) is no message for the person restoring.
      outcome = { kind: "error", status: null, code: "network", error: t("auth.setup.error.generic") };
    } finally {
      if (uploadAbortRef.current === abort) uploadAbortRef.current = null;
    }

    setImporting(false);

    if (outcome.kind === "error") {
      onBusyChange?.(false);
      // The route's own refusal when it gave one (a malformed chunk header, a
      // session that expired), else the uploader's translated reason.
      setResult({ ok: false, error: chunkedUploadErrorMessage(outcome, t) });
      return;
    }

    // Checked field by field: a malformed summary would otherwise crash the KPI grid.
    const restored = importResultFrom(outcome.data);
    setResult(restored);
    if (restored.ok) {
      // Stays busy: the restore replaced the database, and the redirect follows.
      redirectTimerRef.current = setTimeout(() => {
        window.location.href = withBasePath("/login");
      }, 1500);
    } else {
      onBusyChange?.(false);
    }
  }

  // Stops an upload still sending chunks; uploadInChunks drops the server's
  // session and answers "cancelled", which handleImport shows.
  function cancelUpload() {
    uploadAbortRef.current?.abort();
  }

  function clearFile() {
    pickedFileRef.current = null;
    setFile(null);
    setEncrypted(null);
    setSize(null);
    setResult(null);
    setProgress(null);
    setKeepSessions(false);
    // Reset the native input too, or re-choosing the same file fires no change event.
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return {
    file, encrypted, size, importing, progress, result, fileInputRef,
    keepSessions, setKeepSessions, keepAck, setKeepAck,
    handleFileChange, handleImport, cancelUpload, clearFile,
  };
}

type SetupImport = ReturnType<typeof useSetupImport>;

// First-run restore panel: validates + chunk-uploads an encrypted backup, then redirects to /login.
export function SetupImportPanel({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const t = useT();
  const imp = useSetupImport(onBusyChange);
  const { file, importing, result, fileInputRef, handleFileChange, clearFile } = imp;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm text-zinc-300">{t("auth.restore.title")}</p>
        <p className="text-xs text-zinc-500 leading-relaxed">
          {rich(t("auth.restore.description"), {
            ext: <code className="text-zinc-300">.sql.enc</code>,
            envVar: <code className="text-zinc-300">BACKUP_DB_PASSWORD</code>,
          })}
        </p>
      </div>

      <RestoreDropZone imp={imp} />

      <div className="flex items-center gap-2 flex-wrap">
        {/* The native file input stays in the DOM (visually hidden) and is
            opened programmatically so the visible control is a real <Button>. */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".enc"
          aria-label={t("auth.restore.fileLabel")}
          onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
          className="sr-only"
          tabIndex={-1}
        />
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={importing}
          onClick={() => fileInputRef.current?.click()}
        >
          {t("auth.restore.choose")}
        </Button>
        {file && (
          <Button type="button" variant="outline" className="min-h-11" disabled={importing} onClick={clearFile}>
            {t("auth.restore.clear")}
          </Button>
        )}
      </div>

      {!result?.summary && file && <KeepSessionsOption imp={imp} />}

      {!result?.summary && <RestoreButton imp={imp} />}

      {importing && imp.progress && <SetupUploadProgress progress={imp.progress} onCancel={imp.cancelUpload} />}

      {result?.summary && <RestoreSummary result={result} summary={result.summary} />}

      {result?.error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{result.error}</span>
        </div>
      )}
    </div>
  );
}

// The drop target, showing the picked file and whether its header passed.
function RestoreDropZone({ imp }: { imp: SetupImport }) {
  const t = useT();
  const { file, encrypted, size, importing, handleFileChange } = imp;
  const dropBorder =
    encrypted === false
      ? "border-red-500"
      : encrypted === true
        ? "border-green-500/40"
        : "border-zinc-700";

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        // Without preventDefault the browser would open the dropped file itself.
        e.preventDefault();
        if (importing) return;
        const dropped = e.dataTransfer.files?.[0];
        if (dropped) void handleFileChange(dropped);
      }}
      className={`flex flex-col items-center justify-center gap-2 px-4 py-6 rounded-lg border border-dashed text-center transition-colors ${dropBorder} ${
        file ? "bg-zinc-950" : "bg-transparent"
      }`}
    >
      {file ? (
        <>
          <div className="flex items-center gap-2">
            {encrypted === true ? (
              <FileCheck className="w-4 h-4 text-green-500" />
            ) : encrypted === false ? (
              <FileX className="w-4 h-4 text-red-500" />
            ) : (
              <FileText className="w-4 h-4 text-zinc-500" />
            )}
            <span className="text-xs font-mono break-all text-zinc-200">{file.name}</span>
            {size && <span className="text-[10px] text-zinc-500 font-mono">· {size}</span>}
          </div>
          {encrypted === true && (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-green-400">
              <CheckCircle className="w-3 h-3" /> {t("auth.restore.validHeader", { magic: ENCRYPTED_BACKUP_MAGIC })}
            </span>
          )}
          {encrypted === false && (
            <span className="text-[10px] uppercase tracking-wider text-red-400">
              {t("auth.restore.notEncrypted")}
            </span>
          )}
        </>
      ) : (
        <>
          <Upload className="w-5 h-5 text-zinc-500" />
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">
            {t("auth.restore.drop")}
          </span>
        </>
      )}
    </div>
  );
}

// The server-transfer opt-in: off by default, and when ticked it shows what it
// costs and needs a second, explicit acknowledgement before the restore button
// enables. Nothing is stored; it resets with the file.
function KeepSessionsOption({ imp }: { imp: SetupImport }) {
  const t = useT();
  const { importing, keepSessions, setKeepSessions, keepAck, setKeepAck } = imp;
  return (
    <div className="space-y-2">
      <label className="flex items-start gap-2 text-xs text-zinc-300 cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={keepSessions}
          disabled={importing}
          onChange={(e) => setKeepSessions(e.target.checked)}
        />
        <span>
          {t("auth.restore.keep.label")}
          <span className="block text-[11px] text-zinc-500">{t("auth.restore.keep.hint")}</span>
        </span>
      </label>
      {keepSessions && (
        <div role="alert" className="space-y-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-[11px] leading-relaxed text-red-300">
          <p className="font-semibold uppercase tracking-wider">{t("auth.restore.keep.warnTitle")}</p>
          <ul className="list-disc space-y-1 pl-4">
            <li>{t("auth.restore.keep.warnRevoked")}</li>
            <li>{t("auth.restore.keep.warnSecret")}</li>
            <li>{t("auth.restore.keep.warnUrl")}</li>
            <li>{t("auth.restore.keep.warnCompromised")}</li>
          </ul>
          <label className="flex items-start gap-2 font-medium text-red-200 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={keepAck}
              disabled={importing}
              onChange={(e) => setKeepAck(e.target.checked)}
            />
            <span>{t("auth.restore.keep.ack")}</span>
          </label>
        </div>
      )}
    </div>
  );
}

function RestoreButton({ imp }: { imp: SetupImport }) {
  const t = useT();
  const { file, encrypted, importing, progress, handleImport, keepSessions, keepAck } = imp;
  return (
    <Button
      type="button"
      onClick={handleImport}
      disabled={!file || !encrypted || importing || (keepSessions && !keepAck)}
      className="w-full min-h-11"
    >
      {importing ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
          {progress?.phase === "import"
            ? t("auth.restore.importing")
            : progress
              ? t("auth.restore.uploadingPercent", { percent: percentOf(progress) })
              : t("auth.restore.starting")}
        </>
      ) : (
        <>
          <Upload className="w-4 h-4 mr-2" /> {t("auth.restore.submit")}
        </>
      )}
    </Button>
  );
}

// The upload's progress bar. Cancel is offered only while chunks are still
// being sent: once the final chunk is out the server is restoring, and
// aborting would only stop waiting for its answer.
function SetupUploadProgress({ progress, onCancel }: { progress: ChunkedUploadProgress; onCancel: () => void }) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className="h-full bg-indigo-500 transition-all"
          style={{ width: `${percentOf(progress)}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] font-mono text-zinc-500">
        <span>
          {(progress.uploaded / MB).toFixed(1)} MB /{" "}
          {(progress.total / MB).toFixed(1)} MB
        </span>
        <span>
          {progress.phase === "import" ? t("auth.restore.restoringOnServer") : t("auth.restore.uploading")}
        </span>
      </div>
      {progress.phase === "upload" && (
        <Button type="button" variant="outline" className="min-h-11" onClick={onCancel}>
          {t("shared.common.cancel")}
        </Button>
      )}
    </div>
  );
}

const SHOWN_ERRORS = 10;

function RestoreSummary({ result, summary }: { result: ImportResult; summary: ImportSummary }) {
  const t = useT();
  const locale = useLocale();
  const kpis = [
    { label: t("auth.restore.kpi.total"), value: summary.total, color: "text-zinc-200" },
    { label: t("auth.restore.kpi.executed"), value: summary.executed, color: "text-green-400" },
    { label: t("auth.restore.kpi.skipped"), value: summary.skipped, color: "text-amber-400" },
    {
      label: t("auth.restore.kpi.errors"),
      value: summary.errors,
      color: summary.errors > 0 ? "text-red-400" : "text-zinc-500",
    },
  ];
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-3">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">
        {result.ok ? t("auth.restore.resultOk") : t("auth.restore.resultErrors")}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {kpis.map((kpi) => (
          <div key={kpi.label}>
            <div className="text-[9px] uppercase tracking-wider text-zinc-500 font-mono">
              {kpi.label}
            </div>
            <div className={`text-base font-semibold tabular-nums ${kpi.color}`}>
              {kpi.value.toLocaleString(locale)}
            </div>
          </div>
        ))}
      </div>
      {result.warning && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-400 leading-relaxed">
          {result.warning}
        </div>
      )}
      {result.errors && result.errors.length > 0 && (
        <ul className="text-[11px] font-mono text-zinc-400 space-y-0.5 list-disc pl-4">
          {result.errors.slice(0, SHOWN_ERRORS).map((e, i) => (
            <li key={`${i}-${e}`} className="break-all">
              {e}
            </li>
          ))}
          {result.errors.length > SHOWN_ERRORS && (
            <li className="text-zinc-500">{t("auth.restore.moreErrors", { count: result.errors.length - SHOWN_ERRORS })}</li>
          )}
        </ul>
      )}
    </div>
  );
}
