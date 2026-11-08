import { NextResponse, type NextRequest } from "next/server";
import { tooManyRequests } from "@/lib/http";
import type { AuditAction, Issue } from "@/generated/prisma";
import { withAdmin, type SummonarrSession } from "@/lib/api-auth";
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
import { recordIssueGrab } from "@/lib/issue-grab";
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
  type ReplaceFollowUp,
  type ReplaceMark,
  type ReplaceScope,
  type ReplaceSearch,
  type ReplaceableFile,
} from "@/lib/issue-replace";
import { promoteIssueInProgress } from "@/lib/issue-transitions";
import { maintenanceGuard } from "@/lib/maintenance";
import { prisma } from "@/lib/prisma";
import { processSingleton } from "@/lib/process-singleton";
import { checkRateLimit } from "@/lib/rate-limit";
import { answerOf, jobResponse, runningArrJob, startArrJob } from "@/lib/release-search-jobs";
import { sanitizeForLog } from "@/lib/sanitize";
import { ISSUE_FILES_MAX_IDS } from "@/lib/api-body-limits";

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
//       SeriesSearch, and for a series the DELETED episodes only, never its
//       whole missing backlog; an EpisodeSearch naming them while any is still
//       unmonitored). An IssueGrab row is recorded so the next import of the
//       issue's scope on that instance notifies the admin, like a grab.
//       Audited after the arr accepted each write (guardrail 26):
//       ISSUE_STATUS_CHANGE for the flip, ARR_FILE_DELETE for exactly the files
//       deleted, ARR_TITLE_EDIT for the re-monitor, ARR_MARK_FAILED per mark.
//       Searches are not audited (guardrail 5e). → { deleted, requested,
//       marked, unmarked, searched, redownload, redownloading, remonitored,
//       remonitorFailed, nothingMissing }, or 502 with the same counts and an
//       `error` when the delete stopped part-way or the search could not be
//       queued (a series plan that queued SOME of its commands counts as
//       searched — those run on Sonarr). ONE replace per issue at a time, process-wide: a second POST
//       while one runs (another admin, another tab) is 409 with nothing
//       written or sent — the status CAS alone lets IN_PROGRESS → IN_PROGRESS
//       through for both, and each would mark and search again.
//       `async: true` (the browser) runs everything after the CAS as a
//       BACKGROUND job (the guardrail-37a pattern, release-search-jobs.ts):
//       202 { job } at once. The marks run in sequence, each re-reading the
//       title's history, and a long series outlasts a reverse proxy's hold —
//       the admin saw a 502 on a replace that had succeeded. The same admin
//       posting the same replace (issue, instance, files, follow-up) while it
//       runs JOINS it; a different one is the 409 above. The synchronous
//       default stays for API callers.
//   GET ?job=<id> → that replace's poll: 202 { job, running } while it runs,
//       then the POST's own status and body; 404 once it is gone (expired,
//       another admin's, or dropped by a restart — reload the issue).

type RouteContext = { params: Promise<{ id: string }> };

// Fewer than any real title's file count would need; bounds the body.
const MAX_FILES = ISSUE_FILES_MAX_IDS;
// Every call deletes files and spends indexer hits; bounded per admin like the
// title manager's commands.
const LIMIT_PER_MIN = 10;

// The issues with a replace running now (this process — guardrail 17's single
// long-lived server). Claimed before the CAS, released when the replace ends.
const inFlight = processSingleton("issue-replace-inflight", () => new Set<string>());
// The JOIN key is the whole request, not the issue: a second POST naming another
// instance, other files or another follow-up joined the first job and reported its
// result as its own, its files never touched. It now falls through to
// the per-issue `inFlight` 409. An identical retry (a reload, a double submit) joins.
const jobKey = (issueId: string, instance: string, then: string, fileIds: readonly number[]) =>
  `issue-replace\u0000${issueId}\u0000${instance}\u0000${then}\u0000${[...fileIds].sort((a, b) => a - b).join(",")}`;

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

/**
 * The instance a request names: absent ⇒ the default "", a string ⇒ trimmed,
 * anything else ⇒ null (malformed). One parser for the listing and the job
 * join, so a retry's join key is built from exactly what the listing used.
 */
function parseInstanceParam(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "";
  return typeof raw === "string" ? raw.trim() : null;
}

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
  const instance = parseInstanceParam(rawInstance);
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

export const GET = withAdmin(async (req, { params }: RouteContext, session) => {
  const t = translatorForRequest(req);
  const { id } = await params;
  const job = req.nextUrl.searchParams.get("job");
  if (job !== null) return jobResponse(session.user.id, job, t, "apiUser.issues.replaceFile.jobGone");
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
    case "plan": {
      // The deleted episodes only: a season pack per emptied season, the rest by
      // name. The episode ids are read BEFORE any command, so a failed read
      // queues nothing.
      const episodeIds = search.episodes.length > 0 ? await episodeIdsFor(instance, arrId, search.episodes) : [];
      // Sequential. A refusal part-way leaves the commands already queued RUNNING
      // on Sonarr (the Missing plan's rule, searchMissingTracked): answering a
      // failure would record no IssueGrab — the replacement's import would never
      // be announced — and invite a retry that queues them again. So once
      // anything is queued the search counts as queued.
      let queued = 0;
      try {
        for (const seasonNumber of search.seasons) {
          await searchSeason(instance, arrId, seasonNumber);
          queued++;
        }
        if (episodeIds.length > 0) {
          await searchEpisodes(instance, arrId, episodeIds);
          queued++;
        }
      } catch (err) {
        if (queued === 0) throw err;
        // An event (this one search stopping part-way), not a recomputed condition — guardrail 7b doesn't apply.
        console.warn(
          `[issues] sonarr instance "${sanitizeForLog(instance)}" replacement search for series ${arrId} stopped after ${queued} command(s):`,
          arrErrorMessage(err),
        );
      }
      return "queued";
    }
    case "missing":
      try {
        const result = await searchMissing("sonarr", instance, arrId, new Date());
        if (result.partial) {
          // Same shape as the "plan" case above: some searches are queued, so the
          // replacement is still tracked; the refusal of the rest is an event.
          console.warn(
            `[issues] sonarr instance "${sanitizeForLog(instance)}" replacement search for series ${arrId} stopped after ${result.commands} command(s)`,
          );
        }
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
 * What is known about how each grab was picked, for the marks:
 *   notNeeded  — the arr redownloads interactive grabs too (or not at all), so
 *                it was never read;
 *   unreadable — the read failed: every grab is taken as interactive, so its
 *                files are searched for here;
 *   read       — the title's history as the arr sent it.
 */
type GrabHistory = { kind: "notNeeded" } | { kind: "unreadable" } | { kind: "read"; raw: unknown };

/**
 * The title's history as the arr sends it — only to read each grab's
 * `data.releaseSource`, which the projection doesn't carry.
 */
async function readGrabHistory(service: ArrService, instance: string, arrId: number): Promise<GrabHistory> {
  try {
    const cfg = await configuredArrCfg(service, instance);
    const path = service === "radarr" ? `/api/v3/history/movie?movieId=${arrId}` : `/api/v3/history/series?seriesId=${arrId}`;
    const raw = await arrFetch<unknown>(cfg, path, { quietErrors: true });
    return raw === null ? { kind: "unreadable" } : { kind: "read", raw };
  } catch {
    return { kind: "unreadable" };
  }
}

/** Whether a mark's grab counts as picked by hand (see GrabHistory). */
function markIsInteractive(history: GrabHistory, service: ArrService, arrId: number, mark: ReplaceMark): boolean {
  switch (history.kind) {
    case "notNeeded": return false;
    case "unreadable": return true;
    case "read": return isInteractiveGrab(service, arrId, history.raw, mark.grab);
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

type RemonitorAudit = (details: Record<string, unknown>) => void;
type RemonitorWarn = (what: string, err: unknown) => void;

// Re-reading or re-monitoring failed: what the delete unmonitored may still be.
const REMONITOR_FAILED: RemonitorOutcome = { remonitored: 0, failed: true, stillUnmonitored: () => true };

// Radarr: the movie's own monitored flag, before (as `loaded` read it) and now.
async function undoMovieUnmonitor(loaded: Loaded, audit: RemonitorAudit, warn: RemonitorWarn): Promise<RemonitorOutcome> {
  const { instance } = loaded.target;
  const arrId = loaded.arrId;
  const before = loaded.raw?.monitored === true;
  let after: boolean;
  try {
    const raw = await readTitleResource("radarr", instance, arrId);
    if (typeof raw.monitored !== "boolean") throw new Error("the movie carries no monitored flag");
    after = raw.monitored;
  } catch (err) {
    warn("re-reading the movie", err);
    return REMONITOR_FAILED;
  }
  if (unmonitoredByDelete([{ id: arrId, monitored: before }], [{ id: arrId, monitored: after }]).length === 0) {
    return { remonitored: 0, failed: false, stillUnmonitored: () => !after };
  }
  try {
    // The movie editor (PUT /api/v3/movie/editor) — only `monitored` is sent.
    await editTitle("radarr", instance, arrId, { monitored: true });
  } catch (err) {
    warn("re-monitoring the movie", err);
    return REMONITOR_FAILED;
  }
  audit({ fields: ["monitored"], monitored: true });
  return { remonitored: 1, failed: false, stillUnmonitored: () => false };
}

// Sonarr: the deleted files' episodes, before (`loaded.episodes`) and re-read now.
async function undoEpisodeUnmonitor(
  loaded: Loaded,
  deleted: readonly ReplaceableFile[],
  audit: RemonitorAudit,
  warn: RemonitorWarn,
): Promise<RemonitorOutcome> {
  const { instance } = loaded.target;
  const arrId = loaded.arrId;
  const deletedEpisodes = episodesFor(episodesOf(deleted), loaded.episodes);
  let after: TitleEpisode[];
  try {
    after = await readSeriesEpisodes(instance, arrId);
  } catch (err) {
    warn("re-reading the episodes", err);
    return REMONITOR_FAILED;
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
  // A deleted file's episode the list didn't hold counts as unmonitored too.
  const listed = new Set(deletedEpisodes.map(episodeKey));
  for (const e of episodesOf(deleted)) {
    if (!listed.has(episodeKey(e))) off.add(episodeKey(e));
  }
  return {
    remonitored: failed ? 0 : flipped.length,
    failed,
    stillUnmonitored: (f) => f.episodes.some((e) => off.has(episodeKey(e))),
  };
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
  audit: RemonitorAudit,
): Promise<RemonitorOutcome> {
  if (deleted.length === 0) return { remonitored: 0, failed: false, stillUnmonitored: () => false };
  const { service, instance } = loaded.target;
  const warn: RemonitorWarn = (what, err) =>
    console.warn(`[issues] ${service} instance "${sanitizeForLog(instance)}" ${what} after Replace file failed:`, arrErrorMessage(err));
  return service === "radarr"
    ? undoMovieUnmonitor(loaded, audit, warn)
    : undoEpisodeUnmonitor(loaded, deleted, audit, warn);
}

/** One replace, from the delete on: what the POST resolved before it. */
interface ReplaceRun {
  issue: Issue;
  loaded: Loaded;
  /** The in-scope files the admin chose, as re-read now (guardrail 5f). */
  chosen: ReplaceableFile[];
  then: ReplaceFollowUp;
  /** Triggering user, for the IssueGrab row. */
  userId: string;
  t: Translator;
  /** Writes one post-commit audit row about the title (the swallowing logAudit — guardrail 26). */
  audit: (action: AuditAction, details: Record<string, unknown>) => void;
}

/**
 * Delete the chosen files through the arr, audited with exactly what it deleted
 * — even when Radarr stopped part-way (guardrail 26). A delete that sent
 * nothing answers the arr failure.
 */
async function deleteChosen(run: ReplaceRun): Promise<{ deletedIds: number[]; deleteError: unknown } | NextResponse> {
  const { target, arrId } = run.loaded;
  const { service, instance } = target;
  let deletedIds: number[];
  let deleteError: unknown;
  try {
    ({ deleted: deletedIds, error: deleteError } = await deleteTitleFiles(service, instance, arrId, run.chosen.map((f) => f.id)));
  } catch (err) {
    return arrFailure(err, target, run.t, "issue file delete");
  }
  run.audit("ARR_FILE_DELETE", { service, instance, arrId, fileIds: deletedIds, count: deletedIds.length, issueId: run.issue.id });
  if (deleteError) {
    console.warn(`[issues] ${service} instance "${sanitizeForLog(instance)}" file delete stopped part-way:`, arrErrorMessage(deleteError));
  }
  return { deletedIds, deleteError };
}

interface MarkOutcome {
  monitor: RemonitorOutcome;
  marks: ReplaceMark[];
  settings: RedownloadSettings;
  marked: number;
  redownloading: number;
  /** Deleted files a mark's redownload will search for. */
  covered: Set<number>;
}

/**
 * Set back to monitored whatever the delete unmonitored — BEFORE the marks and
 * the search, which both reach monitored items only — then, for "markFailed",
 * mark each deleted file's grab failed: ONE mark per download, in sequence
 * (each re-reads the title's history first, so a pack marked by the first can
 * never be marked again). Each write is audited after the arr accepted it.
 */
async function remonitorAndMark(run: ReplaceRun, deleted: readonly ReplaceableFile[]): Promise<MarkOutcome> {
  const { target, arrId } = run.loaded;
  const { service, instance } = target;
  const monitor = await undoDeleteUnmonitor(run.loaded, deleted, (details) => {
    run.audit("ARR_TITLE_EDIT", { service, instance, arrId, ...details, trigger: "replaceFile", issueId: run.issue.id });
  });

  const marks = run.then === "markFailed" ? planMarks(deleted) : [];
  const settings: RedownloadSettings = marks.length > 0 ? await readRedownloadSettings(service, instance) : { failed: null, interactive: null };
  // Which grabs were picked by hand matters only when the arr says it won't
  // redownload those.
  const history: GrabHistory = settings.failed === true && settings.interactive === false
    ? await readGrabHistory(service, instance, arrId)
    : { kind: "notNeeded" };
  // Radarr's redownload is an automatic search, which honours Minimum
  // Availability — a movie that isn't "available" yet is searched for here.
  const available = service !== "radarr" || run.loaded.raw?.isAvailable !== false;
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
    run.audit("ARR_MARK_FAILED", { service, instance, arrId, historyId: mark.grab.id, release, issueId: run.issue.id });
    // Only a redownload the arr's switches say happens searches for the mark's
    // files (off, unreadable, or an interactive grab with that switch off ⇒
    // searched for here) — and only when none of them is still unmonitored:
    // the arr's redownload searches monitored items only.
    const interactive = markIsInteractive(history, service, arrId, mark);
    const markFiles = deleted.filter((f) => mark.fileIds.includes(f.id));
    if (redownloadCovers(settings, interactive, available) && !markFiles.some(monitor.stillUnmonitored)) {
      redownloading++;
      for (const fileId of mark.fileIds) covered.add(fileId);
    }
  }
  return { monitor, marks, settings, marked, redownloading, covered };
}

/**
 * Search for what no mark covers, then record the IssueGrab once a mark or a
 * search was queued. A failed search is reported, never thrown: the files are
 * already gone.
 */
async function runFollowUp(
  run: ReplaceRun,
  deleted: readonly ReplaceableFile[],
  remaining: readonly TitleFile[],
  marking: MarkOutcome,
): Promise<{ searched: boolean; nothingMissing: boolean; searchError: unknown }> {
  const { issue, loaded } = run;
  const { service, instance } = loaded.target;
  const uncovered = deleted.filter((f) => !marking.covered.has(f.id));
  const search = followUpSearch(loaded.scope, uncovered, remaining, {
    anyCovered: marking.covered.size > 0,
    unmonitored: uncovered.some(marking.monitor.stillUnmonitored),
  });
  let searched = false;
  let nothingMissing = false;
  let searchError: unknown = null;
  if (search) {
    try {
      const outcome = await runSearch(search, instance, loaded.arrId, uncovered);
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
  // It supersedes the issue's earlier pending grabs on this instance (one
  // import, one announcement — recordIssueGrab).
  if (marking.marked > 0 || searched) {
    const rawTvdb = loaded.raw?.tvdbId;
    try {
      await recordIssueGrab({
        issueId: issue.id,
        triggeredById: run.userId,
        tmdbId: issue.tmdbId,
        tvdbId: issue.tvdbId ?? (service === "sonarr" && typeof rawTvdb === "number" && Number.isSafeInteger(rawTvdb) && rawTvdb > 0 ? rawTvdb : null),
        mediaType: issue.mediaType,
        title: issue.title,
        scope: issue.scope,
        seasonNumber: issue.seasonNumber,
        episodeNumber: issue.episodeNumber,
        arrInstance: instance,
      });
    } catch (err) {
      console.warn("[issues] Replace file succeeded but recording the grab failed (issue deleted meanwhile?):", err);
    }
  }
  return { searched, nothingMissing, searchError };
}

/** Everything from the delete on — the part a long series can stretch past a proxy's hold. */
async function replaceFiles(run: ReplaceRun): Promise<NextResponse> {
  const del = await deleteChosen(run);
  if (del instanceof NextResponse) return del;
  const { deletedIds, deleteError } = del;
  const gone = new Set(deletedIds);
  const deleted = run.chosen.filter((f) => gone.has(f.id));
  const remaining = run.loaded.titleFiles.filter((f) => !gone.has(f.id));
  const marking = await remonitorAndMark(run, deleted);
  const { searched, nothingMissing, searchError } = await runFollowUp(run, deleted, remaining, marking);

  const service = run.loaded.target.service;
  const result = {
    deleted: deletedIds.length,
    requested: run.chosen.length,
    marked: marking.marked,
    // Marks the arr refused or failed — those files were searched for instead.
    unmarked: marking.marks.length - marking.marked,
    searched,
    // The arr's Redownload Failed switch (null when no mark was planned or it couldn't be read).
    redownload: marking.settings.failed,
    // Marks the arr's own redownload searches for (none of ours for their files).
    redownloading: marking.redownloading,
    // What the delete unmonitored and was set back; a failure there means the
    // files were searched for by name, and may stay unmonitored in the arr.
    remonitored: marking.monitor.remonitored,
    remonitorFailed: marking.monitor.failed,
    nothingMissing,
  };
  // A search that could not be queued outranks a delete that stopped part-way:
  // the files that did go have nothing coming to replace them.
  if (searchError) {
    return NextResponse.json(
      { ...result, error: run.t("apiUser.issues.replaceFile.searchFailed", { count: deletedIds.length, service: ARR_SERVICE_LABEL[service] }) },
      { status: 502 },
    );
  }
  if (deleteError) {
    return NextResponse.json(
      { ...result, error: run.t("apiAdmin.arr.partialDelete", { done: deletedIds.length, total: run.chosen.length }) },
      { status: 502 },
    );
  }
  return NextResponse.json(result);
}

/** The POST body, validated: the follow-up, the file ids and whether to run it as a background job. */
function parseReplaceBody(body: Record<string, unknown>): { then: ReplaceFollowUp; fileIds: number[]; background: boolean } | null {
  const then = parseReplaceFollowUp(body.then);
  const fileIds = parseIdArray(body.fileIds, MAX_FILES);
  const background = body.async;
  if (!then || !fileIds || (background !== undefined && typeof background !== "boolean")) return null;
  return { then, fileIds, background: background === true };
}

/**
 * One replace from the status CAS on, holding the issue's in-flight claim: the
 * inline replace (or a refusal before it) releases the claim when it ends; a
 * background job releases it from the job itself.
 */
async function runClaimedReplace(
  issue: Issue,
  run: ReplaceRun,
  // The background job's join key; null runs the replace inline.
  backgroundKey: string | null,
  session: SummonarrSession,
  req: NextRequest,
): Promise<NextResponse> {
  const id = issue.id;
  let jobOwnsClaim = false;
  try {
    // Move the issue to IN_PROGRESS BEFORE anything is deleted, with the release
    // grab's compare-and-swap ("only if still not RESOLVED"): the arr calls
    // can't sit inside a DB transaction, so this check up front is what stops a
    // file being deleted for an issue someone just closed. If the delete then
    // fails, leaving IN_PROGRESS is fine — an admin did try. A real change is
    // announced and audited now, whatever happens below.
    const claimed = await promoteIssueInProgress({ issue, from: "notResolved", trigger: "replaceFile", details: { scope: issue.scope }, session, req });
    if (claimed === 0) {
      return NextResponse.json({ error: run.t("apiUser.issues.replaceFile.resolved") }, { status: 409 });
    }
    if (backgroundKey === null) return await replaceFiles(run);
    const { jobId, joined } = startArrJob(session.user.id, backgroundKey, async () => {
      try {
        return await answerOf(await replaceFiles(run));
      } finally {
        inFlight.delete(id);
      }
    });
    // A joined job never runs this callback, so the claim would never be
    // released by it. Unreachable today (the claim above refuses a second
    // replace of the issue while one runs) — but the release must not depend
    // on that ordering.
    jobOwnsClaim = !joined;
    return NextResponse.json({ job: jobId }, { status: 202 });
  } finally {
    if (!jobOwnsClaim) inFlight.delete(id);
  }
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

  const body = await readJsonCapped<Record<string, unknown>>(req, 64 * 1024);
  if (body instanceof NextResponse) return body;
  const parsedBody = parseReplaceBody(body);
  if (!parsedBody) {
    return NextResponse.json({ error: t("apiUser.issues.replaceFile.bodyInvalid") }, { status: 400 });
  }
  const { then, fileIds, background } = parsedBody;
  // This admin's identical replace of this issue is already running: join it —
  // nothing is read, deleted or searched again, and no rate token is spent. The
  // instance is parsed as loadIssueFiles parses it; a malformed one joins nothing.
  const joinInstance = parseInstanceParam(body.instance);
  const running = background && joinInstance !== null ? runningArrJob(session.user.id, jobKey(id, joinInstance, then, fileIds)) : null;
  if (running) return NextResponse.json({ job: running }, { status: 202 });
  if (!checkRateLimit(`issue-replace-file:${session.user.id}`, LIMIT_PER_MIN, 60_000)) {
    return tooManyRequests(60, t("apiUser.common.tooManyRequestsLater"));
  }

  // Re-read the files and the history NOW (guardrail 5e): the page's list may
  // be stale, and only the instance's own answer decides what is deleted.
  const loaded = await loadIssueFiles(issue, body.instance, t);
  if (loaded instanceof NextResponse) return loaded;
  const { service, instance } = loaded.target;
  const chosen = chooseFiles(loaded.files, fileIds);
  if (!chosen) return NextResponse.json({ error: t("apiUser.issues.replaceFile.notInScope") }, { status: 409 });

  const ctx = auditContext(req, session);
  const run: ReplaceRun = {
    issue,
    loaded,
    chosen,
    then,
    userId: session.user.id,
    t,
    audit: (action, details) => {
      void logAudit({
        userId: session.user.id,
        userName: session.user.name ?? session.user.email ?? null,
        action,
        target: `${service}:${instance}:${loaded.arrId}`,
        details,
        ...ctx,
      });
    },
  };

  // One replace per issue at a time — claimed synchronously (no await between
  // the check and the add), BEFORE the CAS, so the loser writes nothing.
  // runClaimedReplace releases the claim.
  if (inFlight.has(id)) {
    return NextResponse.json({ error: t("apiUser.issues.replaceFile.alreadyRunning") }, { status: 409 });
  }
  inFlight.add(id);
  return runClaimedReplace(issue, run, background ? jobKey(id, instance, then, fileIds) : null, session, req);
});
