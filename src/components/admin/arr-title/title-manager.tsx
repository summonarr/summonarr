"use client";

// The admin title manager: one movie or series on one Radarr/Sonarr instance,
// managed without opening the arr — its settings, its seasons and episodes
// (Sonarr), its files, its history, and searching it (automatic, or a release
// picked by hand), and taking it off the instance. Opened from the detail
// pages' "Manage in Radarr/Sonarr" (ArrManageButton, by TMDB id — resolved on
// the instance) and from every admin list that names a Radarr/Sonarr title
// (ManageTitleButton, by the arr's own id). Everything is live and ADMIN-only
// on the server. The title's read is use-title-load.ts; the header, command
// bar, status line and discard banner are manager-parts.tsx.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/design";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Check, Loader2, RefreshCw, Wrench, X } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { useArrCommandWatch } from "@/components/admin/arr-command-watch";
import { ArrSnapshotNote } from "@/components/admin/arr-snapshot-note";
import { ReleaseSearchDialog, type TitleReleaseTarget } from "@/components/admin/release-search-dialog";
import { queueFormatters } from "@/components/admin/queue-format";
import { closeVerdict } from "@/lib/arr-title-ui";
import { COMMAND_ANSWER, idsOf } from "@/lib/client/arr-answers";
import { useAsyncAction } from "@/hooks/use-async-action";
import { SettingsTab } from "./settings-tab";
import { SeasonsTab, type ReleaseScope } from "./seasons-tab";
import { FilesTab } from "./files-tab";
import { HistoryTab } from "./history-tab";
import { RemovePanel } from "./remove-panel";
import { arrApi, type ApiResult, type ArrServiceName, type TitleRef } from "./shared";
import type { TitleReadTarget } from "./snapshot-rules";
import { useStableTarget, useTitleLoad } from "./use-title-load";
import { CommandBar, DiscardBanner, StatusLine, TitleChips } from "./manager-parts";

export type TitleManagerTab = "settings" | "seasons" | "files" | "history";
type Tab = TitleManagerTab;

/** Which title: by TMDB id (resolved on the instance) or by the arr's own id. */
export type TitleManagerTarget = TitleReadTarget;

type CommandAnswer = ApiResult<{ commandIds?: unknown; partial?: unknown }>;

export function ArrTitleManager({
  open,
  onOpenChange,
  service,
  instance,
  target: targetProp,
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
  const target = useStableTarget(targetProp);
  const { state, loadError, version, staleAt, arrId, retry, reload, applyWrite } = useTitleLoad({ open, service, instance, target });
  const [tab, setTab] = useState<Tab>("settings");
  const [notice, setNotice] = useState("");
  // Search missing that Sonarr refused part-way (202 `partial: true`): what it
  // did queue is followed as usual; this says the rest never started.
  const [partialNote, setPartialNote] = useState("");
  const [error, setError] = useState("");
  const [release, setRelease] = useState<{ target: TitleReleaseTarget; subtitle?: string } | null>(null);
  // Tabs stay mounted once opened (hidden, not unmounted), so switching tabs
  // never throws away an unsaved Settings edit or reloads a list.
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(new Set(["settings"]));
  const [settingsDirty, setSettingsDirty] = useState(false);
  // A Settings save whose PATCH is in flight: nothing it sent can be discarded.
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [removed, setRemoved] = useState(false);
  // The command bar's POSTs ("search", "refresh"); closing aborts them.
  const commands = useAsyncAction();
  const busy = commands.busy("search") ? "search" : commands.busy("refresh") ? "refresh" : null;
  // The title's commands, followed live (GET /api/admin/arr/commands) under
  // their button's key; the notice line shows the newest one.
  const { watch, stop: stopWatches, watches } = useArrCommandWatch();
  const [watchKey, setWatchKey] = useState<string | null>(null);

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

  // The discard banner is an alertdialog: focus moves to "Keep editing" when it
  // opens, and back to where it was (the close button, a field) when it goes.
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const discardReturn = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (confirmDiscard) {
      keepEditingRef.current?.focus();
      return;
    }
    const back = discardReturn.current;
    discardReturn.current = null;
    if (back?.isConnected) back.focus();
  }, [confirmDiscard]);

  // Every open (or a new target) starts clean: no line, prompt, release picker
  // or command of the title before. Closing stops following every command
  // and drops the command bar's POSTs — nothing is shown after close.
  useEffect(() => {
    if (!open) return;
    const openTab = firstTabRef.current;
    setNotice("");
    setPartialNote("");
    setError("");
    setRelease(null);
    setTab(openTab);
    setVisited(new Set(["settings", openTab]));
    setSettingsDirty(false);
    setSettingsSaving(false);
    discardReturn.current = null;
    setConfirmDiscard(false);
    setRemoved(false);
    setWatchKey(null);
    return () => {
      commands.abort();
      stopWatches();
    };
  }, [open, target, commands, stopWatches]);

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
    if (verdict === "confirm") {
      if (!confirmDiscard && document.activeElement instanceof HTMLElement) discardReturn.current = document.activeElement;
      setConfirmDiscard(true);
    }
    selectTab("settings");
    return false;
  }
  function requestClose(nextOpen: boolean) {
    if (nextOpen) return onOpenChange(true);
    leave();
  }

  // Stable per title: the tabs key their reads on it.
  const ref = useMemo<TitleRef | null>(() => (arrId === null ? null : { service, instance, arrId }), [service, instance, arrId]);

  /** POST one title command (the title's own instance and id). */
  const sendCommand = useCallback((body: Record<string, unknown>, signal?: AbortSignal): Promise<CommandAnswer> => {
    return arrApi(
      "/api/admin/arr/title/command",
      { method: "POST", body: { service, instance, id: arrId, ...body }, schema: COMMAND_ANSWER, signal },
      t("adminArr.manage.commandFailed"),
    );
  }, [service, instance, arrId, t]);

  // A queued command is followed: `done` (the "started" notice) shows until
  // the arr's first status, then its own progress and how it ended. Searches
  // share one key (a newer search replaces the line); a refresh has its own,
  // so its re-read still happens when a search starts meanwhile.
  const followCommand = useCallback((res: CommandAnswer, done: string, opts: { key?: string; onDone?: () => void } = {}) => {
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (res.data.partial === true) setPartialNote(t("adminArr.notice.searchMissingPartial"));
    const key = opts.key ?? "search";
    const ids = idsOf(res.data.commandIds);
    if (ids.length === 0) {
      // An arr that answered without an id: nothing to follow.
      setNotice(done);
      setWatchKey(null);
      return;
    }
    watch(key, { service, instance }, ids, { pendingText: done, onDone: opts.onDone });
    setWatchKey(key);
  }, [service, instance, t, watch]);

  const clearLines = () => {
    setNotice("");
    setPartialNote("");
    setError("");
  };

  // The Seasons tab's searches: that tab holds its own busy state while one is out.
  const runCommand = useCallback(async (body: Record<string, unknown>, done: string) => {
    if (arrId === null) return;
    setNotice("");
    setPartialNote("");
    setError("");
    followCommand(await sendCommand(body), done);
  }, [arrId, sendCommand, followCommand]);

  async function topCommand(key: "search" | "refresh", body: Record<string, unknown>, done: string, reread = false) {
    if (arrId === null) return;
    clearLines();
    const res = await commands.run(key, (signal) => sendCommand(body, signal), { ifBusy: "skip" });
    if (!res) return;
    // A refresh re-reads metadata and rescans the disk in the background: the
    // title is re-read once the arr reports it ended.
    followCommand(res, done, { key, onDone: reread ? reload : undefined });
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
              {title && <TitleChips title={title} instanceLabel={instanceLabel} isSeries={isSeries} fmt={fmt} />}
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
              <div role="alert" className="flex flex-wrap items-center justify-center gap-2 px-6 py-16 text-center text-sm" style={{ color: "var(--ds-danger)" }}>
                <AlertTriangle className="h-4 w-4 shrink-0" /> {loadError}
                {/* Reads again as the open-time read did: clearing the error brings the spinner back. */}
                <Button variant="ghost" size="sm" onClick={retry}>
                  <RefreshCw /> {t("adminArr.common.retry")}
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-3 py-16 text-sm text-zinc-500">
                <Loader2 className="h-5 w-5 animate-spin" /> {t("adminArr.common.loading")}
              </div>
            )
          ) : (
            <DialogContent className="grid content-start gap-4">
              <CommandBar
                service={service}
                instance={instance}
                arrId={state.title.arrId}
                instanceLabel={instanceLabel}
                busy={busy}
                onSearch={() => void (isSeries
                  ? topCommand("search", { action: "searchMissing" }, t("adminArr.notice.searchMissing"))
                  : topCommand("search", { action: "search" }, t("adminArr.notice.search")))}
                onPickRelease={() => pickRelease(null)}
                onRefresh={() => void topCommand("refresh", { action: "refresh" }, t("adminArr.notice.refresh"), true)}
              />
              {/* Until a live title answer lands, the open-time read is out — or it failed (loadError). */}
              <ArrSnapshotNote at={staleAt} refreshing={loadError === ""} />
              <StatusLine error={error || loadError} watch={watchKey ? watches[watchKey] : undefined} notice={notice} partialNote={partialNote} />

              {confirmDiscard && (
                <DiscardBanner saving={settingsSaving} keepRef={keepEditingRef} onKeep={() => setConfirmDiscard(false)} onDiscard={() => onOpenChange(false)} />
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
                    baseIsSnapshot={staleAt !== null}
                    onSaved={applyWrite}
                    onDirtyChange={onDirtyChange}
                    onSavingChange={setSettingsSaving}
                  />
                  <div className="mt-5">
                    <RemovePanel
                      titleRef={ref}
                      instanceLabel={instanceLabel}
                      onLeave={leave}
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
                    onTitle={applyWrite}
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
  autoFocus = false,
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
  /** Take focus on mount: the button replaces one that had it (the Add button, after an add). */
  autoFocus?: boolean;
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus) triggerRef.current?.focus();
  }, [autoFocus]);
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
          ref={triggerRef}
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
          ref={triggerRef}
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
