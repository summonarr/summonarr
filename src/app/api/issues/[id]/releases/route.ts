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
  const maint = await maintenanceGuard();
  if (maint) return maint;

  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // A RESOLVED issue is closed — don't fire an *arr grab (and the IssueGrab row)
  // for it. The CAS below only prevents reopening; the upstream grab would still run.
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

  // Allowlist GUID characters explicitly. Sonarr/Radarr release guids are opaque tokens from
  // their indexers — typically URL-safe / base64-shaped — and never legitimately contain control
  // chars, quotes, brackets, backticks, null bytes, or whitespace. An allowlist is safer than the
  // previous denylist, which only blocked 7 characters and let backslashes, CRLF, and unicode
  // bidi controls through.
  if (guid.length === 0 || guid.length > 500 || !/^[A-Za-z0-9._:/+\-=?&%#@~,!*$]+$/.test(guid)) {
    return NextResponse.json({ error: "Invalid guid format" }, { status: 400 });
  }
  if (!Number.isInteger(indexerId) || (indexerId as number) <= 0) {
    return NextResponse.json({ error: "indexerId must be a positive integer" }, { status: 400 });
  }

  // Claim the issue (CAS → IN_PROGRESS) BEFORE the grab: the findUnique above is
  // stale, and a concurrent resolve would otherwise still fire an unwanted *arr
  // download. count 0 ⇒ already resolved → abort. (The grab is an HTTP call, so it
  // can't go inside a tx; a pre-grab CAS is what prevents it. A failed grab leaving
  // IN_PROGRESS is fine — an admin attempted it.)
  const claim = await prisma.issue.updateMany({
    where: { id, status: { not: "RESOLVED" } },
    data: { status: "IN_PROGRESS" },
  });
  if (claim.count === 0) {
    return NextResponse.json({ error: "Issue is resolved — reopen it before grabbing a release" }, { status: 409 });
  }
  const statusChanged = issue.status !== "IN_PROGRESS";

  let resolvedTvdbId: number | null = issue.tvdbId;

  try {
    if (issue.mediaType === "MOVIE") {
      await grabMovieRelease(issue.tmdbId, guid, indexerId as number, instance);
    } else {
      if (!resolvedTvdbId) {
        resolvedTvdbId = await resolveTvdbIdFromTmdbId(issue.tmdbId, instance);
        if (!resolvedTvdbId) return NextResponse.json({ error: "Could not resolve TVDB ID for this series — check Sonarr" }, { status: 422 });
      }
      // SEASON scope also carries seasonNumber — passing null for SEASON releases
      // sent the grab to the series default and lost the user-picked season.
      // Only episodeNumber is EPISODE-scope-only.
      await grabSeriesRelease(
        resolvedTvdbId,
        guid,
        indexerId as number,
        issue.scope === "EPISODE" || issue.scope === "SEASON" ? issue.seasonNumber : null,
        issue.scope === "EPISODE" ? issue.episodeNumber : null,
        instance,
      );
    }

    // Issue already claimed IN_PROGRESS above; record the grab attempt for audit.
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

    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? null,
      action: "ISSUE_STATUS_CHANGE",
      target: `issue:${id}`,
      details: {
        trigger: "grab",
        grabId: grab.id,
        scope: issue.scope,
        ...(statusChanged ? { before: { status: issue.status }, after: { status: "IN_PROGRESS" } } : {}),
      },
      ...auditContext(req, session),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[releases] Grab failed:", err);
    return NextResponse.json({ error: arrErrorMessage(err) }, { status: 502 });
  }
});
