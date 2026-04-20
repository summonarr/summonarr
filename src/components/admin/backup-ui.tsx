"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, Upload, Loader2, CheckCircle, XCircle, Lock } from "lucide-react";

// Magic bytes at the start of every encrypted backup file; used to reject plain-SQL uploads
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

export function BackupUI({ mode }: { mode: "db-export" | "db-import" }) {
  if (mode === "db-export") return <DbExportSection />;
  return <DbImportSection />;
}

function DbExportSection() {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/backup/db-export");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Export failed");
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      a.download = `summonarr-full-backup-${date}.sql.enc`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 text-xs text-zinc-300 bg-zinc-800/60 border border-zinc-700 rounded-md p-3">
        <Lock className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          Full-DB backups are always encrypted with the server&apos;s
          <code className="mx-1 px-1 rounded bg-zinc-900">BACKUP_DB_PASSWORD</code>
          environment variable. Only someone with shell access to the server can decrypt the resulting file.
        </span>
      </div>
      <Button onClick={handleExport} disabled={downloading}>
        {downloading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
        Download Encrypted Database Dump
      </Button>
      {error && (
        <div className="flex items-start gap-2 text-sm rounded-md p-3 bg-red-900/20 border border-red-800/30 text-red-400">
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

function DbImportSection() {
  const [file, setFile] = useState<File | null>(null);
  const [encrypted, setEncrypted] = useState(false);
  const [preview, setPreview] = useState<{ size: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; summary?: { total: number; executed: number; skipped: number; errors: number }; errors?: string[]; error?: string } | null>(null);

  async function handleFileChange(f: File | null) {
    setFile(f);
    setResult(null);
    setPreview(null);
    setEncrypted(false);
    if (!f) return;
    try {
      const isEnc = await isEncryptedFile(f);
      setEncrypted(isEnc);
      const kb = (f.size / 1024).toFixed(1);
      const mb = (f.size / (1024 * 1024)).toFixed(1);
      setPreview({ size: f.size > 1024 * 1024 ? `${mb} MB` : `${kb} KB` });
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
    try {

      // Stream the raw file bytes; the server decrypts with BACKUP_DB_PASSWORD before executing
      const res = await fetch("/api/admin/backup/db-import", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      const data = await res.json();
      if (res.ok) {
        setResult({ ok: data.ok, summary: data.summary, errors: data.errors });
      } else {
        setResult({ ok: false, error: data.error ?? "Import failed" });
      }
    } catch (err) {
      setResult({ ok: false, error: (err as Error).message });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 text-xs text-zinc-300 bg-zinc-800/60 border border-zinc-700 rounded-md p-3">
        <Lock className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          The server will decrypt the file using its
          <code className="mx-1 px-1 rounded bg-zinc-900">BACKUP_DB_PASSWORD</code>
          environment variable. Only encrypted dumps produced with the same password can be restored.
        </span>
      </div>

      <input
        type="file"
        accept=".enc"
        onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
        className="block w-full text-sm text-zinc-400 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-medium file:bg-zinc-800 file:text-zinc-300 hover:file:bg-zinc-700 file:cursor-pointer"
      />

      {preview && (
        <div className="bg-zinc-800 rounded-lg p-4 text-sm space-y-1">
          <p className="text-zinc-300 font-medium mb-2">SQL backup contents:</p>
          <p className="text-zinc-400">{preview.size} file size</p>
          <p className="text-zinc-400 flex items-center gap-1">
            <Lock className="w-3 h-3" /> {encrypted ? "Encrypted" : "Not an encrypted backup — will be rejected"}
          </p>
        </div>
      )}

      {preview && !result?.ok && (
        <Button onClick={handleImport} disabled={importing || !encrypted}>
          {importing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
          Import Encrypted Database Dump
        </Button>
      )}

      {result && (
        <div className={`flex items-start gap-2 text-sm rounded-md p-3 ${result.ok ? "bg-green-900/20 border border-green-800/30 text-green-400" : "bg-red-900/20 border border-red-800/30 text-red-400"}`}>
          {result.ok ? <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" /> : <XCircle className="w-4 h-4 shrink-0 mt-0.5" />}
          <div>
            {result.summary ? (
              <div>
                <p className="font-medium">{result.ok ? "Import complete" : "Import completed with errors"}</p>
                <p className="text-xs mt-1 opacity-70">
                  {result.summary.executed} executed, {result.summary.skipped} skipped, {result.summary.errors} errors
                </p>
                {result.errors && result.errors.length > 0 && (
                  <ul className="text-xs mt-2 space-y-1 opacity-70">
                    {result.errors.map((e, i) => (
                      <li key={`${i}-${e}`} className="truncate max-w-[500px]">{e}</li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <p>{result.error}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

