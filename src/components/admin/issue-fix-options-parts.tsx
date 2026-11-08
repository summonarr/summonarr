"use client";

// The Fix file window's options view, drawn (issue-fix-options.tsx holds its
// state and its requests): what is on disk, the choices, what a delete did,
// and the delete's confirm. Each renders what it is handed.

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/design";
import { Loader2, Check, RefreshCw, AlertTriangle, Trash2, Download, Search } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { episodeSummary } from "@/components/admin/queue-format";
import type { FileListing, ListedFile, ReplaceResult } from "./issue-fix-answers";

const BORDER = { border: "1px solid var(--ds-border)" } as const;
const CONFIRM_NAMES = 5;

// Sonarr's own titles for a file's episodes — how the admin checks that the
// issue's numbering (the media server's) names the same episodes as Sonarr's.
export const episodeTitles = (f: ListedFile): string =>
  f.episodes.map((e) => e.title).filter((x): x is string => typeof x === "string" && x !== "").join(" · ");

/** A file's line in the confirm: its episodes and Sonarr's titles first for a series. */
export function confirmFileName(f: ListedFile, isSeries: boolean): string {
  if (!isSeries || f.episodes.length === 0) return f.relativePath;
  const titles = episodeTitles(f);
  return `${episodeSummary(f.episodes)}${titles ? ` · ${titles}` : ""} · ${f.relativePath}`;
}

function ListedFileRow({
  file: f,
  first,
  isSeries,
  done,
  checked,
  working,
  onToggle,
  formatSize,
}: {
  file: ListedFile;
  first: boolean;
  isSeries: boolean;
  done: boolean;
  checked: boolean;
  working: boolean;
  onToggle: (id: number) => void;
  formatSize: (n: number) => string;
}) {
  const t = useT();
  return (
    <li className="flex items-start gap-3 px-3 py-2.5" style={first ? undefined : { borderTop: "1px solid var(--ds-border)" }}>
      {!done && (
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(f.id)}
          disabled={working}
          className="mt-1 accent-[var(--ds-accent)]"
          aria-label={t("adminQueue.issueActions.replaceFileSelectAria", { name: f.relativePath })}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {isSeries && f.episodes.length > 0 && <span className="ds-mono text-xs text-zinc-500">{episodeSummary(f.episodes)}</span>}
          <span className="min-w-0 break-all text-sm text-zinc-100" title={f.path ?? undefined}>{f.relativePath}</span>
        </div>
        {isSeries && episodeTitles(f) !== "" && (
          <div className="mt-0.5 break-words text-xs text-zinc-400">{episodeTitles(f)}</div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          {f.quality && <Chip tone={f.qualityCutoffNotMet ? "pending" : "accent"}>{f.quality}</Chip>}
          <Chip tone={f.qualityCutoffNotMet ? "pending" : "approved"}>
            {f.qualityCutoffNotMet ? t("adminArr.files.cutoffUnmet") : t("adminQueue.issueActions.cutoffMet")}
          </Chip>
          <span>{formatSize(f.size)}</span>
          {f.languages.length > 0 && <span>{f.languages.join(", ")}</span>}
          {f.releaseGroup && <span>{f.releaseGroup}</span>}
        </div>
        {f.grab === null ? (
          <div className="mt-1 text-xs text-amber-400">{t("adminQueue.issueActions.replaceFileGrabUnknown")}</div>
        ) : f.grab.failed ? (
          <div className="mt-1 text-xs text-amber-400">{t("adminQueue.issueActions.replaceFileGrabFailed")}</div>
        ) : (
          <div className="mt-1 break-all text-xs text-zinc-500" title={f.grab.event.sourceTitle}>
            {t("adminQueue.issueActions.replaceFileGrab", { release: f.grab.event.sourceTitle })}
          </div>
        )}
      </div>
    </li>
  );
}

// "On disk": the read's spinner, its error (with Retry), nothing, or the files
// with their checkboxes.
export function OnDiskSection({
  listLoading,
  listError,
  listing,
  isSeries,
  serviceName,
  done,
  selected,
  working,
  onRetry,
  onSelectAll,
  onToggle,
  formatSize,
}: {
  listLoading: boolean;
  listError: string | null;
  listing: FileListing | null;
  isSeries: boolean;
  serviceName: string;
  done: boolean;
  selected: ReadonlySet<number>;
  working: boolean;
  onRetry: () => void;
  onSelectAll: (all: boolean) => void;
  onToggle: (id: number) => void;
  formatSize: (n: number) => string;
}) {
  const t = useT();
  const files = listing?.files ?? [];
  const allSelected = files.length > 0 && files.every((f) => selected.has(f.id));
  let body: React.ReactNode = null;
  if (listLoading) {
    body = (
      <div className="flex items-center gap-3 py-4 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("adminQueue.issueActions.replaceFileLoading")}
      </div>
    );
  } else if (listError) {
    body = (
      <p role="alert" className="m-0 flex flex-wrap items-center gap-1.5 text-xs text-red-400">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{listError}</span>
        <Button variant="ghost" size="sm" onClick={onRetry} disabled={working}>
          <RefreshCw /> {t("adminArr.common.retry")}
        </Button>
      </p>
    );
  } else if (listing !== null && files.length === 0) {
    body = <p className="m-0 text-sm text-zinc-500">{t("adminQueue.issueActions.nothingOnDisk")}</p>;
  } else if (listing !== null) {
    body = (
      <>
        {isSeries && listing.seriesType === "anime" && (
          <p className="m-0 flex items-start gap-1.5 text-xs text-amber-400">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            {t("adminQueue.issueActions.replaceFileAnimeNumbering", { service: serviceName })}
          </p>
        )}
        {files.length > 1 && !done && (
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => onSelectAll(e.target.checked)}
              disabled={working}
              className="accent-[var(--ds-accent)]"
            />
            {t("adminArr.files.selectAll")}
          </label>
        )}
        <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={BORDER}>
          {files.map((f, i) => (
            <ListedFileRow
              key={f.id}
              file={f}
              first={i === 0}
              isSeries={isSeries}
              done={done}
              checked={selected.has(f.id)}
              working={working}
              onToggle={onToggle}
              formatSize={formatSize}
            />
          ))}
        </ul>
        {listing.otherFiles > 0 && (
          <p className="m-0 text-xs text-zinc-500">{t("adminQueue.issueActions.replaceFileOther", { count: listing.otherFiles })}</p>
        )}
      </>
    );
  }
  return (
    <section className="grid gap-2">
      <h3 className="m-0 text-xs font-medium text-zinc-400">{t("adminQueue.issueActions.onDisk")}</h3>
      {body}
    </section>
  );
}

export type FixChoiceKind = "delete" | "search" | "pick";

// The choices, best first. The first is the primary button.
export function FixChoices({
  choices,
  advice,
  serviceName,
  selectedCount,
  working,
  listLoading,
  searching,
  blockRelease,
  deleteRef,
  onDelete,
  onBlockReleaseChange,
  onSearch,
  onPick,
}: {
  choices: FixChoiceKind[];
  advice: string;
  serviceName: string;
  selectedCount: number;
  working: boolean;
  listLoading: boolean;
  searching: boolean;
  blockRelease: boolean;
  /** The delete button: focus comes back to it when its confirm is cancelled. */
  deleteRef: React.RefObject<HTMLButtonElement | null>;
  onDelete: () => void;
  onBlockReleaseChange: (block: boolean) => void;
  onSearch: () => void;
  onPick: () => void;
}) {
  const t = useT();
  const primary = choices[0];
  return (
    <div className="grid gap-2">
      {choices.map((kind) => {
        const variant = kind === primary ? "default" : "outline";
        if (kind === "delete") {
          return (
            <div key="delete" className="grid gap-1.5 rounded-lg p-3" style={BORDER}>
              <Button
                ref={deleteRef}
                size="sm"
                variant={variant}
                onClick={onDelete}
                disabled={selectedCount === 0 || working || listLoading}
                className="justify-self-start"
              >
                <Trash2 />
                {t("adminQueue.issueActions.choiceDelete")}
              </Button>
              <span className="text-xs text-zinc-400">
                {selectedCount === 0
                  ? t("adminQueue.issueActions.choiceDeleteSelect")
                  : t("adminQueue.issueActions.choiceDeleteHint", { service: serviceName })}
              </span>
              <label className="flex items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={blockRelease}
                  onChange={(e) => onBlockReleaseChange(e.target.checked)}
                  disabled={working}
                  className="accent-[var(--ds-accent)]"
                />
                {t("adminQueue.issueActions.blockRelease")}
              </label>
            </div>
          );
        }
        if (kind === "search") {
          return (
            <div key="search" className="grid gap-1.5 rounded-lg p-3" style={BORDER}>
              <Button size="sm" variant={variant} onClick={onSearch} disabled={working} className="justify-self-start">
                {searching ? <Loader2 className="animate-spin" /> : <Search />}
                {t("adminQueue.issueActions.choiceSearch")}
              </Button>
              <span className={`text-xs ${advice === "broken" ? "text-amber-400" : "text-zinc-400"}`}>
                {advice === "broken"
                  ? t("adminQueue.issueActions.choiceSearchAtCutoff")
                  : t("adminQueue.issueActions.choiceSearchHint", { service: serviceName })}
              </span>
            </div>
          );
        }
        return (
          <div key="pick" className="grid gap-1.5 rounded-lg p-3" style={BORDER}>
            <Button size="sm" variant={variant} onClick={onPick} disabled={working} className="justify-self-start">
              <Download />
              {t("adminQueue.issueActions.choicePick")}
            </Button>
            <span className="text-xs text-zinc-400">{t("adminQueue.issueActions.choicePickHint", { service: serviceName })}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ReplaceResultSummary({ result, serviceName }: { result: ReplaceResult; serviceName: string }) {
  const t = useT();
  return (
    <div className="grid gap-1 text-xs">
      <span className="flex items-center gap-1.5 text-green-400">
        <Check className="h-3.5 w-3.5 shrink-0" />
        {t("adminQueue.issueActions.replaceFileDeleted", { count: result.deleted })}
        {result.marked > 0 && ` · ${t("adminQueue.issueActions.replaceFileMarked", { count: result.marked })}`}
      </span>
      {result.remonitored > 0 && (
        <span className="pl-5 text-zinc-400">{t("adminQueue.issueActions.replaceFileRemonitored", { service: serviceName })}</span>
      )}
      {result.remonitorFailed && (
        <span className="pl-5 text-amber-400">{t("adminQueue.issueActions.replaceFileRemonitorFailed", { service: serviceName })}</span>
      )}
      {result.redownloading > 0 && (
        <span className="pl-5 text-zinc-400">{t("adminQueue.issueActions.replaceFileRedownload", { service: serviceName })}</span>
      )}
      {result.searched && (
        <span className="pl-5 text-zinc-400">{t("adminQueue.issueActions.replaceFileSearched")}</span>
      )}
      {result.unmarked > 0 && (
        <span className="pl-5 text-amber-400">{t("adminQueue.issueActions.replaceFileUnmarked", { count: result.unmarked })}</span>
      )}
      {result.nothingMissing && (
        <span className="pl-5 text-amber-400">{t("adminQueue.issueActions.replaceFileNothingMissing", { service: serviceName })}</span>
      )}
    </div>
  );
}

// The delete's confirm, in the footer's place so it can never be scrolled out
// of view below a long file list. It takes focus as it opens (on Cancel, the
// safe choice beside an irreversible delete), so a keyboard or screen-reader
// user lands in it rather than on the choice buttons it replaced.
export function ReplaceConfirm({
  names,
  more,
  size,
  blockRelease,
  serviceName,
  working,
  replacing,
  onCancel,
  onConfirm,
}: {
  names: { id: number; name: string }[];
  more: number;
  size: string;
  blockRelease: boolean;
  serviceName: string;
  working: boolean;
  replacing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div className="grid px-4 py-4 sm:px-6 border-t border-zinc-700 bg-zinc-900 flex-shrink-0">
      <div
        role="alertdialog"
        aria-label={t("adminQueue.issueActions.replaceFileConfirmTitle")}
        className="grid gap-2 rounded-lg px-3 py-2.5 text-sm"
        style={{ background: "color-mix(in oklab, var(--ds-danger) 12%, transparent)", border: "1px solid var(--ds-danger)" }}
      >
        <span className="flex items-center gap-2 font-medium text-zinc-100">
          <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: "var(--ds-danger)" }} />
          {t("adminQueue.issueActions.replaceFileConfirmTitle")}
        </span>
        <ul className="m-0 grid list-none gap-0.5 p-0 text-xs text-zinc-100">
          {names.map((f) => (
            <li key={f.id} className="break-all">{f.name}</li>
          ))}
          {more > 0 && (
            <li className="text-zinc-400">{t("adminArr.files.andMore", { count: more })}</li>
          )}
        </ul>
        <span className="text-xs text-zinc-400">
          {t("adminQueue.issueActions.replaceFileConfirmSize", { size })}
          {" · "}
          {blockRelease
            ? t("adminQueue.issueActions.replaceFileConfirmBlocklist", { service: serviceName })
            : t("adminQueue.issueActions.replaceFileConfirmSearch", { service: serviceName })}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" size="sm" onClick={onCancel} disabled={working}>
            {t("shared.common.cancel")}
          </Button>
          <Button
            size="sm"
            className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]"
            onClick={onConfirm}
            disabled={working}
          >
            {replacing ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {t("adminQueue.issueActions.replaceFileConfirmButton")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export { CONFIRM_NAMES };
