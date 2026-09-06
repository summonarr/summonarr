import { NextResponse, after } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { parsePageParam } from "@/lib/pagination";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { maintenanceGuard } from "@/lib/maintenance";
import { resolveMediaMeta } from "@/lib/request-meta";
import { sanitizeOptional, sanitizeContainsSearch } from "@/lib/sanitize";
import { verifyRequestToken } from "@/lib/request-token";
import { notifyAdminsDeletionVoteThreshold } from "@/lib/email";
import { notifyAdminsDeletionVoteThresholdPush } from "@/lib/push";
import { isFeatureEnabled } from "@/lib/features";
import { getVisibleServerInstances } from "@/lib/media-visibility";

const PAGE_SIZE = 40;
const VALID_VOTE_SORTS = ["votes", "recent"] as const;

export const GET = withAuth(async (req, _ctx, session) => {
  // Same gate as POST below and /api/votes/[tmdbId]: disabling the feature
  // must switch off the whole surface — this listing carries other users'
  // free-text vote reasons, not just the caller's own state.
  if (!(await isFeatureEnabled("feature.page.votes"))) {
    return NextResponse.json({ error: "Deletion voting is disabled" }, { status: 403 });
  }
  if (!checkRateLimit(`votes-list:${session.user.id}`, 30, 60_000)) {
    return tooManyRequests(60);
  }

  const sp = req.nextUrl.searchParams;
  const page = parsePageParam(sp);
  const mine = sp.get("mine") === "1";
  const sortParam = sp.get("sort");
  const sort =
    sortParam && (VALID_VOTE_SORTS as readonly string[]).includes(sortParam)
      ? (sortParam as (typeof VALID_VOTE_SORTS)[number])
      : "votes";
  const q = sanitizeContainsSearch((sp.get("q") ?? "").trim());

  // Mirrors the web /votes page: `mine` scopes to the caller's votes, `q` matches
  // the title, `recent` orders groups by their most-recent vote.
  const where: Prisma.DeletionVoteWhereInput = {
    ...(mine ? { userId: session.user.id } : {}),
    ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
  };

  // The WHOLE group key — `tmdbId` AND `mediaType` — is the tiebreaker on both
  // sorts: without it, groups tied on _count (very common — most titles sit at
  // 1-2 votes) have no total order, so Postgres may return them in a different
  // sequence for the page=1 and page=2 queries and a row gets duplicated onto
  // one page while another is skipped. `tmdbId` alone is not enough: a MOVIE and
  // a TV group can share one TMDB id, and those two rows would still be
  // unordered relative to each other.
  const orderBy: Prisma.DeletionVoteOrderByWithAggregationInput[] =
    sort === "recent"
      ? [{ _max: { createdAt: "desc" } }, { tmdbId: "asc" }, { mediaType: "asc" }]
      : [{ _count: { id: "desc" } }, { tmdbId: "asc" }, { mediaType: "asc" }];

  const [grouped, totalItems] = await Promise.all([
    prisma.deletionVote.groupBy({
      by: ["tmdbId", "mediaType"],
      where,
      _count: { id: true },
      _max: { createdAt: true },
      orderBy,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    // NOTE: this second groupBy transports one row per voted title just to read
    // `.length`. A `SELECT COUNT(*) FROM (… GROUP BY …)` would be cheaper, but it
    // has to be raw SQL, and every route test stubs the prisma MODEL methods
    // in-memory — a `$queryRaw` escapes the stub and tries to open a real
    // connection, failing the suite. Keep the groupBy unless the tests grow a
    // raw-SQL stub; the row count is bounded by the number of voted titles.
    prisma.deletionVote.groupBy({
      by: ["tmdbId", "mediaType"],
      where,
      _count: { id: true },
    }),
  ]);
  const total = totalItems.length;

  if (grouped.length === 0) {
    return NextResponse.json({ items: [], total, page, pageSize: PAGE_SIZE });
  }

  const pairsFilter = grouped.map((g) => ({ tmdbId: g.tmdbId, mediaType: g.mediaType }));

  const [reps, userVotes, otherReasons, mineCounts] = await Promise.all([
    prisma.deletionVote.findMany({
      where: { OR: pairsFilter },
      select: { tmdbId: true, mediaType: true, title: true, posterPath: true },
      distinct: ["tmdbId", "mediaType"],
    }),
    prisma.deletionVote.findMany({
      where: { userId: session.user.id, OR: pairsFilter },
      select: { tmdbId: true, mediaType: true, id: true, reason: true },
    }),
    // A few recent non-empty reasons from OTHER users per title, surfaced as
    // `reasons` on each item (the caller's own reason stays in `userReason`).
    // Not distinct/grouped in SQL — we cap to 3 per group in JS below. The
    // `take` bounds an otherwise unbounded fetch (every reasoned vote across the
    // page's titles): newest-first, 6 rows of headroom per group covers the JS
    // dedupe/3-cap for realistic data; a title buried past the bound merely
    // shows fewer "other reasons" (cosmetic).
    prisma.deletionVote.findMany({
      where: {
        OR: pairsFilter,
        userId: { not: session.user.id },
        reason: { not: null },
      },
      select: { tmdbId: true, mediaType: true, reason: true },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE * 6,
    }),
    // Under `mine`, the paging `where` also scopes the aggregate — and
    // @@unique([tmdbId, mediaType, userId]) means the caller owns exactly one row
    // per group, so `g._count.id` would always be 1. That shipped a "1 vote"
    // badge next to three reasons written by three other users, hiding titles
    // already past the deletion threshold. Recount the page's pairs unscoped.
    mine
      ? prisma.deletionVote.groupBy({ by: ["tmdbId", "mediaType"], where: { OR: pairsFilter }, _count: { id: true } })
      : Promise.resolve(null),
  ]);
  const mineCountMap = new Map<string, number>(
    mineCounts?.map((g) => [`${g.tmdbId}:${g.mediaType}`, g._count.id]) ?? [],
  );

  const repMap = new Map(reps.map((r) => [`${r.tmdbId}:${r.mediaType}`, r]));
  const userVoteMap = new Map(userVotes.map((v) => [`${v.tmdbId}:${v.mediaType}`, v]));

  // Build up to 3 deduped, non-empty reasons per title from other users'.
  const reasonsMap = new Map<string, string[]>();
  for (const r of otherReasons) {
    const reason = r.reason?.trim();
    if (!reason) continue;
    const key = `${r.tmdbId}:${r.mediaType}`;
    const list = reasonsMap.get(key) ?? [];
    if (list.length >= 3 || list.includes(reason)) continue;
    list.push(reason);
    reasonsMap.set(key, list);
  }

  const items = grouped.map((g) => {
    const key = `${g.tmdbId}:${g.mediaType}`;
    const rep = repMap.get(key);
    const userVote = userVoteMap.get(key);
    return {
      tmdbId: g.tmdbId,
      mediaType: g.mediaType,
      title: rep?.title ?? "",
      posterPath: rep?.posterPath ?? null,
      voteCount: mineCountMap.get(key) ?? g._count.id,
      userVoted: !!userVote,
      userReason: userVote?.reason ?? null,
      reasons: reasonsMap.get(key) ?? [],
    };
  });

  return NextResponse.json({ items, total, page, pageSize: PAGE_SIZE });
});

export const POST = withAuth(async (req, _ctx, session) => {
  if (!(await isFeatureEnabled("feature.page.votes"))) {
    return NextResponse.json({ error: "Deletion voting is disabled" }, { status: 403 });
  }

  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  const rlRow = await prisma.setting.findUnique({ where: { key: "rateLimitRequests" } });
  const limit = parseRateLimit(rlRow?.value, 20);
  if (!checkRateLimit(`votes:${session.user.id}`, limit, 60 * 1000)) {
    return tooManyRequests(60, "Too many requests — try again later");
  }

  const parsed = await readJsonCapped<{ tmdbId?: number; mediaType?: string; reason?: string; _token?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

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

  // typeof-guard BEFORE verifyRequestToken: readJsonCapped<T>'s generic is a
  // compile-time cast only, so a truthy non-string (`123`, `{}`) slipped past the
  // old `!_token` check and threw ERR_INVALID_ARG_TYPE out of Buffer.from(a, "hex")
  // as a 500 instead of this 403. Empty string is non-verifying and still 403s.
  if (typeof _token !== "string" || !verifyRequestToken(_token, tmdbId, mediaType, session.user.id)) {
    return NextResponse.json({ error: "Invalid or expired request token" }, { status: 403 });
  }

  // Three-tier cached resolver (TmdbMediaCore -> details cache -> live TMDB),
  // the same one POST /api/requests uses — a vote almost always targets a title
  // the voter just viewed, so a live TMDB call per mutation was pure waste and
  // made a cold-cache TMDB outage 422 votes for titles the app already knows.
  const verified = await resolveMediaMeta(tmdbId, mediaType);
  if (!verified) {
    return NextResponse.json({ error: "Could not verify media with TMDB" }, { status: 422 });
  }

  // Scoped to the servers THIS voter can see. A deletion vote is a claim about media the
  // voter has access to; a copy on a restricted server they hold no grant for is not in
  // "any library" as far as they are concerned, and the vote button on the detail page is
  // gated on the same per-user availability.
  const visible = await getVisibleServerInstances(session);
  const [inPlex, inJellyfin] = await Promise.all([
    prisma.plexLibraryItem.findFirst({ where: { tmdbId, mediaType, serverInstance: { in: visible.plex } } }),
    prisma.jellyfinLibraryItem.findFirst({ where: { tmdbId, mediaType, serverInstance: { in: visible.jellyfin } } }),
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
        // Re-count after winning the claim: an admin "dismiss" deletes all votes AND
        // this claim key in one tx, so a dismiss racing between the count above and the
        // claim insert would re-create the key and fire a false threshold alert for a
        // title whose votes were just wiped. Only notify if still over.
        const recount = await prisma.deletionVote.count({ where: { tmdbId, mediaType } });
        if (recount >= threshold) {
          const data = { title: verified.title, mediaType, voteCount: recount, posterPath: verified.posterPath ?? null, tmdbId };
          after(async () => {
            await Promise.allSettled([
              notifyAdminsDeletionVoteThreshold(data),
              notifyAdminsDeletionVoteThresholdPush(data),
            ]);
          });
        }
      }
    }
  }

  return NextResponse.json(vote, { status: 201 });
});
