import { getPersonDetails } from "@/lib/tmdb";
import type { PersonCredit, PersonDetails, TmdbMedia } from "@/lib/tmdb-types";
import { attachAllAvailability } from "@/lib/attach-all";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { isFeatureEnabled } from "@/lib/features";
import { generateRequestToken } from "@/lib/request-token";
import type { SummonarrSession } from "@/lib/api-auth";
import { localizedBiography } from "@/lib/tmdb-localize";
import { getContentLocale } from "@/lib/i18n/server";
import { USER_MAX_BLOCKING_MISSES } from "@/lib/ratings-cold-budget";

// What the ratings pass needs to know about a credit. A credit carries a year,
// not a date; the ratings caches key their TTLs off the date (a new release
// refreshes sooner, and a not-found answer for one is retried within a day), so
// the year stands in as its first day, as mdblist.ts does for an undated answer.
const RATING_FIELDS = [
  "imdbId", "imdbRating", "imdbVotes", "rottenTomatoes", "rtAudienceScore", "metacritic",
  "traktRating", "letterboxdRating", "mdblistScore", "malRating", "rogerEbertRating",
] as const;
type RatingFields = { [K in (typeof RATING_FIELDS)[number]]?: string | null };

/**
 * A credit's rating fields. The ratings pass leaves a title it did NOT look up
 * (past the per-request share of cold lookups) untouched, so its fields are
 * undefined, while a looked-up title with no rating carries nulls. That
 * difference is kept: a card fetches ratings itself only for a title that
 * arrived without them (useLiveRatings), and a null there reads as "looked up,
 * nothing found" — the credit then showed only its TMDB score until a reload.
 */
export function creditRatingFields(e: RatingFields): RatingFields {
  if (e.imdbRating === undefined && e.rottenTomatoes === undefined) return {};
  return withNullRatings(e);
}

/** Every rating field present, null when unset: the shape GET /api/person/[id] has always answered. */
export function withNullRatings<T extends RatingFields>(e: T): T & Required<RatingFields> {
  const out: RatingFields = {};
  for (const field of RATING_FIELDS) out[field] = e[field] ?? null;
  return { ...e, ...out } as T & Required<RatingFields>;
}

function ratingsInputFor(c: PersonCredit): TmdbMedia {
  const releaseDate = /^\d{4}$/.test(c.releaseYear) ? `${c.releaseYear}-01-01` : null;
  return {
    id: c.id,
    mediaType: c.mediaType,
    title: c.title,
    overview: "",
    posterPath: c.posterPath,
    backdropPath: null,
    releaseDate,
    releaseYear: releaseDate ? c.releaseYear : null,
    voteAverage: c.voteAverage,
  };
}

// Fetch a person's filmography and enrich each credit with THIS viewer's
// availability, request state, ratings, and a request token — the exact shape a
// MediaCard renders. Shared by GET /api/person/[id] (native clients) and the
// /person/[id] server page so the enrichment can't drift between them.
//
// The enrichment IS the discovery grids' (attachAllAvailability): per-viewer
// server visibility (guardrail 35) in the data layer, the default-instance
// request and Radarr/Sonarr state, the blacklist mark, ratings and the
// content-language overlay (guardrail 40a), and the viewer's own "not
// interested" titles left out — one definition, so a credit's badges read as
// the same title's grid card. On top: the caller's badge visibility (a
// cosmetic mask) and a request token scoped to the session user. Throws the
// underlying TMDB error unchanged, so callers can map isTmdbNotFound to Not
// Found and anything else to a 5xx / error boundary.
export async function getEnrichedPerson(
  personId: number,
  session: SummonarrSession,
): Promise<PersonDetails> {
  // Integration flags passed explicitly (they default to TRUE when omitted), so a
  // disabled integration's leftover library rows badge nothing here — matching
  // the movie/TV detail pages.
  const [englishPerson, plexEnabled, jellyfinEnabled, locale] = await Promise.all([
    getPersonDetails(personId),
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
    getContentLocale(),
  ]);
  const { showPlex, showJellyfin } = getBadgeVisibility(session, {
    plex: plexEnabled,
    jellyfin: jellyfinEnabled,
  });
  // Biography in the viewer's language (English is a no-op); the credits'
  // titles and posters are localized by the enrichment below.
  const [biography, enriched] = await Promise.all([
    localizedBiography(personId, locale),
    attachAllAvailability(
      englishPerson.credits.map((credit) => ({ ...ratingsInputFor(credit), credit })),
      session.user.id,
      // A filmography can run to hundreds of credits: wait for at most the
      // per-request share of cold lookups (the rest are warmed after the
      // response), all of them drawn from the viewer's cold-lookup budget.
      { blockRatings: true, maxBlockingRatingMisses: USER_MAX_BLOCKING_MISSES },
    ),
  ]);

  const credits = enriched.map((e): PersonCredit => {
    const c = e.credit;
    const dbType = c.mediaType === "movie" ? "MOVIE" : "TV";
    return {
      ...c,
      title: e.title,
      posterPath: e.posterPath,
      plexAvailable: showPlex ? e.plexAvailable === true : false,
      jellyfinAvailable: showJellyfin ? e.jellyfinAvailable === true : false,
      requested: e.requested === true,
      requestedByMe: e.requestedByMe === true,
      arrPending: e.arrPending === true,
      blacklisted: e.blacklisted === true,
      ...creditRatingFields(e),
      requestToken: generateRequestToken(c.id, dbType, session.user.id),
    };
  });

  return { ...englishPerson, ...(biography ? { biography } : {}), credits };
}
