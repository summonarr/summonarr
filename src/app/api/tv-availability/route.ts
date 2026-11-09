import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  getVisibleServerInstances,
  providerEpisodeSources,
  summarizeEpisodeSources,
  visibleEpisodeSourcesFor,
} from "@/lib/media-visibility";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { isTmdbIdInRange, parseTmdbIdParam } from "@/lib/tmdb-id";

export interface TVSeasonInfo {
  seasonNumber: number;
  episodes: number[];
}

export interface TVAvailabilityResponse {
  source: "plex" | "jellyfin" | "both" | null;
  seasons: TVSeasonInfo[];
}

export const GET = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`tv-availability:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequests") }, { status: 429 });
  }

  const raw = req.nextUrl.searchParams.get("tmdbId");
  if (!raw) return NextResponse.json({ error: t("apiUser.common.tmdbIdRequired") }, { status: 400 });
  const tmdbId = parseTmdbIdParam(raw);
  if (tmdbId === null) {
    return NextResponse.json({ error: t("apiUser.common.tmdbIdPositive") }, { status: 400 });
  }
  // INT4 ceiling: a larger id clears the check above and throws out of the
  // PlexLibraryItem read below — an unhandled 500 for a malformed query string.
  if (!isTmdbIdInRange(tmdbId)) {
    return NextResponse.json({ error: t("apiUser.common.tmdbIdOutOfRange") }, { status: 400 });
  }

  const providerSources = providerEpisodeSources(session.user.provider);

  // TVEpisodeCache has no serverInstance column, so `source` alone would report
  // a RESTRICTED server's per-episode holdings to an ungranted caller — and this
  // route returns them as raw JSON. Gate on whether the viewer can see any
  // server of that type actually holding the title. See media-visibility.ts.
  const visible = await getVisibleServerInstances(session);
  const sources = await visibleEpisodeSourcesFor(tmdbId, visible, providerSources);
  if (sources.length === 0) return NextResponse.json({ source: null, seasons: [] });

  // Only the three columns read below — a long show's rows otherwise carry
  // every episode's overview, still path and name for nothing.
  const rows = await prisma.tVEpisodeCache.findMany({
    where: { tmdbId, source: { in: sources } },
    select: { seasonNumber: true, episodeNumber: true, source: true },
    orderBy: [{ seasonNumber: "asc" }, { episodeNumber: "asc" }],
  });

  const seen = new Map<string, { seasonNumber: number; episodeNumber: number }>();
  for (const row of rows) {
    const key = `${row.seasonNumber}:${row.episodeNumber}`;
    if (!seen.has(key)) seen.set(key, { seasonNumber: row.seasonNumber, episodeNumber: row.episodeNumber });
  }

  const seasonMap = new Map<number, number[]>();
  for (const { seasonNumber, episodeNumber } of seen.values()) {
    if (!seasonMap.has(seasonNumber)) seasonMap.set(seasonNumber, []);
    seasonMap.get(seasonNumber)!.push(episodeNumber);
  }

  const seasons: TVSeasonInfo[] = Array.from(seasonMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([seasonNumber, episodes]) => ({ seasonNumber, episodes: episodes.sort((a, b) => a - b) }));

  const source: TVAvailabilityResponse["source"] = summarizeEpisodeSources(new Set(rows.map((r) => r.source)));

  return NextResponse.json({ source, seasons } satisfies TVAvailabilityResponse);
});
