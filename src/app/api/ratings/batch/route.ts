import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { attachRatingsUnified } from "@/lib/omdb-availability";
import type { TmdbMedia, MediaType } from "@/lib/tmdb-types";
import { checkRateLimit } from "@/lib/rate-limit";
import { isTmdbIdInRange } from "@/lib/tmdb-id";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { RATINGS_BATCH_MAX_ITEMS } from "@/lib/api-body-limits";
import { coldLookupAdmitter, USER_MAX_BLOCKING_MISSES } from "@/lib/ratings-cold-budget";

// The client batcher (src/lib/client/ratings-batcher.ts) reads the same constant.
const MAX_BATCH = RATINGS_BATCH_MAX_ITEMS;

// Cold lookups are held to the per-user budget in ratings-cold-budget.ts, the
// one budget every ratings surface spends: at most USER_MAX_BLOCKING_MISSES
// OMDb chains are awaited in the request (the rest of a call's misses are
// warmed after the response), and past the hourly budget a cold title is
// answered from the cache only. Warm and stale titles are never limited.

type ReqItem = { id: number; type: MediaType; releaseDate: string | null };

// Every rating field the batch answers, in wire order (the spec's batch item
// mirrors this list). A new ratings source is added here once.
const RATING_FIELDS = [
  "imdbId",
  "imdbRating",
  "imdbVotes",
  "rottenTomatoes",
  "rtAudienceScore",
  "metacritic",
  "traktRating",
  "letterboxdRating",
  "mdblistScore",
  "malRating",
  "rogerEbertRating",
] as const satisfies ReadonlyArray<keyof TmdbMedia>;
type RatingField = (typeof RATING_FIELDS)[number];
type RatingsEntry = Record<RatingField, string | null>;

// A vote count alone is not a rating: a title with nothing but imdbVotes is
// left out of the map, as a title with no rating at all is.
const PRESENCE_FIELDS = RATING_FIELDS.filter((f) => f !== "imdbVotes");

function hasAnyRating(item: TmdbMedia): boolean {
  return PRESENCE_FIELDS.some((f) => item[f] != null);
}

function projectRatings(item: TmdbMedia): RatingsEntry {
  const entry = {} as RatingsEntry;
  for (const f of RATING_FIELDS) entry[f] = item[f] ?? null;
  return entry;
}

// POST /api/ratings/batch — resolves external ratings (IMDb/RT/Metacritic/etc.)
// for up to MAX_BATCH deduped tmdbId+type items in one blocking pass; used to
// hydrate ratings across a grid of cards. Cold lookups are held to the budget
// above.
export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`ratings-batch:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequests") }, { status: 429 });
  }

  const parsed = await readJsonCapped(req, 1048576);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const rawItems = (body as { items?: unknown })?.items;
  if (!Array.isArray(rawItems)) {
    return NextResponse.json({ error: t("apiUser.ratings.itemsMissing") }, { status: 400 });
  }
  if (rawItems.length === 0) return NextResponse.json({ ratings: {} });
  if (rawItems.length > MAX_BATCH) {
    return NextResponse.json({ error: t("apiUser.common.tooManyItems", { max: MAX_BATCH }) }, { status: 400 });
  }

  const seen = new Set<string>();
  const items: ReqItem[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const { id, type, releaseDate } = raw as { id?: unknown; type?: unknown; releaseDate?: unknown };
    if (typeof id !== "number" || !isTmdbIdInRange(id)) continue;
    if (type !== "movie" && type !== "tv") continue;
    const key = `${type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ id, type, releaseDate: typeof releaseDate === "string" ? releaseDate : null });
  }

  const stubs: TmdbMedia[] = items.map((i) => ({
    id: i.id,
    mediaType: i.type,
    title: "",
    overview: "",
    posterPath: null,
    backdropPath: null,
    releaseDate: i.releaseDate,
    releaseYear: "",
    voteAverage: 0,
  }));

  const enriched = await attachRatingsUnified(stubs, {
    blocking: true,
    maxBlockingMisses: USER_MAX_BLOCKING_MISSES,
    admitMiss: coldLookupAdmitter(session.user.id),
  });

  const ratings: Record<string, RatingsEntry> = {};
  for (const item of enriched) {
    if (!hasAnyRating(item)) continue;
    ratings[`${item.mediaType}:${item.id}`] = projectRatings(item);
  }

  return NextResponse.json({ ratings });
});
