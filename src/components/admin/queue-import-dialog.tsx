"use client";

// Admin → Download Queue → Import: Radarr/Sonarr's own Manual Import for a
// download they would not import on their own. Lists the files the arr found
// (GET /api/admin/queue/import), what each matched to and why it was refused;
// the admin picks files and a mode and confirms (POST). The server re-reads the
// arr's list and only sends its own rows — the paths here only select
// (guardrail 5d). A file the arr could not match to a title can't be imported
// from here; it has to be matched in the arr's own queue.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, FileCheck, Loader2, X } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { episodeSummary, queueFormatters } from "@/components/admin/queue-format";
import { defaultImportSelection, type ImportCandidate, type ImportMode, type QueueItem } from "@/lib/arr-queue";

const SERVICE_LABEL = { radarr: "Radarr", sonarr: "Sonarr" } as const;

export function QueueImportDialog({
  row,
  onClose,
  onImported,
}: {
  row: QueueItem | null;
  onClose: () => void;
  onImported: (row: QueueItem, files: number) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const [files, setFiles] = useState<ImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<ImportMode>("auto");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const service = row?.service;
  const instance = row?.instance;
  const downloadId = row?.downloadId ?? null;

  useEffect(() => {
    if (!service || instance === undefined || downloadId === null) return;
    let live = true;
    setFiles(null);
    setSelected(new Set());
    setMode("auto");
    setError("");
    setLoading(true);
    (async () => {
      try {
        const qs = new URLSearchParams({ service, instance, downloadId });
        const res = await fetch(withBasePath(`/api/admin/queue/import?${qs}`));
        const data = (await res.json().catch(() => null)) as { files?: ImportCandidate[]; error?: string } | null;
        if (!live) return;
        if (!res.ok || !data?.files) {
          setError(data?.error ?? tRef.current("adminManage.queue.import.loadFailed"));
          return;
        }
        setFiles(data.files);
        setSelected(defaultImportSelection(data.files));
      } catch {
        if (live) setError(tRef.current("adminManage.queue.import.loadFailed"));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [service, instance, downloadId]);

  async function submit() {
    if (!row || downloadId === null || selected.size === 0) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(withBasePath("/api/admin/queue/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: row.service, instance: row.instance, downloadId, paths: [...selected], importMode: mode }),
      });
      const data = (await res.json().catch(() => null)) as { files?: number; error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? t("adminManage.queue.import.failed"));
        return;
      }
      onImported(row, data?.files ?? selected.size);
    } catch {
      setError(t("adminManage.queue.import.failed"));
    } finally {
      setBusy(false);
    }
  }

  const label = service ? SERVICE_LABEL[service] : "";
  const importable = (files ?? []).filter((f) => f.importable);
  const allSelected = importable.length > 0 && importable.every((f) => selected.has(f.path));

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <Dialog open={row !== null} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="max-w-3xl">
          <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-zinc-700 flex-shrink-0">
            <DialogTitle className="text-base font-semibold text-zinc-100">{t("adminManage.queue.import.title")}</DialogTitle>
            <DialogClose
              disabled={busy}
              aria-label={t("adminQueue.common.close")}
              title={t("adminQueue.common.close")}
              className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
            >
              <X className="w-5 h-5" />
            </DialogClose>
          </div>

          {row && (
            <div className="px-6 pt-4 flex-shrink-0">
              <p className="m-0 text-sm font-medium text-zinc-100">
                {row.mediaTitle || row.title}
                {row.episodes.length > 0 && <span className="ds-mono text-zinc-400"> · {episodeSummary(row.episodes)}</span>}
              </p>
              <p className="m-0 mt-1 text-xs text-zinc-500">{t("adminManage.queue.import.intro", { service: label })}</p>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center gap-3 text-sm text-zinc-500 py-14">
              <Loader2 className="w-5 h-5 animate-spin" />
              {t("adminManage.queue.import.loading")}
            </div>
          ) : files === null ? (
            <div role="alert" className="flex items-center justify-center gap-2 text-sm py-14 px-6 text-center" style={{ color: "var(--ds-danger)" }}>
              <AlertTriangle className="w-4 h-4 shrink-0" /> {error || t("adminManage.queue.import.loadFailed")}
            </div>
          ) : files.length === 0 ? (
            <div className="text-sm text-zinc-500 text-center py-14 px-6">{t("adminManage.queue.import.none", { service: label })}</div>
          ) : (
            <>
              {importable.length > 1 && (
                <label className="flex items-center gap-2 px-6 pt-3 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(importable.map((f) => f.path)))}
                  />
                  {t("adminManage.queue.import.selectAll")}
                </label>
              )}
              <ul className="m-0 mt-2 p-0 overflow-y-auto flex-1 divide-y divide-zinc-800 border-y border-zinc-800" style={{ listStyle: "none" }}>
                {files.map((f) => (
                  <li key={f.path}>
                    <label
                      className={`flex items-start gap-3 px-6 py-3 ${f.importable ? "hover:bg-zinc-800/40" : "opacity-70"}`}
                      title={f.path}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(f.path)}
                        disabled={!f.importable || busy}
                        onChange={() => toggle(f.path)}
                        aria-label={t("adminManage.queue.import.fileLabel", { name: f.name })}
                        style={{ marginTop: 3 }}
                      />
                      <span className="flex flex-col min-w-0 gap-0.5">
                        <span className="ds-mono text-xs text-zinc-100" style={{ overflowWrap: "anywhere" }}>{f.name}</span>
                        <span className="text-xs text-zinc-400">
                          {f.target ? (
                            <>
                              {f.target}
                              {f.episodes.length > 0 && <span className="ds-mono"> · {episodeSummary(f.episodes)}</span>}
                            </>
                          ) : (
                            <span style={{ color: "var(--ds-warning)" }}>{t("adminManage.queue.import.unmatched", { service: label })}</span>
                          )}
                        </span>
                        <span className="text-xs text-zinc-500">
                          {[f.quality, fmt.size(f.size), f.languages.join(", "), f.releaseGroup].filter(Boolean).join(" · ")}
                        </span>
                        {f.rejections.length > 0 && (
                          <span className="flex flex-col text-xs" style={{ color: "var(--ds-warning)" }}>
                            {f.rejections.map((r, i) => (
                              <span key={i} className="flex items-start gap-1">
                                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden /> {r}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>

              <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-t border-zinc-700 bg-zinc-900 flex-shrink-0">
                <label className="flex items-center gap-2 text-xs text-zinc-400">
                  {t("adminManage.queue.import.mode")}
                  <StyledSelect compact className="w-auto" value={mode} onChange={(e) => setMode(e.target.value as ImportMode)} disabled={busy}>
                    <option value="auto">{t("adminManage.queue.import.modeAuto")}</option>
                    <option value="move">{t("adminManage.queue.import.modeMove")}</option>
                    <option value="copy">{t("adminManage.queue.import.modeCopy")}</option>
                  </StyledSelect>
                </label>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={onClose} disabled={busy} className="rounded px-2 py-1 text-sm text-zinc-500 hover:text-zinc-300">
                    {t("shared.common.cancel")}
                  </button>
                  <Button size="sm" onClick={() => void submit()} disabled={busy || selected.size === 0}>
                    {busy ? <Loader2 className="animate-spin" /> : <FileCheck />}
                    {t("adminManage.queue.import.submit", { count: selected.size })}
                  </Button>
                </div>
              </div>
            </>
          )}

          {error && files !== null && (
            <p role="alert" className="m-0 px-6 pb-4 text-xs flex items-center gap-1" style={{ color: "var(--ds-danger)" }}>
              <AlertTriangle className="w-3 h-3 shrink-0" /> {error}
            </p>
          )}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
