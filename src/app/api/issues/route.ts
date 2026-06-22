import { NextResponse, after } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { notifyAdminsNewIssue } from "@/lib/email";
import { notifyAdminsNewIssuePush } from "@/lib/push";
import { notifyAdminsNewIssueDiscord } from "@/lib/discord-notify";
import { emitSSE } from "@/lib/sse-emitter";
import { maintenanceGuard } from "@/lib/maintenance";
import { verifyTmdbMedia } from "@/lib/tmdb";
import { sanitizeOptional } from "@/lib/sanitize";
import { isFeatureEnabled } from "@/lib/features";

const VALID_ISSUE_TYPES = ["BAD_VIDEO", "WRONG_AUDIO", "MISSING_SUBTITLES", "WRONG_MATCH", "OTHER"] as const;
const VALID_SCOPES = ["FULL", "SEASON", "EPISODE"] as const;

export const GET = withAuth(async (req, _ctx, session) => {
  const where =
    (session.user.role === "ADMIN" || session.user.role === "ISSUE_ADMIN") ? {} : { reportedBy: session.user.id };

  const isAdmin = session.user.role === "ADMIN" || session.user.role === "ISSUE_ADMIN";

  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(100, Math.max(1, parseInt(limitParam ?? "50", 10) || 50));

  const issues = await (isAdmin
    ? prisma.issue.findMany({
        where,
        include: { user: { select: { name: true, email: true } } },
        orderBy: { createdAt: "desc" },
        take: limit,
      })
    : prisma.issue.findMany({
        where,
        include: { user: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: limit,
      }));

  return NextResponse.json(issues);
});

export const POST = withAuth(async (req, _ctx, session) => {
  if (!(await isFeatureEnabled("feature.page.issues"))) {
    return NextResponse.json({ error: "Issue reporting is disabled" }, { status: 403 });
  }

  const maint = await maintenanceGuard();
  if (maint) return maint;

  const rlRow = await prisma.setting.findUnique({ where: { key: "rateLimitIssues" } });
  const rlLimit = parseRateLimit(rlRow?.value, 10);
  if (!checkRateLimit(`issues:${session.user.id}`, rlLimit, 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  const parsed = await readJsonCapped<{
    mediaType?: string;
    tmdbId?: number;
    tvdbId?: number;
    issueType?: string;
    scope?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    note?: string;
  }>(req, 65536);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { mediaType, tmdbId, tvdbId, issueType, scope, seasonNumber, episodeNumber, note } = body;

  if (!mediaType || !tmdbId || !issueType) {
    return NextResponse.json({ error: "mediaType, tmdbId, and issueType are required" }, { status: 400 });
  }

  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType must be MOVIE or TV" }, { status: 400 });
  }

  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }

  if (!VALID_ISSUE_TYPES.includes(issueType as (typeof VALID_ISSUE_TYPES)[number])) {
    return NextResponse.json({ error: `issueType must be one of: ${VALID_ISSUE_TYPES.join(", ")}` }, { status: 400 });
  }

  const resolvedScope = (scope ?? "FULL") as (typeof VALID_SCOPES)[number];
  if (!VALID_SCOPES.includes(resolvedScope)) {
    return NextResponse.json({ error: `scope must be one of: ${VALID_SCOPES.join(", ")}` }, { status: 400 });
  }

  if (note !== undefined && (typeof note !== "string" || note.length > 1000)) {
    return NextResponse.json({ error: "note must be a string under 1000 characters" }, { status: 400 });
  }
  const sanitizedNote = sanitizeOptional(note);

  if (tvdbId !== undefined && tvdbId !== null) {
    if (!Number.isInteger(tvdbId) || tvdbId <= 0) {
      return NextResponse.json({ error: "tvdbId must be a positive integer" }, { status: 400 });
    }
  }

  if (resolvedScope === "SEASON" || resolvedScope === "EPISODE") {
    if (!Number.isInteger(seasonNumber) || (seasonNumber as number) < 1) {
      return NextResponse.json({ error: "seasonNumber is required for SEASON or EPISODE scope" }, { status: 400 });
    }
  }

  if (resolvedScope === "EPISODE") {
    if (!Number.isInteger(episodeNumber) || (episodeNumber as number) < 1) {
      return NextResponse.json({ error: "episodeNumber is required for EPISODE scope" }, { status: 400 });
    }
  }

  const tmdbType = mediaType === "MOVIE" ? "movie" as const : "tv" as const;
  const verified = await verifyTmdbMedia(tmdbId, tmdbType);
  if (!verified) {
    return NextResponse.json({ error: "Could not verify media with TMDB" }, { status: 422 });
  }

  // Issues presuppose the title is in the library — every type (bad video, wrong
  // audio, missing subs, wrong match) is about media you HAVE. Gate on a Plex or
  // Jellyfin library hit so the API can't be scripted into issue records for titles
  // that aren't available (the UI only surfaces "report issue" on available media).
  const mt = mediaType as "MOVIE" | "TV";
  const [plexHit, jellyfinHit] = await Promise.all([
    prisma.plexLibraryItem.findUnique({ where: { tmdbId_mediaType: { tmdbId, mediaType: mt } }, select: { tmdbId: true } }),
    prisma.jellyfinLibraryItem.findUnique({ where: { tmdbId_mediaType: { tmdbId, mediaType: mt } }, select: { tmdbId: true } }),
  ]);
  if (!plexHit && !jellyfinHit) {
    return NextResponse.json({ error: "This title isn't in the library — issues can only be filed for available media." }, { status: 422 });
  }

  const issue = await prisma.issue.create({
    data: {
      reportedBy: session.user.id,
      mediaType: mediaType as "MOVIE" | "TV",
      tmdbId,
      tvdbId: tvdbId ?? null,
      title: verified.title,
      posterPath: verified.posterPath,
      issueType: issueType as (typeof VALID_ISSUE_TYPES)[number],
      scope: resolvedScope,
      seasonNumber: resolvedScope !== "FULL" ? (seasonNumber ?? null) : null,
      episodeNumber: resolvedScope === "EPISODE" ? (episodeNumber ?? null) : null,
      note: sanitizedNote ?? null,
    },
  });

  emitSSE({ type: "issue:new", issueId: issue.id, userId: session.user.id });
  const reportedBy = session.user.name ?? session.user.email ?? session.user.id;
  after(async () => {
    await Promise.allSettled([
      notifyAdminsNewIssue({ title: verified.title, mediaType, issueType, reportedBy, note: sanitizedNote ?? null, posterPath: verified.posterPath, issueId: issue.id, excludeUserId: session.user.id }),
      notifyAdminsNewIssuePush({ title: verified.title, issueType, reportedBy, issueId: issue.id, excludeUserId: session.user.id }),
      notifyAdminsNewIssueDiscord({ issueId: issue.id, title: verified.title, mediaType, issueType, reportedBy, note: sanitizedNote ?? null, posterPath: verified.posterPath }),
    ]);
  });
  return NextResponse.json(issue, { status: 201 });
});
