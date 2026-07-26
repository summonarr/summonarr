import { prisma } from "@/lib/prisma";
import { getPersonDetails } from "@/lib/tmdb";
import type { PersonDetails, TmdbMedia } from "@/lib/tmdb-types";
import { attachRatingsUnified } from "@/lib/omdb-availability";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { generateRequestToken } from "@/lib/request-token";
import { getBlacklistSet, blacklistKey } from "@/lib/blacklist";
import type { SummonarrSession } from "@/lib/api-auth";

// Fetch a person's filmography and enrich each credit with THIS viewer's
// availability, request state, ratings, and a request token — the exact shape a
// MediaCard renders. Shared by GET /api/person/[id] (native clients) and the
// /person/[id] server page so the enrichment can't drift between them. Availability
// is gated by the caller's badge visibility, and `requestedByMe`/`requestToken`
// are scoped to the session user. Throws the underlying TMDB error unchanged, so
// callers can map a `failed: 404` to Not Found and anything else to a 5xx / error
// boundary (mirrors the previous inline route behavior).
export async function getEnrichedPerson(
  personId: number,
  session: SummonarrSession,
): Promise<PersonDetails> {
  const { showPlex, showJellyfin } = getBadgeVisibility(session);
  const person = await getPersonDetails(personId);
  if (person.credits.length === 0) return person;

  const orClause = person.credits.map((c) => ({
    tmdbId: c.id,
    mediaType: c.mediaType === "movie" ? ("MOVIE" as const) : ("TV" as const),
  }));
  const movieIds = person.credits.filter((c) => c.mediaType === "movie").map((c) => c.id);
  const tvIds = person.credits.filter((c) => c.mediaType === "tv").map((c) => c.id);

  const ratedCredits = await attachRatingsUnified(person.credits as unknown as TmdbMedia[], { blocking: true });
  const ratingByKey = new Map<string, TmdbMedia>();
  for (const r of ratedCredits) ratingByKey.set(`${r.mediaType}:${r.id}`, r);

  const [plexRows, jfRows, requestRows, mineRows, radarrRows, sonarrRows] = await Promise.all([
    prisma.plexLibraryItem.findMany({ where: { OR: orClause }, select: { tmdbId: true, mediaType: true } }),
    prisma.jellyfinLibraryItem.findMany({ where: { OR: orClause }, select: { tmdbId: true, mediaType: true } }),
    prisma.mediaRequest.findMany({
      where: { status: { not: "DECLINED" }, OR: orClause },
      select: { tmdbId: true, mediaType: true },
      distinct: ["tmdbId", "mediaType"],
    }),
    prisma.mediaRequest.findMany({
      where: { status: { not: "DECLINED" }, requestedBy: session.user.id, OR: orClause },
      select: { tmdbId: true, mediaType: true },
      distinct: ["tmdbId", "mediaType"],
    }),
    movieIds.length > 0
      ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: movieIds }, arrInstance: "" }, select: { tmdbId: true } })
      : Promise.resolve([]),
    tvIds.length > 0
      ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: tvIds }, arrInstance: "" }, select: { tmdbId: true } })
      : Promise.resolve([]),
  ]);

  const plexSet = new Set(plexRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
  const jfSet = new Set(jfRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
  const requestedSet = new Set(requestRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
  const mineSet = new Set(mineRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
  const radarrSet = new Set(radarrRows.map((r) => r.tmdbId));
  const sonarrSet = new Set(sonarrRows.map((r) => r.tmdbId));
  const blSet = await getBlacklistSet();

  const credits = person.credits.map((c) => {
    const dbType = c.mediaType === "movie" ? "MOVIE" : "TV";
    const key = `${c.id}:${dbType}`;
    const rated = ratingByKey.get(`${c.mediaType}:${c.id}`);
    return {
      ...c,
      plexAvailable: showPlex ? plexSet.has(key) : false,
      jellyfinAvailable: showJellyfin ? jfSet.has(key) : false,
      requested: requestedSet.has(key),
      requestedByMe: mineSet.has(key),
      arrPending: c.mediaType === "movie" ? radarrSet.has(c.id) : sonarrSet.has(c.id),
      blacklisted: blSet.size > 0 && blSet.has(blacklistKey(c.id, c.mediaType)),
      imdbId: rated?.imdbId ?? null,
      imdbRating: rated?.imdbRating ?? null,
      imdbVotes: rated?.imdbVotes ?? null,
      rottenTomatoes: rated?.rottenTomatoes ?? null,
      rtAudienceScore: rated?.rtAudienceScore ?? null,
      metacritic: rated?.metacritic ?? null,
      traktRating: rated?.traktRating ?? null,
      letterboxdRating: rated?.letterboxdRating ?? null,
      mdblistScore: rated?.mdblistScore ?? null,
      malRating: rated?.malRating ?? null,
      rogerEbertRating: rated?.rogerEbertRating ?? null,
      requestToken: generateRequestToken(c.id, dbType, session.user.id),
    };
  });

  return { ...person, credits };
}
