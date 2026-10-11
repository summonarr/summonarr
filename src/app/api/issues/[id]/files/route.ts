import { NextResponse } from "next/server";
import type { Issue } from "@/generated/prisma";
import { withAdmin } from "@/lib/api-auth";
import { arrErrorMessage, arrFetch } from "@/lib/arr";
import { ARR_SERVICE_LABEL, configuredArrCfg, type ArrService } from "@/lib/arr-admin";
import { arrFailure, arrGate, parseIdArray, type ArrTarget } from "@/lib/arr-admin-http";
import { isValidInstanceSlug } from "@/lib/arr-instances";
import { NothingMissingError, searchMissing } from "@/lib/arr-missing-data";
import { projectEpisodes, type TitleEpisode, type TitleFile } from "@/lib/arr-title";
import {
  AlreadyFailedError,
  NotAGrabError,
  NotOnTitleError,
  TitleNotFoundError,
  deleteTitleFiles,
  editTitle,
  findTitle,
  loadSeasonEpisodes,
  loadTitleFiles,
  loadTitleHistory,
  markHistoryFailed,
  searchEpisodes,
  searchMovie,
  searchSeason,
  setEpisodesMonitored,
} from "@/lib/arr-title-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import {
  chooseFiles,
  episodesFor,
  episodesOf,
  followUpSearch,
  isInteractiveGrab,
  parseReplaceFollowUp,
  planMarks,
  redownloadCovers,
  redownloadSettings,
  replaceableFiles,
  replaceScopeOf,
  unmonitoredByDelete,
  type EpisodeRef,
  type RedownloadSettings,
  type ReplaceScope,
  type ReplaceSearch,
  type ReplaceableFile,
} from "@/lib/issue-replace";
import { maintenanceGuard } from "@/lib/maintenance";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { sanitizeForLog } from "@/lib/sanitize";
import { emitSSE } from "@/lib/sse-emitter";

// An issue's "Replace file" (ADMIN — deleting files is; ISSUE_ADMIN keeps
// Refetch and Replace-release). Radarr/Sonarr only take an UPGRADE while a
// file is on disk, so a broken file already at the profile's cutoff is never
// replaced by a search: this deletes it first.
//   GET ?instance → { service, instance, arrId, scope, seriesType, files,
//       otherFiles }: the title's files on that instance that the issue is
//       about (FULL: all; SEASON: that season's; EPISODE: the file holding that
//       S/E), each with the grab that produced it where the title's history can
//       tell (issue-replace.ts), and its episodes named by SONARR's own titles —
//       the issue's numbers are the media server's, and on an anime or
//       reordered show (seriesType) the two can name different episodes. 404
//       when the title isn't on the instance, 409 on a RESOLVED issue.
//   POST { instance, fileIds, then: "markFailed" | "search" } — the files and
//       history are re-read NOW; every id must be one of the in-scope files
//       (409, nothing deleted, otherwise — guardrail 5e). The issue flips to
//       IN_PROGRESS with the release grab's compare-and-swap BEFORE anything
//       is deleted, then the files go through the arr. Then whatever the delete
//       UNMONITORED (Radarr/Sonarr's "Unmonitor Deleted Movies/Episodes" — read
//       before and after the delete) is set back to monitored, BEFORE the mark
//       or the search, which both search monitored items only. "markFailed"
//       marks each deleted file's grab failed — the arr's own Mark as failed:
//       blocklist, and its Redownload Failed searches again — ONE mark per
//       download (guardrail 5c's per-episode trap); a mark counts as searching
//       only when the arr's switches say it will (an interactive grab also
//       needs "Redownload Failed from Interactive Search") and nothing it
//       covers is still unmonitored. A file with no known grab, one whose
//       download already failed, one no redownload covers, and every file under
//       "search" is searched for here (issue-replace.ts followUpSearch — never
//       SeriesSearch; an EpisodeSearch naming them while any is still
//       unmonitored). An IssueGrab row is recorded so the next import of the
//       issue's scope on that instance notifies the admin, like a grab.
//       Audited after the arr accepted each write (guardrail 26):
//       ISSUE_STATUS_CHANGE for the flip, ARR_FILE_DELETE for exactly the files
//       deleted, ARR_TITLE_EDIT for the re-monitor, ARR_MARK_FAILED per mark.
//       Searches are not audited (guardrail 5e). → { deleted, requested,
//       marked, unmarked, searched, redownload, redownloading, remonitored,
//       remonitorFailed, nothingMissing }, or 502 with the same counts and an
//       `error` when the delete stopped part-way or the search could not be
//       queued.

type RouteContext = { params: Promise<{ id: string }> };

// Fewer than any real title's file count would need; bounds the body.
const MAX_FILES = 5_000;
// Every call deletes files and spends indexer hits; bounded per admin like the
// title manager's commands.
const LIMIT_PER_MIN = 10;

const serviceOf = (issue: Issue): ArrService => (issue.mediaType === "MOVIE" ? "radarr" : "sonarr");
const instanceName = (service: ArrService, instance: string) =>
  instance === "" ? ARR_SERVICE_LABEL[service] : `${ARR_SERVICE_LABEL[service]} (${instance})`;

interface Loaded {
  target: ArrTarget;
  arrId: number;
  /** The library resource findTitle read, when it read one whole (its tvdbId names the series for IssueGrab). */
  raw: Record<string, unknown> | null;
  scope: ReplaceScope;
  titleFiles: TitleFile[];
  files: ReplaceableFile[];
  /** Sonarr: the series' episodes as read now — ids, titles, monitoring. Empty for a movie. */
  episodes: TitleEpisode[];
  /** Sonarr's series type ("standard", "daily", "anime"); null for a movie or when unread. */
  seriesType: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Sonarr's own episodes of a series, read now; rows naming another series are dropped (guardrail 5e). */
async function readSeriesEpisodes(instance: string, seriesId: number): Promise<TitleEpisode[]> {
  const cfg = await configuredArrCfg("sonarr", instance);
  const raw = await arrFetch<unknown>(cfg, `/api/v3/episode?seriesId=${seriesId}`);
  return projectEpisodes(Array.isArray(raw) ? raw.filter((x) => !isRecord(x) || typeof x.seriesId !== "number" || x.seriesId === seriesId) : []);
}

/** The library resource (movie or series) read now; throws when the arr doesn't answer it whole. */
async function readTitleResource(service: ArrService, instance: string, arrId: number): Promise<Record<string, unknown>> {
  const cfg = await configuredArrCfg(service, instance);
  const raw = await arrFetch<unknown>(cfg, `/api/v3/${service === "radarr" ? "movie" : "series"}/${arrId}`);
  if (!isRecord(raw) || raw.id !== arrId) throw new TitleNotFoundError();
  return raw;
}

/**
 * The issue's title on one instance, its files and history read live, and the
 * in-scope files with their grabs — or the response refusing.
 */
async function loadIssueFiles(issue: Issue, rawInstance: unknown, t: Translator): Promise<Loaded | NextResponse> {
  const service = serviceOf(issue);
  const scope = replaceScopeOf(issue);
  if (!scope) return NextResponse.json({ error: t("apiUser.issues.invalidScope") }, { status: 422 });
  // Validated, never coerced — a bad slug must not silently retarget the default.
  const instance = rawInstance === undefined || rawInstance === null ? "" : typeof rawInstance === "string" ? rawInstance.trim() : null;
  if (instance === null || !isValidInstanceSlug(instance)) {
    return NextResponse.json({ error: t("apiUser.common.invalidInstance") }, { status: 400 });
  }
  const target = await arrGate(service, instance, t);
  if (target instanceof NextResponse) return target;
  try {
    // findTitle resolves a series through TMDB's TVDB cross-reference and
    // refuses a row naming another TMDB title (guardrail 14a's rules).
    const found = await findTitle(service, instance, issue.tmdbId);
    if (!found) {
      return NextResponse.json({ error: t("apiUser.issues.replaceFile.notOnInstance", { name: instanceName(service, instance) }) }, { status: 404 });
    }
    const [titleFiles, history, episodes, raw] = await Promise.all([
      loadTitleFiles(service, instance, found.arrId),
      loadTitleHistory(service, instance, found.arrId),
      // The episode list names each file's episodes by Sonarr's titles and
      // holds their ids and monitoring (the re-monitor's "before").
      service === "sonarr" ? readSeriesEpisodes(instance, found.arrId) : Promise.resolve([]),
      // A series found through Sonarr's lookup carries no resource; its type is read here.
      found.raw === null && service === "sonarr" ? readTitleResource(service, instance, found.arrId) : Promise.resolve(found.raw),
    ]);
    const type = service === "sonarr" ? raw?.seriesType : null;
    return {
      target,
      arrId: found.arrId,
      raw,
      scope,
      titleFiles,
      files: replaceableFiles(service, scope, titleFiles, history, episodes),
      episodes,
      seriesType: typeof type === "string" && type.trim() !== "" ? type.slice(0, 40) : null,
    };
  } catch (err) {
    return arrFailure(err, target, t, "issue file listing");
  }
}

export const GET = withAdmin(async (req, { params }: RouteContext, _session) => {
  const t = translatorForRequest(req);
  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });
  if (issue.status === "RESOLVED") {
    return NextResponse.json({ error: t("apiUser.issues.replaceFile.resolved") }, { status: 409 });
  }
  const loaded = await loadIssueFiles(issue, req.nextUrl.searchParams.get("instance"), t);
  if (loaded instanceof NextResponse) return loaded;
  return NextResponse.json({
    service: loaded.target.service,
    instance: loaded.target.instance,
    arrId: loaded.arrId,
    scope: loaded.scope,
    // "anime" numbers episodes absolutely; the panel warns the issue's numbers may not be Sonarr's.
    seriesType: loaded.seriesType,
    files: loaded.files,
    // The title's files the issue is NOT about — not offered, only counted.
    otherFiles: loaded.titleFiles.length - loaded.files.length,
  });
});

/** Sonarr's episode ids for S/E pairs, from each season's own episode list. */
async function episodeIdsFor(instance: string, seriesId: number, episodes: readonly EpisodeRef[]): Promise<number[]> {
  const ids: number[] = [];
  for (const season of new Set(episodes.map((e) => e.seasonNumber))) {
    const list = await loadSeasonEpisodes(instance, seriesId, season);
    for (const e of episodes) {
      if (e.seasonNumber !== season) continue;
      const hit = list.find((x) => x.episodeNumber === e.episodeNumber);
      if (hit) ids.push(hit.id);
    }
  }
  if (ids.length === 0) throw new NotOnTitleError("episode");
  return ids;
}

/** Queue the planned search. "nothingMissing": Sonarr found nothing to search for. */
async function runSearch(
  search: ReplaceSearch,
  instance: string,
  arrId: number,
  uncovered: readonly ReplaceableFile[],
): Promise<"queued" | "nothingMissing"> {
  switch (search.kind) {
    case "movie":
      await searchMovie(instance, arrId);
      return "queued";
    case "season":
      await searchSeason(instance, arrId, search.seasonNumber);
      return "queued";
    case "episodes":
      await searchEpisodes(instance, arrId, await episodeIdsFor(instance, arrId, search.episodes));
      return "queued";
    case "missing":
      try {
        await searchMissing("sonarr", instance, arrId, new Date());
        return "queued";
      } catch (err) {
        if (!(err instanceof NothingMissingError)) throw err;
        // Sonarr says nothing is missing although files were just deleted —
        // its "Unmonitor Deleted Episodes" setting unmonitors them on a manual
        // delete, and the Missing plan only takes monitored episodes. An
        // EpisodeSearch names them explicitly instead.
        const episodes = episodesOf(uncovered);
        if (episodes.length === 0) return "nothingMissing";
        await searchEpisodes(instance, arrId, await episodeIdsFor(instance, arrId, episodes));
        return "queued";
      }
  }
}

/**
 * The arr's Redownload Failed switches; both null when they can't be read (the
 * replacement is then searched for here).
 */
async function readRedownloadSettings(service: ArrService, instance: string): Promise<RedownloadSettings> {
  try {
    const cfg = await configuredArrCfg(service, instance);
    return redownloadSettings(await arrFetch<unknown>(cfg, "/api/v3/config/downloadclient", { quietErrors: true }));
  } catch {
    return { failed: null, interactive: null };
  }
}

/**
 * The title's history as the arr sends it — only to read each grab's
 * `data.releaseSource`, which the projection doesn't carry. Null when it can't
 * be read: every grab is then taken as interactive (searched for here).
 */
async function readRawHistory(service: ArrService, instance: string, arrId: number): Promise<unknown> {
  try {
    const cfg = await configuredArrCfg(service, instance);
    const path = service === "radarr" ? `/api/v3/history/movie?movieId=${arrId}` : `/api/v3/history/series?seriesId=${arrId}`;
    return await arrFetch<unknown>(cfg, path, { quietErrors: true });
  } catch {
    return null;
  }
}

const episodeKey = (e: EpisodeRef) => `${e.seasonNumber}:${e.episodeNumber}`;

interface RemonitorOutcome {
  /** Episodes (Sonarr), or the movie (Radarr: 1), set back to monitored. */
  remonitored: number;
  /** Re-reading or re-monitoring failed: what the delete unmonitored may still be unmonitored. */
  failed: boolean;
  /** A deleted file whose episode — or movie — is still unmonitored: no redownload or monitored-only search reaches it. */
  stillUnmonitored: (f: TitleFile) => boolean;
}

/**
 * Undo what the delete unmonitored. With "Unmonitor Deleted Movies/Episodes"
 * on, Radarr/Sonarr unmonitor what a manual delete removed; a SeasonSearch,
 * the Missing plan and the arr's own redownload after a Mark failed then find
 * nothing. Exactly the ids that went monitored → unmonitored are set back
 * (the episodes' or the movie's state before the delete is `loaded`, read at
 * POST time), through the title manager's own writes. A failure is reported,
 * never thrown: the files are already gone, and the caller searches for them
 * by name instead.
 */
async function undoDeleteUnmonitor(
  loaded: Loaded,
  deleted: readonly ReplaceableFile[],
  audit: (details: Record<string, unknown>) => void,
): Promise<RemonitorOutcome> {
  const { service, instance } = loaded.target;
  const arrId = loaded.arrId;
  const failedOutcome: RemonitorOutcome = { remonitored: 0, failed: true, stillUnmonitored: () => true };
  const warn = (what: string, err: unknown) =>
    console.warn(`[issues] ${service} instance "${sanitizeForLog(instance)}" ${what} after Replace file failed:`, arrErrorMessage(err));
  if (deleted.length === 0) return { remonitored: 0, failed: false, stillUnmonitored: () => false };

  if (service === "radarr") {
    const before = loaded.raw?.monitored === true;
    let after: boolean;
    try {
      const raw = await readTitleResource("radarr", instance, arrId);
      if (typeof raw.monitored !== "boolean") throw new Error("the movie carries no monitored flag");
      after = raw.monitored;
    } catch (err) {
      warn("re-reading the movie", err);
      return failedOutcome;
    }
    if (unmonitoredByDelete([{ id: arrId, monitored: before }], [{ id: arrId, monitored: after }]).length === 0) {
      return { remonitored: 0, failed: false, stillUnmonitored: () => !after };
    }
    try {
      // The movie editor (PUT /api/v3/movie/editor) — only `monitored` is sent.
      await editTitle("radarr", instance, arrId, { monitored: true });
    } catch (err) {
      warn("re-monitoring the movie", err);
      return failedOutcome;
    }
    audit({ fields: ["monitored"], monitored: true });
    return { remonitored: 1, failed: false, stillUnmonitored: () => false };
  }

  const deletedEpisodes = episodesFor(episodesOf(deleted), loaded.episodes);
  let after: TitleEpisode[];
  try {
    after = await readSeriesEpisodes(instance, arrId);
  } catch (err) {
    warn("re-reading the episodes", err);
    return failedOutcome;
  }
  const flipped = unmonitoredByDelete(deletedEpisodes, after);
  let failed = false;
  if (flipped.length > 0) {
    try {
      // PUT /api/v3/episode/monitor — the title manager's episode switch.
      await setEpisodesMonitored(instance, arrId, flipped, true);
    } catch (err) {
      warn("re-monitoring the episodes", err);
      failed = true;
    }
    if (!failed) audit({ fields: ["episodes"], episodes: flipped.length, monitored: true });
  }
  const fixed = new Set(failed ? [] : flipped);
  const monitoredNow = new Map(after.map((e) => [e.id, e.monitored]));
  // An episode the re-read didn't return counts as unmonitored: it is then
  // searched for by name, which costs nothing if it is in fact monitored.
  const off = new Set(deletedEpisodes.filter((e) => !fixed.has(e.id) && monitoredNow.get(e.id) !== true).map(episodeKey));
  for (const e of episodesOf(deleted)) {
    if (!deletedEpisodes.some((d) => episodeKey(d) === episodeKey(e))) off.add(episodeKey(e));
  }
  return {
    remonitored: failed ? 0 : flipped.length,
    failed,
    stillUnmonitored: (f) => f.episodes.some((e) => off.has(episodeKey(e))),
  };
}

export const POST = withAdmin(async (req, { params }: RouteContext, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });
  // A RESOLVED issue is closed: nothing is deleted for it. (The status CAS
  // below re-checks this in case it is resolved meanwhile.)
  if (issue.status === "RESOLVED") {
    return NextResponse.json({ error: t("apiUser.issues.replaceFile.resolved") }, { status: 409 });
  }

  const parsed = await readJsonCapped<Record<string, unknown>>(req, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const then = parseReplaceFollowUp(body.then);
  const fileIds = parseIdArray(body.fileIds, MAX_FILES);
  if (!then || !fileIds) return NextResponse.json({ error: t("apiUser.issues.replaceFile.bodyInvalid") }, { status: 400 });
  if (!checkRateLimit(`issue-replace-file:${session.user.id}`, LIMIT_PER_MIN, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }

  // Re-read the files and the history NOW (guardrail 5e): the page's list may
  // be stale, and only the instance's own answer decides what is deleted.
  const loaded = await loadIssueFiles(issue, body.instance, t);
  if (loaded instanceof NextResponse) return loaded;
  const { target, arrId, scope } = loaded;
  const { service, instance } = target;
  const chosen = chooseFiles(loaded.files, fileIds);
  if (!chosen) return NextResponse.json({ error: t("apiUser.issues.replaceFile.notInScope") }, { status: 409 });

  // Move the issue to IN_PROGRESS BEFORE anything is deleted, with the release
  // grab's compare-and-swap ("only if still not RESOLVED"): the arr calls
  // can't sit inside a DB transaction, so this check up front is what stops a
  // file being deleted for an issue someone just closed. If the delete then
  // fails, leaving IN_PROGRESS is fine — an admin did try.
  const claim = await prisma.issue.updateMany({
    where: { id, status: { not: "RESOLVED" } },
    data: { status: "IN_PROGRESS" },
  });
  if (claim.count === 0) {
    return NextResponse.json({ error: t("apiUser.issues.replaceFile.resolved") }, { status: 409 });
  }
  if (issue.status !== "IN_PROGRESS") {
    // The row already says IN_PROGRESS whatever happens below, so announce and
    // audit it now (guardrail 26: the CAS has committed — the swallowing logAudit).
    emitSSE({ type: "issue:updated", issueId: id, status: "IN_PROGRESS", userId: issue.reportedBy });
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? null,
      action: "ISSUE_STATUS_CHANGE",
      target: `issue:${id}`,
      details: {
        trigger: "replaceFile",
        scope: issue.scope,
        before: { status: issue.status },
        after: { status: "IN_PROGRESS" },
      },
      ...auditContext(req, session),
    });
  }

  let deletedIds: number[];
  let deleteError: unknown;
  try {
    ({ deleted: deletedIds, error: deleteError } = await deleteTitleFiles(service, instance, arrId, chosen.map((f) => f.id)));
  } catch (err) {
    return arrFailure(err, target, t, "issue file delete");
  }
  // Exactly what the arr deleted, even when Radarr stopped part-way (guardrail 26).
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_FILE_DELETE",
    target: `${service}:${instance}:${arrId}`,
    details: { service, instance, arrId, fileIds: deletedIds, count: deletedIds.length, issueId: id },
    ...auditContext(req, session),
  });
  if (deleteError) {
    console.warn(`[issues] ${service} instance "${sanitizeForLog(instance)}" file delete stopped part-way:`, arrErrorMessage(deleteError));
  }

  const gone = new Set(deletedIds);
  const deleted = chosen.filter((f) => gone.has(f.id));
  const remaining = loaded.titleFiles.filter((f) => !gone.has(f.id));

  // Set back to monitored whatever the delete unmonitored — BEFORE the mark and
  // the search, which both reach monitored items only. Audited after the arr
  // accepted it (guardrail 26).
  const monitor = await undoDeleteUnmonitor(loaded, deleted, (details) => {
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? null,
      action: "ARR_TITLE_EDIT",
      target: `${service}:${instance}:${arrId}`,
      details: { service, instance, arrId, ...details, trigger: "replaceFile", issueId: id },
      ...auditContext(req, session),
    });
  });

  // Mark each deleted file's grab failed — one mark per download. Sequential:
  // each re-reads the title's history first (markHistoryFailed), so a pack
  // marked by the first can never be marked again.
  const marks = then === "markFailed" ? planMarks(deleted) : [];
  const settings: RedownloadSettings = marks.length > 0 ? await readRedownloadSettings(service, instance) : { failed: null, interactive: null };
  // Which grabs were picked by hand matters only when the arr says it won't
  // redownload those; undefined = not needed, null = unreadable (all count as interactive).
  const rawHistory = settings.failed === true && settings.interactive === false ? await readRawHistory(service, instance, arrId) : undefined;
  const covered = new Set<number>();
  let marked = 0;
  let redownloading = 0;
  for (const mark of marks) {
    let release: string;
    try {
      release = (await markHistoryFailed(service, instance, arrId, mark.grab.id)).sourceTitle;
    } catch (err) {
      // History moved since the read (already failed, no longer a grab, gone):
      // its files are searched for instead, below. Anything else is the arr
      // failing — logged, and the files are searched for too.
      if (!(err instanceof AlreadyFailedError || err instanceof NotAGrabError || err instanceof NotOnTitleError)) {
        console.warn(`[issues] ${service} instance "${sanitizeForLog(instance)}" mark failed failed:`, arrErrorMessage(err));
      }
      continue;
    }
    marked++;
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? null,
      action: "ARR_MARK_FAILED",
      target: `${service}:${instance}:${arrId}`,
      details: { service, instance, arrId, historyId: mark.grab.id, release, issueId: id },
      ...auditContext(req, session),
    });
    // Only a redownload the arr's switches say happens searches for the mark's
    // files (off, unreadable, or an interactive grab with that switch off ⇒
    // searched for here) — and only when none of them is still unmonitored:
    // the arr's redownload searches monitored items only.
    const interactive = rawHistory === undefined ? false : rawHistory === null || isInteractiveGrab(service, arrId, rawHistory, mark.grab);
    const markFiles = deleted.filter((f) => mark.fileIds.includes(f.id));
    if (redownloadCovers(settings, interactive) && !markFiles.some(monitor.stillUnmonitored)) {
      redownloading++;
      for (const fileId of mark.fileIds) covered.add(fileId);
    }
  }

  const uncovered = deleted.filter((f) => !covered.has(f.id));
  const search = followUpSearch(scope, uncovered, covered.size > 0, remaining, uncovered.some(monitor.stillUnmonitored));
  let searched = false;
  let nothingMissing = false;
  let searchError: unknown = null;
  if (search) {
    try {
      const outcome = await runSearch(search, instance, arrId, uncovered);
      searched = outcome === "queued";
      nothingMissing = outcome === "nothingMissing";
    } catch (err) {
      searchError = err;
      console.warn(`[issues] ${service} instance "${sanitizeForLog(instance)}" replacement search failed:`, arrErrorMessage(err));
    }
  }

  // Recorded OUTSIDE the try/catch blocks above, as the release grab does: the
  // arr has already deleted the files and queued the follow-up, so a failure
  // here must not read as the replace failing (the usual cause is the issue
  // being deleted meanwhile — P2003 on the IssueGrab -> Issue link). The row
  // makes the next import of the issue's scope on this instance notify the
  // admin like a grab's: the webhooks match IssueGrab by title, instance and
  // scope, never by release, so a search-based replacement matches the same way.
  if (marked > 0 || searched) {
    const rawTvdb = loaded.raw?.tvdbId;
    try {
      await prisma.issueGrab.create({
        data: {
          issueId: id,
          triggeredById: session.user.id,
          tmdbId: issue.tmdbId,
          tvdbId: issue.tvdbId ?? (service === "sonarr" && typeof rawTvdb === "number" && Number.isSafeInteger(rawTvdb) && rawTvdb > 0 ? rawTvdb : null),
          mediaType: issue.mediaType,
          title: issue.title,
          scope: issue.scope,
          seasonNumber: issue.seasonNumber,
          episodeNumber: issue.episodeNumber,
          arrInstance: instance,
        },
      });
    } catch (err) {
      console.warn("[issues] Replace file succeeded but recording the grab failed (issue deleted meanwhile?):", err);
    }
  }

  const result = {
    deleted: deletedIds.length,
    requested: chosen.length,
    marked,
    // Marks the arr refused or failed — those files were searched for instead.
    unmarked: marks.length - marked,
    searched,
    // The arr's Redownload Failed switch (null when no mark was planned or it couldn't be read).
    redownload: settings.failed,
    // Marks the arr's own redownload searches for (none of ours for their files).
    redownloading,
    // What the delete unmonitored and was set back; a failure there means the
    // files were searched for by name, and may stay unmonitored in the arr.
    remonitored: monitor.remonitored,
    remonitorFailed: monitor.failed,
    nothingMissing,
  };
  if (searchError) {
    return NextResponse.json(
      { ...result, error: t("apiUser.issues.replaceFile.searchFailed", { count: deletedIds.length, service: ARR_SERVICE_LABEL[service] }) },
      { status: 502 },
    );
  }
  if (deleteError) {
    return NextResponse.json(
      { ...result, error: t("apiAdmin.arr.partialDelete", { done: deletedIds.length, total: chosen.length }) },
      { status: 502 },
    );
  }
  return NextResponse.json(result);
});
