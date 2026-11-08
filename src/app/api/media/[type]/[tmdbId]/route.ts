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
  isTmdbNotFound,
  type TmdbMedia,
} from "@/lib/tmdb";
import type { CastMember } from "@/lib/tmdb-types";
import { isTmdbIdInRange, parseTmdbIdParam } from "@/lib/tmdb-id";
import { attachAllAvailability } from "@/lib/attach-all";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { checkRateLimit } from "@/lib/rate-limit";
import { translatorForRequest } from "@/lib/i18n/server-locale";

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

// The viewer's own state on the title: an open deletion vote (the native detail
// screen shows "Voted to delete" and offers to retract), whether it is on their
// watchlist / hidden list (the detail menu's Watchlist and "Not interested"
// toggles start right — the web pages seed the same two flags from SSR) and,
// when they can see 4K at all, whether they already hold an open 4K request
// (the native "Request in 4K" button states, mirroring the web's per-viewer
// `requested4k`). Each read keys only on the title and the viewer.
async function viewerTitleFlags(userId: string, tmdbId: number, mediaType: "MOVIE" | "TV", show4k: boolean) {
  const title = { tmdbId, mediaType };
  const [voteRow, my4kRequest, watchlistRow, hiddenRow] = await Promise.all([
    prisma.deletionVote.findFirst({ where: { ...title, userId }, select: { id: true } }),
    show4k
      ? prisma.mediaRequest.findFirst({
          where: { ...title, requestedBy: userId, arrInstance: "4k", status: { not: "DECLINED" } },
          select: { id: true },
        })
      : Promise.resolve(null),
    prisma.watchlistItem.findFirst({ where: { userId, ...title }, select: { id: true } }),
    prisma.hiddenItem.findFirst({ where: { userId, ...title }, select: { id: true } }),
  ]);
  return {
    votedByMe: voteRow !== null,
    onWatchlist: watchlistRow !== null,
    onHidden: hiddenRow !== null,
    // Present only when the viewer can see 4K state at all — same convention
    // as the arr4k* fields attachAllAvailability emits.
    requested4kByMe: show4k ? my4kRequest !== null : undefined,
  };
}

// Additive native-client enrichment derived from the detail payload (which
// already carries keywords / watchProviders / homepage / collection ids via
// append_to_response).
function detailExtras(detail: TmdbMedia) {
  return {
    // normalize emits `keywords`/`genres` (names, back-compat) alongside
    // `keywordList`/`genreList` (id+name for deep-linking) directly, so ship as-is.
    keywords: detail.keywords ?? [],
    keywordList: detail.keywordList ?? [],
    genreList: detail.genreList ?? [],
    // All US-region provider types (stream / rent / buy), each tagged with its
    // `type` so native clients can group them like the web detail page. The
    // detail payload's watchProviders are already US-scoped (extractWatchProviders).
    watchProviders: (detail.watchProviders ?? []).map((p) => ({ name: p.name, logoPath: p.logoPath, type: p.type })),
    homepage: detail.homepage ?? null,
  };
}

// Movies only: resolve belongs_to_collection (collectionId/Name on detail) into
// the collection's parts, with the same availability marks as the similar rail
// (parts are all movies — clients may ignore the mediaType). Best-effort: a
// TMDB hiccup here shouldn't fail the whole detail response — it resolves to
// null (no `collection` on the wire), while a successful fetch with no usable
// parts still ships `{ …, items: [] }`.
function loadCollectionParts(type: "movie" | "tv", detail: TmdbMedia, userId: string): Promise<TmdbMedia[] | null> {
  if (type !== "movie" || !detail.collectionId) return Promise.resolve(null);
  return getMovieCollection(detail.collectionId)
    .then((parts) => attachAllAvailability(parts, userId, { skipRatings: true }))
    .catch((err: unknown): null => {
      console.error("[media] collection fetch failed:", err);
      return null;
    });
}

// Full single-title detail for native clients. The web app builds this in a
// server component (src/app/(app)/{movie,tv}/[id]); this mirrors it as REST:
// rich TMDB details (genres, runtime, seasons, ratings, trailer) + top cast +
// per-viewer availability/request/4K flags.
export const GET = withAuth(async (
  req,
  { params }: { params: Promise<{ type: string; tmdbId: string }> },
  session,
) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`media:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequests") }, { status: 429 });
  }

  const { type, tmdbId: rawId } = await params;
  // Canonical digits only: parseInt served "550abc" and "550.9" as movie 550.
  const tmdbId = parseTmdbIdParam(rawId);

  if (tmdbId === null) {
    return NextResponse.json({ error: t("apiUser.common.tmdbIdPositive") }, { status: 400 });
  }
  // INT4 ceiling shared with tv-availability and the season route: the
  // int-keyed Prisma reads below throw past it.
  if (!isTmdbIdInRange(tmdbId)) {
    return NextResponse.json({ error: t("apiUser.common.tmdbIdOutOfRange") }, { status: 400 });
  }
  if (type !== "movie" && type !== "tv") {
    return NextResponse.json({ error: t("apiUser.media.typeInvalid") }, { status: 400 });
  }

  try {
    const [show4k, detail, cast, suggestions] = await Promise.all([
      // Scoped to this page's backend (web-page parity): a movie page must not
      // surface 4K state when only the Sonarr 4K instance is configured, and
      // vice-versa. Inside the try like every other read, so a settings-read
      // failure is the localized 502, not a bare framework 500.
      getShow4kVisibility(session, type),
      type === "movie" ? getMovieDetails(tmdbId) : getTVDetails(tmdbId),
      // Cast is best-effort, exactly as the web detail pages treat it
      // (`getMovieCredits(id).catch(() => [])`): the credits helpers have no
      // internal degrade, so an isolated TMDB hiccup on /credits must not take
      // the title, availability and request state down with it.
      (type === "movie" ? getMovieCredits(tmdbId) : getTVCredits(tmdbId)).catch(
        (err: unknown): CastMember[] => {
          console.error("[media] credits fetch failed:", err);
          return [];
        },
      ),
      // recommendations-first with a similar fallback, deduped + poster-gated,
      // already baked into these helpers (the web detail page uses the same).
      type === "movie" ? getMovieSuggestions(tmdbId) : getTVSuggestions(tmdbId),
    ]);

    // One wave for everything that needs the detail: the collection (started
    // as soon as collectionId is known, so its TMDB round trip and availability
    // pass overlap the suggestions — the web movie page runs them in one wave
    // too), both availability passes and the viewer's own flags. Ratings are
    // skipped for the related rail — native tiles show no rating chips, only
    // the poster + availability mark.
    const [[withAvailability], similarWithAvailability, collectionParts, flags] = await Promise.all([
      // includeHidden: never filter out the very item the viewer opened, even if
      // they've hidden it. The related rail below is left to filter normally.
      attachAllAvailability([detail], session.user.id, { show4k, includeHidden: true }),
      attachAllAvailability(suggestions.slice(0, 12), session.user.id, { skipRatings: true }),
      loadCollectionParts(type, detail, session.user.id),
      viewerTitleFlags(session.user.id, tmdbId, type === "tv" ? "TV" : "MOVIE", show4k),
    ]);

    // `collection` stays null when the title has none (native clients decode
    // it as optional) or when the best-effort fetch above failed.
    const collection: { id: number; name: string; items: ReturnType<typeof lite>[] } | null =
      type === "movie" && detail.collectionId && collectionParts !== null
        ? { id: detail.collectionId, name: detail.collectionName ?? "", items: collectionParts.map(lite) }
        : null;

    const extras = detailExtras(detail);
    return NextResponse.json({
      ...withAvailability,
      cast,
      similar: similarWithAvailability.map(lite),
      keywords: extras.keywords,
      keywordList: extras.keywordList,
      genreList: extras.genreList,
      watchProviders: extras.watchProviders,
      homepage: extras.homepage,
      collection,
      votedByMe: flags.votedByMe,
      onWatchlist: flags.onWatchlist,
      onHidden: flags.onHidden,
      requested4kByMe: flags.requested4kByMe,
    });
  } catch (err) {
    console.error("[media] detail fetch failed:", err);
    // TMDB doesn't know the id: Not Found, told apart from an upstream outage.
    if (isTmdbNotFound(err)) {
      return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });
    }
    return NextResponse.json({ error: t("apiUser.media.loadFailed") }, { status: 502 });
  }
});
