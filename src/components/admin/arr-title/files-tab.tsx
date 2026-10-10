"use client";

// The title manager's Files tab: every file Radarr/Sonarr has for the title —
// path, size, quality, languages, custom formats and media info — with the
// arr's own two file actions: delete (from disk, through the arr) and rename
// to its naming scheme (the arr's preview first, then RenameFiles for the
// files chosen). The server re-checks every id against the title's files
// (GET/DELETE /api/admin/arr/title/files, GET/POST …/rename).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/design";
import { AlertTriangle, ArrowDown, Check, FileText, Loader2, RefreshCw, Trash2 } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { episodeSummary, queueFormatters } from "@/components/admin/queue-format";
import type { RenamePreview, TitleFile, TitleFileMedia } from "@/lib/arr-title";
import { arrApi, titleQuery, useTRef, type TitleRef } from "./shared";

function mediaSummary(m: TitleFileMedia | null): string {
  if (!m) return "";
  const audio = [m.audioCodec, m.audioChannels !== null ? String(m.audioChannels) : null].filter(Boolean).join(" ");
  return [
    m.resolution,
    m.videoCodec,
    m.videoDynamicRange,
    m.videoBitDepth ? `${m.videoBitDepth}-bit` : null,
    audio || null,
    m.audioLanguages,
    m.subtitles ? `subs ${m.subtitles}` : null,
    m.runTime,
  ].filter((x): x is string => !!x).join(" · ");
}

export function FilesTab({ titleRef, onChanged }: { titleRef: TitleRef; onChanged: () => void }) {
  const t = useT();
  const tRef = useTRef();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const [files, setFiles] = useState<TitleFile[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<"delete" | "preview" | "rename" | null>(null);
  const [renames, setRenames] = useState<RenamePreview[] | null>(null);
  const [renameSelected, setRenameSelected] = useState<ReadonlySet<number>>(new Set());
  const isSeries = titleRef.service === "sonarr";

  const load = useCallback(async () => {
    const res = await arrApi<{ files: TitleFile[] }>(`/api/admin/arr/title/files?${titleQuery(titleRef)}`, undefined, tRef.current("adminArr.files.loadFailed"));
    if (res.ok) {
      setFiles(res.data.files);
      setSelected((prev) => new Set([...prev].filter((id) => res.data.files.some((f) => f.id === id))));
      setError("");
    } else {
      setError(res.error);
      setFiles((f) => f ?? []);
    }
  }, [titleRef, tRef]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmDelete(false);
  }

  async function remove() {
    setBusy("delete");
    setError("");
    const ids = [...selected];
    const res = await arrApi<{ deleted: number }>(
      `/api/admin/arr/title/files?${titleQuery(titleRef, { fileIds: ids.join(",") })}`,
      { method: "DELETE" },
      t("adminArr.files.deleteFailed"),
    );
    setBusy(null);
    setConfirmDelete(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNotice(t("adminArr.files.deleted", { count: res.data.deleted }));
    setSelected(new Set());
    await load();
    onChanged();
  }

  async function preview() {
    setBusy("preview");
    setError("");
    setNotice("");
    const res = await arrApi<{ files: RenamePreview[] }>(`/api/admin/arr/title/rename?${titleQuery(titleRef)}`, undefined, t("adminArr.files.renameFailed"));
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRenames(res.data.files);
    setRenameSelected(new Set(res.data.files.map((r) => r.fileId)));
  }

  async function rename() {
    setBusy("rename");
    setError("");
    const res = await arrApi<{ files: number }>(
      "/api/admin/arr/title/rename",
      { method: "POST", body: { service: titleRef.service, instance: titleRef.instance, id: titleRef.arrId, fileIds: [...renameSelected] } },
      t("adminArr.files.renameFailed"),
    );
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRenames(null);
    setNotice(t("adminArr.files.renaming", { count: res.data.files }));
    // The arr renames in the background; read the new names once it has.
    window.setTimeout(() => void load(), 3_000);
  }

  if (files === null) {
    return <div className="flex items-center gap-2 py-8 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>;
  }

  const allSelected = files.length > 0 && files.every((f) => selected.has(f.id));

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {files.length > 0 && (
          <label className="mr-1 flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => setSelected(e.target.checked ? new Set(files.map((f) => f.id)) : new Set())}
              className="accent-[var(--ds-accent)]"
            />
            {t("adminArr.files.selectAll")}
          </label>
        )}
        <Button variant="outline" size="sm" disabled={selected.size === 0 || busy !== null} onClick={() => setConfirmDelete(true)}>
          <Trash2 /> {t("adminArr.files.delete", { count: selected.size })}
        </Button>
        <Button variant="outline" size="sm" disabled={files.length === 0 || busy !== null} onClick={() => void preview()}>
          {busy === "preview" ? <Loader2 className="animate-spin" /> : <FileText />} {t("adminArr.files.previewRename")}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void load()} className="ml-auto">
          <RefreshCw /> {t("adminArr.common.reload")}
        </Button>
      </div>

      {confirmDelete && (
        <div role="alertdialog" aria-label={t("adminArr.files.confirmTitle")} className="flex flex-wrap items-center gap-3 rounded-lg px-3 py-2.5 text-sm" style={{ background: "color-mix(in oklab, var(--ds-danger) 12%, transparent)", border: "1px solid var(--ds-danger)" }}>
          <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: "var(--ds-danger)" }} />
          <span className="min-w-0 flex-1 text-zinc-100">{t("adminArr.files.confirm", { count: selected.size })}</span>
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} disabled={busy !== null}>{t("adminArr.common.cancel")}</Button>
          <Button size="sm" className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]" onClick={() => void remove()} disabled={busy !== null}>
            {busy === "delete" && <Loader2 className="animate-spin" />} {t("adminArr.files.confirmDelete")}
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="m-0 flex items-center gap-1.5 text-xs" style={{ color: "var(--ds-danger)" }}>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}
      {notice && (
        <p className="m-0 flex items-center gap-1.5 text-xs text-green-400"><Check className="h-3.5 w-3.5" /> {notice}</p>
      )}

      {renames !== null && (
        <div className="grid gap-2 rounded-lg p-3" style={{ border: "1px solid var(--ds-border)", background: "var(--ds-bg-1)" }}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">{t("adminArr.files.renameTitle")}</span>
            <span className="text-xs text-zinc-500">{t("adminArr.files.renameHint")}</span>
            <span className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setRenames(null)} disabled={busy !== null}>{t("adminArr.common.cancel")}</Button>
            <Button size="sm" onClick={() => void rename()} disabled={renameSelected.size === 0 || busy !== null}>
              {busy === "rename" && <Loader2 className="animate-spin" />} {t("adminArr.files.renameApply", { count: renameSelected.size })}
            </Button>
          </div>
          {renames.length === 0 ? (
            <p className="m-0 text-xs text-zinc-500">{t("adminArr.files.renameNone")}</p>
          ) : (
            <ul className="m-0 grid list-none gap-2 p-0">
              {renames.map((r) => (
                <li key={r.fileId} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={renameSelected.has(r.fileId)}
                    onChange={(e) => setRenameSelected((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(r.fileId);
                      else next.delete(r.fileId);
                      return next;
                    })}
                    className="mt-1 accent-[var(--ds-accent)]"
                    aria-label={r.existingPath}
                  />
                  <div className="min-w-0 text-xs">
                    <div className="break-all text-zinc-500">{r.existingPath}</div>
                    <div className="flex items-start gap-1 break-all text-zinc-200"><ArrowDown className="mt-0.5 h-3 w-3 shrink-0 text-zinc-500" aria-hidden /> {r.newPath}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {files.length === 0 ? (
        <p className="m-0 py-6 text-center text-sm text-zinc-500">{t("adminArr.files.none")}</p>
      ) : (
        <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
          {files.map((f, i) => {
            const media = mediaSummary(f.media);
            return (
              <li key={f.id} className="flex items-start gap-3 px-3 py-2.5" style={i > 0 ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
                <input
                  type="checkbox"
                  checked={selected.has(f.id)}
                  onChange={() => toggle(f.id)}
                  className="mt-1 accent-[var(--ds-accent)]"
                  aria-label={t("adminArr.files.selectAria", { name: f.relativePath })}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {isSeries && f.episodes.length > 0 && <span className="ds-mono text-xs text-zinc-500">{episodeSummary(f.episodes)}</span>}
                    <span className="min-w-0 break-all text-sm text-zinc-100" title={f.path ?? undefined}>{f.relativePath}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                    {f.quality && (
                      <Chip tone={f.qualityCutoffNotMet ? "pending" : "accent"}>
                        {f.quality}
                        {f.qualityTags.length > 0 && ` ${f.qualityTags.map((tag) => t(`adminManage.queue.qualityTag.${tag}`)).join(" ")}`}
                      </Chip>
                    )}
                    {f.qualityCutoffNotMet && <Chip tone="pending">{t("adminArr.files.cutoffUnmet")}</Chip>}
                    <span>{fmt.size(f.size)}</span>
                    {f.languages.length > 0 && <span>{f.languages.join(", ")}</span>}
                    {f.releaseGroup && <span>{f.releaseGroup}</span>}
                    {f.edition && <span>{f.edition}</span>}
                    {f.customFormats.length > 0 && (
                      <span title={f.customFormats.join(", ")}>
                        {t("adminArr.files.customFormats", { count: f.customFormats.length })}
                        {f.customFormatScore !== null && ` (${fmt.score(f.customFormatScore)})`}
                      </span>
                    )}
                    {f.dateAdded && <span>{t("adminArr.files.added", { date: fmt.dateTime(f.dateAdded) })}</span>}
                  </div>
                  {media && <div className="mt-1 text-xs text-zinc-500">{media}</div>}
                  {f.sceneName && <div className="mt-1 truncate text-xs text-zinc-500" title={f.sceneName}>{f.sceneName}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
