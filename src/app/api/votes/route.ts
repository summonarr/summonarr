import { NextResponse, after } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { maintenanceGuard } from "@/lib/maintenance";
import { verifyTmdbMedia } from "@/lib/tmdb";
import { sanitizeOptional } from "@/lib/sanitize";
import { verifyRequestToken } from "@/lib/request-token";
import { notifyAdminsDeletionVoteThreshold } from "@/lib/email";
import { notifyAdminsDeletionVoteThresholdPush } from "@/lib/push";
import { isFeatureEnabled } from "@/lib/features";

const PAGE_SIZE = 40;

export const GET = withAuth(async (req, _ctx, session) => {
  const page = Math.min(Math.max(1, parseInt(req.nextUrl.searchParams.get("page") ?? "1", 10) || 1), 10_000);

  const [grouped, totalItems] = await Promise.all([
    prisma.deletionVote.groupBy({
      by: ["tmdbId", "mediaType"],
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.deletionVote.groupBy({
      by: ["tmdbId", "mediaType"],
      _count: { id: true },
    }),
  ]);

  if (grouped.length === 0) {
    return NextResponse.json({ items: [], total: totalItems.length, page, pageSize: PAGE_SIZE });
  }

  const pairsFilter = grouped.map((g) => ({ tmdbId: g.tmdbId, mediaType: g.mediaType }));

  const [reps, userVotes] = await Promise.all([
    prisma.deletionVote.findMany({
      where: { OR: pairsFilter },
      select: { tmdbId: true, mediaType: true, title: true, posterPath: true },
      distinct: ["tmdbId", "mediaType"],
    }),
    prisma.deletionVote.findMany({
      where: { userId: session.user.id, OR: pairsFilter },
      select: { tmdbId: true, mediaType: true, id: true, reason: true },
    }),
  ]);

  const repMap = new Map(reps.map((r) => [`${r.tmdbId}:${r.mediaType}`, r]));
  const userVoteMap = new Map(userVotes.map((v) => [`${v.tmdbId}:${v.mediaType}`, v]));

  const items = grouped.map((g) => {
    const key = `${g.tmdbId}:${g.mediaType}`;
    const rep = repMap.get(key);
    const userVote = userVoteMap.get(key);
    return {
      tmdbId: g.tmdbId,
      mediaType: g.mediaType,
      title: rep?.title ?? "",
      posterPath: rep?.posterPath ?? null,
      voteCount: g._count.id,
      userVoted: !!userVote,
      userReason: userVote?.reason ?? null,
    };
  });

  return NextResponse.json({ items, total: totalItems.length, page, pageSize: PAGE_SIZE });
});

export const POST = withAuth(async (req, _ctx, session) => {
  if (!(await isFeatureEnabled("feature.page.votes"))) {
    return NextResponse.json({ error: "Deletion voting is disabled" }, { status: 403 });
  }

  const maint = await maintenanceGuard();
  if (maint) return maint;

  const rlRow = await prisma.setting.findUnique({ where: { key: "rateLimitRequests" } });
  const limit = parseRateLimit(rlRow?.value, 20);
  if (!checkRateLimit(`votes:${session.user.id}`, limit, 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  let body: { tmdbId?: number; mediaType?: string; reason?: string; _token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { tmdbId, mediaType, reason, _token } = body;

  if (!tmdbId || !mediaType) {
    return NextResponse.json({ error: "tmdbId and mediaType are required" }, { status: 400 });
  }
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType must be MOVIE or TV" }, { status: 400 });
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 200)) {
    return NextResponse.json({ error: "reason must be a string under 200 characters" }, { status: 400 });
  }

  if (!_token || !verifyRequestToken(_token, tmdbId, mediaType, session.user.id)) {
    return NextResponse.json({ error: "Invalid or expired request token" }, { status: 403 });
  }

  const tmdbType = mediaType === "MOVIE" ? "movie" as const : "tv" as const;
  const verified = await verifyTmdbMedia(tmdbId, tmdbType);
  if (!verified) {
    return NextResponse.json({ error: "Could not verify media with TMDB" }, { status: 422 });
  }

  const [inPlex, inJellyfin] = await Promise.all([
    prisma.plexLibraryItem.findUnique({ where: { tmdbId_mediaType: { tmdbId, mediaType } } }),
    prisma.jellyfinLibraryItem.findUnique({ where: { tmdbId_mediaType: { tmdbId, mediaType } } }),
  ]);
  if (!inPlex && !inJellyfin) {
    return NextResponse.json({ error: "Media is not in any library" }, { status: 422 });
  }

  const sanitizedReason = sanitizeOptional(reason);

  // Bar any user who has ever requested this media (regardless of order). Earlier
  // versions only checked the oldest requester via orderBy; a co-requester could
  // then vote against a title they themselves had requested.
  const ownRequest = await prisma.mediaRequest.findFirst({
    where: { tmdbId, mediaType, requestedBy: session.user.id },
    select: { id: true },
  });
  if (ownRequest) {
    return NextResponse.json({ error: "Cannot vote to delete your own request" }, { status: 403 });
  }

  let vote: Awaited<ReturnType<typeof prisma.deletionVote.create>>;
  try {
    vote = await prisma.deletionVote.create({
      data: {
        tmdbId,
        mediaType,
        title: verified.title,
        posterPath: verified.posterPath,
        userId: session.user.id,
        reason: sanitizedReason ?? null,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "Already voted" }, { status: 409 });
    }
    throw err;
  }

  // Fire the "deletion threshold reached" admin alert exactly once per item. The
  // claimKey row is an idempotent one-shot gate: createMany(skipDuplicates) reports
  // count === 1 for the single caller that wins the insert and 0 for everyone after.
  // This MUST stay out of the vote-insert transaction — a bare create() whose
  // duplicate-key error is caught-and-ignored inside a single-level interactive tx
  // leaves Postgres in the aborted state (there is no per-statement SAVEPOINT at
  // depth 1), so the trailing COMMIT becomes a ROLLBACK and silently discards the
  // vote too. Running it afterwards is also self-healing: if the process dies before
  // the claim, the next vote re-evaluates the threshold and fires the alert.
  const thresholdRow = await prisma.setting.findUnique({ where: { key: "deletionVoteThreshold" } });
  const threshold = parseInt(thresholdRow?.value ?? "0", 10);
  if (threshold > 0) {
    const voteCount = await prisma.deletionVote.count({ where: { tmdbId, mediaType } });
    if (voteCount >= threshold) {
      const claimKey = `deletionVoteNotified:${tmdbId}:${mediaType}`;
      const claim = await prisma.setting.createMany({
        data: [{ key: claimKey, value: "1" }],
        skipDuplicates: true,
      });
      if (claim.count === 1) {
        const data = { title: verified.title, mediaType, voteCount, posterPath: verified.posterPath ?? null, tmdbId };
        after(async () => {
          await Promise.allSettled([
            notifyAdminsDeletionVoteThreshold(data),
            notifyAdminsDeletionVoteThresholdPush(data),
          ]);
        });
      }
    }
  }

  return NextResponse.json(vote, { status: 201 });
});
