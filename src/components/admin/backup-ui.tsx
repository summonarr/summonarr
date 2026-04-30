"use client";

import { useState } from "react";
import { Download, Upload, Loader2, CheckCircle, XCircle, FileCheck, FileX, FileText } from "lucide-react";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { uploadInChunks, type ChunkedUploadProgress } from "@/lib/chunked-upload";

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

function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="ds-tap inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      style={{
        padding: "8px 14px",
        fontSize: 13,
        borderRadius: 8,
        background: "var(--ds-accent)",
        color: "var(--ds-accent-fg)",
        border: "1px solid var(--ds-accent)",
      }}
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="ds-tap inline-flex items-center gap-1.5 font-medium transition-colors"
      style={{
        padding: "5px 12px",
        fontSize: 12,
        borderRadius: 6,
        background: "var(--ds-bg-2)",
        color: "var(--ds-fg-muted)",
        border: "1px solid var(--ds-border)",
      }}
    >
      {children}
    </button>
  );
}

function DbExportSection() {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFilename, setLastFilename] = useState<string | null>(null);
  // Default-filename preview includes today's date; gate to avoid SSR/CSR
  // drift across midnight UTC. See CLAUDE.md guardrail 16.
  const mounted = useHasMounted();

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
      const filename = `summonarr-full-backup-${date}.sql.enc`;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      setLastFilename(filename);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        className="flex items-center"
        style={{
          gap: 10,
          padding: "10px 12px",
          background: "var(--ds-bg-inset, var(--ds-bg))",
          border: "1px solid var(--ds-border)",
          borderRadius: 6,
        }}
      >
        <span
          className="ds-mono uppercase"
          style={{
            fontSize: 10.5,
            color: "var(--ds-fg-subtle)",
            letterSpacing: "0.06em",
          }}
        >
          Filename
        </span>
        <span
          className="ds-mono break-all"
          style={{ fontSize: 11.5, color: "var(--ds-fg)", flex: 1 }}
        >
          {lastFilename ?? (mounted ? `summonarr-full-backup-${new Date().toISOString().slice(0, 10)}.sql.enc` : "")}
        </span>
      </div>

      <PrimaryButton onClick={handleExport} disabled={downloading}>
        {downloading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" /> Generating…
          </>
        ) : (
          <>
            <Download className="w-4 h-4" /> Download encrypted dump
          </>
        )}
      </PrimaryButton>

      {error && (
        <div
          className="flex items-start gap-2"
          style={{
            padding: "10px 12px",
            borderRadius: 6,
            background: "color-mix(in oklab, var(--ds-danger) 12%, transparent)",
            border: "1px solid color-mix(in oklab, var(--ds-danger) 30%, var(--ds-border))",
            color: "var(--ds-danger)",
            fontSize: 12.5,
          }}
        >
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

function DbImportSection() {
  const [file, setFile] = useState<File | null>(null);
  const [encrypted, setEncrypted] = useState<boolean | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ChunkedUploadProgress | null>(null);
  const [result, setResult] = useState<
    | {
        ok: boolean;
        summary?: { total: number; executed: number; skipped: number; errors: number };
        errors?: string[];
        error?: string;
        warning?: string;
      }
    | null
  >(null);

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
      endpoint: "/api/admin/backup/db-import-chunk",
      onProgress: setProgress,
    });

    setImporting(false);

    if (outcome.kind === "error") {
      setResult({ ok: false, error: outcome.error });
      return;
    }
    const data = outcome.data as {
      ok: boolean;
      summary?: { total: number; executed: number; skipped: number; errors: number };
      errors?: string[];
      warning?: string;
    };
    setResult({ ok: data.ok, summary: data.summary, errors: data.errors, warning: data.warning });
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
      ? "var(--ds-danger)"
      : encrypted === true
        ? "color-mix(in oklab, var(--ds-success) 40%, var(--ds-border))"
        : "var(--ds-border-strong, var(--ds-border))";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        style={{
          border: `1px dashed ${dropBorder}`,
          borderRadius: 8,
          padding: 18,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          minHeight: 110,
          textAlign: "center",
          background: file ? "var(--ds-bg-inset, var(--ds-bg))" : "transparent",
          transition: "background 120ms, border-color 120ms",
        }}
      >
        {file ? (
          <>
            <div className="flex items-center gap-2">
              {encrypted === true ? (
                <FileCheck style={{ width: 18, height: 18, color: "var(--ds-success)" }} />
              ) : encrypted === false ? (
                <FileX style={{ width: 18, height: 18, color: "var(--ds-danger)" }} />
              ) : (
                <FileText style={{ width: 18, height: 18, color: "var(--ds-fg-muted)" }} />
              )}
              <span className="ds-mono font-medium break-all" style={{ fontSize: 12 }}>
                {file.name}
              </span>
              {size && (
                <span
                  className="ds-mono"
                  style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
                >
                  · {size}
                </span>
              )}
            </div>
            {encrypted === true && (
              <span
                className="ds-chip ds-chip-approved inline-flex items-center"
                style={{ gap: 4, fontSize: 10, letterSpacing: "0.04em" }}
              >
                <CheckCircle style={{ width: 10, height: 10 }} />
                VALID HEADER · RBKBKP01
              </span>
            )}
            {encrypted === false && (
              <span
                className="ds-chip ds-chip-declined"
                style={{ fontSize: 10, letterSpacing: "0.04em" }}
              >
                NOT ENCRYPTED · REJECTED
              </span>
            )}
          </>
        ) : (
          <>
            <Upload
              style={{ width: 22, height: 22, color: "var(--ds-fg-subtle)" }}
            />
            <span
              className="ds-mono uppercase"
              style={{
                fontSize: 10.5,
                color: "var(--ds-fg-subtle)",
                letterSpacing: "0.06em",
              }}
            >
              Drop .sql.enc file or choose below
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <label
          className="ds-tap inline-flex items-center gap-1.5 font-medium transition-colors cursor-pointer"
          style={{
            padding: "5px 12px",
            fontSize: 12,
            borderRadius: 6,
            background: "var(--ds-bg-2)",
            color: "var(--ds-fg-muted)",
            border: "1px solid var(--ds-border)",
          }}
        >
          Choose file
          <input
            type="file"
            accept=".enc"
            onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
            className="hidden"
          />
        </label>
        {file && <SecondaryButton onClick={clearFile}>Clear</SecondaryButton>}
      </div>

      {!result?.summary && (
        <PrimaryButton
          onClick={handleImport}
          disabled={!file || !encrypted || importing}
        >
          {importing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {progress?.phase === "import"
                ? "Importing…"
                : progress
                  ? `Uploading… ${Math.round((progress.uploaded / progress.total) * 100)}%`
                  : "Starting…"}
            </>
          ) : (
            <>
              <Upload className="w-4 h-4" /> Restore from file
            </>
          )}
        </PrimaryButton>
      )}

      {importing && progress && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div
            style={{
              height: 6,
              borderRadius: 999,
              background: "var(--ds-bg-3)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.round((progress.uploaded / progress.total) * 100)}%`,
                background: "var(--ds-accent)",
                transition: "width 120ms",
              }}
            />
          </div>
          <div
            className="ds-mono"
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 10.5,
              color: "var(--ds-fg-subtle)",
            }}
          >
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
        <div
          style={{
            padding: 14,
            background: "var(--ds-bg-inset, var(--ds-bg))",
            border: "1px solid var(--ds-border)",
            borderRadius: 8,
          }}
        >
          <div
            className="ds-mono uppercase"
            style={{
              fontSize: 10.5,
              color: "var(--ds-fg-subtle)",
              letterSpacing: "0.06em",
              marginBottom: 10,
            }}
          >
            Result · {result.ok ? "import complete" : "import completed with errors"}
          </div>
          <div
            className="grid grid-cols-2 sm:grid-cols-4"
            style={{ gap: 10 }}
          >
            {[
              { label: "Total", value: result.summary.total, color: "var(--ds-fg)" },
              { label: "Executed", value: result.summary.executed, color: "var(--ds-success)" },
              { label: "Skipped", value: result.summary.skipped, color: "var(--ds-warning)" },
              {
                label: "Errors",
                value: result.summary.errors,
                color: result.summary.errors > 0 ? "var(--ds-danger)" : "var(--ds-fg-subtle)",
              },
            ].map((kpi) => (
              <div key={kpi.label}>
                <div
                  className="ds-mono uppercase"
                  style={{
                    fontSize: 10,
                    color: "var(--ds-fg-subtle)",
                    letterSpacing: "0.06em",
                  }}
                >
                  {kpi.label}
                </div>
                <div
                  className="ds-mono font-semibold"
                  style={{
                    fontSize: 18,
                    color: kpi.color,
                    marginTop: 2,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {kpi.value.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
          {result.warning && (
            <div
              style={{
                marginTop: 12,
                padding: "8px 10px",
                borderRadius: 6,
                background: "color-mix(in oklab, var(--ds-warning) 12%, transparent)",
                border: "1px solid color-mix(in oklab, var(--ds-warning) 30%, var(--ds-border))",
                color: "var(--ds-warning)",
                fontSize: 11.5,
                lineHeight: 1.5,
              }}
            >
              {result.warning}
            </div>
          )}
          {result.errors && result.errors.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div
                className="ds-mono uppercase"
                style={{
                  fontSize: 10,
                  color: "var(--ds-fg-subtle)",
                  letterSpacing: "0.06em",
                  marginBottom: 6,
                }}
              >
                Errors ({result.errors.length})
              </div>
              <ul
                className="ds-mono"
                style={{
                  margin: 0,
                  paddingLeft: 18,
                  fontSize: 11,
                  color: "var(--ds-fg-muted)",
                  lineHeight: 1.6,
                }}
              >
                {result.errors.slice(0, 10).map((e, i) => (
                  <li key={`${i}-${e}`} className="break-all">
                    {e}
                  </li>
                ))}
                {result.errors.length > 10 && (
                  <li style={{ color: "var(--ds-fg-subtle)" }}>
                    …and {result.errors.length - 10} more
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}

      {result?.error && (
        <div
          className="flex items-start gap-2"
          style={{
            padding: "10px 12px",
            borderRadius: 6,
            background: "color-mix(in oklab, var(--ds-danger) 12%, transparent)",
            border: "1px solid color-mix(in oklab, var(--ds-danger) 30%, var(--ds-border))",
            color: "var(--ds-danger)",
            fontSize: 12.5,
          }}
        >
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{result.error}</span>
        </div>
      )}
    </div>
  );
}
