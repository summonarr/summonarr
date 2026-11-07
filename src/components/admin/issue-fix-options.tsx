"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DialogContent } from "@/components/ui/dialog";
import { Chip } from "@/components/ui/design";
import { Loader2, Check, RefreshCw, AlertTriangle, Trash2, Download, Search } from "@/components/icons";
import type { ReplaceableFile, ReplaceFollowUp } from "@/lib/issue-replace";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { episodeSummary, queueFormatters } from "@/components/admin/queue-format";
import { requestPageRefresh } from "@/lib/client/refresh-hold";
import { apiErrorText, readApiError } from "@/lib/client/api-error";
import { runReplaceFileJob } from "@/lib/client/replace-file-job";
import { defaultFileSelection, fixAdvice, type FixAdvice } from "@/lib/issue-fix";

/** The Fix file window's one write at a time: the delete, the search or the grab. */
export type FixFileAction = "replace" | "search" | "grab";

// GET /api/issues/[id]/files — the in-scope files on one instance.
interface FileListing {
  files: ReplaceableFile[];
  /** The title's files outside the issue's scope — not offered, only counted. */
  otherFiles: number;
  /** Sonarr's series type: "anime" numbers episodes its own way (the issue's numbers are the media server's). */
  seriesType: string | null;
}

// POST /api/issues/[id]/files — what happened (also carried by a 502 beside `error`).
interface ReplaceResult {
  deleted: number;
  requested: number;
  marked: number;
  unmarked: number;
  searched: boolean;
  redownload: boolean | null;
  /** Marks the arr's own redownload searches for. */
  redownloading: number;
  /** What the delete unmonitored and was monitored again. */
  remonitored: number;
  /** That re-monitor failed: the files were searched for by name, and may stay unmonitored. */
  remonitorFailed: boolean;
  nothingMissing: boolean;
}

const CONFIRM_NAMES = 5;

// Sonarr's own titles for a file's episodes — how the admin checks that the
// issue's numbering (the media server's) names the same episodes as Sonarr's.
const episodeTitles = (f: ReplaceableFile): string =>
  f.episodes.map((e) => e.title).filter((x): x is string => typeof x === "string" && x !== "").join(" · ");

const ADVICE_KEY: Record<FixAdvice, string> = {
  broken: "adminQueue.issueActions.adviceBroken",
  upgrade: "adminQueue.issueActions.adviceUpgrade",
  nothing: "adminQueue.issueActions.adviceNothing",
  unknown: "adminQueue.issueActions.adviceUnknown",
};

// The Fix file window's options view for ONE instance: what is on disk
// (ADMIN), the advice, the choices and the delete's confirm. The window mounts
// it with key={instance}, so an instance switch starts every piece of state
// here from its initial value and nothing is reset by hand. It stays mounted
// while the release list shows (rendering nothing), so Back finds the files,
// the selection and a result as they were: the files are read once per
// instance. The write in flight (`action`) and the delete's follow-up
// (`blockRelease`) are the window's, so the header can lock and a switch
// keeps the box as the admin left it.
export function FixFileOptions({
  issueId,
  mediaType,
  isAdmin,
  canPickRelease,
  instance,
  shown,
  action,
  onAction,
  blockRelease,
  onBlockReleaseChange,
  onPickRelease,
  onClose,
}: {
  issueId: string;
  mediaType: string;
  isAdmin: boolean;
  canPickRelease: boolean;
  /** The instance this view reads and writes; the window remounts the view for another. */
  instance: string;
  /** False while the release list shows. */
  shown: boolean;
  action: FixFileAction | null;
  onAction: (action: FixFileAction | null) => void;
  blockRelease: boolean;
  onBlockReleaseChange: (block: boolean) => void;
  onPickRelease: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const serviceName = mediaType === "MOVIE" ? "Radarr" : "Sonarr";
  const isSeries = mediaType !== "MOVIE";

  const [actionError, setActionError] = useState<string | null>(null);

  // What's on disk (ADMIN only).
  const [listing, setListing] = useState<FileListing | null>(null);
  const [listLoading, setListLoading] = useState(isAdmin);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ReplaceResult | null>(null);
  const [searched, setSearched] = useState(false);
  // Only the newest read may write state: an older answer (a re-run effect, a
  // Retry, the reload after a failed delete) must not land on a newer one.
  const reqRef = useRef(0);

  // The delete's polling stops once the window (or this instance's view) is gone.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const load = useCallback(async (target: string) => {
    const reqId = ++reqRef.current;
    setListLoading(true);
    setListError(null);
    try {
      const res = await fetch(withBasePath(`/api/issues/${issueId}/files?instance=${encodeURIComponent(target)}`));
      const data = (await res.json().catch(() => ({}))) as Partial<FileListing>;
      if (reqId !== reqRef.current) return;
      if (!res.ok || !Array.isArray(data.files)) {
        setListing(null);
        setListError(apiErrorText(data, t("adminQueue.issueActions.replaceFileLoadFailed")));
        return;
      }
      const files = data.files;
      setListing({
        files,
        otherFiles: typeof data.otherFiles === "number" ? data.otherFiles : 0,
        seriesType: typeof data.seriesType === "string" ? data.seriesType : null,
      });
      // Keep what is still listed; with nothing kept, tick the only file.
      setSelected((prev) => {
        const kept = [...prev].filter((id) => files.some((f) => f.id === id));
        return new Set(kept.length > 0 ? kept : defaultFileSelection(files));
      });
    } catch {
      if (reqId === reqRef.current) {
        setListing(null);
        setListError(t("shared.thread.networkError"));
      }
    } finally {
      if (reqId === reqRef.current) setListLoading(false);
    }
  }, [issueId, t]);

  // Read when this instance's view mounts — ADMIN only.
  useEffect(() => {
    if (isAdmin) void load(instance);
  }, [isAdmin, load, instance]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirming(false);
  }

  function pickRelease() {
    setActionError(null);
    onPickRelease();
  }

  async function searchNow() {
    onAction("search");
    setActionError(null);
    try {
      const res = await fetch(withBasePath(`/api/issues/${issueId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // The instance the window names — an issue about the 4K copy must
        // search the 4K instance, not the default. "" when there is one instance.
        body: JSON.stringify({ refetch: true, instance }),
      });
      // Check res.ok FIRST. The server reports two kinds of failure: a normal
      // error status (503, 401/403, 404, 400, 409, 413, 429) with no `arrError`
      // field, and a Radarr/Sonarr failure sent as HTTP 200 WITH `arrError`.
      // Looking only for `arrError` would report the first kind as sent.
      if (!res.ok) {
        setActionError(await readApiError(res, t("adminQueue.issueActions.searchFailed", { status: res.status })));
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { arrError?: string };
      if (data.arrError) {
        setActionError(data.arrError);
      } else {
        setSearched(true);
        // Once the window closes — the issue may leave this tab's list.
        requestPageRefresh(() => router.refresh());
      }
    } catch {
      setActionError(t("shared.thread.networkError"));
    } finally {
      onAction(null);
    }
  }

  async function replace(then: ReplaceFollowUp) {
    onAction("replace");
    setActionError(null);
    let reload = false;
    try {
      // A background job, polled (the guardrail-37a pattern): a long series'
      // marks outlast a reverse proxy's hold, and a 502 there read as a failed
      // replace while the files were already gone.
      const answer = await runReplaceFileJob(
        fetch,
        withBasePath(`/api/issues/${issueId}/files`),
        { instance, fileIds: [...selected], then },
        { isAlive: () => aliveRef.current },
      );
      if (answer === null) return;
      if (answer.status === 0) {
        // No answer (the polls failed or ran out): the replace may still be
        // running, and files may already be gone — never "try again" on a
        // destructive job. Show what's left.
        setActionError(t("adminQueue.issueActions.replaceFileNoAnswer"));
        reload = true;
      } else {
        const res = { ok: answer.status >= 200 && answer.status < 300 };
        const data = (answer.data && typeof answer.data === "object" ? answer.data : {}) as Partial<ReplaceResult>;
        // A 502 can still carry what WAS done (files deleted before the search
        // failed, or a delete that stopped part-way) — show it either way.
        if (typeof data.deleted === "number" && data.deleted > 0) {
          setResult({
            deleted: data.deleted,
            requested: data.requested ?? data.deleted,
            marked: data.marked ?? 0,
            unmarked: data.unmarked ?? 0,
            searched: data.searched === true,
            redownload: typeof data.redownload === "boolean" ? data.redownload : null,
            redownloading: typeof data.redownloading === "number" ? data.redownloading : 0,
            remonitored: typeof data.remonitored === "number" ? data.remonitored : 0,
            remonitorFailed: data.remonitorFailed === true,
            nothingMissing: data.nothingMissing === true,
          });
          setSelected(new Set());
          // Once the window closes — the issue may leave this tab's list.
          requestPageRefresh(() => router.refresh());
        }
        if (!res.ok) {
          setActionError(apiErrorText(data, t("adminQueue.issueActions.replaceFileFailed")));
          // Some files may be gone: show what's left.
          reload = true;
        }
      }
    } catch {
      // The POST itself failed on the network — it may have reached the
      // server first, so this is the same "no answer", not a network retry.
      setActionError(t("adminQueue.issueActions.replaceFileNoAnswer"));
      reload = true;
    } finally {
      onAction(null);
      setConfirming(false);
    }
    if (reload) {
      void load(instance);
    }
  }

  // Hidden behind the release list: the state above stays, nothing renders.
  if (!shown) return null;

  const files = listing?.files ?? [];
  const advice = fixAdvice(isAdmin && listing !== null ? files : null);
  const done = (result !== null && actionError === null) || searched;
  const working = action !== null;
  const chosen = files.filter((f) => selected.has(f.id));
  const chosenSize = chosen.reduce((n, f) => n + f.size, 0);
  const allSelected = files.length > 0 && files.every((f) => selected.has(f.id));
  const fileName = (f: ReplaceableFile) => {
    if (!isSeries || f.episodes.length === 0) return f.relativePath;
    const titles = episodeTitles(f);
    return `${episodeSummary(f.episodes)}${titles ? ` · ${titles}` : ""} · ${f.relativePath}`;
  };

  // The choices, best first for what is on disk. Delete needs listed files.
  const canDelete = isAdmin && files.length > 0;
  const order: Array<"delete" | "search" | "pick"> =
    advice === "broken" ? ["delete", "pick", "search"]
    : advice === "upgrade" ? ["search", "delete", "pick"]
    : ["search", "pick", "delete"];
  const choices = order.filter((c) => (c === "delete" ? canDelete : c === "pick" ? canPickRelease : true));
  const primary = choices[0];

  function choice(kind: "delete" | "search" | "pick") {
    const variant = kind === primary ? "default" : "outline";
    if (kind === "delete") {
      return (
        <div key="delete" className="grid gap-1.5 rounded-lg p-3" style={{ border: "1px solid var(--ds-border)" }}>
          <Button
            size="sm"
            variant={variant}
            onClick={() => setConfirming(true)}
            disabled={selected.size === 0 || working || listLoading}
            className="justify-self-start"
          >
            <Trash2 />
            {t("adminQueue.issueActions.choiceDelete")}
          </Button>
          <span className="text-xs text-zinc-400">
            {selected.size === 0
              ? t("adminQueue.issueActions.choiceDeleteSelect")
              : t("adminQueue.issueActions.choiceDeleteHint", { service: serviceName })}
          </span>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={blockRelease}
              onChange={(e) => { onBlockReleaseChange(e.target.checked); setConfirming(false); }}
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
        <div key="search" className="grid gap-1.5 rounded-lg p-3" style={{ border: "1px solid var(--ds-border)" }}>
          <Button size="sm" variant={variant} onClick={() => void searchNow()} disabled={working} className="justify-self-start">
            {action === "search" ? <Loader2 className="animate-spin" /> : <Search />}
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
      <div key="pick" className="grid gap-1.5 rounded-lg p-3" style={{ border: "1px solid var(--ds-border)" }}>
        <Button size="sm" variant={variant} onClick={pickRelease} disabled={working} className="justify-self-start">
          <Download />
          {t("adminQueue.issueActions.choicePick")}
        </Button>
        <span className="text-xs text-zinc-400">{t("adminQueue.issueActions.choicePickHint", { service: serviceName })}</span>
      </div>
    );
  }

  return (
    <>
      <DialogContent className="grid gap-4 p-4 sm:p-6">
        {/* Hidden once the delete went through: the list would show files no longer on disk. */}
        {isAdmin && !(result !== null && actionError === null) && (
          <section className="grid gap-2">
            <h3 className="m-0 text-xs font-medium text-zinc-400">{t("adminQueue.issueActions.onDisk")}</h3>
            {listLoading ? (
              <div className="flex items-center gap-3 py-4 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("adminQueue.issueActions.replaceFileLoading")}
              </div>
            ) : listError ? (
              <p role="alert" className="m-0 flex flex-wrap items-center gap-1.5 text-xs text-red-400">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{listError}</span>
                <Button variant="ghost" size="sm" onClick={() => void load(instance)} disabled={working}>
                  <RefreshCw /> {t("adminArr.common.retry")}
                </Button>
              </p>
            ) : listing === null ? null : files.length === 0 ? (
              <p className="m-0 text-sm text-zinc-500">{t("adminQueue.issueActions.nothingOnDisk")}</p>
            ) : (
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
                      onChange={(e) => { setSelected(e.target.checked ? new Set(files.map((f) => f.id)) : new Set()); setConfirming(false); }}
                      disabled={working}
                      className="accent-[var(--ds-accent)]"
                    />
                    {t("adminArr.files.selectAll")}
                  </label>
                )}
                <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
                  {files.map((f, i) => (
                    <li key={f.id} className="flex items-start gap-3 px-3 py-2.5" style={i > 0 ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
                      {!done && (
                        <input
                          type="checkbox"
                          checked={selected.has(f.id)}
                          onChange={() => toggle(f.id)}
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
                          <span>{fmt.size(f.size)}</span>
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
                  ))}
                </ul>
                {listing.otherFiles > 0 && (
                  <p className="m-0 text-xs text-zinc-500">{t("adminQueue.issueActions.replaceFileOther", { count: listing.otherFiles })}</p>
                )}
              </>
            )}
          </section>
        )}

        {!done && !listLoading && (
          <p className="m-0 text-sm text-zinc-300">
            {isAdmin
              ? t(ADVICE_KEY[advice], { service: serviceName })
              : t("adminQueue.issueActions.adviceIssueAdmin", { service: serviceName })}
          </p>
        )}

        {result && (
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
        )}

        {searched && (
          <span className="flex items-center gap-1.5 text-sm text-green-400">
            <Check className="h-4 w-4 shrink-0" />
            {t("adminQueue.issueActions.searchSent", { service: serviceName })}
          </span>
        )}

        {actionError && (
          <p role="alert" className="m-0 flex items-start gap-1.5 text-xs text-red-400">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{actionError}</span>
          </p>
        )}

        {!done && !confirming && !listLoading && (
          <div className="grid gap-2">{choices.map(choice)}</div>
        )}
      </DialogContent>

      {confirming && chosen.length > 0 && !done && (
        // The confirm takes the footer's place, so it can never be scrolled
        // out of view below a long file list.
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
              {chosen.slice(0, CONFIRM_NAMES).map((f) => (
                <li key={f.id} className="break-all">{fileName(f)}</li>
              ))}
              {chosen.length > CONFIRM_NAMES && (
                <li className="text-zinc-400">{t("adminArr.files.andMore", { count: chosen.length - CONFIRM_NAMES })}</li>
              )}
            </ul>
            <span className="text-xs text-zinc-400">
              {t("adminQueue.issueActions.replaceFileConfirmSize", { size: fmt.size(chosenSize) })}
              {" · "}
              {blockRelease
                ? t("adminQueue.issueActions.replaceFileConfirmBlocklist", { service: serviceName })
                : t("adminQueue.issueActions.replaceFileConfirmSearch", { service: serviceName })}
            </span>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={working}>
                {t("shared.common.cancel")}
              </Button>
              <Button
                size="sm"
                className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]"
                onClick={() => void replace(blockRelease ? "markFailed" : "search")}
                disabled={working}
              >
                {action === "replace" ? <Loader2 className="animate-spin" /> : <Trash2 />}
                {t("adminQueue.issueActions.replaceFileConfirmButton")}
              </Button>
            </div>
          </div>
        </div>
      )}
      {done && (
        <div className="flex justify-end px-4 py-4 sm:px-6 border-t border-zinc-700 bg-zinc-900 flex-shrink-0">
          <Button size="sm" onClick={onClose}>{t("adminQueue.common.close")}</Button>
        </div>
      )}
    </>
  );
}
