import { NextResponse } from "next/server";
import { withIssueAdmin } from "@/lib/api-auth";
import { grabDefinitelyRefused, grabRefusalResponse } from "@/lib/release-grab";
import { claimReleaseHandle, forgetReleaseHandle, issueReleaseHandles, releaseReleaseHandle } from "@/lib/release-handles";
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
import { isValidInstanceSlug } from "@/lib/arr-instances";
import { getSyncableArrInstances } from "@/lib/arr-instance-registry";
import { logAudit, auditContext } from "@/lib/audit";
import { maintenanceGuard } from "@/lib/maintenance";
import { emitSSE } from "@/lib/sse-emitter";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { recordIssueGrab } from "@/lib/issue-grab";

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
const handleScope = (issueId: string, service: "radarr" | "sonarr", instance: string) =>
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

// Resolves + validates the target instance slug for a release browse/grab.
// The slug must be valid and name a CONFIGURED connection — the default ""
// included. The default used to skip the check and fall through to the arr
// helper's "Radarr is not configured" throw, which the catch answered as a 502
// (an upstream-failure status for a local config state) in hardcoded English,
// while the same condition on a named instance was a translated 422. The
// default has no slug to print, so it gets the name-only message.
// Returns a NextResponse on rejection.
async function resolveInstanceOr(
  raw: string | null | undefined,
  service: "radarr" | "sonarr",
  t: Translator,
): Promise<string | NextResponse> {
  const instance = typeof raw === "string" ? raw.trim() : "";
  if (!isValidInstanceSlug(instance)) {
    return NextResponse.json({ error: t("apiUser.common.invalidInstance") }, { status: 400 });
  }
  // The registry decides which slugs exist (guardrail 32): a de-registered
  // instance's Url/ApiKey rows can outlive it, and a bare isArrConfigured would
  // turn any slug a MANAGE_ISSUES delegate guesses into those Setting reads —
  // and then into searches and grabs on a server the admin removed.
  const configured = await getSyncableArrInstances(service);
  if (!configured.some((i) => i.slug === instance)) {
    const error = instance === ""
      ? t("apiUser.common.notConfigured", { name: service === "radarr" ? "Radarr" : "Sonarr" })
      : t("apiUser.issues.instanceNotConfigured", { service, instance });
    return NextResponse.json({ error }, { status: 422 });
  }
  return instance;
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

  const service = issue.mediaType === "MOVIE" ? ("radarr" as const) : ("sonarr" as const);
  const instanceOr = await resolveInstanceOr(req.nextUrl.searchParams.get("instance"), service, t);
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

  const parsed = await readJsonCapped<{ guid?: string; indexerId?: number; instance?: string }>(req, 65536);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const service = issue.mediaType === "MOVIE" ? ("radarr" as const) : ("sonarr" as const);
  const instanceOr = await resolveInstanceOr(body.instance, service, t);
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

  // Only allow characters a real release guid uses. Radarr/Sonarr guids are
  // URL-like tokens from the indexers and never contain whitespace, quotes,
  // brackets, backslashes or control characters. Listing what IS allowed is
  // safer than listing what is not, because nothing unexpected slips through.
  if (guid.length === 0 || guid.length > 500 || !/^[A-Za-z0-9._:/+\-=?&%#@~,!*$]+$/.test(guid)) {
    return NextResponse.json({ error: t("apiUser.issues.guidInvalid") }, { status: 400 });
  }
  // Still checked, no longer used: the handle names the indexer (below).
  if (!Number.isInteger(indexerId) || (indexerId as number) <= 0) {
    return NextResponse.json({ error: t("apiUser.issues.indexerIdInvalid") }, { status: 400 });
  }
  // `guid` is a handle from this issue's own search. A raw indexer guid (an
  // older client, a replay) is "search again", like an expired handle.
  if (!HANDLE_RE.test(guid)) {
    return NextResponse.json({ error: t("apiUser.requests.releases.handleExpired") }, { status: 410 });
  }
  // Claim it for ONE grab BEFORE the CAS, synchronously: of two requests racing
  // with one handle (a double submit, a replay) exactly one reaches the arr —
  // the CAS below (`not RESOLVED`) lets both through, and the download client
  // would fetch the release twice. An unknown handle never flips the issue.
  const picked = claimReleaseHandle(handleScope(id, service, instance), guid);
  if (picked === "unknown") return NextResponse.json({ error: t("apiUser.requests.releases.handleExpired") }, { status: 410 });
  if (picked === "busy") return NextResponse.json({ error: t("apiUser.requests.releases.grabInProgress") }, { status: 409 });

  // Move the issue to IN_PROGRESS BEFORE the grab, with a compare-and-swap
  // ("only if it is still not RESOLVED"). The row we read above may be out of
  // date, and someone may have resolved the issue since; count 0 means they did,
  // so we stop. The grab is an HTTP call and can't run inside a DB transaction,
  // so this check up front is what prevents an unwanted download. If the grab
  // then fails, leaving IN_PROGRESS is fine: an admin did try.
  let claim: { count: number };
  try {
    claim = await prisma.issue.updateMany({
      where: { id, status: { not: "RESOLVED" } },
      data: { status: "IN_PROGRESS" },
    });
  } catch (err) {
    releaseReleaseHandle(guid); // nothing was sent: a retry may use it
    throw err;
  }
  if (claim.count === 0) {
    releaseReleaseHandle(guid);
    return NextResponse.json({ error: t("apiUser.issues.resolvedBeforeGrab") }, { status: 409 });
  }
  const statusChanged = issue.status !== "IN_PROGRESS";
  // Announce AND audit the status change now: the row already says IN_PROGRESS,
  // and the 422/502 returns below leave it that way, so other admins' lists and
  // the reporter's page need to hear about it here — and the audit log needs
  // the row too, or a flip whose grab then failed had no entry saying who moved
  // it (guardrail 26: the CAS has committed, so the swallowing logAudit). Only
  // a real change is broadcast/audited; the grab itself is audited after it
  // succeeds, below.
  if (statusChanged) {
    emitSSE({ type: "issue:updated", issueId: id, status: "IN_PROGRESS", userId: issue.reportedBy });
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? null,
      action: "ISSUE_STATUS_CHANGE",
      target: `issue:${id}`,
      details: {
        trigger: "grab",
        scope: issue.scope,
        before: { status: issue.status },
        after: { status: "IN_PROGRESS" },
      },
      ...auditContext(req, session),
    });
  }

  let resolvedTvdbId: number | null = issue.tvdbId;

  // Set by the arr helper just before POST /api/v3/release goes out: a failure
  // while it is still false (no config, the title lookup, the tvdb resolution)
  // sent nothing, so the handle goes back and a retry needs no new search.
  const progress: GrabProgress = { sent: false };
  try {
    if (issue.mediaType === "MOVIE") {
      await grabMovieRelease(issue.tmdbId, picked.guid, picked.indexerId, instance, progress);
    } else {
      if (!resolvedTvdbId) {
        resolvedTvdbId = await resolveTvdbIdFromTmdbId(issue.tmdbId, instance);
        if (!resolvedTvdbId) {
          releaseReleaseHandle(guid);
          return NextResponse.json({ error: t("apiUser.issues.tvdbUnresolved") }, { status: 422 });
        }
      }
      // Both SEASON and EPISODE issues pass their seasonNumber, so the grab
      // targets the right season. Only EPISODE issues pass an episodeNumber.
      await grabSeriesRelease(
        resolvedTvdbId,
        picked.guid,
        picked.indexerId,
        issue.scope === "EPISODE" || issue.scope === "SEASON" ? issue.seasonNumber : null,
        issue.scope === "EPISODE" ? issue.episodeNumber : null,
        instance,
        progress,
      );
    }
  } catch (err) {
    // Nothing sent yet (no config, the title lookup or the tvdb resolution
    // failed), or the arr definitely refused (a 4xx, or it doesn't have the
    // title): the release may be tried again. No answer, or a 408/5xx (a
    // timeout, a gateway that gave up mid-grab): it may well have taken it —
    // never send it twice.
    if (!progress.sent) releaseReleaseHandle(guid);
    else if (grabDefinitelyRefused(err)) releaseReleaseHandle(guid);
    else forgetReleaseHandle(guid);
    // The arr's own refusals say what to do: search again (its 30-minute
    // search cache no longer has the release) or why the indexer or client
    // refused it (masked).
    const refused = grabRefusalResponse(err, service === "radarr" ? "Radarr" : "Sonarr", t);
    if (refused) return refused;
    // Detail to the log, translated generic to the client (see the GET catch).
    console.error("[releases] Grab failed:", arrErrorMessage(err));
    return NextResponse.json({ error: t("apiUser.issues.arrFailed") }, { status: 502 });
  }

  forgetReleaseHandle(guid);

  // Recording the grab is kept OUTSIDE the try/catch above: Radarr/Sonarr has
  // already accepted the download, so a failure here must not answer 502 "grab
  // failed" (the admin would retry and download the same release twice). The
  // usual cause is the issue being deleted during the grab, which breaks the
  // IssueGrab -> Issue link (Prisma error P2003). The row supersedes the issue's
  // earlier pending grabs on this instance (one import, one announcement —
  // recordIssueGrab).
  let grabId: string | null = null;
  try {
    const grab = await recordIssueGrab({
      issueId: id,
      triggeredById: session.user.id,
      tmdbId: issue.tmdbId,
      tvdbId: resolvedTvdbId,
      mediaType: issue.mediaType,
      title: issue.title,
      scope: issue.scope,
      seasonNumber: issue.seasonNumber,
      episodeNumber: issue.episodeNumber,
      arrInstance: instance,
    });
    grabId = grab.id;
  } catch (err) {
    console.warn("[releases] Grab succeeded but recording it failed (issue deleted mid-grab?):", err);
  }

  // The grab itself. The status flip (if any) was audited right after its CAS
  // above, so this entry records only what happened here: which release went
  // to which instance. `grabId` is absent when the IssueGrab row could not be
  // written (see the catch above) — the download still happened. The release
  // NAME is recorded, never the guid (some indexers put the apikey in it).
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
