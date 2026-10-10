"use client";

// The admin title manager: one movie or series on one Radarr/Sonarr instance,
// managed without opening the arr — its settings, its seasons and episodes
// (Sonarr), its files, its history, and searching it (automatic, or a release
// picked by hand). Opened from the detail pages' "Manage in Radarr/Sonarr"
// (ArrManageButton). Everything is live (GET /api/admin/arr/title?tmdbId=…
// resolves the title on the instance) and ADMIN-only on the server.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip, FilterBar } from "@/components/ui/design";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Check, Download, Loader2, RefreshCw, Search, Wrench, X } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { OpenInArrLink } from "@/components/admin/open-in-arr";
import { ReleaseSearchDialog, type TitleReleaseTarget } from "@/components/admin/release-search-dialog";
import { queueFormatters } from "@/components/admin/queue-format";
import type { ArrTitle, Choice, RootFolderChoice } from "@/lib/arr-title";
import { SettingsTab } from "./settings-tab";
import { SeasonsTab, type ReleaseScope } from "./seasons-tab";
import { FilesTab } from "./files-tab";
import { HistoryTab } from "./history-tab";
import { arrApi, useTRef, type ArrServiceName, type TitleRef } from "./shared";

interface TitleState {
  title: ArrTitle;
  qualityProfiles: Choice[];
  rootFolders: RootFolderChoice[];
  tags: Choice[];
}

type Tab = "settings" | "seasons" | "files" | "history";

function ArrTitleManager({
  open,
  onOpenChange,
  service,
  instance,
  tmdbId,
  instanceLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: ArrServiceName;
  instance: string;
  tmdbId: number;
  instanceLabel: string;
}) {
  const t = useT();
  const locale = useLocale();
  const [state, setState] = useState<TitleState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("settings");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  // Bumped by the OPEN-time read only: a background re-read (after a refresh or
  // a file delete) must not reset settings the admin is still editing.
  const [version, setVersion] = useState(0);
  const [release, setRelease] = useState<{ target: TitleReleaseTarget; subtitle?: string } | null>(null);
  const loadSeq = useRef(0);
  const tRef = useTRef();

  const load = useCallback(async (by: { tmdbId: number } | { arrId: number }) => {
    const seq = ++loadSeq.current;
    const q = new URLSearchParams({ service, instance });
    if ("tmdbId" in by) q.set("tmdbId", String(by.tmdbId));
    else q.set("id", String(by.arrId));
    const res = await arrApi<TitleState>(`/api/admin/arr/title?${q.toString()}`, undefined, tRef.current("adminArr.manage.loadFailed"));
    if (seq !== loadSeq.current) return;
    if (res.ok) {
      setState(res.data);
      if ("tmdbId" in by) setVersion((v) => v + 1);
      setLoadError("");
    } else {
      setLoadError(res.error);
    }
  }, [service, instance, tRef]);

  useEffect(() => {
    if (!open) return;
    setState(null);
    setLoadError("");
    setNotice("");
    setError("");
    setTab("settings");
    void load({ tmdbId });
    // Closing invalidates a read still in flight.
    const counter = loadSeq;
    return () => {
      counter.current++;
    };
  }, [open, tmdbId, load]);

  // Stable per title: the tabs key their reads on it.
  const arrId = state?.title.arrId ?? null;
  const ref = useMemo<TitleRef | null>(() => (arrId === null ? null : { service, instance, arrId }), [service, instance, arrId]);
  const reload = useCallback(() => {
    if (arrId !== null) void load({ arrId });
  }, [arrId, load]);

  const runCommand = useCallback(async (body: Record<string, unknown>, done: string) => {
    if (!state) return;
    setNotice("");
    setError("");
    const res = await arrApi<{ commands: number }>(
      "/api/admin/arr/title/command",
      { method: "POST", body: { service, instance, id: state.title.arrId, ...body } },
      t("adminArr.manage.commandFailed"),
    );
    if (res.ok) setNotice(done);
    else setError(res.error);
  }, [state, service, instance, t]);

  async function topCommand(key: string, body: Record<string, unknown>, done: string, reread = false) {
    setBusy(key);
    await runCommand(body, done);
    setBusy(null);
    // A refresh re-reads metadata and rescans the disk in the background.
    if (reread) window.setTimeout(() => reload(), 4_000);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                  {title.status && <span>{title.status}</span>}
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

          {!state ? (
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
              {(notice || error || loadError) && (
                <p role={error || loadError ? "alert" : "status"} className={`m-0 flex items-center gap-1.5 text-xs ${error || loadError ? "" : "text-green-400"}`} style={error || loadError ? { color: "var(--ds-danger)" } : undefined}>
                  {error || loadError ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <Check className="h-3.5 w-3.5 shrink-0" />} {error || loadError || notice}
                </p>
              )}

              <FilterBar segments={tabs} active={tab} onChange={setTab} className="mb-0" />

              {ref && tab === "settings" && (
                <SettingsTab
                  key={version}
                  titleRef={ref}
                  title={state.title}
                  qualityProfiles={state.qualityProfiles}
                  rootFolders={state.rootFolders}
                  tags={state.tags}
                  onSaved={(next) => setState((s) => (s ? { ...s, title: next } : s))}
                />
              )}
              {ref && tab === "seasons" && (
                <SeasonsTab
                  titleRef={ref}
                  title={state.title}
                  onTitle={(next) => setState((s) => (s ? { ...s, title: next } : s))}
                  runCommand={runCommand}
                  pickRelease={(scope, subtitle) => pickRelease(scope, subtitle)}
                />
              )}
              {ref && tab === "files" && <FilesTab titleRef={ref} onChanged={reload} />}
              {ref && tab === "history" && <HistoryTab titleRef={ref} />}
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
 * "Manage in Radarr / Sonarr" beside the detail pages' "Open in" link — the
 * title manager for one instance holding the title. Callers render it for
 * admins only (the routes behind it are ADMIN-gated themselves).
 */
export function ArrManageButton({
  service,
  instance,
  tmdbId,
  instanceLabel,
}: {
  service: ArrServiceName;
  instance: string;
  tmdbId: number;
  /** Already formatted: "Radarr", "Sonarr (4K)". */
  instanceLabel: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const label = t("adminArr.manage.button", { name: instanceLabel });
  return (
    <>
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
      {open && (
        <ArrTitleManager open={open} onOpenChange={setOpen} service={service} instance={instance} tmdbId={tmdbId} instanceLabel={instanceLabel} />
      )}
    </>
  );
}
