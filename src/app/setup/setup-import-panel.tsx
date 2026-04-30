"use client";

import { useState } from "react";
import { Upload, Loader2, CheckCircle, XCircle, FileCheck, FileX, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uploadInChunks, type ChunkedUploadProgress } from "@/lib/chunked-upload";

const ENCRYPTED_MAGIC = "RBKBKP01";

async function isEncryptedFile(file: File): Promise<boolean> {
  if (file.size < ENCRYPTED_MAGIC.length) return false;
  const head = await file.slice(0, ENCRYPTED_MAGIC.length).arrayBuffer();
  const bytes = new Uint8Array(head);
  for (let i = 0; i < ENCRYPTED_MAGIC.length; i++) {
    if (bytes[i] !== ENCRYPTED_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

type ImportResult =
  | {
      ok: boolean;
      summary?: { total: number; executed: number; skipped: number; errors: number };
      errors?: string[];
      error?: string;
      warning?: string;
    }
  | null;

export function SetupImportPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [encrypted, setEncrypted] = useState<boolean | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ChunkedUploadProgress | null>(null);
  const [result, setResult] = useState<ImportResult>(null);

  async function handleFileChange(f: File | null) {
    setFile(f);
    setResult(null);
    setProgress(null);
    setSize(null);
    setEncrypted(null);
    if (!f) return;
    try {
      const isEnc = await isEncryptedFile(f);
      setEncrypted(isEnc);
      const kb = (f.size / 1024).toFixed(1);
      const mb = (f.size / (1024 * 1024)).toFixed(1);
      setSize(f.size > 1024 * 1024 ? `${mb} MB` : `${kb} KB`);
    } catch {
      setResult({ ok: false, error: "Could not read file" });
    }
  }

  async function handleImport() {
    if (!file) return;
    if (!encrypted) {
      setResult({ ok: false, error: "Backup file is not an encrypted Summonarr dump." });
      return;
    }
    setImporting(true);
    setResult(null);
    setProgress({ uploaded: 0, total: file.size, phase: "upload" });

    const outcome = await uploadInChunks({
      file,
      endpoint: "/api/setup/import-chunk",
      onProgress: setProgress,
    });

    setImporting(false);

    if (outcome.kind === "error") {
      setResult({ ok: false, error: outcome.error });
      return;
    }

    const data = outcome.data as ImportResult & { ok: boolean };
    setResult({ ok: data.ok, summary: data.summary, errors: data.errors, warning: data.warning });
    if (data.ok) {
      setTimeout(() => {
        window.location.href = "/login";
      }, 1500);
    }
  }

  function clearFile() {
    setFile(null);
    setEncrypted(null);
    setSize(null);
    setResult(null);
    setProgress(null);
  }

  const dropBorder =
    encrypted === false
      ? "border-red-500"
      : encrypted === true
        ? "border-green-500/40"
        : "border-zinc-700";

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm text-zinc-300">Restore from a previous Summonarr backup</p>
        <p className="text-xs text-zinc-500 leading-relaxed">
          Upload a <code className="text-zinc-300">.sql.enc</code> file exported from another Summonarr instance.
          The server decrypts it with the configured <code className="text-zinc-300">BACKUP_DB_PASSWORD</code> and
          replaces the empty database — settings, accounts, library caches, and the original admin user are all
          restored. Sign in afterwards with the credentials from the source server.
        </p>
      </div>

      <div
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
                <CheckCircle className="w-3 h-3" /> Valid header · RBKBKP01
              </span>
            )}
            {encrypted === false && (
              <span className="text-[10px] uppercase tracking-wider text-red-400">
                Not encrypted · rejected
              </span>
            )}
          </>
        ) : (
          <>
            <Upload className="w-5 h-5 text-zinc-500" />
            <span className="text-[11px] uppercase tracking-wider text-zinc-500">
              Drop .sql.enc file or choose below
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors">
          Choose file
          <input
            type="file"
            accept=".enc"
            onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
            className="hidden"
          />
        </label>
        {file && (
          <button
            type="button"
            onClick={clearFile}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-800 border border-zinc-700 text-zinc-400 hover:bg-zinc-700 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {!result?.summary && (
        <Button
          type="button"
          onClick={handleImport}
          disabled={!file || !encrypted || importing}
          className="w-full bg-indigo-600 hover:bg-indigo-500"
        >
          {importing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              {progress?.phase === "import"
                ? "Importing…"
                : progress
                  ? `Uploading… ${Math.round((progress.uploaded / progress.total) * 100)}%`
                  : "Starting…"}
            </>
          ) : (
            <>
              <Upload className="w-4 h-4 mr-2" /> Restore from file
            </>
          )}
        </Button>
      )}

      {importing && progress && (
        <div className="space-y-1.5">
          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-indigo-500 transition-all"
              style={{ width: `${Math.round((progress.uploaded / progress.total) * 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] font-mono text-zinc-500">
            <span>
              {(progress.uploaded / (1024 * 1024)).toFixed(1)} MB /{" "}
              {(progress.total / (1024 * 1024)).toFixed(1)} MB
            </span>
            <span>
              {progress.phase === "import" ? "Decrypting + restoring on server…" : "Uploading"}
            </span>
          </div>
        </div>
      )}

      {result?.summary && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-3">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">
            Result · {result.ok ? "import complete · redirecting…" : "import completed with errors"}
          </div>
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: "Total", value: result.summary.total, color: "text-zinc-200" },
              { label: "Executed", value: result.summary.executed, color: "text-green-400" },
              { label: "Skipped", value: result.summary.skipped, color: "text-amber-400" },
              {
                label: "Errors",
                value: result.summary.errors,
                color: result.summary.errors > 0 ? "text-red-400" : "text-zinc-500",
              },
            ].map((kpi) => (
              <div key={kpi.label}>
                <div className="text-[9px] uppercase tracking-wider text-zinc-500 font-mono">
                  {kpi.label}
                </div>
                <div className={`text-base font-semibold tabular-nums ${kpi.color}`}>
                  {kpi.value.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
          {result.warning && (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300 leading-relaxed">
              {result.warning}
            </div>
          )}
          {result.errors && result.errors.length > 0 && (
            <ul className="text-[11px] font-mono text-zinc-400 space-y-0.5 list-disc pl-4">
              {result.errors.slice(0, 10).map((e, i) => (
                <li key={`${i}-${e}`} className="break-all">
                  {e}
                </li>
              ))}
              {result.errors.length > 10 && (
                <li className="text-zinc-500">…and {result.errors.length - 10} more</li>
              )}
            </ul>
          )}
        </div>
      )}

      {result?.error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{result.error}</span>
        </div>
      )}
    </div>
  );
}
