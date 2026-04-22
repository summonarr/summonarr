import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import {
  getReleasesForMovie,
  getReleasesForSeries,
  grabMovieRelease,
  grabSeriesRelease,
  resolveTvdbIdFromTmdbId,
  arrErrorMessage,
} from "@/lib/arr";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  const session = await requireAuth({ role: "ISSUE_ADMIN", split: true });
  if (session instanceof NextResponse) return session;

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
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const issueRecord = await prisma.issue.findUnique({ where: { id }, select: { reportedBy: true } });
  if (!issueRecord) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const canGrab =
    session.user.role === "ADMIN" ||
    session.user.role === "ISSUE_ADMIN" ||
    issueRecord.reportedBy === session.user.id;
  if (!canGrab) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { guid?: string; indexerId?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { guid, indexerId } = body;
  if (!guid || typeof guid !== "string") {
    return NextResponse.json({ error: "guid is required" }, { status: 400 });
  }

  if (guid.length > 500 || /[<>"';&|]/.test(guid)) {
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
      await grabSeriesRelease(
        resolvedTvdbId,
        guid,
        indexerId as number,
        issue.scope === "EPISODE" ? issue.seasonNumber : null,
        issue.scope === "EPISODE" ? issue.episodeNumber : null,
      );
    }

    await prisma.$transaction([
      prisma.issue.update({ where: { id }, data: { status: "IN_PROGRESS" } }),
      prisma.issueGrab.create({
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
      }),
    ]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[releases] Grab failed:", err);
    return NextResponse.json({ error: arrErrorMessage(err) }, { status: 502 });
  }
}
