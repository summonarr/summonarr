import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { attachRatingsUnified } from "@/lib/omdb-availability";
import type { TmdbMedia, MediaType } from "@/lib/tmdb-types";
import { checkRateLimit } from "@/lib/rate-limit";
import { isTmdbIdInRange } from "@/lib/tmdb-id";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Keep in step with MAX_BATCH in src/lib/client/ratings-batcher.ts.
const MAX_BATCH = 200;

// What one signed-in user may make this route fetch upstream. Every cold title
// is an MDBList batch slot and, when MDBList can't rate it, a TMDB + OMDb chain
// (OMDb's free tier is 1,000 a day for the whole site). Without a budget, ten
// calls a minute of 200 distinct cold ids let one account drive ~2,000 chains a
// minute and trip the site-wide OMDb lockout.
//   - At most ROUTE_MAX_BLOCKING_MISSES OMDb chains are awaited in the request;
//     the rest of a call's misses are warmed after the response.
//   - Past COLD_LOOKUP_BUDGET cold titles in an hour, a cold title is answered
//     from the cache only (no rating yet) until the hour rolls on. Warm and
//     stale titles are never limited.
const ROUTE_MAX_BLOCKING_MISSES = 40;
const COLD_LOOKUP_BUDGET = 600;
const COLD_LOOKUP_WINDOW_MS = 60 * 60 * 1000;

type ReqItem = { id: number; type: MediaType; releaseDate: string | null };

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

  const budgetKey = `ratings-batch-cold:${session.user.id}`;
  const enriched = await attachRatingsUnified(stubs, {
    blocking: true,
    maxBlockingMisses: ROUTE_MAX_BLOCKING_MISSES,
    admitMiss: () => checkRateLimit(budgetKey, COLD_LOOKUP_BUDGET, COLD_LOOKUP_WINDOW_MS),
  });

  const ratings: Record<string, unknown> = {};
  for (const item of enriched) {
    if (
      item.imdbId == null &&
      item.imdbRating == null &&
      item.rottenTomatoes == null &&
      item.rtAudienceScore == null &&
      item.metacritic == null &&
      item.traktRating == null &&
      item.letterboxdRating == null &&
      item.mdblistScore == null &&
      item.malRating == null &&
      item.rogerEbertRating == null
    ) continue;
    ratings[`${item.mediaType}:${item.id}`] = {
      imdbId: item.imdbId ?? null,
      imdbRating: item.imdbRating ?? null,
      imdbVotes: item.imdbVotes ?? null,
      rottenTomatoes: item.rottenTomatoes ?? null,
      rtAudienceScore: item.rtAudienceScore ?? null,
      metacritic: item.metacritic ?? null,
      traktRating: item.traktRating ?? null,
      letterboxdRating: item.letterboxdRating ?? null,
      mdblistScore: item.mdblistScore ?? null,
      malRating: item.malRating ?? null,
      rogerEbertRating: item.rogerEbertRating ?? null,
    };
  }

  return NextResponse.json({ ratings });
});
