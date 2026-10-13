"use client";

// The title manager's Files tab: every file Radarr/Sonarr has for the title —
// path, size, quality, languages, custom formats and media info — with the
// arr's own two file actions: delete (from disk, through the arr) and rename
// to its naming scheme (the arr's preview first, then RenameFiles for the
// files chosen). The server re-checks every id against the title's files
// (GET/DELETE /api/admin/arr/title/files, GET/POST …/rename).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/design";
import { AlertTriangle, ArrowDown, Check, ChevronDown, ChevronRight, FileText, Loader2, RefreshCw, Trash2 } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { episodeSummary, queueFormatters } from "@/components/admin/queue-format";
import { CommandWatchLine, useArrCommandWatch } from "@/components/admin/arr-command-watch";
import type { RenamePreview, TitleFile, TitleFileMedia } from "@/lib/arr-title";
import { withBasePath } from "@/lib/base-path";
import { arrApi, titleQuery, useTRef, type TitleRef } from "./shared";

type T = ReturnType<typeof useT>;

function mediaSummary(m: TitleFileMedia | null, t: T): string {
  if (!m) return "";
  const audio = [m.audioCodec, m.audioChannels !== null ? String(m.audioChannels) : null].filter(Boolean).join(" ");
  return [
    m.resolution,
    m.videoCodec,
    m.videoDynamicRange,
    m.videoBitDepth ? t("adminArr.files.bitDepth", { bits: m.videoBitDepth }) : null,
    audio || null,
    m.audioLanguages,
    m.subtitles ? t("adminArr.files.subtitles", { list: m.subtitles }) : null,
    m.runTime,
  ].filter((x): x is string => !!x).join(" · ");
}

// The rest of the media info the arr reports, for a file's details.
function mediaDetails(m: TitleFileMedia | null, t: T, locale: string): Array<[string, string]> {
  if (!m) return [];
  const kbps = new Intl.NumberFormat(locale, { style: "unit", unit: "kilobit-per-second", unitDisplay: "narrow", maximumFractionDigits: 0 });
  const num = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  const rows: Array<[string, string | null]> = [
    [t("adminArr.files.detail.videoBitrate"), m.videoBitrate ? kbps.format(m.videoBitrate / 1000) : null],
    [t("adminArr.files.detail.fps"), m.videoFps ? num.format(m.videoFps) : null],
    [t("adminArr.files.detail.scanType"), m.scanType],
    [t("adminArr.files.detail.audioBitrate"), m.audioBitrate ? kbps.format(m.audioBitrate / 1000) : null],
    [t("adminArr.files.detail.audioStreams"), m.audioStreamCount !== null ? String(m.audioStreamCount) : null],
    [t("adminArr.files.detail.runTime"), m.runTime],
  ];
  return rows.filter((r): r is [string, string] => r[1] !== null && r[1] !== "");
}

// A delete runs as a BACKGROUND job on the server — each delete may wait 120 s
// (a recycle bin on another disk is a copy), past a reverse proxy's hold, and
// the admin was shown "delete failed" while the arr finished it. Start it, then
// poll `&job=` for the DELETE's own answer: counted, one poll per answer, never
// a clock (guardrail 16). A few failed polls in a row (a network blip, a
// proxy's own 5xx with no JSON) are retried — the delete keeps running there.
const DELETE_POLL_MS = 1_500;
const DELETE_MAX_POLLS = 600; // ~15 minutes
const DELETE_FAILED_POLLS = 5;
type DeleteAnswer = { ok: true; deleted: number } | { ok: false; error: string } | { ok: false; running: true };
type PollBody = { deleted?: unknown; error?: unknown };

async function runDelete(path: string, fileIds: number[], fallback: string, alive: () => boolean): Promise<DeleteAnswer | null> {
  const start = await arrApi<{ deleted?: number; job?: unknown }>(path, { method: "DELETE", body: { fileIds, async: true } }, fallback);
  if (!start.ok) return start;
  if (typeof start.data.job !== "string") return { ok: true, deleted: start.data.deleted ?? 0 };
  const pollUrl = withBasePath(`${path}&job=${encodeURIComponent(start.data.job)}`);
  let failed = 0;
  for (let i = 0; i < DELETE_MAX_POLLS; i++) {
    await new Promise((r) => window.setTimeout(r, DELETE_POLL_MS));
    if (!alive()) return null;
    let status = 0;
    let data: PollBody | null = null;
    try {
      const res = await fetch(pollUrl);
      status = res.status;
      data = (await res.json().catch(() => null)) as PollBody | null;
    } catch {
      // network: retried below
    }
    if (!alive()) return null;
    if (status === 202) {
      failed = 0;
      continue;
    }
    if (data === null || typeof data !== "object") {
      if (++failed >= DELETE_FAILED_POLLS) return { ok: false, running: true };
      continue;
    }
    if (status >= 200 && status < 300) return { ok: true, deleted: typeof data.deleted === "number" ? data.deleted : 0 };
    return { ok: false, error: typeof data.error === "string" ? data.error : fallback };
  }
  return { ok: false, running: true };
}

export function FilesTab({ titleRef, onChanged }: { titleRef: TitleRef; onChanged: () => void }) {
  const t = useT();
  const tRef = useTRef();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  // null until the first read answers; a failed FIRST read is not "no files".
  const [files, setFiles] = useState<TitleFile[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<"delete" | "preview" | "rename" | null>(null);
  const [renames, setRenames] = useState<RenamePreview[] | null>(null);
  const [renameSelected, setRenameSelected] = useState<ReadonlySet<number>>(new Set());
  // The RenameFiles command, followed live; the files are re-read once it ends.
  // Unmounting (the manager closing) stops it.
  const { watch, watches } = useArrCommandWatch();
  const isSeries = titleRef.service === "sonarr";
  // The inline delete confirm is an alertdialog: focus moves to its Cancel when
  // it opens, and back to Delete (n) when it closes unconfirmed (Cancel, or a
  // delete that failed and left the selection). Closed by a change of
  // selection, focus stays on the checkbox the admin just used.
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const refocusDelete = useRef(false);
  // A background delete's polling stops when the manager closes.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (confirmDelete) cancelDeleteRef.current?.focus();
    else if (refocusDelete.current) {
      refocusDelete.current = false;
      deleteRef.current?.focus();
    }
  }, [confirmDelete]);

  const load = useCallback(async () => {
    const res = await arrApi<{ files: TitleFile[] }>(`/api/admin/arr/title/files?${titleQuery(titleRef)}`, undefined, tRef.current("adminArr.files.loadFailed"));
    if (res.ok) {
      setFiles(res.data.files);
      setLoadFailed(false);
      setSelected((prev) => new Set([...prev].filter((id) => res.data.files.some((f) => f.id === id))));
      setError("");
    } else {
      // A failed re-read keeps the list it had.
      setError(res.error);
      setLoadFailed(true);
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

  function selectAll(on: boolean) {
    setSelected(on && files ? new Set(files.map((f) => f.id)) : new Set());
    setConfirmDelete(false);
  }

  async function remove() {
    setBusy("delete");
    setError("");
    // The ids go in the body: "select all" on a long-running series is more
    // than a query string holds.
    const res = await runDelete(`/api/admin/arr/title/files?${titleQuery(titleRef)}`, [...selected], t("adminArr.files.deleteFailed"), () => mounted.current);
    if (res === null) return;
    setBusy(null);
    // Set before the close renders: the button comes back with the selection.
    refocusDelete.current = !res.ok;
    setConfirmDelete(false);
    // A rename preview lists the files as they were — never offer it after a delete.
    setRenames(null);
    if (!res.ok) {
      setError("running" in res ? t("adminArr.files.deleteStillRunning") : res.error);
      // Some files may have gone before it failed: show what's left.
      await load();
      onChanged();
      return;
    }
    setNotice(t("adminArr.files.deleted", { count: res.deleted }));
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
    const res = await arrApi<{ files: number; commandIds?: number[] }>(
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
    setNotice("");
    const renaming = t("adminArr.files.renaming", { count: res.data.files });
    const ids = Array.isArray(res.data.commandIds) ? res.data.commandIds : [];
    // The arr renames in the background; read the new names once it says it
    // has. An arr that sent no command id leaves just the notice.
    if (ids.length > 0) watch("rename", titleRef, ids, { pendingText: renaming, onDone: () => void load() });
    else setNotice(renaming);
  }

  if (files === null) {
    return loadFailed ? (
      <p role="alert" className="m-0 flex flex-wrap items-center gap-2 py-8 text-sm" style={{ color: "var(--ds-danger)" }}>
        <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        <Button variant="ghost" size="sm" onClick={() => void load()}><RefreshCw /> {t("adminArr.common.retry")}</Button>
      </p>
    ) : (
      <div className="flex items-center gap-2 py-8 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>
    );
  }

  const allSelected = files.length > 0 && files.every((f) => selected.has(f.id));
  const chosen = files.filter((f) => selected.has(f.id));
  const chosenSize = chosen.reduce((n, f) => n + f.size, 0);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {files.length > 0 && (
          <label className="mr-1 flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => selectAll(e.target.checked)}
              className="accent-[var(--ds-accent)]"
            />
            {t("adminArr.files.selectAll")}
          </label>
        )}
        <Button ref={deleteRef} variant="outline" size="sm" disabled={selected.size === 0 || busy !== null} onClick={() => setConfirmDelete(true)}>
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
          <span className="min-w-0 flex-1 text-zinc-100">
            {t("adminArr.files.confirm", { count: selected.size })}
            <span className="block text-xs text-zinc-400">
              {t("adminArr.files.confirmSize", { size: fmt.size(chosenSize) })}
              {" · "}
              {chosen.slice(0, 4).map((f) => (isSeries && f.episodes.length > 0 ? episodeSummary(f.episodes) : f.relativePath)).join(", ")}
              {chosen.length > 4 && ` ${t("adminArr.files.andMore", { count: chosen.length - 4 })}`}
            </span>
          </span>
          <Button
            ref={cancelDeleteRef}
            variant="ghost"
            size="sm"
            onClick={() => {
              refocusDelete.current = true;
              setConfirmDelete(false);
            }}
            disabled={busy !== null}
          >
            {t("adminArr.common.cancel")}
          </Button>
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
      {watches.rename && <CommandWatchLine watch={watches.rename} />}

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
            <>
              {/* Every listed file starts ticked; a long show's preview lists thousands. */}
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={renames.every((r) => renameSelected.has(r.fileId))}
                  onChange={(e) => setRenameSelected(e.target.checked ? new Set(renames.map((r) => r.fileId)) : new Set())}
                  disabled={busy !== null}
                  className="accent-[var(--ds-accent)]"
                />
                {t("adminArr.files.selectAll")}
              </label>
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
            </>
          )}
        </div>
      )}

      {files.length === 0 ? (
        <p className="m-0 py-6 text-center text-sm text-zinc-500">{t("adminArr.files.none")}</p>
      ) : (
        <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
          {files.map((f, i) => {
            const media = mediaSummary(f.media, t);
            const details = mediaDetails(f.media, t, locale);
            const expanded = open.has(f.id);
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
                  {(details.length > 0 || f.path) && (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setOpen((prev) => {
                        const next = new Set(prev);
                        if (next.has(f.id)) next.delete(f.id);
                        else next.add(f.id);
                        return next;
                      })}
                      className="mt-1 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
                    >
                      {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} {t("adminArr.files.details")}
                    </button>
                  )}
                  {expanded && (
                    <dl className="m-0 mt-1 grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr]">
                      {details.map(([k, v]) => (
                        <div key={k} className="contents">
                          <dt className="text-zinc-500">{k}</dt>
                          <dd className="m-0 text-zinc-300">{v}</dd>
                        </div>
                      ))}
                      {f.path && (
                        <div className="contents">
                          <dt className="text-zinc-500">{t("adminArr.files.detail.path")}</dt>
                          <dd className="m-0 break-all text-zinc-300">{f.path}</dd>
                        </div>
                      )}
                    </dl>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
