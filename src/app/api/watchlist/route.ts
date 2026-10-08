import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { parsePageParam } from "@/lib/pagination";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { sanitizeContainsSearch } from "@/lib/sanitize";
import { addToWatchlist, takeWatchlistAddToken, WATCHLIST_ITEM_SELECT } from "@/lib/watchlist-add";
import { translatorForRequest } from "@/lib/i18n/server-locale";

const PAGE_SIZE = 60;
const SELECT = WATCHLIST_ITEM_SELECT;

// GET — the caller's own watchlist (newest first), optionally filtered by type/query.
export const GET = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`watchlist-list:${session.user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequests") }, { status: 429 });
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
  const t = translatorForRequest(req);
  if (!takeWatchlistAddToken(session.user.id)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }

  const parsed = await readJsonCapped<{ tmdbId?: number; mediaType?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const { tmdbId, mediaType } = parsed;

  if (!tmdbId || !mediaType) {
    return NextResponse.json({ error: t("apiUser.common.tmdbIdMediaTypeRequired") }, { status: 400 });
  }
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: t("apiUser.common.tmdbIdPositive") }, { status: 400 });
  }
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: t("apiUser.common.mediaTypeInvalid") }, { status: 400 });
  }

  // TMDB verification, the insert and auto-request are the shared
  // chokepoint Discord's /watchlist add goes through too (src/lib/watchlist-add.ts).
  const added = await addToWatchlist(session, tmdbId, mediaType, t);
  if (!added.ok) return NextResponse.json({ error: added.error }, { status: added.status });
  const { item, autoRequest } = added;
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
  const t = translatorForRequest(req);
  if (!checkRateLimit(`watchlist-del:${session.user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequests") }, { status: 429 });
  }

  const sp = req.nextUrl.searchParams;
  const tmdbId = Number(sp.get("tmdbId"));
  const mediaType = sp.get("mediaType");
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: t("apiUser.common.tmdbIdPositive") }, { status: 400 });
  }
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: t("apiUser.common.mediaTypeInvalid") }, { status: 400 });
  }

  await prisma.watchlistItem.deleteMany({ where: { userId: session.user.id, tmdbId, mediaType } });
  return NextResponse.json({ ok: true });
});
