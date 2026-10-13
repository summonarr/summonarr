"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Chip } from "@/components/ui/design";
import {
  Loader2, Check, RefreshCw, AlertTriangle, Clock, Trash2,
  Download, ChevronDown, ChevronUp, Magnet, Radio, Search, X, FileX,
} from "@/components/icons";
import type { ArrRelease } from "@/lib/arr";
import type { ReplaceableFile, ReplaceFollowUp } from "@/lib/issue-replace";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { episodeSummary, queueFormatters } from "@/components/admin/queue-format";
import { ManageTitleButton } from "@/components/admin/arr-title/title-manager";
import { arrInstanceLabel } from "@/components/admin/open-in-arr";
import { manageTabFor } from "@/lib/arr-manage-links";
import { holdLiveRefresh, runOrDefer } from "@/lib/client/refresh-hold";
import { runReplaceFileJob } from "@/lib/client/replace-file-job";
import { runReleaseSearchJob } from "@/lib/client/release-search-job";
import { seriesReleaseScopeSearchable } from "@/lib/release-scope";

interface IssueActionsProps {
  issueId: string;
  currentStatus: string;
  mediaType: string;
  tvdbId: number | null;
  scope: string;
  seasonNumber: number | null;
  episodeNumber: number | null;

  libraryConfirmed?: boolean;
  // Configured Radarr/Sonarr instances for this issue's service (default first).
  // More than one ⇒ the Replace panel shows an instance picker.
  instances?: { slug: string; name: string }[];
  // The viewer is an ADMIN: "Replace file" deletes files, which issue admins
  // can't (the route is withAdmin). Cosmetic — the route decides.
  isAdmin?: boolean;
  // ADMIN only: the title's TMDB id and the configured instances whose synced
  // cache holds it — one "Manage" icon each, opening the title manager there.
  manage?: { tmdbId: number; holders: { slug: string; name: string }[] };
}

// i18n keys, translated at render.
const REFETCH_LABEL_KEY: Record<string, string> = {
  FULL: "adminQueue.issueActions.refetchAll",
  SEASON: "adminQueue.issueActions.refetchSeason",
  EPISODE: "adminQueue.issueActions.refetchEpisode",
};

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function formatAge(hours: number): string {
  if (hours < 24) return `${Math.round(hours)}h`;
  if (hours < 24 * 30) return `${Math.round(hours / 24)}d`;
  return `${Math.round(hours / (24 * 30))}mo`;
}

export function IssueActions({
  issueId,
  currentStatus,
  mediaType,
  tvdbId,
  scope,
  seasonNumber,
  episodeNumber,
  libraryConfirmed,
  instances,
  isAdmin = false,
  manage,
}: IssueActionsProps) {
  const router = useRouter();
  const t = useT();

  const [loading, setLoading] = useState<"refetch" | "status" | "delete" | "releases" | "grab" | null>(null);
  const [arrError, setArrError] = useState<string | null>(null);
  const [refetchOk, setRefetchOk] = useState(false);

  const [panel, setPanel] = useState<"resolve" | "delete" | "replace" | "replaceFile" | null>(null);
  const [resolution, setResolution] = useState("");

  // `instances` lists only the CONFIGURED Radarr/Sonarr servers, default first.
  // If the default server isn't configured, the "" slug is missing from the list,
  // so we fall back to the first real entry instead of aiming at a server that
  // doesn't exist. This is computed on every render (not stored once) because the
  // same component is reused when the selected issue switches between a movie
  // (Radarr) and a TV show (Sonarr).
  const instanceOptions = instances ?? [];
  const [pickedInstance, setPickedInstance] = useState<string | null>(null);
  const instance =
    pickedInstance !== null && instanceOptions.some((i) => i.slug === pickedInstance)
      ? pickedInstance
      : instanceOptions[0]?.slug ?? "";
  const [releases, setReleases] = useState<ArrRelease[]>([]);
  const [selectedGuid, setSelectedGuid] = useState<string | null>(null);
  const [grabOk, setGrabOk] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [releaseFilter, setReleaseFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  // Counter that numbers each release search. Switching instances twice can leave two
  // searches running at once, and whichever finishes LAST would otherwise win — even if
  // it belongs to the instance no longer selected. grabRelease() would then send one
  // server's release ids to a different server. Only the newest search may write state.
  const releaseReqRef = useRef(0);

  // While the Replace-release dialog is open, the page's live refresh waits
  // (refresh-hold.ts): the grab flips the issue to IN_PROGRESS and announces
  // it first, and on the OPEN tab the refresh would unmount this row — and the
  // dialog with its answer — mid-request. Closing it lets the refresh through.
  useEffect(() => (panel === "replace" ? holdLiveRefresh() : undefined), [panel]);

  async function triggerRefetch() {
    setLoading("refetch");
    setArrError(null);
    setRefetchOk(false);
    try {
      const res = await fetch(withBasePath(`/api/issues/${issueId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Same instance the Replace picker selects — an issue about the 4K copy must
        // re-search the 4K instance, not the default. "" when there is one instance.
        body: JSON.stringify({ refetch: true, instance }),
      });
      // Check res.ok FIRST. The server reports two kinds of failure: a normal
      // error status (503, 401/403, 404, 400, 413) with no `arrError` field,
      // and a Radarr/Sonarr failure sent as HTTP 200 WITH `arrError`. Looking
      // only for `arrError` would show a green "Search triggered" for the first kind.
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setArrError(data.message ?? data.error ?? t("adminQueue.issueActions.searchFailed", { status: res.status }));
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { arrError?: string };
      if (data.arrError) {
        setArrError(data.arrError);
      } else {
        setRefetchOk(true);
        router.refresh();
      }
    } catch {
      setArrError(t("shared.thread.networkError"));
    } finally {
      setLoading(null);
    }
  }

  async function updateStatus(status: string, resolutionNote?: string) {
    setLoading("status");
    setArrError(null);
    try {
      const res = await fetch(withBasePath(`/api/issues/${issueId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, resolution: resolutionNote }),
      });
      if (!res.ok) {
        // `message` first — a concurrent status change answers
        // { error: "status-conflict", message: "<sentence>" }; the slug alone is noise.
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setArrError(data.message ?? data.error ?? t("adminQueue.issueActions.statusFailed"));
        return;
      }
      router.refresh();
    } catch {
      // `finally` closes the resolve panel either way, so without this a network
      // failure looked exactly like a successful resolve: panel gone, no error.
      setArrError(t("shared.thread.networkError"));
    } finally {
      setLoading(null);
      setPanel(null);
    }
  }

  async function deleteIssue() {
    setLoading("delete");
    setArrError(null);
    try {
      const res = await fetch(withBasePath(`/api/issues/${issueId}`), { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setArrError((data as { error?: string }).error ?? t("adminQueue.actions.deleteFailed"));
        return;
      }
      router.refresh();
    } catch {
      setArrError(t("shared.thread.networkError"));
    } finally {
      setLoading(null);
      setPanel(null);
    }
  }

  async function loadReleases(targetInstance: string) {
    const reqId = ++releaseReqRef.current;
    setLoading("releases");
    setArrError(null);
    setReleases([]);
    setSelectedGuid(null);
    setGrabOk(false);
    setShowRejected(false);
    setReleaseFilter("");
    try {
      // In the background (release-search-jobs.ts, the guardrail-37a pattern):
      // a Sonarr season search takes a minute or two, longer than a reverse
      // proxy keeps one request open — held open, the admin saw a 502 while the
      // arr finished, and a retry hit every indexer again.
      const answer = await runReleaseSearchJob(
        fetch,
        withBasePath(`/api/issues/${issueId}/releases?instance=${encodeURIComponent(targetInstance)}`),
        { isAlive: () => reqId === releaseReqRef.current },
      );
      // A superseded search must not write back — neither its list nor its error.
      if (answer === null || reqId !== releaseReqRef.current) return;
      if (answer.status < 200 || answer.status >= 300 || !Array.isArray(answer.data)) {
        const data = answer.data as { error?: string } | null;
        setArrError(data?.error ?? t("adminQueue.issueActions.releasesFailed"));
        setPanel(null);
      } else {
        const data = answer.data as ArrRelease[];
        setReleases(data);
        const first = data.find((r) => !r.rejected) ?? data[0];
        if (first) setSelectedGuid(first.guid);
      }
    } catch {
      // Report the failure (only if this is still the latest search). Otherwise the
      // dialog would show the empty list and say "No releases found", which is a
      // different claim from "the search never completed".
      if (reqId === releaseReqRef.current) {
        setArrError(t("shared.thread.networkError"));
        setPanel(null);
      }
    } finally {
      // Guarded too: a stale request clearing the spinner makes the UI read "done" while the
      // current search is still running.
      if (reqId === releaseReqRef.current) setLoading(null);
    }
  }

  // Closing the panel supersedes a search still polling: it stops, and its
  // late answer writes nothing (nor leaves the spinner state behind).
  function closeReplacePicker() {
    releaseReqRef.current++;
    if (loading === "releases") setLoading(null);
    setPanel(null);
  }

  async function openReplacePicker() {
    setPanel("replace");
    await loadReleases(instance);
  }

  async function switchInstance(next: string) {
    setPickedInstance(next);
    await loadReleases(next);
  }

  async function grabRelease() {
    if (!selectedGuid) return;
    const rel = releases.find((r) => r.guid === selectedGuid);
    if (!rel) return;
    setLoading("grab");
    setArrError(null);
    try {
      const res = await fetch(withBasePath(`/api/issues/${issueId}/releases`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guid: rel.guid, indexerId: rel.indexerId, instance }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setArrError(data.error ?? t("adminQueue.issueActions.grabFailed"));
      } else {
        setGrabOk(true);
        // Once the dialog closes — not under the "grab queued" it is showing.
        runOrDefer(() => router.refresh());
      }
    } catch {
      setArrError(t("shared.thread.networkError"));
    } finally {
      setLoading(null);
    }
  }

  useEffect(() => {
    if (panel !== "replace" || releases.length === 0) return;
    const term = releaseFilter.toLowerCase();
    const visible = releases.filter(
      (r) => (showRejected || !r.rejected) && r.title.toLowerCase().includes(term)
    );
    if (visible.length === 0) { setSelectedGuid(null); return; }
    if (!visible.some((r) => r.guid === selectedGuid)) {
      setSelectedGuid(visible[0].guid);
    }
  }, [releaseFilter, showRejected, releases, panel, selectedGuid]);

  useEffect(() => {
    if (panel === "replace" && releases.length > 0 && loading !== "releases") {
      setTimeout(() => filterRef.current?.focus(), 50);
    }
  }, [panel, releases.length, loading]);

  const refetchLabel =
    mediaType === "MOVIE"
      ? t("adminQueue.issueActions.refetchMovie")
      : t(REFETCH_LABEL_KEY[scope] ?? "adminQueue.issueActions.refetch");
  const canRefetch = mediaType === "MOVIE" || !!tvdbId;

  // A whole-series TV issue has no release search: Sonarr's series-only query is
  // the indexers' RSS feed, other shows included (release-scope.ts). Refetch or
  // Replace file covers it.
  const canReplace = mediaType === "MOVIE"
    || (seriesReleaseScopeSearchable(scope, seasonNumber, episodeNumber) && (!!tvdbId || scope === "EPISODE"));
  const serviceName = mediaType === "MOVIE" ? "Radarr" : "Sonarr";
  // A search only ever takes an UPGRADE of a file still on disk, so Refetch
  // can't replace a broken file that's already at the profile's cutoff — say
  // so, and point at the action that can.
  const refetchHint = isAdmin
    ? t("adminQueue.issueActions.refetchHint")
    : t("adminQueue.issueActions.refetchHintIssueAdmin");
  const isResolved = currentStatus === "RESOLVED";
  const isInProgress = currentStatus === "IN_PROGRESS";

  const scopeDetail =
    scope === "EPISODE" && seasonNumber != null && episodeNumber != null
      ? `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`
      : scope === "SEASON" && seasonNumber != null
      ? t("adminQueue.issues.scope.seasonN", { number: seasonNumber })
      : null;

  const filterTerm = releaseFilter.toLowerCase();
  const visibleReleases = releases.filter(
    (r) => (showRejected || !r.rejected) && (filterTerm === "" || r.title.toLowerCase().includes(filterTerm))
  );
  const rejectedCount = releases.filter((r) => r.rejected).length;

  return (
    // No `shrink-0`: a non-shrinking flex item keeps its max-content width, and
    // the max-content of the wrapping button row below is the SUM of its
    // buttons, so the inner flex-wrap could never engage. A TV-episode issue
    // (Refetch + Replace + In progress + Resolve + delete ≈ 500px) was clipped
    // by the xl aside (442px of content) and pushed off a phone-width card.
    // `min-w-0` is what lets the column shrink below that sum so the row wraps.
    <div className="flex flex-col items-end gap-1.5 min-w-0">
      {scopeDetail && (
        <span className="text-[10px] text-zinc-500 font-mono">{scopeDetail}</span>
      )}
      {libraryConfirmed && scope === "EPISODE" && !isResolved && (
        <span className="text-[10px] text-sky-400">{t("adminQueue.issueActions.matchConfirmed")}</span>
      )}

      {panel === null && (
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {isAdmin && manage?.holders.map((h) => {
            const service = mediaType === "MOVIE" ? "radarr" : "sonarr";
            return (
              <ManageTitleButton
                key={h.slug}
                service={service}
                instance={h.slug}
                target={{ tmdbId: manage.tmdbId }}
                instanceLabel={arrInstanceLabel(service, h.name, h.slug)}
                variant="icon"
                initialTab={manageTabFor("issue", service)}
              />
            );
          })}
          {canRefetch && !isResolved && (
            <Button
              size="sm"
              variant="outline"
              onClick={triggerRefetch}
              disabled={loading !== null}
              title={refetchHint}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-amber-400 hover:border-amber-500/50 gap-1"
            >
              {loading === "refetch" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              {refetchLabel}
            </Button>
          )}

          {canReplace && !isResolved && (
            <Button
              size="sm"
              variant="outline"
              onClick={openReplacePicker}
              disabled={loading !== null}
              className={`h-7 px-3 text-xs gap-1 ${
                libraryConfirmed && scope === "EPISODE"
                  ? "border-sky-500/50 text-sky-400 hover:text-zinc-100 hover:border-sky-500"
                  : "border-zinc-700 text-zinc-400 hover:text-sky-400 hover:border-sky-500/50"
              }`}
            >
              <Download className="w-3 h-3" />
              {libraryConfirmed && scope === "EPISODE" ? t("adminQueue.issueActions.replaceEpisode") : t("adminQueue.issueActions.replace")}
            </Button>
          )}

          {isAdmin && !isResolved && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setArrError(null); setPanel("replaceFile"); }}
              disabled={loading !== null}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-red-400 hover:border-red-500/50 gap-1"
            >
              <FileX className="w-3 h-3" />
              {t("adminQueue.issueActions.replaceFile")}
            </Button>
          )}

          {!isResolved && !isInProgress && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => updateStatus("IN_PROGRESS")}
              disabled={loading !== null}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-yellow-400 hover:border-yellow-500/50 gap-1"
            >
              {loading === "status" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Clock className="w-3 h-3" />}
              {t("personal.issues.status.inProgress")}
            </Button>
          )}

          {!isResolved && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPanel("resolve")}
              disabled={loading !== null}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-green-400 hover:border-green-500/50 gap-1"
            >
              <Check className="w-3 h-3" />
              {t("adminQueue.issueActions.resolve")}
            </Button>
          )}

          {isResolved && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => updateStatus("OPEN")}
              disabled={loading !== null}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-500 hover:text-zinc-100 gap-1"
            >
              {t("adminQueue.issueActions.reopen")}
            </Button>
          )}

          <Button
            size="sm"
            variant="outline"
            onClick={() => setPanel("delete")}
            disabled={loading !== null}
            aria-label={t("adminQueue.issueActions.deleteIssue")}
            title={t("adminQueue.issueActions.deleteIssue")}
            className="h-7 px-3 text-xs border-zinc-700 text-zinc-500 hover:text-red-400 hover:border-red-500/50"
          >
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      )}

      {panel === "resolve" && (
        <div className="flex items-center gap-1.5 justify-end mt-0.5">
          <input
            type="text"
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            placeholder={t("adminQueue.issueActions.resolutionPlaceholder")}
            aria-label={t("adminQueue.issueActions.resolutionAria")}
            className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 focus-visible:ring-2 focus-visible:ring-ring w-44"
          />
          <Button
            size="sm"
            onClick={() => updateStatus("RESOLVED", resolution || undefined)}
            disabled={loading !== null}
            className="h-6 px-2 text-xs bg-green-600 text-[var(--ds-on-status)] hover:bg-green-600/90 gap-1"
          >
            {loading === "status" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            {t("adminQueue.actions.done")}
          </Button>
          <button type="button" onClick={() => setPanel(null)} className="rounded px-2 py-1 text-zinc-500 hover:text-zinc-400 text-xs">{t("shared.common.cancel")}</button>
        </div>
      )}

      {panel === "delete" && (
        <div className="flex items-center gap-1.5 justify-end mt-0.5">
          <span className="text-[11px] text-zinc-400">{t("adminQueue.issueActions.deleteConfirm")}</span>
          <Button
            size="sm"
            onClick={deleteIssue}
            disabled={loading !== null}
            className="h-6 px-2 text-xs bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] gap-1"
          >
            {loading === "delete" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            {t("adminQueue.actions.delete")}
          </Button>
          <button type="button" onClick={() => setPanel(null)} className="rounded px-2 py-1 text-zinc-500 hover:text-zinc-400 text-xs">{t("shared.common.cancel")}</button>
        </div>
      )}

      <Dialog open={panel === "replace"} onOpenChange={(o) => { if (!o && loading !== "grab") closeReplacePicker(); }}>
        <DialogPortal>
          <DialogBackdrop />
          <DialogPopup className="max-w-3xl">

            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700 flex-shrink-0">
              <DialogTitle className="text-base font-semibold text-zinc-100">
                {libraryConfirmed && scope === "EPISODE" ? t("adminQueue.issueActions.replaceEpisode") : t("adminQueue.issueActions.replace")}
              </DialogTitle>
              <div className="flex items-center gap-3">
                {(instances?.length ?? 0) > 1 && (
                  <StyledSelect
                    compact
                    value={instance}
                    onChange={(e) => switchInstance(e.target.value)}
                    disabled={loading !== null}
                    aria-label={t("adminQueue.issueActions.instance")}
                    className="w-auto md:text-xs"
                  >
                    {(instances ?? []).map((i) => (
                      <option key={i.slug || "default"} value={i.slug}>{i.name}</option>
                    ))}
                  </StyledSelect>
                )}
                <DialogClose
                  disabled={loading === "grab"}
                  aria-label={t("adminQueue.common.close")}
                  title={t("adminQueue.common.close")}
                  className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
                >
                  <X className="w-5 h-5" />
                </DialogClose>
              </div>
            </div>

            {loading === "releases" ? (
              <div className="flex items-center justify-center gap-3 text-sm text-zinc-500 py-16">
                <Loader2 className="w-5 h-5 animate-spin" />
                {t("adminQueue.issueActions.searching")}
              </div>
            ) : grabOk ? (
              <div className="flex items-center justify-center gap-2 text-sm text-green-400 py-16">
                <Check className="w-4 h-4" />
                {t("adminQueue.issueActions.grabQueued")}
              </div>
            ) : releases.length === 0 ? (
              <div className="text-sm text-zinc-500 text-center py-16">{t("adminQueue.issueActions.noReleases")}</div>
            ) : (
              <>
                {libraryConfirmed && scope === "EPISODE" && (
                  <div className="px-6 py-2.5 bg-sky-500/10 border-b border-sky-500/30 flex items-center gap-2 flex-shrink-0">
                    <span className="text-xs text-sky-400">
                      {t("adminQueue.issueActions.matchBanner")}
                    </span>
                  </div>
                )}

                <div className="px-6 py-3 border-b border-zinc-800 flex-shrink-0">
                  <div className="relative flex items-center">
                    <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
                    <input
                      ref={filterRef}
                      type="text"
                      value={releaseFilter}
                      onChange={(e) => setReleaseFilter(e.target.value)}
                      placeholder={t("adminQueue.issueActions.filterPlaceholder")}
                      aria-label={t("adminQueue.issueActions.filterAria")}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-md pl-10 pr-9 py-2.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500/60 focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    {releaseFilter && (
                      <button
                        type="button"
                        onClick={() => setReleaseFilter("")}
                        aria-label={t("adminQueue.issueActions.clearFilter")}
                        title={t("adminQueue.issueActions.clearFilter")}
                        className="absolute right-1 rounded px-2 py-1 text-zinc-500 hover:text-zinc-300"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  {visibleReleases.length === 0 && filterTerm && (
                    <p className="text-xs text-zinc-500 mt-2 text-center">
                      {t("adminQueue.issueActions.noMatch", { filter: releaseFilter })}{" "}
                      <button onClick={() => setReleaseFilter("")} className="text-zinc-400 hover:text-zinc-200 underline">{t("adminQueue.list.clear")}</button>
                    </p>
                  )}
                </div>

                <div className="overflow-y-auto flex-1 divide-y divide-zinc-800">
                  {visibleReleases.map((rel) => {
                    const isSelected = selectedGuid === rel.guid;
                    const profileMatch = !rel.rejected;
                    return (
                      <button
                        key={rel.guid}
                        type="button"
                        onClick={() => setSelectedGuid(rel.guid)}
                        aria-pressed={isSelected}
                        className={`w-full text-left px-6 py-3.5 flex items-start gap-4 hover:bg-zinc-800/60 transition-colors ${isSelected ? "bg-zinc-800" : ""}`}
                      >
                        <span className={`mt-0.5 shrink-0 ${rel.protocol === "torrent" ? "text-green-500" : "text-sky-400"}`}>
                          {rel.protocol === "torrent" ? <Magnet className="w-4 h-4" /> : <Radio className="w-4 h-4" />}
                        </span>

                        <div className="flex-1 min-w-0">
                          <p className={`text-sm truncate ${isSelected ? "text-zinc-100" : "text-zinc-300"}`} title={rel.title}>
                            {rel.title}
                          </p>
                          <div className="flex items-center gap-3 mt-1 flex-wrap">
                            <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${profileMatch ? "bg-sky-500/10 text-sky-400" : "bg-zinc-800 text-zinc-500"}`}>
                              {rel.quality.quality.name}
                              {rel.quality.revision.version > 1 && " v2"}
                            </span>
                            <span className="text-xs text-zinc-500">{formatSize(rel.size)}</span>
                            <span className="text-xs text-zinc-500">{rel.indexer}</span>
                            {rel.protocol === "torrent" && rel.seeders != null && (
                              <span className={`text-xs ${rel.seeders > 5 ? "text-green-400" : rel.seeders > 0 ? "text-yellow-400" : "text-red-400"}`}>
                                {rel.seeders}S
                              </span>
                            )}
                            <span className="text-xs text-zinc-500">{formatAge(rel.age * 24)}</span>
                          </div>
                          {rel.rejected && rel.rejections.length > 0 && (
                            <p className="text-xs text-amber-400 mt-0.5 truncate">{rel.rejections[0]}</p>
                          )}
                        </div>

                        {isSelected && <Check className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />}
                      </button>
                    );
                  })}
                </div>

                {rejectedCount > 0 && (
                  <button
                    onClick={() => setShowRejected((v) => !v)}
                    className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-zinc-500 hover:text-zinc-400 border-t border-zinc-800 transition-colors flex-shrink-0"
                  >
                    {showRejected ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    {showRejected ? t("adminQueue.issueActions.hideRejected", { count: rejectedCount }) : t("adminQueue.issueActions.showRejected", { count: rejectedCount })}
                  </button>
                )}

                {/* A refused grab is said HERE: the column copy below sits
                    under this dialog's backdrop. The arr's 410 ("search
                    again") is what Search again answers. */}
                {arrError && (
                  <div role="alert" className="flex items-start justify-between gap-3 px-6 py-3 border-t border-zinc-800 bg-amber-500/10 flex-shrink-0">
                    <span className="flex items-start gap-1.5 text-xs text-amber-400">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                      {arrError}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void loadReleases(instance)}
                      disabled={loading !== null}
                      className="shrink-0"
                    >
                      <RefreshCw />
                      {t("adminQueue.issueActions.searchAgain")}
                    </Button>
                  </div>
                )}

                <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-700 bg-zinc-900 flex-shrink-0">
                  <button type="button" onClick={() => setPanel(null)} className="rounded px-2 py-1 text-sm text-zinc-500 hover:text-zinc-300">{t("shared.common.cancel")}</button>
                  {/* The accent Button, like every other primary CTA — the old
                      bg-blue-700 had no --color-blue-* remap, so it was a fixed
                      blue under every accent (guardrail 42). */}
                  <Button
                    size="sm"
                    onClick={grabRelease}
                    disabled={!selectedGuid || loading === "grab"}
                  >
                    {loading === "grab" ? <Loader2 className="animate-spin" /> : <Download />}
                    {t("adminQueue.issueActions.grab")}
                  </Button>
                </div>
              </>
            )}
          </DialogPopup>
        </DialogPortal>
      </Dialog>

      {panel === "replaceFile" && (
        <ReplaceFileDialog
          issueId={issueId}
          serviceName={serviceName}
          instance={instance}
          instances={instanceOptions}
          onInstanceChange={setPickedInstance}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === null && refetchOk && (
        <span className="flex flex-col items-end gap-0.5 text-right">
          <span className="flex items-center gap-1 text-[11px] text-green-400">
            <Check className="w-3 h-3" />
            {t("adminQueue.issueActions.searchTriggered")}
          </span>
          <span className="max-w-60 text-[10px] text-zinc-500">{refetchHint}</span>
        </span>
      )}
      {arrError && panel !== "replace" && (
        <span className="flex items-center gap-1 text-[11px] text-amber-400 max-w-52 text-right">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          {arrError}
        </span>
      )}
    </div>
  );
}

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

// "Replace file" (ADMIN): delete the files the issue is about so Radarr/Sonarr
// fetch new ones — while a file is on disk a search only takes an upgrade of
// it. The server re-reads the files and history and checks every id against
// the issue's scope before anything is deleted (/api/issues/[id]/files).
function ReplaceFileDialog({
  issueId,
  serviceName,
  instance,
  instances,
  onInstanceChange,
  onClose,
}: {
  issueId: string;
  serviceName: string;
  instance: string;
  instances: { slug: string; name: string }[];
  onInstanceChange: (slug: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const [busy, setBusy] = useState<"list" | "replace" | null>("list");
  const [listing, setListing] = useState<FileListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [confirm, setConfirm] = useState<ReplaceFollowUp | null>(null);
  const [result, setResult] = useState<ReplaceResult | null>(null);
  // Only the newest read may write state — switching instances twice must not
  // let the older answer land on the newer instance's picker.
  const reqRef = useRef(0);

  // The page's live refresh waits while this dialog is open (refresh-hold.ts):
  // the replace flips the issue to IN_PROGRESS and announces it BEFORE the
  // delete, and on the OPEN tab a refresh would unmount the issue's row — and
  // this dialog with its result and warnings — mid-request. Unmounting (the
  // dialog closing) releases it, and any refresh asked for meanwhile runs then.
  useEffect(() => holdLiveRefresh(), []);
  // Polling stops once the dialog is gone.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const load = useCallback(async (target: string) => {
    const reqId = ++reqRef.current;
    try {
      const res = await fetch(withBasePath(`/api/issues/${issueId}/files?instance=${encodeURIComponent(target)}`));
      const data = (await res.json().catch(() => ({}))) as Partial<FileListing> & { error?: string };
      if (reqId !== reqRef.current) return;
      if (!res.ok || !Array.isArray(data.files)) {
        setListing(null);
        setError(data.error ?? t("adminQueue.issueActions.replaceFileLoadFailed"));
        return;
      }
      const files = data.files;
      setListing({
        files,
        otherFiles: typeof data.otherFiles === "number" ? data.otherFiles : 0,
        seriesType: typeof data.seriesType === "string" ? data.seriesType : null,
      });
      setSelected((prev) => new Set([...prev].filter((id) => files.some((f) => f.id === id))));
    } catch {
      if (reqId === reqRef.current) {
        setListing(null);
        setError(t("shared.thread.networkError"));
      }
    } finally {
      if (reqId === reqRef.current) setBusy((b) => (b === "list" ? null : b));
    }
  }, [issueId, t]);

  // Read on open and whenever the instance changes.
  useEffect(() => {
    void load(instance);
  }, [load, instance]);

  function reset() {
    setBusy("list");
    setListing(null);
    setSelected(new Set());
    setConfirm(null);
    setResult(null);
    setError(null);
  }

  function pickInstance(next: string) {
    reset();
    onInstanceChange(next);
  }

  function retry() {
    reset();
    void load(instance);
  }

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirm(null);
  }

  async function replace(then: ReplaceFollowUp) {
    setBusy("replace");
    setError(null);
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
        setError(t("adminQueue.issueActions.replaceFileNoAnswer"));
        reload = true;
      } else {
        const res = { ok: answer.status >= 200 && answer.status < 300 };
        const data = (answer.data && typeof answer.data === "object" ? answer.data : {}) as Partial<ReplaceResult> & { error?: string };
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
          // Once the dialog closes — the issue may leave this tab's list.
          runOrDefer(() => router.refresh());
        }
        if (!res.ok) {
          setError(data.error ?? t("adminQueue.issueActions.replaceFileFailed"));
          // Some files may be gone: show what's left.
          reload = true;
        }
      }
    } catch {
      // The POST itself failed on the network — it may have reached the
      // server first, so this is the same "no answer", not a network retry.
      setError(t("adminQueue.issueActions.replaceFileNoAnswer"));
      reload = true;
    } finally {
      setBusy(null);
      setConfirm(null);
    }
    if (reload) {
      setBusy("list");
      void load(instance);
    }
  }

  const files = listing?.files ?? [];
  const done = result !== null && error === null;
  const isSeries = serviceName === "Sonarr";
  const chosen = files.filter((f) => selected.has(f.id));
  const chosenSize = chosen.reduce((n, f) => n + f.size, 0);
  const allSelected = files.length > 0 && files.every((f) => selected.has(f.id));
  const fileName = (f: ReplaceableFile) => {
    if (!isSeries || f.episodes.length === 0) return f.relativePath;
    const titles = episodeTitles(f);
    return `${episodeSummary(f.episodes)}${titles ? ` · ${titles}` : ""} · ${f.relativePath}`;
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && busy !== "replace") onClose(); }}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="max-w-2xl">
          <div className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6 border-b border-zinc-700 flex-shrink-0">
            <DialogTitle className="text-base font-semibold text-zinc-100">
              {t("adminQueue.issueActions.replaceFile")}
            </DialogTitle>
            <div className="flex items-center gap-3">
              {instances.length > 1 && (
                <StyledSelect
                  compact
                  value={instance}
                  onChange={(e) => pickInstance(e.target.value)}
                  disabled={busy !== null}
                  aria-label={t("adminQueue.issueActions.instance")}
                  className="w-auto md:text-xs"
                >
                  {instances.map((i) => (
                    <option key={i.slug || "default"} value={i.slug}>{i.name}</option>
                  ))}
                </StyledSelect>
              )}
              <DialogClose
                disabled={busy === "replace"}
                aria-label={t("adminQueue.common.close")}
                title={t("adminQueue.common.close")}
                className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
              >
                <X className="w-5 h-5" />
              </DialogClose>
            </div>
          </div>

          <DialogContent className="grid gap-3 p-4 sm:p-6">
            <p className="m-0 text-xs text-zinc-400">
              {t("adminQueue.issueActions.replaceFileIntro", { service: serviceName })}
            </p>

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

            {error && (
              <p role="alert" className="m-0 flex flex-wrap items-center gap-1.5 text-xs text-red-400">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{error}</span>
                {listing === null && busy === null && (
                  <Button variant="ghost" size="sm" onClick={retry}><RefreshCw /> {t("adminArr.common.retry")}</Button>
                )}
              </p>
            )}

            {busy === "list" ? (
              <div className="flex items-center justify-center gap-3 py-10 text-sm text-zinc-500">
                <Loader2 className="h-5 w-5 animate-spin" />
                {t("adminQueue.issueActions.replaceFileLoading")}
              </div>
            ) : listing === null || done ? null : files.length === 0 ? (
              <p className="m-0 py-6 text-center text-sm text-zinc-500">{t("adminQueue.issueActions.replaceFileNone")}</p>
            ) : (
              <>
                {isSeries && listing.seriesType === "anime" && (
                  <p className="m-0 flex items-start gap-1.5 text-xs text-amber-400">
                    <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                    {t("adminQueue.issueActions.replaceFileAnimeNumbering", { service: serviceName })}
                  </p>
                )}
                <label className="flex items-center gap-2 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) => { setSelected(e.target.checked ? new Set(files.map((f) => f.id)) : new Set()); setConfirm(null); }}
                    disabled={busy !== null}
                    className="accent-[var(--ds-accent)]"
                  />
                  {t("adminArr.files.selectAll")}
                </label>
                <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
                  {files.map((f, i) => (
                    <li key={f.id} className="flex items-start gap-3 px-3 py-2.5" style={i > 0 ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
                      <input
                        type="checkbox"
                        checked={selected.has(f.id)}
                        onChange={() => toggle(f.id)}
                        disabled={busy !== null}
                        className="mt-1 accent-[var(--ds-accent)]"
                        aria-label={t("adminQueue.issueActions.replaceFileSelectAria", { name: f.relativePath })}
                      />
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
                          {f.qualityCutoffNotMet && <Chip tone="pending">{t("adminArr.files.cutoffUnmet")}</Chip>}
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

          </DialogContent>

          {listing !== null && files.length > 0 && !done && (
            // The confirm takes the footer's place, so it can never be scrolled
            // out of view below a long file list.
            <div className="grid px-4 py-4 sm:px-6 border-t border-zinc-700 bg-zinc-900 flex-shrink-0">
              {confirm && chosen.length > 0 ? (
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
                    {confirm === "markFailed"
                      ? t("adminQueue.issueActions.replaceFileConfirmBlocklist", { service: serviceName })
                      : t("adminQueue.issueActions.replaceFileConfirmSearch", { service: serviceName })}
                  </span>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setConfirm(null)} disabled={busy !== null}>
                      {t("shared.common.cancel")}
                    </Button>
                    <Button
                      size="sm"
                      className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]"
                      onClick={() => void replace(confirm)}
                      disabled={busy !== null}
                    >
                      {busy === "replace" ? <Loader2 className="animate-spin" /> : <Trash2 />}
                      {t("adminQueue.issueActions.replaceFileConfirmButton")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirm("search")}
                    disabled={selected.size === 0 || busy !== null}
                    className="h-auto min-h-7 whitespace-normal py-1.5 text-left"
                  >
                    <Search />
                    {t("adminQueue.issueActions.replaceFileSearch")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirm("markFailed")}
                    disabled={selected.size === 0 || busy !== null}
                    className="h-auto min-h-7 whitespace-normal py-1.5 text-left"
                  >
                    <FileX />
                    {t("adminQueue.issueActions.replaceFileBlocklist", { service: serviceName })}
                  </Button>
                </div>
              )}
            </div>
          )}
          {done && (
            <div className="flex justify-end px-4 py-4 sm:px-6 border-t border-zinc-700 bg-zinc-900 flex-shrink-0">
              <Button size="sm" onClick={onClose}>{t("adminQueue.common.close")}</Button>
            </div>
          )}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
