"use client";

import { useState, useEffect, useRef, useMemo, useDeferredValue, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Chip } from "@/components/ui/design";
import {
  Loader2, Check, RefreshCw, AlertTriangle, Clock, Trash2,
  Download, ChevronDown, ChevronUp, ChevronLeft, Magnet, Radio, Search, X,
} from "@/components/icons";
import type { ArrRelease } from "@/lib/arr";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { ageFormatter, sizeFormatter } from "./queue-format";
import { FixFileOptions, type FixFileAction } from "./issue-fix-options";
import { releaseListOf } from "./issue-fix-answers";
import { ManageTitleButton } from "@/components/admin/arr-title/title-manager";
import { arrInstanceLabel } from "@/components/admin/open-in-arr";
import { manageTabFor } from "@/lib/arr-manage-links";
import { holdLiveRefresh, requestPageRefresh } from "@/lib/client/refresh-hold";
import { apiErrorText } from "@/lib/client/api-error";
import { fetchJson, jsonInit, type FetchJsonFailure } from "@/lib/client/fetch-json";
import { runReleaseSearchJob } from "@/lib/client/release-search-job";
import { useAsyncAction } from "@/hooks/use-async-action";
import { seriesReleaseScopeSearchable } from "@/lib/release-scope";
import { defaultRelease, rejectedOnlyForFileOnDisk } from "@/lib/issue-fix";
import { arrServiceName } from "@/lib/arr-service-name";

// A grab answers once the arr has fetched the .torrent/.nzb and handed it to
// the download client — the server waits up to 120 s for that (arr-releases.ts).
const GRAB_TIMEOUT_MS = 150_000;

// A failed write's line: the route's own reason, or the network line when no
// answer came at all.
function writeErrorText(res: FetchJsonFailure, t: Translator): string {
  return res.kind === "http" ? res.error : t("shared.thread.networkError");
}

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

// ManageTitleButton's onActiveChange for the issue page: one hold on the page's
// live refresh (refresh-hold.ts) per open title manager, released when it closes
// or unmounts. Why: a refresh can drop this issue's row — a duplicate report
// makes another issue the group's representative (the row's key), a status
// change moves it off the tab — and the manager with it, unsaved edits and all.
function managerRefreshHolds(): (slug: string, open: boolean) => void {
  const holds = new Map<string, () => void>();
  return (slug, open) => {
    holds.get(slug)?.();
    holds.delete(slug);
    if (open) holds.set(slug, holdLiveRefresh());
  };
}

// "S01E02" for an episode, "Season 1" for a season, nothing for the rest.
function scopeDetailOf(scope: string, seasonNumber: number | null, episodeNumber: number | null, t: Translator): string | null {
  if (scope === "EPISODE" && seasonNumber != null && episodeNumber != null) {
    return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
  }
  if (scope === "SEASON" && seasonNumber != null) return t("adminQueue.issues.scope.seasonN", { number: seasonNumber });
  return null;
}

// The status row's buttons when no panel is open: In progress, Resolve (or
// Reopen) and Delete.
function StatusButtons({
  isResolved,
  isInProgress,
  busy,
  statusLoading,
  onInProgress,
  onResolve,
  onReopen,
  onDelete,
}: {
  isResolved: boolean;
  isInProgress: boolean;
  busy: boolean;
  statusLoading: boolean;
  onInProgress: () => void;
  onResolve: () => void;
  onReopen: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <>
      {!isResolved && !isInProgress && (
        <Button
          size="sm"
          variant="outline"
          onClick={onInProgress}
          disabled={busy}
          className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-yellow-400 hover:border-yellow-500/50 gap-1"
        >
          {statusLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Clock className="w-3 h-3" />}
          {t("personal.issues.status.inProgress")}
        </Button>
      )}

      {!isResolved && (
        <Button
          size="sm"
          variant="outline"
          onClick={onResolve}
          disabled={busy}
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
          onClick={onReopen}
          disabled={busy}
          className="h-7 px-3 text-xs border-zinc-700 text-zinc-500 hover:text-zinc-100 gap-1"
        >
          {t("adminQueue.issueActions.reopen")}
        </Button>
      )}

      <Button
        size="sm"
        variant="outline"
        onClick={onDelete}
        disabled={busy}
        aria-label={t("adminQueue.issueActions.deleteIssue")}
        title={t("adminQueue.issueActions.deleteIssue")}
        className="h-7 px-3 text-xs border-zinc-700 text-zinc-500 hover:text-red-400 hover:border-red-500/50"
      >
        <Trash2 className="w-3 h-3" />
      </Button>
    </>
  );
}

function DeleteConfirm({ busy, deleting, onDelete, onCancel }: { busy: boolean; deleting: boolean; onDelete: () => void; onCancel: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-zinc-400">{t("adminQueue.issueActions.deleteConfirm")}</span>
      <Button
        size="sm"
        onClick={onDelete}
        disabled={busy}
        className="h-6 px-2 text-xs bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] gap-1"
      >
        {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
        {t("adminQueue.actions.delete")}
      </Button>
      <button type="button" onClick={onCancel} className="rounded px-2 py-1 text-zinc-500 hover:text-zinc-400 text-xs">{t("shared.common.cancel")}</button>
    </div>
  );
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
  const [onManagerActive] = useState<(slug: string, open: boolean) => void>(managerRefreshHolds);
  // The status this card showed when a change or a delete went through. The
  // page's refresh is debounced (and deferred while any dialog holds it), so
  // until a new `currentStatus` arrives (or the row goes) the buttons describe
  // the issue as it WAS: a second Delete 404'd, and a stale "In progress" after
  // a Resolve passed the server's check against the new status and reopened it.
  // So the lock stays until the server says otherwise — and says so on the card
  // (the "Updating…" line below) instead of leaving the buttons dead unexplained.
  const [actedFrom, setActedFrom] = useState<string | null>(null);
  if (actedFrom !== null && actedFrom !== currentStatus) setActedFrom(null);
  const busy = loading !== null || actedFrom !== null;

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
    if (busy) return;
    setLoading("status");
    setError(null);
    const res = await fetchJson(withBasePath(`/api/issues/${issueId}`), {
      init: jsonInit("PATCH", { status, resolution: resolutionNote }),
      fallbackError: t("adminQueue.issueActions.statusFailed"),
    });
    // A failure keeps the resolve panel open beside the error, note and all.
    setLoading(null);
    // A 2xx whose body can't be read still changed the status.
    if (!res.ok && res.kind !== "invalid") {
      // The route's reason, `message` first — a concurrent status change answers
      // { error: "status-conflict", message: "<sentence>" }; the slug alone is noise.
      setError(writeErrorText(res, t));
      return;
    }
    setActedFrom(currentStatus);
    // Sent: a later Resolve (after a Reopen) starts from an empty note
    // instead of re-sending, and re-announcing, this one.
    setResolution("");
    setPanel(null);
    // The change is announced over SSE too; the page's one shared refresh
    // (refresh-hold.ts) makes the two a single reload.
    requestPageRefresh(() => router.refresh());
  }

  async function deleteIssue() {
    if (busy) return;
    setLoading("delete");
    setError(null);
    const res = await fetchJson(withBasePath(`/api/issues/${issueId}`), {
      init: { method: "DELETE" },
      fallbackError: t("adminQueue.actions.deleteFailed"),
    });
    setLoading(null);
    setPanel(null);
    if (!res.ok && res.kind !== "invalid") {
      setError(writeErrorText(res, t));
      return;
    }
    setActedFrom(currentStatus);
    requestPageRefresh(() => router.refresh());
  }

  // A whole-series TV issue has no release list: Sonarr's series-only query is
  // the indexers' RSS feed, other shows included (release-scope.ts). The
  // window's search, or an admin's delete, covers it.
  const canPickRelease = mediaType === "MOVIE"
    || (seriesReleaseScopeSearchable(scope, seasonNumber, episodeNumber) && (!!tvdbId || scope === "EPISODE"));
  const isResolved = currentStatus === "RESOLVED";
  const isInProgress = currentStatus === "IN_PROGRESS";
  const justify = align === "start" ? "justify-start" : "justify-end";
  const scopeDetail = scopeDetailOf(scope, seasonNumber, episodeNumber, t);

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
          onActiveChange={(open) => onManagerActive(h.slug, open)}
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
              disabled={busy}
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
          // A form, so Enter in the note submits it like Done.
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void updateStatus("RESOLVED", resolution || undefined);
            }}
          >
            <input
              type="text"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              placeholder={t("adminQueue.issueActions.resolutionPlaceholder")}
              aria-label={t("adminQueue.issueActions.resolutionAria")}
              className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 focus-visible:ring-2 focus-visible:ring-ring w-44"
            />
            <Button
              type="submit"
              size="sm"
              disabled={busy}
              className="h-6 px-2 text-xs bg-green-600 text-[var(--ds-on-status)] hover:bg-green-600/90 gap-1"
            >
              {loading === "status" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              {t("adminQueue.actions.done")}
            </Button>
            <button type="button" onClick={() => setPanel(null)} className="rounded px-2 py-1 text-zinc-500 hover:text-zinc-400 text-xs">{t("shared.common.cancel")}</button>
          </form>
        ) : panel === "delete" ? (
          <DeleteConfirm busy={busy} deleting={loading === "delete"} onDelete={() => void deleteIssue()} onCancel={() => setPanel(null)} />
        ) : (
          <StatusButtons
            isResolved={isResolved}
            isInProgress={isInProgress}
            busy={busy}
            statusLoading={loading === "status"}
            onInProgress={() => void updateStatus("IN_PROGRESS")}
            onResolve={() => setPanel("resolve")}
            onReopen={() => void updateStatus("OPEN")}
            onDelete={() => setPanel("delete")}
          />
        )}
      </div>

      {actedFrom !== null && (
        // Done on the server; the card follows once the page's refresh lands.
        <span role="status" className="flex items-center gap-1 text-[11px] text-zinc-500">
          <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
          {t("adminQueue.issueActions.updating")}
        </span>
      )}

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

// One instance's release search: the answer's list (null until one came), the
// spinner, the error, and whether the grab went through. Tagged with the
// instance it ran on: the window reads it only while that instance is selected
// (releaseSearchOn), and a write lands only on its own instance's search
// (patchReleaseSearch), so one server's list — and its release handles — is
// never shown or grabbed on another.
interface ReleaseSearch {
  instance: string;
  releases: ArrRelease[] | null;
  loading: boolean;
  error: string | null;
  grabOk: boolean;
}

type ReleaseSearchPatch = Partial<Omit<ReleaseSearch, "instance">>;

function releaseSearchOn(search: ReleaseSearch | null, instance: string): ReleaseSearch | null {
  return search !== null && search.instance === instance ? search : null;
}

function patchReleaseSearch(instance: string, patch: ReleaseSearchPatch) {
  return (search: ReleaseSearch | null): ReleaseSearch | null =>
    search !== null && search.instance === instance ? { ...search, ...patch } : search;
}

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
//
// This window keeps the header, the release search and the one write in
// flight; the options view (FixFileOptions) owns what is on disk, the choices
// and the delete, per instance; ReleasesView shows the search, ReleasePicker
// owns one answer's list.
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
  const serviceName = arrServiceName(mediaType);

  const [view, setView] = useState<"options" | "releases">("options");
  // The one write running, if any: the delete, the search or the grab. While
  // it runs the window can't be switched to another instance or left for the
  // other view. It CAN be closed: the server finishes the write either way
  // (a delete runs as a background job), and a replace's polls run for up to
  // ten minutes — the admin was stuck behind the window all that time.
  const [action, setAction] = useState<FixFileAction | null>(null);
  // The grab's request: aborted (its answer dropped) when the window closes.
  const writes = useAsyncAction();
  // Ticked: the delete marks each file's release failed, so it is blocklisted
  // and not downloaded again. Unticked: the delete is followed by a search.
  // The window's choice, not one instance's: a switch leaves it as it was.
  const [blockRelease, setBlockRelease] = useState(true);

  // The release list — searched only when the admin opens it, once per
  // instance (Search again re-runs it). The selection, filter and rejected
  // toggle live in ReleasePicker, which each new answer remounts.
  const [search, setSearch] = useState<ReleaseSearch | null>(null);
  const current = releaseSearchOn(search, instance);
  const releases = current?.releases ?? null;
  const releasesLoading = current?.loading === true;
  const releaseError = current?.error ?? null;
  const grabOk = current?.grabOk === true;
  const patchSearch = (target: string, patch: ReleaseSearchPatch) => setSearch(patchReleaseSearch(target, patch));
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

  async function loadReleases(targetInstance: string) {
    const reqId = ++releaseReqRef.current;
    setSearch({ instance: targetInstance, releases: null, loading: true, error: null, grabOk: false });
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
      // Checked before the list renders: a payload of another shape is the
      // search failing, never a crash inside the picker.
      const list = answer.status >= 200 && answer.status < 300 ? releaseListOf(answer.data) : null;
      if (list === null) {
        // The route's own reason (the integration switched off, an instance
        // that isn't a configured one), else "failed to fetch".
        patchSearch(targetInstance, { error: apiErrorText(answer.data, t("adminQueue.issueActions.releasesFailed")) });
      } else {
        patchSearch(targetInstance, { releases: list });
      }
    } catch {
      // Report the failure (only if this is still the latest search). Otherwise the
      // list would say "No releases found", which is a different claim from "the
      // search never completed".
      if (reqId === releaseReqRef.current) patchSearch(targetInstance, { error: t("shared.thread.networkError") });
    } finally {
      // Guarded too: a stale request clearing the spinner makes the UI read "done" while the
      // current search is still running.
      if (reqId === releaseReqRef.current) patchSearch(targetInstance, { loading: false });
    }
  }

  // Leaving the list (Back, the instance switch, closing) supersedes a search
  // still polling: it stops, and its late answer writes nothing.
  function stopReleaseSearch() {
    releaseReqRef.current++;
    setSearch((s) => (s === null ? s : { ...s, loading: false }));
  }

  // The pick choice (the options view clears its own error first).
  function openReleases() {
    setView("releases");
    // Searched once per instance; a failed or abandoned search runs again.
    if (releases === null && !releasesLoading) void loadReleases(instance);
  }

  function backToOptions() {
    if (releasesLoading) stopReleaseSearch();
    patchSearch(instance, { error: null });
    setView("options");
  }

  function close() {
    stopReleaseSearch();
    onClose();
  }

  // Nothing of one instance follows the window to another: its options view
  // is remounted (key={instance} below) and its release search is dropped
  // whole, so switching back searches again.
  function pickInstance(next: string) {
    stopReleaseSearch();
    setSearch(null);
    onInstanceChange(next);
    // The new instance's view reads its files as it mounts; the open list searches it.
    if (view === "releases") void loadReleases(next);
  }

  // `rel` is the one the admin has selected AND can see (ReleasePicker); its
  // guid is the server-issued handle, sent back as it came (guardrail 5e).
  async function grabRelease(rel: ArrRelease) {
    if (writes.busy("grab")) return;
    setAction("grab");
    patchSearch(instance, { error: null });
    const res = await writes.run("grab", (signal) =>
      fetchJson(withBasePath(`/api/issues/${issueId}/releases`), {
        init: jsonInit("POST", { guid: rel.guid, indexerId: rel.indexerId, instance }),
        signal,
        timeoutMs: GRAB_TIMEOUT_MS,
        fallbackError: t("adminQueue.issueActions.grabFailed"),
      }), { ifBusy: "skip" });
    setAction(null);
    // The window closed meanwhile: nothing here to tell.
    if (!res) return;
    // A 2xx whose body can't be read was still a grab.
    if (!res.ok && res.kind !== "invalid") {
      patchSearch(instance, { error: writeErrorText(res, t) });
    } else {
      patchSearch(instance, { grabOk: true });
      // Once the window closes — not under the "grab queued" it is showing.
      requestPageRefresh(() => router.refresh());
    }
  }

  const working = action !== null;
  const closeLabel = working ? t("adminQueue.issueActions.closeWhileWorking") : t("adminQueue.common.close");

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

  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
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
                aria-label={closeLabel}
                title={closeLabel}
                className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
              >
                <X className="w-5 h-5" />
              </DialogClose>
            </div>
          </div>

          <FixFileOptions
            key={instance}
            issueId={issueId}
            mediaType={mediaType}
            isAdmin={isAdmin}
            canPickRelease={canPickRelease}
            instance={instance}
            shown={view === "options"}
            action={action}
            onAction={setAction}
            blockRelease={blockRelease}
            onBlockReleaseChange={setBlockRelease}
            onPickRelease={openReleases}
            onClose={close}
          />

          {view === "releases" && (
            <ReleasesView
              loading={releasesLoading}
              grabOk={grabOk}
              releases={releases}
              releaseError={releaseError}
              serviceName={serviceName}
              matchBanner={libraryConfirmed && scope === "EPISODE"}
              working={working}
              grabbing={action === "grab"}
              onSearchAgain={() => void loadReleases(instance)}
              onBack={backToOptions}
              onGrab={(rel) => void grabRelease(rel)}
              onClose={close}
            />
          )}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

// The release list's view of one search: searching, the grab queued, nothing
// (or the search failed), or the list itself — in that order.
function ReleasesView({
  loading,
  grabOk,
  releases,
  releaseError,
  serviceName,
  matchBanner,
  working,
  grabbing,
  onSearchAgain,
  onBack,
  onGrab,
  onClose,
}: {
  loading: boolean;
  grabOk: boolean;
  releases: ArrRelease[] | null;
  releaseError: string | null;
  serviceName: string;
  matchBanner: boolean;
  working: boolean;
  grabbing: boolean;
  onSearchAgain: () => void;
  onBack: () => void;
  onGrab: (rel: ArrRelease) => void;
  onClose: () => void;
}) {
  const t = useT();
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-3 text-sm text-zinc-500 py-16">
        <Loader2 className="w-5 h-5 animate-spin" />
        {t("adminQueue.issueActions.searching")}
      </div>
    );
  }
  if (grabOk) {
    return (
      <>
        <div className="flex items-center justify-center gap-2 text-sm text-green-400 py-16">
          <Check className="w-4 h-4" />
          {t("adminQueue.issueActions.grabQueued")}
        </div>
        <div className="flex justify-end px-4 py-4 sm:px-6 border-t border-zinc-700 bg-zinc-900 flex-shrink-0">
          <Button size="sm" onClick={onClose}>{t("adminQueue.common.close")}</Button>
        </div>
      </>
    );
  }
  if (releases === null || releases.length === 0) {
    return (
      <div className="grid justify-items-center gap-3 px-6 py-16 text-center text-sm">
        {releases === null ? (
          <span role="alert" className="flex items-start gap-1.5 text-red-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {releaseError ?? t("adminQueue.issueActions.releasesFailed")}
          </span>
        ) : (
          <span className="text-zinc-500">{t("adminQueue.issueActions.noReleases")}</span>
        )}
        <Button variant="ghost" size="sm" onClick={onSearchAgain} disabled={working}>
          <RefreshCw />
          {t("adminQueue.issueActions.searchAgain")}
        </Button>
      </div>
    );
  }
  return (
    <ReleasePicker
      releases={releases}
      serviceName={serviceName}
      matchBanner={matchBanner}
      releaseError={releaseError}
      working={working}
      grabbing={grabbing}
      onSearchAgain={onSearchAgain}
      onBack={onBack}
      onGrab={onGrab}
    />
  );
}

// The release list of one search's answer: the filter, the rejected toggle,
// the selection and Grab. Its state lives and dies with that answer — a new
// search, Back or an instance switch unmounts it — so nothing is reset by hand.
// The filter and the toggle never MOVE the selection: one they hide can't be
// grabbed until it shows again (as in Pick release), so Grab never sends a
// release the admin didn't pick.
function ReleasePicker({
  releases,
  serviceName,
  matchBanner,
  releaseError,
  working,
  grabbing,
  onSearchAgain,
  onBack,
  onGrab,
}: {
  releases: ArrRelease[];
  serviceName: string;
  matchBanner: boolean;
  releaseError: string | null;
  working: boolean;
  grabbing: boolean;
  onSearchAgain: () => void;
  onBack: () => void;
  onGrab: (rel: ArrRelease) => void;
}) {
  const t = useT();
  const locale = useLocale();
  // Reads like the request queue's Pick release: sizes and ages in the
  // viewer's locale, seeders through the plural key.
  const formatSize = useMemo(() => sizeFormatter(locale), [locale]);
  const formatAge = useMemo(() => ageFormatter(locale), [locale]);
  const [selectedGuid, setSelectedGuid] = useState<string | null>(() => defaultRelease(releases));
  const [showRejected, setShowRejected] = useState(false);
  const [releaseFilter, setReleaseFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => filterRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  // A season pack's search answers hundreds of releases: the list follows a
  // deferred copy of the filter (typing stays responsive), and each pass over
  // the whole answer runs only when what it reads changed.
  const filterTerm = useDeferredValue(releaseFilter).toLowerCase();
  const visibleReleases = useMemo(
    () => releases.filter(
      (r) => (showRejected || !r.rejected || rejectedOnlyForFileOnDisk(r))
        && (filterTerm === "" || r.title.toLowerCase().includes(filterTerm)),
    ),
    [releases, showRejected, filterTerm],
  );
  const selectedVisible = visibleReleases.find((r) => r.guid === selectedGuid) ?? null;
  const { rejectedCount, anyDiskOnly } = useMemo(() => {
    let rejected = 0;
    let diskOnly = false;
    for (const r of releases) {
      const onlyDisk = rejectedOnlyForFileOnDisk(r);
      if (r.rejected && !onlyDisk) rejected++;
      if (onlyDisk) diskOnly = true;
    }
    return { rejectedCount: rejected, anyDiskOnly: diskOnly };
  }, [releases]);

  return (
    <>
      {matchBanner && (
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
            onClick={onSearchAgain}
            disabled={working}
            className="shrink-0"
          >
            <RefreshCw />
            {t("adminQueue.issueActions.searchAgain")}
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-700 bg-zinc-900 flex-shrink-0">
        <button type="button" onClick={onBack} disabled={working} className="rounded px-2 py-1 text-sm text-zinc-500 hover:text-zinc-300 disabled:opacity-40">{t("adminQueue.issueActions.back")}</button>
        <Button size="sm" onClick={() => { if (selectedVisible) onGrab(selectedVisible); }} disabled={!selectedGuid || !selectedVisible || working}>
          {grabbing ? <Loader2 className="animate-spin" /> : <Download />}
          {t("adminQueue.issueActions.grab")}
        </Button>
      </div>
    </>
  );
}
