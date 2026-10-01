import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { parsePageParam } from "@/lib/pagination";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { resolveMediaMeta } from "@/lib/request-meta";
import { sanitizeContainsSearch } from "@/lib/sanitize";
import { maybeAutoRequestWatchlistAdd } from "@/lib/auto-request";

const PAGE_SIZE = 60;
const SELECT = { tmdbId: true, mediaType: true, title: true, posterPath: true, createdAt: true } as const;

// GET — the caller's own watchlist (newest first), optionally filtered by type/query.
export const GET = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`watchlist-list:${session.user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const sp = req.nextUrl.searchParams;
  const page = parsePageParam(sp);
  const typeParam = sp.get("type");
  const mediaType = typeParam === "MOVIE" || typeParam === "TV" ? typeParam : undefined;
  const q = sanitizeContainsSearch((sp.get("q") ?? "").trim());

  const where: Prisma.WatchlistItemWhereInput = {
    userId: session.user.id,
    ...(mediaType ? { mediaType } : {}),
    ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.watchlistItem.findMany({
      where,
      select: SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.watchlistItem.count({ where }),
  ]);

  return NextResponse.json({ items, total, page, pageSize: PAGE_SIZE });
});

// POST — add { tmdbId, mediaType } to the caller's watchlist. No library/permission
// gate: the watchlist is a personal save-for-later list, deliberately usable for
// unavailable titles. TMDB verification supplies the denormalized title/poster.
//
// Watchlist auto-request (src/lib/auto-request.ts): for a caller holding an
// AUTO_REQUEST* bit while feature.behavior.watchlistAutoRequest is on, the add
// also files a request. That is strictly ADDITIVE — the add has already
// succeeded, so a refusal (quota, blacklist, already available…) or any failure
// never turns it into an error; the response is the item plus an `autoRequest`
// field describing what happened. The field is absent whenever auto-request
// does not apply, so the response is byte-identical to before for everyone else
// (the iOS app decodes it).
export const POST = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`watchlist:${session.user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  const parsed = await readJsonCapped<{ tmdbId?: number; mediaType?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const { tmdbId, mediaType } = parsed;

  if (!tmdbId || !mediaType) {
    return NextResponse.json({ error: "tmdbId and mediaType are required" }, { status: 400 });
  }
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType must be MOVIE or TV" }, { status: 400 });
  }

  // Three-tier cached resolver — see votes/route.ts for the rationale.
  const verified = await resolveMediaMeta(tmdbId, mediaType);
  if (!verified) {
    return NextResponse.json({ error: "Could not verify media with TMDB" }, { status: 422 });
  }

  let item: Prisma.WatchlistItemGetPayload<{ select: typeof SELECT }>;
  try {
    item = await prisma.watchlistItem.create({
      data: { tmdbId, mediaType, title: verified.title, posterPath: verified.posterPath, userId: session.user.id },
      select: SELECT,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "Already on your watchlist" }, { status: 409 });
    }
    throw err;
  }

  // Never throws (auto-request.ts), and runs outside the try above so nothing it
  // does can be mistaken for the watchlist insert's own P2002.
  const autoRequest = await maybeAutoRequestWatchlistAdd(session, tmdbId, mediaType);
  if (!autoRequest) return NextResponse.json(item, { status: 201 });
  return NextResponse.json(
    {
      ...item,
      autoRequest: {
        outcome: autoRequest.outcome,
        requested: autoRequest.outcome === "requested",
        status: autoRequest.status,
        message: autoRequest.message,
      },
    },
    { status: 201 },
  );
});

// DELETE — remove ?tmdbId=&mediaType= from the caller's watchlist. deleteMany so a
// missing row is a no-op success (idempotent toggle-off).
export const DELETE = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`watchlist-del:${session.user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const sp = req.nextUrl.searchParams;
  const tmdbId = Number(sp.get("tmdbId"));
  const mediaType = sp.get("mediaType");
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType must be MOVIE or TV" }, { status: 400 });
  }

  await prisma.watchlistItem.deleteMany({ where: { userId: session.user.id, tmdbId, mediaType } });
  return NextResponse.json({ ok: true });
});
