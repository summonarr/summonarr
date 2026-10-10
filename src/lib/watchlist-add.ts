import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { resolveMediaMeta } from "@/lib/request-meta";
import { maybeAutoRequestWatchlistAdd, type AutoRequestAttempt } from "@/lib/auto-request";
import type { SummonarrSession } from "@/lib/api-auth";
import type { Translator } from "@/lib/i18n/translate";

// Adding a title to a user's watchlist — POST /api/watchlist minus its HTTP
// shell, shared with Discord's /watchlist add so the two can't drift on the
// TMDB verification, the duplicate answer or watchlist auto-request. Both
// callers spend the same per-user add budget (takeWatchlistAddToken) first.
// No library/permission gate: the watchlist is a personal save-for-later list,
// deliberately usable for unavailable titles.

export const WATCHLIST_ITEM_SELECT = { tmdbId: true, mediaType: true, title: true, posterPath: true, createdAt: true } as const;
export type WatchlistItemRow = Prisma.WatchlistItemGetPayload<{ select: typeof WATCHLIST_ITEM_SELECT }>;

export type AddToWatchlistResult =
  | {
      ok: true;
      item: WatchlistItemRow;
      // Null when watchlist auto-request does not apply (feature off, or no
      // AUTO_REQUEST bit for this media type). Never an error: the add has
      // already succeeded whatever auto-request answered.
      autoRequest: AutoRequestAttempt | null;
    }
  | { ok: false; status: 409 | 422; reason: "tmdb-unverified" | "already-added"; error: string };

// The per-user add rate limit (60 a minute), shared by every add path. The web
// route spends it before reading the body, as it always has.
export function takeWatchlistAddToken(userId: string): boolean {
  return checkRateLimit(`watchlist:${userId}`, 60, 60_000);
}

export async function addToWatchlist(
  session: SummonarrSession,
  tmdbId: number,
  mediaType: "MOVIE" | "TV",
  t: Translator,
): Promise<AddToWatchlistResult> {
  // Three-tier cached resolver — see votes/route.ts for the rationale.
  const verified = await resolveMediaMeta(tmdbId, mediaType);
  if (!verified) return { ok: false, status: 422, reason: "tmdb-unverified", error: t("apiUser.common.tmdbUnverified") };

  let item: WatchlistItemRow;
  try {
    item = await prisma.watchlistItem.create({
      data: { tmdbId, mediaType, title: verified.title, posterPath: verified.posterPath, userId: session.user.id },
      select: WATCHLIST_ITEM_SELECT,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, status: 409, reason: "already-added", error: t("apiUser.watchlist.alreadyAdded") };
    }
    throw err;
  }

  // Never throws (auto-request.ts), and runs outside the try above so nothing it
  // does can be mistaken for the watchlist insert's own P2002.
  const autoRequest = await maybeAutoRequestWatchlistAdd(session, tmdbId, mediaType, t);
  return { ok: true, item, autoRequest };
}
