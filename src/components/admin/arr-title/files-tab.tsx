"use client";

// The title manager's Files tab: every file Radarr/Sonarr has for the title —
// path, size, quality, languages, custom formats and media info — with the
// arr's own two file actions: delete (from disk, through the arr) and rename
// to its naming scheme (the arr's preview first, then RenameFiles for the
// files chosen). The server re-checks every id against the title's files
// (GET/DELETE /api/admin/arr/title/files, GET/POST …/rename). The delete runs
// as a background job (title-file-delete.ts); the rows, the confirm and the
// rename preview are in files-parts.tsx.
//
// "Instant, then live" (src/lib/arr-snapshot.ts): on open the list the server
// last read is painted while the live read is out. It only ever fills an EMPTY
// list, never while a delete or rename is in flight; the live answer replaces
// it and prunes the selection as every re-read does.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Check, FileText, Loader2, RefreshCw, Trash2 } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { queueFormatters } from "@/components/admin/queue-format";
import { CommandWatchLine, useArrCommandWatch } from "@/components/admin/arr-command-watch";
import { ArrSnapshotNote } from "@/components/admin/arr-snapshot-note";
import { useArrSnapshot } from "@/components/admin/use-arr-snapshot";
import type { RenamePreview, TitleFile } from "@/lib/arr-title";
import { withBasePath } from "@/lib/base-path";
import { FILES_ANSWER, RENAME_ANSWER, RENAME_PREVIEW_ANSWER, idsOf } from "@/lib/client/arr-answers";
import { runTitleFileDelete } from "@/lib/client/title-file-delete";
import { check } from "@/lib/validate";
import { useAsyncAction } from "@/hooks/use-async-action";
import { arrApi, titleQuery, useTRef, type TitleRef } from "./shared";
import { snapshotMayPaint } from "./snapshot-rules";
import { DeleteConfirm, FileRow, mediaDetails, mediaFormatters, mediaSummary, RenamePanel } from "./files-parts";

// The tab's writes, each its own action key; "load" is the read.
const WRITES = ["delete", "preview", "rename"] as const;
type Write = (typeof WRITES)[number];

export function FilesTab({ titleRef, onChanged }: { titleRef: TitleRef; onChanged: () => void }) {
  const t = useT();
  const tRef = useTRef();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const mediaFmt = useMemo(() => mediaFormatters(locale), [locale]);
  // null until the first read answers; a failed FIRST read is not "no files".
  const [files, setFiles] = useState<TitleFile[] | null>(null);
  // The list's last read failed ("" once one answers) — apart from a delete's
  // or a rename's refusal, which a re-read must not wipe.
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renames, setRenames] = useState<RenamePreview[] | null>(null);
  const [renameSelected, setRenameSelected] = useState<ReadonlySet<number>>(new Set());
  // The read ("load": only the newest lands — Reload, a delete's re-read and a
  // rename's can overlap, and an older answer arriving last would bring back
  // the list from before the change) and each write. The manager closing
  // aborts them all, a delete's polling included.
  const action = useAsyncAction();
  const busy: Write | null = WRITES.find((k) => action.busy(k)) ?? null;
  // Read live (not off a render): a snapshot answering mid-write sees it.
  const writing = () => WRITES.some((k) => action.busy(k));
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
  useEffect(() => {
    if (confirmDelete) cancelDeleteRef.current?.focus();
    else if (refocusDelete.current) {
      refocusDelete.current = false;
      deleteRef.current?.focus();
    }
  }, [confirmDelete]);

  // The live listing's URL — and its snapshot's (one builder: the server keys
  // on it). The delete names the same route and title.
  const readPath = useMemo(() => `/api/admin/arr/title/files?${titleQuery(titleRef)}`, [titleRef]);
  // A checked snapshot paints an EMPTY list only, never under a write; declined, nothing stale is on screen.
  const applySnapshot = (data: unknown) => {
    const parsed = check(FILES_ANSWER, data);
    if (!parsed.ok || !snapshotMayPaint(files !== null, writing())) return false;
    setFiles(parsed.value.files);
    return true;
  };
  const snap = useArrSnapshot<unknown>(withBasePath(readPath), applySnapshot);
  const markLive = snap.markLive;

  const load = useCallback(async () => {
    const res = await action.run("load", (signal) =>
      arrApi(readPath, { schema: FILES_ANSWER, signal }, tRef.current("adminArr.files.loadFailed")),
    );
    // Superseded by a newer read, or the manager closed.
    if (!res) return;
    if (res.ok) {
      const ids = new Set(res.data.files.map((f) => f.id));
      setFiles(res.data.files);
      setLoadError("");
      setSelected((prev) => new Set([...prev].filter((id) => ids.has(id))));
      markLive();
    } else {
      // A failed re-read keeps the list it had.
      setLoadError(res.error);
    }
  }, [action, readPath, tRef, markLive]);

  useEffect(() => {
    void load();
  }, [load]);

  // Each file's media lines, worked out once per list — not again on every
  // checkbox click (a long series lists thousands of files).
  const fileMedia = useMemo(
    () => new Map((files ?? []).map((f) => [f.id, { summary: mediaSummary(f.media, t), details: mediaDetails(f.media, t, mediaFmt) }])),
    [files, t, mediaFmt],
  );

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
    setActionError("");
    const res = await action.run(
      "delete",
      (signal) => runTitleFileDelete(withBasePath(readPath), [...selected], t("adminArr.files.deleteFailed"), { signal }),
      { ifBusy: "skip" },
    );
    // The manager closed: nothing left to show it on.
    if (!res) return;
    // Set before the close renders: the button comes back with the selection.
    refocusDelete.current = res.kind !== "deleted";
    setConfirmDelete(false);
    // A rename preview lists the files as they were — never offer it after a delete.
    setRenames(null);
    if (res.kind === "deleted") {
      setNotice(t("adminArr.files.deleted", { count: res.deleted }));
      setSelected(new Set());
    } else {
      // The tab's own line, apart from the list's: the re-read below keeps it.
      setActionError(res.kind === "running" ? t("adminArr.files.deleteStillRunning") : res.error);
    }
    // Some files may have gone before a failure too: show what's left.
    await load();
    onChanged();
  }

  async function preview() {
    setActionError("");
    setNotice("");
    const res = await action.run("preview", (signal) =>
      arrApi(`/api/admin/arr/title/rename?${titleQuery(titleRef)}`, { schema: RENAME_PREVIEW_ANSWER, signal }, t("adminArr.files.renameFailed")),
    );
    if (!res) return;
    if (!res.ok) {
      setActionError(res.error);
      return;
    }
    setRenames(res.data.files);
    setRenameSelected(new Set(res.data.files.map((r) => r.fileId)));
  }

  async function rename() {
    setActionError("");
    const res = await action.run(
      "rename",
      (signal) =>
        arrApi(
          "/api/admin/arr/title/rename",
          { method: "POST", body: { service: titleRef.service, instance: titleRef.instance, id: titleRef.arrId, fileIds: [...renameSelected] }, schema: RENAME_ANSWER, signal },
          t("adminArr.files.renameFailed"),
        ),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      setActionError(res.error);
      return;
    }
    setRenames(null);
    setNotice("");
    const renaming = t("adminArr.files.renaming", { count: res.data.files });
    const ids = idsOf(res.data.commandIds);
    // The arr renames in the background; read the new names once it says it
    // has. An arr that sent no command id leaves just the notice.
    if (ids.length > 0) watch("rename", titleRef, ids, { pendingText: renaming, onDone: () => void load() });
    else setNotice(renaming);
  }

  if (files === null) {
    return loadError ? (
      <p role="alert" className="m-0 flex flex-wrap items-center gap-2 py-8 text-sm" style={{ color: "var(--ds-danger)" }}>
        <AlertTriangle className="h-4 w-4 shrink-0" /> {loadError}
        <Button variant="ghost" size="sm" onClick={() => void load()}><RefreshCw /> {t("adminArr.common.retry")}</Button>
      </p>
    ) : (
      <div className="flex items-center gap-2 py-8 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>
    );
  }

  const allSelected = files.length > 0 && files.every((f) => selected.has(f.id));
  const error = actionError || loadError;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {files.length > 0 && (
          <label className="mr-1 flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => selectAll(e.target.checked)}
              disabled={busy !== null}
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
        {/* A Reload is what a still-running delete's line asks for: it clears that line. */}
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => { setActionError(""); void load(); }} className="ml-auto">
          <RefreshCw /> {t("adminArr.common.reload")}
        </Button>
      </div>
      <ArrSnapshotNote at={snap.staleAt} refreshing={action.busy("load")} />

      {confirmDelete && (
        <DeleteConfirm
          files={files.filter((f) => selected.has(f.id))}
          isSeries={isSeries}
          busy={busy !== null}
          deleting={busy === "delete"}
          cancelRef={cancelDeleteRef}
          onCancel={() => {
            refocusDelete.current = true;
            setConfirmDelete(false);
          }}
          onConfirm={() => void remove()}
          fmt={fmt}
        />
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
        <RenamePanel
          renames={renames}
          selected={renameSelected}
          onSelectedChange={setRenameSelected}
          busy={busy !== null}
          renaming={busy === "rename"}
          onCancel={() => setRenames(null)}
          onApply={() => void rename()}
        />
      )}

      {files.length === 0 ? (
        <p className="m-0 py-6 text-center text-sm text-zinc-500">{t("adminArr.files.none")}</p>
      ) : (
        <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
          {files.map((f, i) => {
            const { summary, details } = fileMedia.get(f.id) ?? { summary: "", details: [] };
            return (
              <FileRow
                key={f.id}
                file={f}
                first={i === 0}
                isSeries={isSeries}
                media={summary}
                details={details}
                expanded={open.has(f.id)}
                onToggleExpanded={() => setOpen((prev) => {
                  const next = new Set(prev);
                  if (next.has(f.id)) next.delete(f.id);
                  else next.add(f.id);
                  return next;
                })}
                selected={selected.has(f.id)}
                onSelect={() => toggle(f.id)}
                busy={busy !== null}
                fmt={fmt}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
