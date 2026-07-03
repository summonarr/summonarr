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
// app only needs poster + label + availability marks for these, not the full
// detail payload. The availability booleans mirror the web detail page, which
// runs attachAllAvailability over the same rails so their cards show
// in-library / in-queue badges.
function lite(m: TmdbMedia) {
  return {
    tmdbId: m.id,
    mediaType: m.mediaType,
    title: m.title,
    posterPath: m.posterPath,
    releaseYear: m.releaseYear,
    plexAvailable: m.plexAvailable,
    jellyfinAvailable: m.jellyfinAvailable,
    arrPending: m.arrPending,
    requested: m.requested,
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

  // Scoped to this page's backend (web-page parity): a movie page must not
  // surface 4K state when only the Sonarr 4K instance is configured, and
  // vice-versa.
  const show4k = await getShow4kVisibility(session, type);

  try {
    const [detail, cast, suggestions] = await Promise.all([
      type === "movie" ? getMovieDetails(tmdbId) : getTVDetails(tmdbId),
      type === "movie" ? getMovieCredits(tmdbId) : getTVCredits(tmdbId),
      // recommendations-first with a similar fallback, deduped + poster-gated,
      // already baked into these helpers (the web detail page uses the same).
      type === "movie" ? getMovieSuggestions(tmdbId) : getTVSuggestions(tmdbId),
    ]);
    // Ratings are skipped for the related rail — native tiles show no rating
    // chips, only the poster + availability mark.
    const [[withAvailability], similarWithAvailability] = await Promise.all([
      attachAllAvailability([detail], session.user.id, { show4k }),
      attachAllAvailability(suggestions.slice(0, 12), session.user.id, { skipRatings: true }),
    ]);

    // Whether this viewer has an open deletion vote on the title — lets the
    // native detail screen show "Voted to delete" + offer to retract — and,
    // when they can see 4K at all, whether they already hold an open 4K
    // request (drives the native "Request in 4K" button states, mirroring the
    // per-viewer `requested4k` the web detail pages compute).
    const [voteRow, my4kRequest] = await Promise.all([
      prisma.deletionVote.findFirst({
        where: { tmdbId, mediaType: type === "tv" ? "TV" : "MOVIE", userId: session.user.id },
        select: { id: true },
      }),
      show4k
        ? prisma.mediaRequest.findFirst({
            where: {
              tmdbId,
              mediaType: type === "tv" ? "TV" : "MOVIE",
              requestedBy: session.user.id,
              is4k: true,
              status: { not: "DECLINED" },
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    const votedByMe = voteRow !== null;

    // Additive native-client enrichment derived from the detail payload (which
    // already carries keywords / watchProviders / homepage / collection ids via
    // append_to_response) plus the suggestions fetch above.
    const similar = similarWithAvailability.map(lite);
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
    // into the collection's parts, with the same availability marks as the
    // similar rail (parts are all movies — clients may ignore the mediaType).
    let collection:
      | { id: number; name: string; items: ReturnType<typeof lite>[] }
      | null = null;
    if (type === "movie" && detail.collectionId) {
      try {
        const parts = await getMovieCollection(detail.collectionId);
        const partsWithAvailability = await attachAllAvailability(parts, session.user.id, {
          skipRatings: true,
        });
        collection = {
          id: detail.collectionId,
          name: detail.collectionName ?? "",
          items: partsWithAvailability.map(lite),
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
      // Present only when the viewer can see 4K state at all — same convention
      // as the arr4k* fields attachAllAvailability emits.
      requested4kByMe: show4k ? my4kRequest !== null : undefined,
    });
  } catch (err) {
    console.error("[media] detail fetch failed:", err);
    return NextResponse.json({ error: "Could not load this title" }, { status: 502 });
  }
});
