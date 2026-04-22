import { NextRequest, NextResponse, after } from "next/server";
import { requireAuth } from "@/lib/api-auth";
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

export async function GET(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

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
}

export async function POST(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  if (!(await isFeatureEnabled("feature.page.votes"))) {
    return NextResponse.json({ error: "Deletion voting is disabled" }, { status: 403 });
  }

  const maint = await maintenanceGuard(session.user.role);
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

  const ownRequest = await prisma.mediaRequest.findFirst({
    where: { tmdbId, mediaType },
    select: { requestedBy: true },
    orderBy: { createdAt: "asc" },
  });
  if (ownRequest?.requestedBy === session.user.id) {
    return NextResponse.json({ error: "Cannot vote to delete your own request" }, { status: 403 });
  }

  let thresholdNotifyData: { title: string; mediaType: string; voteCount: number; posterPath: string | null; tmdbId: number } | null = null;

  let vote: Awaited<ReturnType<typeof prisma.deletionVote.create>>;
  try {
    vote = await prisma.$transaction(async (tx) => {
      const created = await tx.deletionVote.create({
        data: {
          tmdbId,
          mediaType,
          title: verified.title,
          posterPath: verified.posterPath,
          userId: session.user.id,
          reason: sanitizedReason ?? null,
        },
      });

      const thresholdRow = await tx.setting.findUnique({ where: { key: "deletionVoteThreshold" } });
      const threshold = parseInt(thresholdRow?.value ?? "0", 10);
      if (threshold > 0) {
        const voteCount = await tx.deletionVote.count({ where: { tmdbId, mediaType } });
        if (voteCount >= threshold) {
          // Unique constraint on claimKey acts as a one-shot gate: create fails on a second insertion
          const claimKey = `deletionVoteNotified:${tmdbId}:${mediaType}`;
          try {
            await tx.setting.create({ data: { key: claimKey, value: "1" } });
            thresholdNotifyData = { title: verified.title, mediaType, voteCount, posterPath: verified.posterPath ?? null, tmdbId };
          } catch { }
        }
      }

      return created;
    }, { isolationLevel: "Serializable", timeout: 15_000 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "Already voted" }, { status: 409 });
    }
    throw err;
  }

  if (thresholdNotifyData) {
    const data = thresholdNotifyData;
    after(async () => {
      await Promise.allSettled([
        notifyAdminsDeletionVoteThreshold(data),
        notifyAdminsDeletionVoteThresholdPush(data),
      ]);
    });
  }

  return NextResponse.json(vote, { status: 201 });
}
