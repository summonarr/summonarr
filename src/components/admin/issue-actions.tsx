"use client";

import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Chip } from "@/components/ui/design";
import {
  Loader2, Check, RefreshCw, AlertTriangle, Clock, Trash2,
  Download, ChevronDown, ChevronUp, ChevronLeft, Magnet, Radio, Search, X,
} from "@/components/icons";
import type { ArrRelease } from "@/lib/arr";
import type { ReplaceableFile, ReplaceFollowUp } from "@/lib/issue-replace";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { ageFormatter, sizeFormatter } from "./release-search-dialog";
import { episodeSummary, queueFormatters } from "@/components/admin/queue-format";
import { ManageTitleButton } from "@/components/admin/arr-title/title-manager";
import { arrInstanceLabel } from "@/components/admin/open-in-arr";
import { manageTabFor } from "@/lib/arr-manage-links";
import { holdLiveRefresh, requestPageRefresh } from "@/lib/client/refresh-hold";
import { runReplaceFileJob } from "@/lib/client/replace-file-job";
import { runReleaseSearchJob } from "@/lib/client/release-search-job";
import { seriesReleaseScopeSearchable } from "@/lib/release-scope";
import { defaultFileSelection, defaultRelease, fixAdvice, rejectedOnlyForFileOnDisk, type FixAdvice } from "@/lib/issue-fix";

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
  // More than one ⇒ the Fix file window shows an instance picker.
  instances?: { slug: string; name: string }[];
  // The viewer is an ADMIN: reading and deleting the files on disk is
  // ADMIN-only (the files route is withAdmin). Cosmetic — the route decides.
  isAdmin?: boolean;
  // ADMIN only: the title's TMDB id and the configured instances whose synced
  // cache holds it — one "Manage" icon each, opening the title manager there.
  manage?: { tmdbId: number; holders: { slug: string; name: string }[] };
  // Which edge the two rows hug: the list card keeps them at its end, the side
  // panel and the mobile detail start them at the left under the issue.
  align?: "start" | "end";
  // The claim control (rendered by the page), first in the status row.
  claim?: ReactNode;
  // A WRONG_MATCH issue's Fix match (rendered by the page), first in the fix row.
  fixMatch?: ReactNode;
}

// Two rows: fixing the file (Fix match, Fix file, Manage) and working the
// issue (claim, In progress, Resolve/Reopen, Delete). Fix file is ONE window
// in place of the old Refetch / Replace / Replace file buttons — see
// src/lib/issue-fix.ts for why.
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
  align = "end",
  claim,
  fixMatch,
}: IssueActionsProps) {
  const router = useRouter();
  const t = useT();

  const [loading, setLoading] = useState<"status" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"resolve" | "delete" | "fix" | null>(null);
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

  async function updateStatus(status: string, resolutionNote?: string) {
    setLoading("status");
    setError(null);
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
        setError(data.message ?? data.error ?? t("adminQueue.issueActions.statusFailed"));
        return;
      }
      // The change is announced over SSE too; the page's one shared refresh
      // (refresh-hold.ts) makes the two a single reload.
      requestPageRefresh(() => router.refresh());
    } catch {
      // `finally` closes the resolve panel either way, so without this a network
      // failure looked exactly like a successful resolve: panel gone, no error.
      setError(t("shared.thread.networkError"));
    } finally {
      setLoading(null);
      setPanel(null);
    }
  }

  async function deleteIssue() {
    setLoading("delete");
    setError(null);
    try {
      const res = await fetch(withBasePath(`/api/issues/${issueId}`), { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error ?? t("adminQueue.actions.deleteFailed"));
        return;
      }
      requestPageRefresh(() => router.refresh());
    } catch {
      setError(t("shared.thread.networkError"));
    } finally {
      setLoading(null);
      setPanel(null);
    }
  }

  // A whole-series TV issue has no release list: Sonarr's series-only query is
  // the indexers' RSS feed, other shows included (release-scope.ts). The
  // window's search, or an admin's delete, covers it.
  const canPickRelease = mediaType === "MOVIE"
    || (seriesReleaseScopeSearchable(scope, seasonNumber, episodeNumber) && (!!tvdbId || scope === "EPISODE"));
  const isResolved = currentStatus === "RESOLVED";
  const isInProgress = currentStatus === "IN_PROGRESS";
  const justify = align === "start" ? "justify-start" : "justify-end";

  const scopeDetail =
    scope === "EPISODE" && seasonNumber != null && episodeNumber != null
      ? `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`
      : scope === "SEASON" && seasonNumber != null
      ? t("adminQueue.issues.scope.seasonN", { number: seasonNumber })
      : null;

  const service = mediaType === "MOVIE" ? "radarr" : "sonarr";
  const manageIcons = isAdmin && manage
    ? manage.holders.map((h) => (
        <ManageTitleButton
          key={h.slug}
          service={service}
          instance={h.slug}
          target={{ tmdbId: manage.tmdbId }}
          instanceLabel={arrInstanceLabel(service, h.name, h.slug)}
          variant="icon"
          initialTab={manageTabFor("issue", service)}
        />
      ))
    : [];
  const showFixRow = fixMatch != null || !isResolved || manageIcons.length > 0;

  return (
    // No `shrink-0`: a non-shrinking flex item keeps its max-content width, and
    // the max-content of a wrapping button row is the SUM of its buttons, so
    // the inner flex-wrap could never engage and the row was clipped by the xl
    // aside or pushed off a phone-width card. `min-w-0` lets it wrap.
    <div className={`flex flex-col gap-1.5 min-w-0 ${align === "start" ? "items-start" : "items-end"}`}>
      {scopeDetail && (
        <span className="text-[10px] text-zinc-500 font-mono">{scopeDetail}</span>
      )}
      {libraryConfirmed && scope === "EPISODE" && !isResolved && (
        <span className="text-[10px] text-sky-400">{t("adminQueue.issueActions.matchConfirmed")}</span>
      )}

      {showFixRow && (
        <div className={`flex items-center gap-2 flex-wrap ${justify}`}>
          {fixMatch}
          {!isResolved && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setError(null); setPanel("fix"); }}
              disabled={loading !== null}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-300 hover:text-sky-400 hover:border-sky-500/50 gap-1"
            >
              <RefreshCw className="w-3 h-3" />
              {t("adminQueue.issueActions.fixFile")}
            </Button>
          )}
          {manageIcons}
        </div>
      )}

      <div className={`flex items-center gap-2 flex-wrap ${justify}`}>
        {claim}

        {panel === "resolve" ? (
          <div className="flex items-center gap-1.5">
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
        ) : panel === "delete" ? (
          <div className="flex items-center gap-1.5">
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
        ) : (
          <>
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
          </>
        )}
      </div>

      {panel === "fix" && (
        <FixFileDialog
          issueId={issueId}
          mediaType={mediaType}
          scope={scope}
          libraryConfirmed={libraryConfirmed === true}
          isAdmin={isAdmin}
          canPickRelease={canPickRelease}
          instance={instance}
          instances={instanceOptions}
          onInstanceChange={setPickedInstance}
          onClose={() => setPanel(null)}
        />
      )}

      {error && (
        <span className="flex items-center gap-1 text-[11px] text-amber-400 max-w-52 text-right">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          {error}
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

const ADVICE_KEY: Record<FixAdvice, string> = {
  broken: "adminQueue.issueActions.adviceBroken",
  upgrade: "adminQueue.issueActions.adviceUpgrade",
  nothing: "adminQueue.issueActions.adviceNothing",
  unknown: "adminQueue.issueActions.adviceUnknown",
};

// "Fix file": one window for getting a working copy of what the issue is
// about. It reads what is on disk first (ADMIN — the listing names paths and
// releases), then leads with the fix that can work:
// - a file that meets the cutoff → delete it and get a new copy (a search
//   only takes an UPGRADE of a file on disk, so it would do nothing);
// - a file below the cutoff, or none → search automatically;
// - always (where Sonarr can search the scope) → pick a release by hand.
// The delete goes through /api/issues/[id]/files, which re-reads the files and
// history and checks every id against the issue's scope before anything is
// deleted (guardrail 5f); the search is the issue's PATCH { refetch }; the
// release list is /api/issues/[id]/releases. Nothing is read twice: the files
// once per instance, the release search only when the admin opens the list.
function FixFileDialog({
  issueId,
  mediaType,
  scope,
  libraryConfirmed,
  isAdmin,
  canPickRelease,
  instance,
  instances,
  onInstanceChange,
  onClose,
}: {
  issueId: string;
  mediaType: string;
  scope: string;
  libraryConfirmed: boolean;
  isAdmin: boolean;
  canPickRelease: boolean;
  instance: string;
  instances: { slug: string; name: string }[];
  onInstanceChange: (slug: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  // The release list reads like the request queue's Pick release: sizes and
  // ages in the viewer's locale, seeders through the plural key.
  const formatSize = useMemo(() => sizeFormatter(locale), [locale]);
  const formatAge = useMemo(() => ageFormatter(locale), [locale]);
  const serviceName = mediaType === "MOVIE" ? "Radarr" : "Sonarr";
  const isSeries = mediaType !== "MOVIE";

  const [view, setView] = useState<"options" | "releases">("options");
  // The one write running, if any: the delete, the search or the grab. While
  // it runs the window can't be closed, switched or left.
  const [action, setAction] = useState<"replace" | "search" | "grab" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // What's on disk (ADMIN only).
  const [listing, setListing] = useState<FileListing | null>(null);
  const [listLoading, setListLoading] = useState(isAdmin);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  // Ticked: the delete marks each file's release failed, so it is blocklisted
  // and not downloaded again. Unticked: the delete is followed by a search.
  const [blockRelease, setBlockRelease] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ReplaceResult | null>(null);
  const [searched, setSearched] = useState(false);
  // Only the newest read may write state — switching instances twice must not
  // let the older answer land on the newer instance's list.
  const reqRef = useRef(0);

  // The release list — searched only when the admin opens it, once per
  // instance (Search again re-runs it).
  const [releases, setReleases] = useState<ArrRelease[] | null>(null);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
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

  // The page's live refresh waits while this window is open (refresh-hold.ts):
  // the delete, the search and the grab all flip the issue to IN_PROGRESS and
  // announce it, and on the OPEN tab a refresh would unmount the issue's row —
  // and this window with its result and warnings — mid-request. Unmounting
  // (the window closing) releases it, and any refresh asked for meanwhile runs then.
  useEffect(() => holdLiveRefresh(), []);
  // Polling stops once the window is gone.
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
      const data = (await res.json().catch(() => ({}))) as Partial<FileListing> & { error?: string };
      if (reqId !== reqRef.current) return;
      if (!res.ok || !Array.isArray(data.files)) {
        setListing(null);
        setListError(data.error ?? t("adminQueue.issueActions.replaceFileLoadFailed"));
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

  // Read on open and whenever the instance changes — ADMIN only.
  useEffect(() => {
    if (isAdmin) void load(instance);
  }, [isAdmin, load, instance]);

  async function loadReleases(targetInstance: string) {
    const reqId = ++releaseReqRef.current;
    setReleasesLoading(true);
    setReleaseError(null);
    setReleases(null);
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
        setReleaseError(data?.error ?? t("adminQueue.issueActions.releasesFailed"));
      } else {
        const data = answer.data as ArrRelease[];
        setReleases(data);
        setSelectedGuid(defaultRelease(data));
      }
    } catch {
      // Report the failure (only if this is still the latest search). Otherwise the
      // list would say "No releases found", which is a different claim from "the
      // search never completed".
      if (reqId === releaseReqRef.current) setReleaseError(t("shared.thread.networkError"));
    } finally {
      // Guarded too: a stale request clearing the spinner makes the UI read "done" while the
      // current search is still running.
      if (reqId === releaseReqRef.current) setReleasesLoading(false);
    }
  }

  // Leaving the list (Back, the instance switch, closing) supersedes a search
  // still polling: it stops, and its late answer writes nothing.
  function stopReleaseSearch() {
    releaseReqRef.current++;
    setReleasesLoading(false);
  }

  function openReleases() {
    setActionError(null);
    setView("releases");
    // Searched once per instance; a failed or abandoned search runs again.
    if (releases === null && !releasesLoading) void loadReleases(instance);
  }

  function backToOptions() {
    if (releasesLoading) stopReleaseSearch();
    setReleaseError(null);
    setView("options");
  }

  function close() {
    stopReleaseSearch();
    onClose();
  }

  function pickInstance(next: string) {
    stopReleaseSearch();
    setListing(null);
    setListLoading(isAdmin);
    setListError(null);
    setSelected(new Set());
    setConfirming(false);
    setResult(null);
    setSearched(false);
    setActionError(null);
    setReleases(null);
    setReleaseError(null);
    setGrabOk(false);
    onInstanceChange(next);
    // The files are re-read by the effect above; the open list searches the new instance.
    if (view === "releases") void loadReleases(next);
  }

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirming(false);
  }

  async function searchNow() {
    setAction("search");
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
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setActionError(data.message ?? data.error ?? t("adminQueue.issueActions.searchFailed", { status: res.status }));
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
      setAction(null);
    }
  }

  async function replace(then: ReplaceFollowUp) {
    setAction("replace");
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
          // Once the window closes — the issue may leave this tab's list.
          requestPageRefresh(() => router.refresh());
        }
        if (!res.ok) {
          setActionError(data.error ?? t("adminQueue.issueActions.replaceFileFailed"));
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
      setAction(null);
      setConfirming(false);
    }
    if (reload) {
      void load(instance);
    }
  }

  async function grabRelease() {
    if (!selectedGuid || releases === null) return;
    const rel = releases.find((r) => r.guid === selectedGuid);
    if (!rel) return;
    setAction("grab");
    setReleaseError(null);
    try {
      const res = await fetch(withBasePath(`/api/issues/${issueId}/releases`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guid: rel.guid, indexerId: rel.indexerId, instance }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setReleaseError(data.error ?? t("adminQueue.issueActions.grabFailed"));
      } else {
        setGrabOk(true);
        // Once the window closes — not under the "grab queued" it is showing.
        requestPageRefresh(() => router.refresh());
      }
    } catch {
      setReleaseError(t("shared.thread.networkError"));
    } finally {
      setAction(null);
    }
  }

  // Keep a visible release selected as the filter and the rejected toggle change.
  const filterTerm = releaseFilter.toLowerCase();
  const isShown = useCallback(
    (r: ArrRelease) => (showRejected || !r.rejected || rejectedOnlyForFileOnDisk(r))
      && (filterTerm === "" || r.title.toLowerCase().includes(filterTerm)),
    [showRejected, filterTerm],
  );
  const visibleReleases = useMemo(() => (releases ?? []).filter(isShown), [releases, isShown]);
  useEffect(() => {
    if (view !== "releases" || releases === null || releases.length === 0) return;
    if (visibleReleases.length === 0) { setSelectedGuid(null); return; }
    if (!visibleReleases.some((r) => r.guid === selectedGuid)) setSelectedGuid(visibleReleases[0].guid);
  }, [view, releases, visibleReleases, selectedGuid]);

  useEffect(() => {
    if (view === "releases" && releases !== null && releases.length > 0 && !releasesLoading) {
      setTimeout(() => filterRef.current?.focus(), 50);
    }
  }, [view, releases, releasesLoading]);

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
  const rejectedCount = (releases ?? []).filter((r) => r.rejected && !rejectedOnlyForFileOnDisk(r)).length;
  const anyDiskOnly = (releases ?? []).some(rejectedOnlyForFileOnDisk);

  // The choices, best first for what is on disk. Delete needs listed files.
  const canDelete = isAdmin && files.length > 0;
  const order: Array<"delete" | "search" | "pick"> =
    advice === "broken" ? ["delete", "pick", "search"]
    : advice === "upgrade" ? ["search", "delete", "pick"]
    : ["search", "pick", "delete"];
  const choices = order.filter((c) => (c === "delete" ? canDelete : c === "pick" ? canPickRelease : true));
  const primary = choices[0];

  const instancePicker = instances.length > 1 && (
    <StyledSelect
      compact
      value={instance}
      onChange={(e) => pickInstance(e.target.value)}
      disabled={working}
      aria-label={t("adminQueue.issueActions.instance")}
      className="w-auto md:text-xs"
    >
      {instances.map((i) => (
        <option key={i.slug || "default"} value={i.slug}>{i.name}</option>
      ))}
    </StyledSelect>
  );

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
              onChange={(e) => { setBlockRelease(e.target.checked); setConfirming(false); }}
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
        <Button size="sm" variant={variant} onClick={openReleases} disabled={working} className="justify-self-start">
          <Download />
          {t("adminQueue.issueActions.choicePick")}
        </Button>
        <span className="text-xs text-zinc-400">{t("adminQueue.issueActions.choicePickHint", { service: serviceName })}</span>
      </div>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !working) close(); }}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="max-w-3xl">
          <div className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6 border-b border-zinc-700 flex-shrink-0">
            <div className="flex min-w-0 items-center gap-2">
              {view === "releases" && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={backToOptions}
                  disabled={working}
                  aria-label={t("adminQueue.issueActions.back")}
                  title={t("adminQueue.issueActions.back")}
                >
                  <ChevronLeft />
                </Button>
              )}
              <DialogTitle className="text-base font-semibold text-zinc-100">
                {view === "releases" ? t("adminQueue.issueActions.choicePick") : t("adminQueue.issueActions.fixFile")}
              </DialogTitle>
            </div>
            <div className="flex items-center gap-3">
              {instancePicker}
              <DialogClose
                disabled={working}
                aria-label={t("adminQueue.common.close")}
                title={t("adminQueue.common.close")}
                className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
              >
                <X className="w-5 h-5" />
              </DialogClose>
            </div>
          </div>

          {view === "options" ? (
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
                  <Button size="sm" onClick={close}>{t("adminQueue.common.close")}</Button>
                </div>
              )}
            </>
          ) : releasesLoading ? (
            <div className="flex items-center justify-center gap-3 text-sm text-zinc-500 py-16">
              <Loader2 className="w-5 h-5 animate-spin" />
              {t("adminQueue.issueActions.searching")}
            </div>
          ) : grabOk ? (
            <>
              <div className="flex items-center justify-center gap-2 text-sm text-green-400 py-16">
                <Check className="w-4 h-4" />
                {t("adminQueue.issueActions.grabQueued")}
              </div>
              <div className="flex justify-end px-4 py-4 sm:px-6 border-t border-zinc-700 bg-zinc-900 flex-shrink-0">
                <Button size="sm" onClick={close}>{t("adminQueue.common.close")}</Button>
              </div>
            </>
          ) : releases === null || releases.length === 0 ? (
            <div className="grid justify-items-center gap-3 px-6 py-16 text-center text-sm">
              {releases === null ? (
                <span role="alert" className="flex items-start gap-1.5 text-red-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  {releaseError ?? t("adminQueue.issueActions.releasesFailed")}
                </span>
              ) : (
                <span className="text-zinc-500">{t("adminQueue.issueActions.noReleases")}</span>
              )}
              <Button variant="ghost" size="sm" onClick={() => void loadReleases(instance)} disabled={working}>
                <RefreshCw />
                {t("adminQueue.issueActions.searchAgain")}
              </Button>
            </div>
          ) : (
            <>
              {libraryConfirmed && scope === "EPISODE" && (
                <div className="px-6 py-2.5 bg-sky-500/10 border-b border-sky-500/30 flex items-center gap-2 flex-shrink-0">
                  <span className="text-xs text-sky-400">
                    {t("adminQueue.issueActions.matchBanner")}
                  </span>
                </div>
              )}

              <div className="px-6 py-3 border-b border-zinc-800 flex-shrink-0 grid gap-2">
                {anyDiskOnly && (
                  <p className="m-0 text-xs text-zinc-400">{t("adminQueue.issueActions.notBetterNote", { service: serviceName })}</p>
                )}
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
                  <p className="m-0 text-xs text-zinc-500 text-center">
                    {t("adminQueue.issueActions.noMatch", { filter: releaseFilter })}{" "}
                    <button type="button" onClick={() => setReleaseFilter("")} className="text-zinc-400 hover:text-zinc-200 underline">{t("adminQueue.list.clear")}</button>
                  </p>
                )}
              </div>

              <div className="overflow-y-auto flex-1 divide-y divide-zinc-800">
                {visibleReleases.map((rel) => {
                  const isSelected = selectedGuid === rel.guid;
                  const diskOnly = rejectedOnlyForFileOnDisk(rel);
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
                          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${profileMatch || diskOnly ? "bg-sky-500/10 text-sky-400" : "bg-zinc-800 text-zinc-500"}`}>
                            {rel.quality.quality.name}
                            {rel.quality.revision.version > 1 && ` v${rel.quality.revision.version}`}
                          </span>
                          <span className="text-xs text-zinc-500">{formatSize(rel.size)}</span>
                          <span className="text-xs text-zinc-500">{rel.indexer}</span>
                          {rel.protocol === "torrent" && rel.seeders != null && (
                            <span className={`text-xs ${rel.seeders > 5 ? "text-green-400" : rel.seeders > 0 ? "text-yellow-400" : "text-red-400"}`}>
                              {t("adminQueue.releases.seeders", { count: rel.seeders })}
                            </span>
                          )}
                          <span className="text-xs text-zinc-500">{formatAge(rel.age)}</span>
                          {diskOnly && <Chip tone="pending">{t("adminQueue.issueActions.notBetter")}</Chip>}
                        </div>
                        {rel.rejected && !diskOnly && rel.rejections.length > 0 && (
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
                  type="button"
                  onClick={() => setShowRejected((v) => !v)}
                  className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-zinc-500 hover:text-zinc-400 border-t border-zinc-800 transition-colors flex-shrink-0"
                >
                  {showRejected ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  {showRejected ? t("adminQueue.issueActions.hideRejected", { count: rejectedCount }) : t("adminQueue.issueActions.showRejected", { count: rejectedCount })}
                </button>
              )}

              {/* A refused grab is said HERE, inside the window. The arr's 410
                  ("search again") is what Search again answers. */}
              {releaseError && (
                <div role="alert" className="flex items-start justify-between gap-3 px-6 py-3 border-t border-zinc-800 bg-amber-500/10 flex-shrink-0">
                  <span className="flex items-start gap-1.5 text-xs text-amber-400">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                    {releaseError}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void loadReleases(instance)}
                    disabled={working}
                    className="shrink-0"
                  >
                    <RefreshCw />
                    {t("adminQueue.issueActions.searchAgain")}
                  </Button>
                </div>
              )}

              <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-700 bg-zinc-900 flex-shrink-0">
                <button type="button" onClick={backToOptions} disabled={working} className="rounded px-2 py-1 text-sm text-zinc-500 hover:text-zinc-300 disabled:opacity-40">{t("adminQueue.issueActions.back")}</button>
                <Button size="sm" onClick={grabRelease} disabled={!selectedGuid || working}>
                  {action === "grab" ? <Loader2 className="animate-spin" /> : <Download />}
                  {t("adminQueue.issueActions.grab")}
                </Button>
              </div>
            </>
          )}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
