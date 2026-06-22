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
  arrErrorMessage,
} from "@/lib/arr";
import { logAudit, auditContext } from "@/lib/audit";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withIssueAdmin(async (_req, { params }: RouteContext, _session) => {
  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    let releases;
    if (issue.mediaType === "MOVIE") {
      releases = await getReleasesForMovie(issue.tmdbId);
    } else {
      let tvdbId = issue.tvdbId;
      if (!tvdbId) {
        tvdbId = await resolveTvdbIdFromTmdbId(issue.tmdbId);
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
      );
    }
    return NextResponse.json(releases);
  } catch (err) {
    console.error("[releases] Fetch failed:", err);
    return NextResponse.json({ error: arrErrorMessage(err) }, { status: 502 });
  }
});

export const POST = withIssueAdmin(async (req, { params }: RouteContext, session) => {
  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = await readJsonCapped<{ guid?: string; indexerId?: number }>(req, 65536);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

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

  let resolvedTvdbId: number | null = issue.tvdbId;

  try {
    if (issue.mediaType === "MOVIE") {
      await grabMovieRelease(issue.tmdbId, guid, indexerId as number);
    } else {
      if (!resolvedTvdbId) {
        resolvedTvdbId = await resolveTvdbIdFromTmdbId(issue.tmdbId);
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
      );
    }

    // CAS on issue status so we don't clobber a concurrent RESOLVED transition.
    // Always create the IssueGrab row (it's an audit of what was attempted).
    const result = await prisma.$transaction(async (tx) => {
      const claimed = await tx.issue.updateMany({
        where: { id, status: { not: "RESOLVED" } },
        data: { status: "IN_PROGRESS" },
      });
      const grab = await tx.issueGrab.create({
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
        },
      });
      return { statusChanged: claimed.count > 0, grabId: grab.id };
    });

    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? null,
      action: "ISSUE_STATUS_CHANGE",
      target: `issue:${id}`,
      details: {
        trigger: "grab",
        grabId: result.grabId,
        scope: issue.scope,
        ...(result.statusChanged ? { before: { status: issue.status }, after: { status: "IN_PROGRESS" } } : {}),
      },
      ...auditContext(req, session),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[releases] Grab failed:", err);
    return NextResponse.json({ error: arrErrorMessage(err) }, { status: 502 });
  }
});
