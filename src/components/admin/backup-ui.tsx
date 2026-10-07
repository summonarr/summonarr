"use client";

import { useRef, useState } from "react";
import { Download, Upload, Loader2, CheckCircle, XCircle, FileCheck, FileX, FileText, AlertTriangle } from "@/components/icons";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { uploadInChunks, type ChunkedUploadProgress } from "@/lib/chunked-upload";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MB = 1024 * 1024;

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

// `exportReady` is the server page's read of BACKUP_DB_PASSWORD (set, ≥12
// chars — the db-export route's own 503 gate); false swaps the Download button
// for a warning so the admin learns it here instead of from a tab of raw JSON.
export function BackupUI({
  mode,
  exportReady = true,
}: {
  mode: "db-export" | "db-import";
  exportReady?: boolean;
}) {
  if (mode === "db-export") return <DbExportSection ready={exportReady} />;
  return <DbImportSection />;
}

function DbExportSection({ ready }: { ready: boolean }) {
  const t = useT();
  // Default-filename preview includes today's date; gate to avoid SSR/CSR
  // drift across midnight UTC. See CLAUDE.md guardrail 16.
  const mounted = useHasMounted();

  function handleExport() {
    // Open the download URL directly instead of fetch() + Blob. The dump can be
    // hundreds of MB, and a Blob would hold all of it in browser memory. With
    // direct navigation the browser saves it straight to disk (the server's
    // `Content-Disposition: attachment` header names the file) and shows its
    // normal download progress. Errors (429, 500) show up as JSON in the new
    // tab. There is no "done" signal, so there is no spinner here — and no
    // "served" claim either: the Filename row is only a PREVIEW of the name the
    // route will use (same date formula). A HEAD probe is not a cheap check:
    // the route defines only GET and Next auto-implements HEAD by running it,
    // i.e. a full dump, a rate-limit slot and a BACKUP_EXPORT audit row.
    window.open(withBasePath("/api/admin/backup/db-export"), "_blank");
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
          {t("adminManage.backup.filename")}
        </span>
        <span
          className="ds-mono break-all"
          style={{ fontSize: 11.5, color: "var(--ds-fg)", flex: 1 }}
        >
          {mounted ? `summonarr-full-backup-${new Date().toISOString().slice(0, 10)}.sql.enc` : ""}
        </span>
      </div>

      {ready ? (
        <Button onClick={handleExport}>
          <Download /> {t("adminManage.backup.download")}
        </Button>
      ) : (
        <div
          role="status"
          className="flex items-start gap-2"
          style={{
            padding: "10px 12px",
            borderRadius: 6,
            background: "color-mix(in oklab, var(--ds-warning) 12%, transparent)",
            border: "1px solid color-mix(in oklab, var(--ds-warning) 30%, var(--ds-border))",
            color: "var(--ds-warning)",
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{t("adminManage.backup.exportNotConfigured")}</span>
        </div>
      )}
    </div>
  );
}

function DbImportSection() {
  const t = useT();
  const locale = useLocale();
  const [file, setFile] = useState<File | null>(null);
  const [encrypted, setEncrypted] = useState<boolean | null>(null);
  // Raw bytes; formatted at render so the size follows the viewer's locale
  // (decimal separator) like the result KPIs below it.
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const sizeFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const formatSize = (bytes: number) =>
    bytes > MB ? `${sizeFmt.format(bytes / MB)} MB` : `${sizeFmt.format(bytes / 1024)} KB`;
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    setSizeBytes(null);
    setEncrypted(null);
    if (!f) return;
    try {
      const isEnc = await isEncryptedFile(f);
      setEncrypted(isEnc);
      setSizeBytes(f.size);
    } catch {
      setResult({ ok: false, error: t("adminManage.backup.error.read") });
    }
  }

  async function handleImport() {
    if (!file) return;
    if (!encrypted) {
      setResult({ ok: false, error: t("adminManage.backup.error.notEncrypted") });
      return;
    }
    setConfirming(false);
    setImporting(true);
    setResult(null);
    setProgress({ uploaded: 0, total: file.size, phase: "upload" });

    // uploadInChunks folds fetch failures into an "error" outcome, but it can
    // still throw before its own try (crypto.randomUUID is undefined outside a
    // secure context — a plain-HTTP LAN deployment). Unguarded, that rejection
    // left `importing` true forever: a spinner with no way to retry.
    let outcome: Awaited<ReturnType<typeof uploadInChunks>>;
    try {
      outcome = await uploadInChunks({
        file,
        endpoint: withBasePath("/api/admin/backup/db-import-chunk"),
        onProgress: setProgress,
      });
    } catch (err) {
      setImporting(false);
      setResult({ ok: false, error: err instanceof Error ? err.message : t("adminManage.backup.error.upload") });
      return;
    }

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
    // Reset the uncontrolled input too, or re-picking the same file fires no
    // change event and the drop zone stays empty.
    if (fileInputRef.current) fileInputRef.current.value = "";
    setFile(null);
    setEncrypted(null);
    setSizeBytes(null);
    setResult(null);
    setProgress(null);
    setConfirming(false);
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
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => {
          // Without preventDefault the browser's own drop runs and navigates
          // away to (or downloads) the dropped file.
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={(e) => {
          // dragleave fires when the pointer crosses onto a CHILD of the zone
          // too; only clear once it has actually left the zone.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const dropped = e.dataTransfer.files[0];
          if (dropped) void handleFileChange(dropped);
        }}
        style={{
          border: `1px dashed ${dragging ? "var(--ds-accent-ring)" : dropBorder}`,
          borderRadius: 8,
          padding: 18,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          minHeight: 110,
          textAlign: "center",
          background: dragging
            ? "var(--ds-accent-soft)"
            : file
              ? "var(--ds-bg-inset, var(--ds-bg))"
              : "transparent",
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
              {sizeBytes !== null && (
                <span
                  className="ds-mono"
                  style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
                >
                  · {formatSize(sizeBytes)}
                </span>
              )}
            </div>
            {encrypted === true && (
              <span
                className="ds-chip ds-chip-approved inline-flex items-center"
                style={{ gap: 4, fontSize: 10, letterSpacing: "0.04em" }}
              >
                <CheckCircle style={{ width: 10, height: 10 }} />
                {t("adminManage.backup.validHeader")}
              </span>
            )}
            {encrypted === false && (
              <span
                className="ds-chip ds-chip-declined"
                style={{ fontSize: 10, letterSpacing: "0.04em" }}
              >
                {t("adminManage.backup.notEncrypted")}
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
              {t("adminManage.backup.drop")}
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <label
          // Styled as the secondary Button beside it (same recipe, so the pair
          // reads as one control row); a <label> is not a <button>, so the
          // pointer and the focus ring (from the sr-only input inside) are
          // restated here rather than coming from the base rule / focus-visible.
          className={cn(
            buttonVariants({ variant: "secondary", size: "sm" }),
            "cursor-pointer focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          )}
        >
          {t("adminManage.backup.chooseFile")}
          <input
            ref={fileInputRef}
            type="file"
            accept=".enc"
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null;
              // Empty the input once read: a later drop or Clear replaces the
              // file in state, and re-picking the same file must still fire.
              e.target.value = "";
              void handleFileChange(picked);
            }}
            // sr-only, not hidden: display:none drops the input from the tab
            // order and a <label> can't take focus, so keyboard users could
            // never open the chooser.
            className="sr-only"
          />
        </label>
        {file && (
          <Button variant="secondary" size="sm" onClick={clearFile}>
            {t("adminManage.backup.clear")}
          </Button>
        )}
      </div>

      {!result?.summary && !confirming && (
        <Button
          onClick={() => setConfirming(true)}
          disabled={!file || !encrypted || importing}
        >
          {importing ? (
            <>
              <Loader2 className="animate-spin" />
              {progress?.phase === "import"
                ? t("adminManage.backup.importing")
                : progress
                  ? t("adminManage.backup.uploadingPct", { pct: Math.round((progress.uploaded / progress.total) * 100) })
                  : t("adminManage.backup.starting")}
            </>
          ) : (
            <>
              <Upload /> {t("adminManage.backup.restoreFromFile")}
            </>
          )}
        </Button>
      )}

      {!result?.summary && confirming && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: 14,
            borderRadius: 8,
            background: "color-mix(in oklab, var(--ds-danger) 8%, transparent)",
            border: "1px solid color-mix(in oklab, var(--ds-danger) 40%, var(--ds-border))",
          }}
        >
          <span style={{ fontSize: 12.5, color: "var(--ds-fg)" }}>
            {t("adminManage.backup.confirm")}
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
              {t("adminManage.common.cancel")}
            </Button>
            <Button onClick={handleImport} disabled={importing}>
              <Upload /> {t("adminManage.backup.confirmYes")}
            </Button>
          </div>
        </div>
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
              {sizeFmt.format(progress.uploaded / MB)} MB /{" "}
              {sizeFmt.format(progress.total / MB)} MB
            </span>
            <span>
              {progress.phase === "import" ? t("adminManage.backup.restoringOnServer") : t("adminManage.backup.uploading")}
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
            {result.ok ? t("adminManage.backup.resultOk") : t("adminManage.backup.resultErrors")}
          </div>
          <div
            className="grid grid-cols-2 sm:grid-cols-4"
            style={{ gap: 10 }}
          >
            {[
              { label: t("adminManage.backup.kpi.total"), value: result.summary.total, color: "var(--ds-fg)" },
              { label: t("adminManage.backup.kpi.executed"), value: result.summary.executed, color: "var(--ds-success)" },
              { label: t("adminManage.backup.kpi.skipped"), value: result.summary.skipped, color: "var(--ds-warning)" },
              {
                label: t("adminManage.backup.kpi.errors"),
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
                  {kpi.value.toLocaleString(locale)}
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
                {t("adminManage.backup.errorsCount", { count: result.errors.length })}
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
                    {t("adminManage.backup.andMore", { count: result.errors.length - 10 })}
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
