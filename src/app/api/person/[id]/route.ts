import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { getPersonDetails } from "@/lib/tmdb";
import { prisma } from "@/lib/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { attachRatingsUnified } from "@/lib/omdb-availability";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { generateRequestToken } from "@/lib/request-token";
import { checkRateLimit } from "@/lib/rate-limit";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session || isTokenExpired(session)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!checkRateLimit(`person:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { showPlex, showJellyfin } = getBadgeVisibility(session);

  const { id } = await params;
  const personId = Number(id);
  if (!Number.isFinite(personId) || personId <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const person = await getPersonDetails(personId);

    if (person.credits.length > 500) {
      person.credits = person.credits.slice(0, 500);
    }

    if (person.credits.length === 0) {
      return NextResponse.json(person);
    }

    const orClause = person.credits.map((c) => ({
      tmdbId: c.id,
      mediaType: c.mediaType === "movie" ? ("MOVIE" as const) : ("TV" as const),
    }));

    const movieIds = person.credits.filter((c) => c.mediaType === "movie").map((c) => c.id);
    const tvIds    = person.credits.filter((c) => c.mediaType === "tv").map((c) => c.id);

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
        ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: movieIds } }, select: { tmdbId: true } })
        : Promise.resolve([]),
      tvIds.length > 0
        ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: tvIds } }, select: { tmdbId: true } })
        : Promise.resolve([]),
    ]);

    const plexSet      = new Set(plexRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
    const jfSet        = new Set(jfRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
    const requestedSet = new Set(requestRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
    const mineSet      = new Set(mineRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
    const radarrSet    = new Set(radarrRows.map((r) => r.tmdbId));
    const sonarrSet    = new Set(sonarrRows.map((r) => r.tmdbId));

    const enrichedCredits = person.credits.map((c) => {
      const dbType = c.mediaType === "movie" ? "MOVIE" : "TV";
      const key = `${c.id}:${dbType}`;
      const rated = ratingByKey.get(`${c.mediaType}:${c.id}`);
      return {
        ...c,
        plexAvailable:     showPlex ? plexSet.has(key) : false,
        jellyfinAvailable: showJellyfin ? jfSet.has(key) : false,
        requested:         requestedSet.has(key),
        requestedByMe:     mineSet.has(key),
        arrPending:        c.mediaType === "movie" ? radarrSet.has(c.id) : sonarrSet.has(c.id),
        imdbId:            rated?.imdbId ?? null,
        imdbRating:        rated?.imdbRating ?? null,
        imdbVotes:         rated?.imdbVotes ?? null,
        rottenTomatoes:    rated?.rottenTomatoes ?? null,
        rtAudienceScore:   rated?.rtAudienceScore ?? null,
        metacritic:        rated?.metacritic ?? null,
        traktRating:       rated?.traktRating ?? null,
        letterboxdRating:  rated?.letterboxdRating ?? null,
        mdblistScore:      rated?.mdblistScore ?? null,
        malRating:         rated?.malRating ?? null,
        rogerEbertRating:  rated?.rogerEbertRating ?? null,
        requestToken:      generateRequestToken(c.id, dbType, session.user.id),
      };
    });

    return NextResponse.json({ ...person, credits: enrichedCredits });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
