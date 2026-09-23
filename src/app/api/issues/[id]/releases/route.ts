import { NextResponse } from "next/server";
import { withIssueAdmin } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import {
  getReleasesForMovie,
  getReleasesForSeries,
  grabMovieRelease,
  grabSeriesRelease,
  resolveTvdbIdFromTmdbId,
  isArrConfigured,
  arrErrorMessage,
} from "@/lib/arr";
import { isValidInstanceSlug } from "@/lib/arr-instances";
import { logAudit, auditContext } from "@/lib/audit";
import { maintenanceGuard } from "@/lib/maintenance";
import { emitSSE } from "@/lib/sse-emitter";

type RouteContext = { params: Promise<{ id: string }> };

// Resolves + validates the target instance slug for a release browse/grab.
// "" (default) is always allowed; a non-default slug must be a valid slug with
// a configured connection. Returns a NextResponse on rejection.
async function resolveInstanceOr(
  raw: string | null | undefined,
  service: "radarr" | "sonarr",
): Promise<string | NextResponse> {
  const instance = typeof raw === "string" ? raw.trim() : "";
  if (!isValidInstanceSlug(instance)) {
    return NextResponse.json({ error: "Invalid instance" }, { status: 400 });
  }
  if (instance !== "" && !(await isArrConfigured(service, instance))) {
    return NextResponse.json({ error: `${service} (${instance}) is not configured` }, { status: 422 });
  }
  return instance;
}

export const GET = withIssueAdmin(async (req, { params }: RouteContext, _session) => {
  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const service = issue.mediaType === "MOVIE" ? ("radarr" as const) : ("sonarr" as const);
  const instanceOr = await resolveInstanceOr(req.nextUrl.searchParams.get("instance"), service);
  if (instanceOr instanceof NextResponse) return instanceOr;
  const instance = instanceOr;

  try {
    let releases;
    if (issue.mediaType === "MOVIE") {
      releases = await getReleasesForMovie(issue.tmdbId, instance);
    } else {
      let tvdbId = issue.tvdbId;
      if (!tvdbId) {
        tvdbId = await resolveTvdbIdFromTmdbId(issue.tmdbId, instance);
        if (!tvdbId) {
          return NextResponse.json({ error: "Could not resolve TVDB ID for this series — check Sonarr" }, { status: 422 });
        }
      }
      const VALID_SCOPES = ["FULL", "SEASON", "EPISODE"] as const;
      type IssueScope = typeof VALID_SCOPES[number];
      if (!(VALID_SCOPES as readonly string[]).includes(issue.scope)) {
        return NextResponse.json({ error: "Invalid issue scope" }, { status: 422 });
      }
      releases = await getReleasesForSeries(
        tvdbId,
        issue.scope as IssueScope,
        issue.seasonNumber,
        issue.episodeNumber,
        instance,
      );
    }
    return NextResponse.json(releases);
  } catch (err) {
    console.error("[releases] Fetch failed:", err);
    return NextResponse.json({ error: arrErrorMessage(err) }, { status: 502 });
  }
});

export const POST = withIssueAdmin(async (req, { params }: RouteContext, session) => {
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // A RESOLVED issue is closed, so don't start a download for it. (The status
  // update further down re-checks this in case the issue is resolved meanwhile.)
  if (issue.status === "RESOLVED") {
    return NextResponse.json({ error: "Issue is resolved — reopen it before grabbing a release" }, { status: 409 });
  }

  const parsed = await readJsonCapped<{ guid?: string; indexerId?: number; instance?: string }>(req, 65536);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const service = issue.mediaType === "MOVIE" ? ("radarr" as const) : ("sonarr" as const);
  const instanceOr = await resolveInstanceOr(body.instance, service);
  if (instanceOr instanceof NextResponse) return instanceOr;
  const instance = instanceOr;

  const { guid, indexerId } = body;
  if (!guid || typeof guid !== "string") {
    return NextResponse.json({ error: "guid is required" }, { status: 400 });
  }

  // Only allow characters a real release guid uses. Radarr/Sonarr guids are
  // URL-like tokens from the indexers and never contain whitespace, quotes,
  // brackets, backslashes or control characters. Listing what IS allowed is
  // safer than listing what is not, because nothing unexpected slips through.
  if (guid.length === 0 || guid.length > 500 || !/^[A-Za-z0-9._:/+\-=?&%#@~,!*$]+$/.test(guid)) {
    return NextResponse.json({ error: "Invalid guid format" }, { status: 400 });
  }
  if (!Number.isInteger(indexerId) || (indexerId as number) <= 0) {
    return NextResponse.json({ error: "indexerId must be a positive integer" }, { status: 400 });
  }

  // Move the issue to IN_PROGRESS BEFORE the grab, with a compare-and-swap
  // ("only if it is still not RESOLVED"). The row we read above may be out of
  // date, and someone may have resolved the issue since; count 0 means they did,
  // so we stop. The grab is an HTTP call and can't run inside a DB transaction,
  // so this check up front is what prevents an unwanted download. If the grab
  // then fails, leaving IN_PROGRESS is fine: an admin did try.
  const claim = await prisma.issue.updateMany({
    where: { id, status: { not: "RESOLVED" } },
    data: { status: "IN_PROGRESS" },
  });
  if (claim.count === 0) {
    return NextResponse.json({ error: "Issue is resolved — reopen it before grabbing a release" }, { status: 409 });
  }
  const statusChanged = issue.status !== "IN_PROGRESS";
  // Announce the status change now: the row already says IN_PROGRESS, and the
  // 422/502 returns below leave it that way, so other admins' lists and the
  // reporter's page need to hear about it here. Only broadcast a real change.
  if (statusChanged) {
    emitSSE({ type: "issue:updated", issueId: id, status: "IN_PROGRESS", userId: issue.reportedBy });
  }

  let resolvedTvdbId: number | null = issue.tvdbId;

  try {
    if (issue.mediaType === "MOVIE") {
      await grabMovieRelease(issue.tmdbId, guid, indexerId as number, instance);
    } else {
      if (!resolvedTvdbId) {
        resolvedTvdbId = await resolveTvdbIdFromTmdbId(issue.tmdbId, instance);
        if (!resolvedTvdbId) return NextResponse.json({ error: "Could not resolve TVDB ID for this series — check Sonarr" }, { status: 422 });
      }
      // Both SEASON and EPISODE issues pass their seasonNumber, so the grab
      // targets the right season. Only EPISODE issues pass an episodeNumber.
      await grabSeriesRelease(
        resolvedTvdbId,
        guid,
        indexerId as number,
        issue.scope === "EPISODE" || issue.scope === "SEASON" ? issue.seasonNumber : null,
        issue.scope === "EPISODE" ? issue.episodeNumber : null,
        instance,
      );
    }
  } catch (err) {
    console.error("[releases] Grab failed:", err);
    return NextResponse.json({ error: arrErrorMessage(err) }, { status: 502 });
  }

  // Recording the grab is kept OUTSIDE the try/catch above: Radarr/Sonarr has
  // already accepted the download, so a failure here must not answer 502 "grab
  // failed" (the admin would retry and download the same release twice). The
  // usual cause is the issue being deleted during the grab, which breaks the
  // IssueGrab -> Issue link (Prisma error P2003).
  let grabId: string | null = null;
  try {
    const grab = await prisma.issueGrab.create({
      data: {
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
      },
    });
    grabId = grab.id;
  } catch (err) {
    console.warn("[releases] Grab succeeded but recording it failed (issue deleted mid-grab?):", err);
  }

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ISSUE_STATUS_CHANGE",
    target: `issue:${id}`,
    details: {
      trigger: "grab",
      ...(grabId ? { grabId } : {}),
      scope: issue.scope,
      ...(statusChanged ? { before: { status: issue.status }, after: { status: "IN_PROGRESS" } } : {}),
    },
    ...auditContext(req, session),
  });

  return NextResponse.json({ ok: true });
});
