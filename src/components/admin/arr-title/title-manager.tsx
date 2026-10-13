"use client";

// The admin title manager: one movie or series on one Radarr/Sonarr instance,
// managed without opening the arr — its settings, its seasons and episodes
// (Sonarr), its files, its history, and searching it (automatic, or a release
// picked by hand), and taking it off the instance. Opened from the detail
// pages' "Manage in Radarr/Sonarr" (ArrManageButton, by TMDB id — resolved on
// the instance) and from every admin list that names a Radarr/Sonarr title
// (ManageTitleButton, by the arr's own id). Everything is live and ADMIN-only
// on the server.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip, FilterBar } from "@/components/ui/design";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Check, Download, Loader2, RefreshCw, Search, Wrench, X } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { OpenInArrLink } from "@/components/admin/open-in-arr";
import { CommandWatchLine, useArrCommandWatch } from "@/components/admin/arr-command-watch";
import { ArrSnapshotNote } from "@/components/admin/arr-snapshot-note";
import { useArrSnapshot } from "@/components/admin/use-arr-snapshot";
import { ReleaseSearchDialog, type TitleReleaseTarget } from "@/components/admin/release-search-dialog";
import { queueFormatters } from "@/components/admin/queue-format";
import type { ArrTitle, Choice, RootFolderChoice } from "@/lib/arr-title";
import { closeVerdict } from "@/lib/arr-title-ui";
import { withBasePath } from "@/lib/base-path";
import { SettingsTab } from "./settings-tab";
import { SeasonsTab, type ReleaseScope } from "./seasons-tab";
import { FilesTab } from "./files-tab";
import { HistoryTab } from "./history-tab";
import { RemovePanel } from "./remove-panel";
import { arrApi, useTRef, type ArrServiceName, type TitleRef } from "./shared";
import { liveTitleLanding, snapshotMayPaint, titleReadPath, titleTargetKey, titleTargetOfKey } from "./snapshot-rules";

interface TitleState {
  title: ArrTitle;
  qualityProfiles: Choice[] | null;
  rootFolders: RootFolderChoice[] | null;
  tags: Choice[] | null;
}

export type TitleManagerTab = "settings" | "seasons" | "files" | "history";
type Tab = TitleManagerTab;

/** Which title: by TMDB id (resolved on the instance) or by the arr's own id. */
export type TitleManagerTarget = { tmdbId: number } | { arrId: number };

// The arr's own status word, translated (a literal map — never a built key);
// an unknown word shows as the arr sent it.
const TITLE_STATUS_KEYS: Record<string, string> = {
  tba: "adminArr.titleStatus.tba",
  announced: "adminArr.availability.announced",
  inCinemas: "adminArr.status.inCinemas",
  released: "adminArr.availability.released",
  deleted: "adminArr.titleStatus.deleted",
  continuing: "adminArr.titleStatus.continuing",
  ended: "adminArr.titleStatus.ended",
  upcoming: "adminArr.status.upcoming",
};

/**
 * A re-read title that lost its root folder (an arr version that omits
 * rootFolderPath, read without the root-folder list to infer it from) keeps
 * the one the manager already knew.
 */
function mergeTitle(prev: ArrTitle, next: ArrTitle): ArrTitle {
  return next.rootFolderPath === null && prev.rootFolderPath !== null ? { ...next, rootFolderPath: prev.rootFolderPath } : next;
}

export function ArrTitleManager({
  open,
  onOpenChange,
  service,
  instance,
  target,
  instanceLabel,
  initialTab,
  onRemoved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: ArrServiceName;
  instance: string;
  target: TitleManagerTarget;
  instanceLabel: string;
  /** The tab to open on (a deep link names one); Seasons only for Sonarr. */
  initialTab?: TitleManagerTab;
  /** The title was taken off the instance — a list showing it may re-read. */
  onRemoved?: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [state, setState] = useState<TitleState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("settings");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  // Search missing that Sonarr refused part-way (202 `partial: true`): what it
  // did queue is followed as usual; this says the rest never started.
  const [partialNote, setPartialNote] = useState("");
  const [error, setError] = useState("");
  // Bumped by the OPEN-time read only: a background re-read (after a refresh or
  // a file delete) must not reset settings the admin is still editing.
  const [version, setVersion] = useState(0);
  const [release, setRelease] = useState<{ target: TitleReleaseTarget; subtitle?: string } | null>(null);
  // Tabs stay mounted once opened (hidden, not unmounted), so switching tabs
  // never throws away an unsaved Settings edit or reloads a list.
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(new Set(["settings"]));
  const [settingsDirty, setSettingsDirty] = useState(false);
  // A Settings save whose PATCH is in flight: nothing it sent can be discarded.
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [removed, setRemoved] = useState(false);
  const loadSeq = useRef(0);
  // Reads still waiting for their answer (dropped ones included): a write that
  // answers meanwhile reads the title once more (supersedeReads).
  const loadsInFlight = useRef(0);
  // The title's commands, followed live (GET /api/admin/arr/commands) under
  // their button's key; the notice line shows the newest one.
  const { watch, stop: stopWatches, watches } = useArrCommandWatch();
  const [watchKey, setWatchKey] = useState<string | null>(null);
  const tRef = useTRef();
  // This open's title came from the snapshot (src/lib/arr-snapshot.ts): the
  // open-time live answer rebases the form instead of replacing it — the admin
  // may already be editing over what was painted.
  const snapshotPainted = useRef(false);

  // Effects key on the target's VALUE: a parent re-render hands a new object.
  const targetKey = titleTargetKey(target);
  // "Instant, then live": the open-time read's snapshot is painted while the
  // live read is out. Its URL is the open-time live read's own (one builder).
  // It only ever fills an EMPTY dialog — never over a live answer or a write's.
  const openPath = open ? titleReadPath(service, instance, titleTargetOfKey(targetKey)) : null;
  const applyTitleSnapshot = useCallback((data: TitleState) => {
    if (!data?.title) return false;
    snapshotPainted.current = true;
    setState((prev) => (snapshotMayPaint(prev !== null, false) ? data : prev));
  }, []);
  const snap = useArrSnapshot<TitleState>(openPath === null ? null : withBasePath(openPath), applyTitleSnapshot);
  // Through a ref: the reads answer after the commit that opened this url.
  const markTitleLive = useRef(snap.markLive);
  useEffect(() => {
    markTitleLive.current = snap.markLive;
  });

  // `initial` is the open-time read: it replaces the state and remounts the
  // Settings form; a later re-read merges and leaves the admin's edits alone.
  // So does the open-time read when a snapshot was painted first.
  const load = useCallback(async (by: TitleManagerTarget, initial = false) => {
    const seq = ++loadSeq.current;
    const fallback = tRef.current("adminArr.manage.loadFailed");
    // arrApi never throws: a failure is its answer.
    loadsInFlight.current++;
    const res = await arrApi<TitleState>(titleReadPath(service, instance, by), undefined, fallback);
    loadsInFlight.current--;
    if (seq !== loadSeq.current) return;
    if (res.ok) {
      const landing = liveTitleLanding(initial, snapshotPainted.current);
      setState((prev) => (prev && landing === "rebase" ? { ...res.data, title: mergeTitle(prev.title, res.data.title) } : res.data));
      if (landing === "replace") setVersion((v) => v + 1);
      setLoadError("");
      markTitleLive.current();
    } else {
      setLoadError(res.error);
    }
  }, [service, instance, tRef]);

  const firstTab: Tab = initialTab === "seasons" && service !== "sonarr" ? "settings" : initialTab ?? "settings";
  // The tab is chosen at OPEN time only. A host re-rendering with another
  // initialTab (the request list's follows the row's live status) must not
  // re-run the open-time reset below — it would throw away unsaved Settings
  // edits without asking. Declared before that effect, so it is current when
  // the dialog opens in the same commit.
  const firstTabRef = useRef(firstTab);
  useEffect(() => {
    firstTabRef.current = firstTab;
  });

  useEffect(() => {
    if (!open) return;
    const openTab = firstTabRef.current;
    setState(null);
    setLoadError("");
    setNotice("");
    setError("");
    setTab(openTab);
    setVisited(new Set(["settings", openTab]));
    setSettingsDirty(false);
    setSettingsSaving(false);
    setConfirmDiscard(false);
    setRemoved(false);
    setWatchKey(null);
    snapshotPainted.current = false;
    void load(titleTargetOfKey(targetKey), true);
    // Closing invalidates a read still in flight, and stops following every
    // command — no status read and no re-read after close.
    const counter = loadSeq;
    return () => {
      counter.current++;
      stopWatches();
    };
  }, [open, targetKey, load, stopWatches]);

  // The banner asks about edits that would be lost: once there are none (saved,
  // reset), it goes — or it would keep offering Discard, and the next close of
  // a fresh edit would skip the question (closeVerdict reads it as answered).
  const onDirtyChange = useCallback((dirty: boolean) => {
    setSettingsDirty(dirty);
    if (!dirty) setConfirmDiscard(false);
  }, []);

  function selectTab(next: Tab) {
    setTab(next);
    setVisited((v) => (v.has(next) ? v : new Set([...v, next])));
  }

  // Closing with unsaved Settings edits asks first — the edits would be lost;
  // closing during a save waits for it (closeVerdict). True when it closed.
  function leave(): boolean {
    const verdict = closeVerdict({ removed, saving: settingsSaving, dirty: settingsDirty, confirming: confirmDiscard });
    if (verdict === "close") {
      onOpenChange(false);
      return true;
    }
    // The Settings tab shows why: the banner, or the save's spinner.
    if (verdict === "confirm") setConfirmDiscard(true);
    selectTab("settings");
    return false;
  }
  function requestClose(nextOpen: boolean) {
    if (nextOpen) return onOpenChange(true);
    leave();
  }

  // Stable per title: the tabs key their reads on it.
  const arrId = state?.title.arrId ?? null;
  const ref = useMemo<TitleRef | null>(() => (arrId === null ? null : { service, instance, arrId }), [service, instance, arrId]);
  const reload = useCallback(() => {
    if (arrId !== null) void load({ arrId });
  }, [arrId, load]);

  // A write's answer (a Settings save, a season/episode flip) carries the title
  // as the arr holds it AFTER the write. A read still in flight may have been
  // answered before it, so it is dropped (loadSeq) rather than merged over the
  // write. True when one was: it may also have carried what the write's answer
  // can't (a refresh's re-read, the choice lists), so the caller reads again
  // once the write's title is in.
  function supersedeReads(): boolean {
    const overlapped = loadsInFlight.current > 0;
    loadSeq.current++;
    return overlapped;
  }

  // Queue one title command and follow it: `done` (the "started" notice) shows
  // until the arr's first status, then its own progress and how it ended.
  // Searches share one key (a newer search replaces the line); a refresh has
  // its own, so its re-read still happens when a search starts meanwhile.
  const runCommand = useCallback(async (
    body: Record<string, unknown>,
    done: string,
    opts: { key?: string; onDone?: () => void } = {},
  ) => {
    if (!state) return;
    setNotice("");
    setPartialNote("");
    setError("");
    const res = await arrApi<{ commands: number; commandIds?: number[]; partial?: boolean }>(
      "/api/admin/arr/title/command",
      { method: "POST", body: { service, instance, id: state.title.arrId, ...body } },
      t("adminArr.manage.commandFailed"),
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (res.data.partial === true) setPartialNote(t("adminArr.notice.searchMissingPartial"));
    const key = opts.key ?? "search";
    const ids = Array.isArray(res.data.commandIds) ? res.data.commandIds : [];
    if (ids.length === 0) {
      // An arr that answered without an id: nothing to follow.
      setNotice(done);
      setWatchKey(null);
      return;
    }
    watch(key, { service, instance }, ids, { pendingText: done, onDone: opts.onDone });
    setWatchKey(key);
  }, [state, service, instance, t, watch]);

  async function topCommand(key: string, body: Record<string, unknown>, done: string, reread = false) {
    setBusy(key);
    // A refresh re-reads metadata and rescans the disk in the background: the
    // title is re-read once the arr reports it ended.
    await runCommand(body, done, { key, onDone: reread ? reload : undefined });
    setBusy(null);
  }

  function pickRelease(scope: ReleaseScope | null, subtitle?: string) {
    if (!state) return;
    setRelease({ target: { service, instance, arrId: state.title.arrId, scope }, subtitle });
  }

  const title = state?.title;
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const isSeries = service === "sonarr";
  const tabs: Array<{ value: Tab; label: string }> = [
    { value: "settings", label: t("adminArr.manage.tab.settings") },
    ...(isSeries ? [{ value: "seasons" as const, label: t("adminArr.manage.tab.seasons") }] : []),
    { value: "files", label: t("adminArr.manage.tab.files") },
    { value: "history", label: t("adminArr.manage.tab.history") },
  ];

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="max-w-4xl">
          <div className="flex flex-shrink-0 items-start justify-between gap-3 border-b border-zinc-700 px-6 py-4">
            <div className="min-w-0">
              <DialogTitle className="truncate text-base font-semibold text-zinc-100">
                {title ? `${title.title}${title.year ? ` (${title.year})` : ""}` : t("adminArr.manage.title", { name: instanceLabel })}
              </DialogTitle>
              {title && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                  <Chip>{instanceLabel}</Chip>
                  <Chip tone={title.monitored ? "accent" : "neutral"}>{title.monitored ? t("adminArr.status.monitored") : t("adminArr.status.unmonitored")}</Chip>
                  {isSeries ? (
                    <Chip tone={title.episodeCount > 0 && title.episodeFileCount >= title.episodeCount ? "approved" : "pending"}>
                      {t("adminArr.seasons.files", { have: title.episodeFileCount, count: title.episodeCount })}
                    </Chip>
                  ) : (
                    <Chip tone={title.hasFile ? "approved" : "declined"}>{title.hasFile ? t("adminArr.status.downloaded") : t("adminArr.status.missing")}</Chip>
                  )}
                  {title.status && <span>{TITLE_STATUS_KEYS[title.status] ? t(TITLE_STATUS_KEYS[title.status]) : title.status}</span>}
                  {title.sizeOnDisk > 0 && <span>{fmt.size(title.sizeOnDisk)}</span>}
                  {title.network && <span>{title.network}</span>}
                  {title.studio && <span>{title.studio}</span>}
                </div>
              )}
            </div>
            <DialogClose aria-label={t("adminArr.common.close")} title={t("adminArr.common.close")} className="text-zinc-500 transition-colors hover:text-zinc-300">
              <X className="h-5 w-5" />
            </DialogClose>
          </div>

          {removed ? (
            <p role="status" className="m-0 flex items-center justify-center gap-2 px-6 py-16 text-center text-sm text-green-400">
              <Check className="h-4 w-4 shrink-0" /> {t("adminArr.remove.done", { name: instanceLabel })}
            </p>
          ) : !state ? (
            loadError ? (
              <div role="alert" className="flex items-center justify-center gap-2 px-6 py-16 text-center text-sm" style={{ color: "var(--ds-danger)" }}>
                <AlertTriangle className="h-4 w-4 shrink-0" /> {loadError}
              </div>
            ) : (
              <div className="flex items-center justify-center gap-3 py-16 text-sm text-zinc-500">
                <Loader2 className="h-5 w-5 animate-spin" /> {t("adminArr.common.loading")}
              </div>
            )
          ) : (
            <DialogContent className="grid content-start gap-4">
              <div className="flex flex-wrap items-center gap-2">
                {isSeries ? (
                  <Button size="sm" disabled={busy !== null} onClick={() => void topCommand("search", { action: "searchMissing" }, t("adminArr.notice.searchMissing"))} title={t("adminArr.actions.searchMissingHint")}>
                    {busy === "search" ? <Loader2 className="animate-spin" /> : <Search />} {t("adminArr.actions.searchMissing")}
                  </Button>
                ) : (
                  <>
                    <Button size="sm" disabled={busy !== null} onClick={() => void topCommand("search", { action: "search" }, t("adminArr.notice.search"))} title={t("adminArr.actions.searchHint")}>
                      {busy === "search" ? <Loader2 className="animate-spin" /> : <Search />} {t("adminArr.actions.search")}
                    </Button>
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => pickRelease(null)}>
                      <Download /> {t("adminArr.actions.interactive")}
                    </Button>
                  </>
                )}
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void topCommand("refresh", { action: "refresh" }, t("adminArr.notice.refresh"), true)} title={t("adminArr.actions.refreshHint")}>
                  {busy === "refresh" ? <Loader2 className="animate-spin" /> : <RefreshCw />} {t("adminArr.actions.refresh")}
                </Button>
                <span className="flex-1" />
                <OpenInArrLink service={service} instance={instance} target={{ arrId: state.title.arrId }} label={t("adminManage.openIn", { name: instanceLabel })} />
              </div>
              {/* Until a live title answer lands, the open-time read is out — or it failed (loadError). */}
              <ArrSnapshotNote at={snap.staleAt} refreshing={loadError === ""} />
              {error || loadError ? (
                <p role="alert" className="m-0 flex items-center gap-1.5 text-xs" style={{ color: "var(--ds-danger)" }}>
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error || loadError}
                </p>
              ) : watchKey && watches[watchKey] ? (
                <CommandWatchLine watch={watches[watchKey]} />
              ) : notice ? (
                <p role="status" className="m-0 flex items-center gap-1.5 text-xs text-green-400">
                  <Check className="h-3.5 w-3.5 shrink-0" /> {notice}
                </p>
              ) : null}
              {partialNote && !error && !loadError && (
                <p role="status" className="m-0 text-xs text-zinc-400">{partialNote}</p>
              )}

              {confirmDiscard && (
                <div role="alertdialog" aria-label={t("adminArr.settings.discardTitle")} className="flex flex-wrap items-center gap-3 rounded-lg px-3 py-2.5 text-sm" style={{ background: "color-mix(in oklab, var(--ds-warning) 12%, transparent)", border: "1px solid var(--ds-warning)" }}>
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
                  <span className="min-w-0 flex-1 text-zinc-100">{t("adminArr.settings.discardTitle")}</span>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDiscard(false)}>{t("adminArr.settings.keepEditing")}</Button>
                  <Button size="sm" disabled={settingsSaving} className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]" onClick={() => onOpenChange(false)}>
                    {t("adminArr.settings.discard")}
                  </Button>
                </div>
              )}

              <FilterBar segments={tabs} active={tab} onChange={selectTab} className="mb-0" />

              {ref && (
                <div hidden={tab !== "settings"}>
                  <SettingsTab
                    key={version}
                    titleRef={ref}
                    title={state.title}
                    qualityProfiles={state.qualityProfiles}
                    rootFolders={state.rootFolders}
                    tags={state.tags}
                    baseIsSnapshot={snap.staleAt !== null}
                    onSaved={(next) => {
                      // The write landed but its re-read failed: read it again.
                      if (!next) return reload();
                      const reread = supersedeReads();
                      setState((s) => (s ? { ...s, title: mergeTitle(s.title, next) } : s));
                      if (reread) reload();
                    }}
                    onDirtyChange={onDirtyChange}
                    onSavingChange={setSettingsSaving}
                  />
                  <div className="mt-5">
                    <RemovePanel
                      titleRef={ref}
                      instanceLabel={instanceLabel}
                      onRemoved={() => {
                        stopWatches();
                        setSettingsDirty(false);
                        setRemoved(true);
                        onRemoved?.();
                      }}
                    />
                  </div>
                </div>
              )}
              {ref && visited.has("seasons") && (
                <div hidden={tab !== "seasons"}>
                  <SeasonsTab
                    titleRef={ref}
                    title={state.title}
                    onTitle={(next) => {
                      // The write landed but its re-read failed: read it again.
                      if (!next) return reload();
                      const reread = supersedeReads();
                      setState((s) => (s ? { ...s, title: mergeTitle(s.title, next) } : s));
                      if (reread) reload();
                    }}
                    runCommand={runCommand}
                    pickRelease={(scope, subtitle) => pickRelease(scope, subtitle)}
                  />
                </div>
              )}
              {ref && visited.has("files") && <div hidden={tab !== "files"}><FilesTab titleRef={ref} onChanged={reload} /></div>}
              {ref && visited.has("history") && <div hidden={tab !== "history"}><HistoryTab titleRef={ref} onLeave={leave} /></div>}
            </DialogContent>
          )}

          {/* Nested inside the popup so the picker's clicks are never "outside" this dialog. */}
          <ReleaseSearchDialog
            open={release !== null}
            onOpenChange={(o) => { if (!o) setRelease(null); }}
            target={release?.target}
            subtitle={release?.subtitle ?? title?.title}
          />
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

/**
 * Opens the title manager for one title on one instance. `variant="icon"` is
 * the compact form for a table row (queue, missing, calendar, history,
 * requests, issues); the labelled form sits beside "Open in" on the detail
 * pages. Callers render it for admins only (every route behind it is
 * ADMIN-gated itself).
 */
export function ManageTitleButton({
  service,
  instance,
  target,
  instanceLabel,
  variant = "button",
  initialTab,
  autoOpen = false,
  onRemoved,
  onActiveChange,
}: {
  service: ArrServiceName;
  instance: string;
  target: TitleManagerTarget;
  /** Already formatted: "Radarr", "Sonarr (4K)". */
  instanceLabel: string;
  variant?: "button" | "icon";
  initialTab?: TitleManagerTab;
  /** Open on first render — a deep link (`?manage=` on the detail pages). */
  autoOpen?: boolean;
  onRemoved?: () => void;
  /**
   * Told `true` when the dialog opens and `false` when it closes (or the button
   * unmounts with it open). A live list holds its refresh meanwhile: a refresh
   * can drop the row — and the dialog with it, unsaved edits and all.
   */
  onActiveChange?: (open: boolean) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(autoOpen);
  // The latest callback, so a parent's new function each render never reads as
  // a close and a re-open.
  const activeRef = useRef(onActiveChange);
  useEffect(() => {
    activeRef.current = onActiveChange;
  });
  useEffect(() => {
    if (!open) return;
    activeRef.current?.(true);
    const active = activeRef;
    return () => active.current?.(false);
  }, [open]);
  const label = t("adminArr.manage.button", { name: instanceLabel });
  // The button usually sits IN a row of the list that re-reads on a removal,
  // and that re-read unmounts the row — dialog and its "Removed" confirmation
  // with it. So the list hears of the removal when the admin closes the dialog.
  const removedRef = useRef(false);
  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next && removedRef.current) {
      removedRef.current = false;
      onRemoved?.();
    }
  }
  return (
    <>
      {variant === "icon" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={label}
          aria-label={label}
          className="ds-hover-tint inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:text-zinc-100"
        >
          <Wrench className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={label}
          className="ds-hover-tint inline-flex items-center gap-1.5 rounded-md text-zinc-400 transition-colors hover:text-zinc-100"
          style={{ fontSize: 12, padding: "5px 10px", border: "1px solid var(--ds-border)", background: "var(--ds-bg-2)" }}
        >
          <Wrench style={{ width: 12, height: 12 }} aria-hidden />
          {label}
        </button>
      )}
      {open && (
        <ArrTitleManager
          open={open}
          onOpenChange={changeOpen}
          service={service}
          instance={instance}
          target={target}
          instanceLabel={instanceLabel}
          initialTab={initialTab}
          onRemoved={() => {
            removedRef.current = true;
          }}
        />
      )}
    </>
  );
}

/**
 * "Manage in Radarr / Sonarr" beside the detail pages' "Open in" link — the
 * title manager for one instance holding the title, by its TMDB id.
 */
export function ArrManageButton({
  service,
  instance,
  tmdbId,
  instanceLabel,
  initialTab,
  autoOpen,
}: {
  service: ArrServiceName;
  instance: string;
  tmdbId: number;
  /** Already formatted: "Radarr", "Sonarr (4K)". */
  instanceLabel: string;
  initialTab?: TitleManagerTab;
  autoOpen?: boolean;
}) {
  return (
    <ManageTitleButton
      service={service}
      instance={instance}
      target={{ tmdbId }}
      instanceLabel={instanceLabel}
      initialTab={initialTab}
      autoOpen={autoOpen}
    />
  );
}
