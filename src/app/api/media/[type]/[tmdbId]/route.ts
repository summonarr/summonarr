import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import {
  getMovieDetails,
  getTVDetails,
  getMovieCredits,
  getTVCredits,
  getMovieSuggestions,
  getTVSuggestions,
  getMovieCollection,
  type TmdbMedia,
} from "@/lib/tmdb";
import { attachAllAvailability } from "@/lib/attach-all";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { checkRateLimit } from "@/lib/rate-limit";

// Lightweight projection for related/collection rails on native clients — the
// app only needs poster + label for these, not the full detail payload.
function lite(m: TmdbMedia) {
  return {
    tmdbId: m.id,
    mediaType: m.mediaType,
    title: m.title,
    posterPath: m.posterPath,
    releaseYear: m.releaseYear,
  };
}

// Full single-title detail for native clients. The web app builds this in a
// server component (src/app/(app)/{movie,tv}/[id]); this mirrors it as REST:
// rich TMDB details (genres, runtime, seasons, ratings, trailer) + top cast +
// per-viewer availability/request/4K flags.
export const GET = withAuth(async (
  _req,
  { params }: { params: Promise<{ type: string; tmdbId: string }> },
  session,
) => {
  if (!checkRateLimit(`media:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { type, tmdbId: rawId } = await params;
  const tmdbId = parseInt(rawId, 10);

  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }
  if (type !== "movie" && type !== "tv") {
    return NextResponse.json({ error: "type must be movie or tv" }, { status: 400 });
  }

  const show4k = await getShow4kVisibility(session);

  try {
    const [detail, cast, suggestions] = await Promise.all([
      type === "movie" ? getMovieDetails(tmdbId) : getTVDetails(tmdbId),
      type === "movie" ? getMovieCredits(tmdbId) : getTVCredits(tmdbId),
      // recommendations-first with a similar fallback, deduped + poster-gated,
      // already baked into these helpers (the web detail page uses the same).
      type === "movie" ? getMovieSuggestions(tmdbId) : getTVSuggestions(tmdbId),
    ]);
    const [withAvailability] = await attachAllAvailability([detail], session.user.id, { show4k });

    // Whether this viewer has an open deletion vote on the title — lets the
    // native detail screen show "Voted to delete" + offer to retract (web parity).
    const votedByMe =
      (await prisma.deletionVote.findFirst({
        where: { tmdbId, mediaType: type === "tv" ? "TV" : "MOVIE", userId: session.user.id },
        select: { id: true },
      })) !== null;

    // Additive native-client enrichment derived from the detail payload (which
    // already carries keywords / watchProviders / homepage / collection ids via
    // append_to_response) plus the suggestions fetch above.
    const similar = suggestions.slice(0, 12).map(lite);
    // normalize emits `keywords`/`genres` (names, back-compat) alongside
    // `keywordList`/`genreList` (id+name for deep-linking) directly, so ship as-is.
    const keywords = detail.keywords ?? [];
    const keywordList = detail.keywordList ?? [];
    const genreList = detail.genreList ?? [];
    // All US-region provider types (stream / rent / buy), each tagged with its
    // `type` so native clients can group them like the web detail page. The
    // detail payload's watchProviders are already US-scoped (extractWatchProviders).
    const watchProviders = (detail.watchProviders ?? [])
      .map((p) => ({ name: p.name, logoPath: p.logoPath, type: p.type }));
    const homepage = detail.homepage ?? null;

    // Movies only: resolve belongs_to_collection (collectionId/Name on detail)
    // into the collection's parts. Collection items are all movies, so they omit
    // the mediaType field that `similar` items carry.
    let collection:
      | {
          id: number;
          name: string;
          items: { tmdbId: number; title: string; posterPath: string | null; releaseYear: string | null }[];
        }
      | null = null;
    if (type === "movie" && detail.collectionId) {
      try {
        const parts = await getMovieCollection(detail.collectionId);
        collection = {
          id: detail.collectionId,
          name: detail.collectionName ?? "",
          items: parts.map((p) => ({
            tmdbId: p.id,
            title: p.title,
            posterPath: p.posterPath,
            releaseYear: p.releaseYear,
          })),
        };
      } catch (err) {
        // Collection enrichment is best-effort; a TMDB hiccup here shouldn't
        // fail the whole detail response.
        console.error("[media] collection fetch failed:", err);
      }
    }

    return NextResponse.json({
      ...withAvailability,
      cast,
      similar,
      keywords,
      keywordList,
      genreList,
      watchProviders,
      homepage,
      collection,
      votedByMe,
    });
  } catch (err) {
    console.error("[media] detail fetch failed:", err);
    return NextResponse.json({ error: "Could not load this title" }, { status: 502 });
  }
});
