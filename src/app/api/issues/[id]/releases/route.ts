import { NextResponse } from "next/server";
import { withIssueAdmin } from "@/lib/api-auth";
import { grabDefinitelyRefused, grabRefusalResponse } from "@/lib/release-grab";
import { claimReleaseHandle, forgetReleaseHandle, issueReleaseHandles, releaseReleaseHandle, type ReleaseClaim } from "@/lib/release-handles";
import { answerOf, releaseSearchJobResponse, runningReleaseSearchJob, startReleaseSearchJob } from "@/lib/release-search-jobs";
import { tooManyRequests } from "@/lib/http";
import { checkRateLimit } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import {
  ReleaseSeasonRequiredError,
  arrErrorMessage,
  getReleasesForMovie,
  getReleasesForSeries,
  grabMovieRelease,
  grabSeriesRelease,
  resolveTvdbIdFromTmdbId,
  type GrabProgress,
} from "@/lib/arr";
import { seriesReleaseScopeSearchable } from "@/lib/release-scope";
import { issueArrService, resolveIssueArrInstance, type IssueArrService } from "@/lib/issue-arr-instance";
import { logAudit, auditContext } from "@/lib/audit";
import { maintenanceGuard } from "@/lib/maintenance";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { recordIssueGrab } from "@/lib/issue-grab";
import { promoteIssueInProgress } from "@/lib/issue-transitions";
import type { Issue } from "@/generated/prisma";

type RouteContext = { params: Promise<{ id: string }> };

const HANDLE_RE = /^[0-9a-f]{32}$/;
// Interactive searches per admin per minute — the same budget as the request
// queue's Pick release and the title manager's search (each sweeps every indexer).
const SEARCH_LIMIT_PER_MIN = 20;

// Each release's `guid` is handed out as an opaque handle bound to this issue,
// service and instance (release-handles.ts) — the request "Pick release" rule:
// some indexers (and Prowlarr's proxied feeds) build the guid from the
// apikey'd download link, and this list reaches MANAGE_ISSUES delegates, not
// only admins. The handle rides in the `guid` field, so the wire shape the
// iOS app decodes (`[ArrRelease]`, POST `{ guid, indexerId }`) is unchanged.
const handleScope = (issueId: string, service: IssueArrService, instance: string) =>
  ["issue", issueId, service, instance].join("\u0000");

const VALID_SCOPES = ["FULL", "SEASON", "EPISODE"] as const;
type IssueScope = typeof VALID_SCOPES[number];

// Sonarr searches a SEASON or an EPISODE only: `/api/v3/release` with just a
// `seriesId` is the indexers' RSS feed — other shows' episodes, some of them
// grabbable, which the panel would pre-select and the grab would download
// under this issue. A whole-series (FULL) issue therefore has no release
// search (Refetch, or an admin's Replace file, covers it), and neither does a
// SEASON/EPISODE issue missing its numbers. Answered before any upstream read,
// for the search and the grab alike. null = searchable.
function seriesScopeRefusal(
  issue: { mediaType: string; scope: string; seasonNumber: number | null; episodeNumber: number | null },
  t: Translator,
): NextResponse | null {
  if (issue.mediaType === "MOVIE") return null;
  if (!(VALID_SCOPES as readonly string[]).includes(issue.scope)) {
    return NextResponse.json({ error: t("apiUser.issues.invalidScope") }, { status: 422 });
  }
  if (!seriesReleaseScopeSearchable(issue.scope, issue.seasonNumber, issue.episodeNumber)) {
    return NextResponse.json({ error: t("apiUser.issues.replaceNeedsSeason") }, { status: 422 });
  }
  return null;
}

// GET → the bare `[ArrRelease]` list, synchronously — the wire contract the iOS
// app decodes. `&async=1` (the web panel) → 202 { job } at once: the search runs
// in the background (release-search-jobs.ts, the guardrail-37a pattern — a
// Sonarr season search takes 60–120 s, past what a reverse proxy holds a
// request) and GET ?job=<id> answers 202 while it runs, then the search's own
// status and body, 404 once the job is gone. Polls are the starting admin's
// only, and the same admin re-searching the same issue and instance while one
// runs joins it (no second indexer sweep).
export const GET = withIssueAdmin(async (req, { params }: RouteContext, session) => {
  const t = translatorForRequest(req);
  const job = req.nextUrl.searchParams.get("job");
  if (job !== null) return releaseSearchJobResponse(session.user.id, job, t);
  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });

  // The slug must be valid, its integration on and the instance one the
  // registry lists as configured, the default "" included (issue-arr-instance.ts).
  const service = issueArrService(issue.mediaType);
  const instanceOr = await resolveIssueArrInstance(req.nextUrl.searchParams.get("instance"), service, t);
  if (instanceOr instanceof NextResponse) return instanceOr;
  const instance = instanceOr;
  const refused = seriesScopeRefusal(issue, t);
  if (refused) return refused;

  const key = handleScope(id, service, instance);
  const background = req.nextUrl.searchParams.get("async") === "1";
  // Joining a search already running costs no indexer hit, so no rate token;
  // past that, the same per-user budget as the request-queue and title-manager
  // searches (SEARCH_LIMIT_PER_MIN) — every search sweeps every indexer, and
  // this one is reachable by MANAGE_ISSUES delegates.
  const running = background ? runningReleaseSearchJob(session.user.id, key) : null;
  if (running) return NextResponse.json({ job: running }, { status: 202 });
  if (!checkRateLimit(`issue-releases:${session.user.id}`, SEARCH_LIMIT_PER_MIN, 60_000)) {
    return tooManyRequests(60, t("apiUser.common.tooManyRequestsLater"));
  }

  const search = async (): Promise<NextResponse> => {
    try {
      let releases;
      if (issue.mediaType === "MOVIE") {
        releases = await getReleasesForMovie(issue.tmdbId, instance);
      } else {
        let tvdbId = issue.tvdbId;
        if (!tvdbId) {
          tvdbId = await resolveTvdbIdFromTmdbId(issue.tmdbId, instance);
          if (!tvdbId) {
            return NextResponse.json({ error: t("apiUser.issues.tvdbUnresolved") }, { status: 422 });
          }
        }
        releases = await getReleasesForSeries(
          tvdbId,
          issue.scope as IssueScope,
          issue.seasonNumber,
          issue.episodeNumber,
          instance,
        );
      }
      // `releases` is already projected to the ArrRelease field list by arr.ts
      // (toArrRelease) — the raw upstream objects carry indexer download URLs —
      // and each guid is swapped for a handle (see handleScope).
      return NextResponse.json(issueReleaseHandles(key, releases, { owner: session.user.id }));
    } catch (err) {
      if (err instanceof ReleaseSeasonRequiredError) {
        return NextResponse.json({ error: t("apiUser.issues.replaceNeedsSeason") }, { status: 422 });
      }
      // The detail (which includes raw upstream `err.message`) goes to the log;
      // the client gets the translated generic, like the refetch path.
      console.error("[releases] Fetch failed:", arrErrorMessage(err));
      return NextResponse.json({ error: t("apiUser.issues.arrFailed") }, { status: 502 });
    }
  };
  if (!background) return await search();
  // The same admin's search of the same issue and instance already running is
  // JOINED (startReleaseSearchJob): no second indexer sweep.
  const { jobId } = startReleaseSearchJob(session.user.id, key, async () => answerOf(await search()));
  return NextResponse.json({ job: jobId }, { status: 202 });
});

type PickedRelease = Exclude<ReleaseClaim, "unknown" | "busy">;

/**
 * Send the picked release to the issue's instance. Resolves to the series'
 * TVDB id it grabbed under (the row's, else resolved now; null for a movie), or
 * the 422 when a series' TVDB id can't be resolved. Every failure decides the
 * handle's fate itself (see the catch) and answers: the arr's own refusal
 * where it explains itself, else the translated generic 502.
 */
async function grabPickedRelease(
  issue: Issue,
  handle: string,
  picked: PickedRelease,
  instance: string,
  service: IssueArrService,
  t: Translator,
): Promise<{ tvdbId: number | null } | NextResponse> {
  let tvdbId: number | null = issue.tvdbId;
  // Set by the arr helper just before POST /api/v3/release goes out: a failure
  // while it is still false (no config, the title lookup, the tvdb resolution)
  // sent nothing, so the handle goes back and a retry needs no new search.
  const progress: GrabProgress = { sent: false };
  try {
    if (issue.mediaType === "MOVIE") {
      await grabMovieRelease(issue.tmdbId, picked.guid, picked.indexerId, instance, progress);
      return { tvdbId };
    }
    if (!tvdbId) {
      tvdbId = await resolveTvdbIdFromTmdbId(issue.tmdbId, instance);
      if (!tvdbId) {
        releaseReleaseHandle(handle);
        return NextResponse.json({ error: t("apiUser.issues.tvdbUnresolved") }, { status: 422 });
      }
    }
    // Both SEASON and EPISODE issues pass their seasonNumber, so the grab
    // targets the right season. Only EPISODE issues pass an episodeNumber.
    await grabSeriesRelease(
      tvdbId,
      picked.guid,
      picked.indexerId,
      issue.scope === "EPISODE" || issue.scope === "SEASON" ? issue.seasonNumber : null,
      issue.scope === "EPISODE" ? issue.episodeNumber : null,
      instance,
      progress,
    );
    return { tvdbId };
  } catch (err) {
    // Nothing sent yet (no config, the title lookup or the tvdb resolution
    // failed), or the arr definitely refused (a 4xx, or it doesn't have the
    // title): the release may be tried again. No answer, or a 408/5xx (a
    // timeout, a gateway that gave up mid-grab): it may well have taken it —
    // never send it twice.
    if (!progress.sent) releaseReleaseHandle(handle);
    else if (grabDefinitelyRefused(err)) releaseReleaseHandle(handle);
    else forgetReleaseHandle(handle);
    // The arr's own refusals say what to do: search again (its 30-minute
    // search cache no longer has the release) or why the indexer or client
    // refused it (masked).
    const refused = grabRefusalResponse(err, service === "radarr" ? "Radarr" : "Sonarr", t);
    if (refused) return refused;
    // Detail to the log, translated generic to the client (see the GET catch).
    console.error("[releases] Grab failed:", arrErrorMessage(err));
    return NextResponse.json({ error: t("apiUser.issues.arrFailed") }, { status: 502 });
  }
}

// The grab the arr accepted, as an IssueGrab row. Kept OUTSIDE the grab's
// try/catch: Radarr/Sonarr has already accepted the download, so a failure here
// must not answer 502 "grab failed" (the admin would retry and download the same
// release twice). The usual cause is the issue being deleted during the grab,
// which breaks the IssueGrab -> Issue link (Prisma error P2003). The row
// supersedes the issue's earlier pending grabs on this instance (one import, one
// announcement — recordIssueGrab). The row's id, or null when it wasn't written.
async function recordGrab(issue: Issue, userId: string, tvdbId: number | null, instance: string): Promise<string | null> {
  try {
    const grab = await recordIssueGrab({
      issueId: issue.id,
      triggeredById: userId,
      tmdbId: issue.tmdbId,
      tvdbId,
      mediaType: issue.mediaType,
      title: issue.title,
      scope: issue.scope,
      seasonNumber: issue.seasonNumber,
      episodeNumber: issue.episodeNumber,
      arrInstance: instance,
    });
    return grab.id;
  } catch (err) {
    console.warn("[releases] Grab succeeded but recording it failed (issue deleted mid-grab?):", err);
    return null;
  }
}

export const POST = withIssueAdmin(async (req, { params }: RouteContext, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });

  // A RESOLVED issue is closed, so don't start a download for it. (The status
  // update further down re-checks this in case the issue is resolved meanwhile.)
  if (issue.status === "RESOLVED") {
    return NextResponse.json({ error: t("apiUser.issues.resolvedBeforeGrab") }, { status: 409 });
  }

  const parsed = await readJsonCapped<{ guid?: unknown; indexerId?: unknown; instance?: unknown }>(req, 65536);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const service = issueArrService(issue.mediaType);
  const instanceOr = await resolveIssueArrInstance(body.instance, service, t);
  if (instanceOr instanceof NextResponse) return instanceOr;
  const instance = instanceOr;
  // No release of a whole-series issue is ever grabbed under it (see
  // seriesScopeRefusal) — refused before the handle claim and the CAS.
  const scopeRefused = seriesScopeRefusal(issue, t);
  if (scopeRefused) return scopeRefused;

  const { guid, indexerId } = body;
  if (!guid || typeof guid !== "string") {
    return NextResponse.json({ error: t("apiUser.issues.guidRequired") }, { status: 400 });
  }
  // Still checked, no longer used: the handle names the indexer (below). The
  // POST body `{ guid, indexerId }` is the wire contract the iOS app sends.
  if (!Number.isInteger(indexerId) || (indexerId as number) <= 0) {
    return NextResponse.json({ error: t("apiUser.issues.indexerIdInvalid") }, { status: 400 });
  }
  // `guid` is a handle from this issue's own search — the only shape accepted,
  // and it is never sent anywhere (the handle resolves to the arr's own guid).
  // A raw indexer guid (an older client, a replay) is "search again", like an
  // expired handle.
  if (!HANDLE_RE.test(guid)) {
    return NextResponse.json({ error: t("apiUser.requests.releases.handleExpired") }, { status: 410 });
  }
  // Claim it for ONE grab BEFORE the CAS, synchronously: of two requests racing
  // with one handle (a double submit, a replay) exactly one reaches the arr —
  // the CAS below (`not RESOLVED`) lets both through, and the download client
  // would fetch the release twice. An unknown handle never flips the issue.
  const picked = claimReleaseHandle(handleScope(id, service, instance), guid, Date.now(), session.user.id);
  if (picked === "unknown") return NextResponse.json({ error: t("apiUser.requests.releases.handleExpired") }, { status: 410 });
  if (picked === "busy") return NextResponse.json({ error: t("apiUser.requests.releases.grabInProgress") }, { status: 409 });

  // Move the issue to IN_PROGRESS BEFORE the grab, with a compare-and-swap
  // ("only if it is still not RESOLVED"). The row we read above may be out of
  // date, and someone may have resolved the issue since; count 0 means they did,
  // so we stop. The grab is an HTTP call and can't run inside a DB transaction,
  // so this check up front is what prevents an unwanted download. If the grab
  // then fails, leaving IN_PROGRESS is fine: an admin did try.
  //
  // A real change is announced AND audited right after the CAS: the row already
  // says IN_PROGRESS, and the 422/502 returns below leave it that way, so other
  // admins' lists, the reporter's page and the audit log hear about it even
  // when the grab then fails. The grab itself is audited after it succeeds.
  let claimed: number;
  try {
    claimed = await promoteIssueInProgress({ issue, from: "notResolved", trigger: "grab", details: { scope: issue.scope }, session, req });
  } catch (err) {
    releaseReleaseHandle(guid); // nothing was sent: a retry may use it
    throw err;
  }
  if (claimed === 0) {
    releaseReleaseHandle(guid);
    return NextResponse.json({ error: t("apiUser.issues.resolvedBeforeGrab") }, { status: 409 });
  }

  const grabbed = await grabPickedRelease(issue, guid, picked, instance, service, t);
  if (grabbed instanceof NextResponse) return grabbed;
  forgetReleaseHandle(guid);
  const grabId = await recordGrab(issue, session.user.id, grabbed.tvdbId, instance);

  // The grab itself. The status flip (if any) was audited right after its CAS
  // above, so this entry records only what happened here: which release went
  // to which instance. `grabId` is absent when the IssueGrab row could not be
  // written (see recordGrab) — the download still happened. The release NAME
  // is recorded, never the guid (some indexers put the apikey in it).
  // ARR_RELEASE_GRAB, like every other grab (request queue, title manager,
  // queue Grab now), so the audit log's "Release Grabbed" filter finds it; the
  // status flip above keeps its ISSUE_STATUS_CHANGE row.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_RELEASE_GRAB",
    target: `issue:${id}`,
    details: {
      trigger: "grab",
      ...(grabId ? { grabId } : {}),
      scope: issue.scope,
      instance,
      indexerId: picked.indexerId,
      release: picked.title,
    },
    ...auditContext(req, session),
  });

  return NextResponse.json({ ok: true });
});
