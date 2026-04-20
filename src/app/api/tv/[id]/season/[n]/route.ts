import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getTVSeasonEpisodes } from "@/lib/tmdb";
import type { TmdbEpisode } from "@/lib/tmdb-types";

export interface TVSeasonResponse {
  episodes: TmdbEpisode[];
  owned: number[];
  source: "plex" | "jellyfin" | "both" | null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string }> },
) {
  const session = await auth();
  if (!session || isTokenExpired(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: rawId, n: rawN } = await params;
  const tmdbId = parseInt(rawId, 10);
  const seasonNumber = parseInt(rawN, 10);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "id must be a positive integer" }, { status: 400 });
  }
  if (!Number.isInteger(seasonNumber) || seasonNumber < 0) {
    return NextResponse.json({ error: "n must be a non-negative integer" }, { status: 400 });
  }

  let episodes: TmdbEpisode[];
  try {
    episodes = await getTVSeasonEpisodes(tmdbId, seasonNumber);
  } catch {
    return NextResponse.json({ error: "Failed to fetch season from TMDB" }, { status: 502 });
  }

  const provider = session.user.provider;
  let sources: string[];
  if (provider === "plex") sources = ["plex"];
  else if (provider === "jellyfin" || provider === "jellyfin-quickconnect") sources = ["jellyfin"];
  else sources = ["plex", "jellyfin"];

  const ownedRows = await prisma.tVEpisodeCache.findMany({
    where: { tmdbId, seasonNumber, source: { in: sources } },
    select: { episodeNumber: true, source: true },
  });

  if (ownedRows.length > 0 && episodes.length > 0) {
    const metaMap = new Map(episodes.map((e) => [e.episodeNumber, e]));
    Promise.all(
      ownedRows.map((row) => {
        const ep = metaMap.get(row.episodeNumber);
        if (!ep) return Promise.resolve();
        return prisma.tVEpisodeCache.update({
          where: {
            source_tmdbId_seasonNumber_episodeNumber: {
              source: row.source,
              tmdbId,
              seasonNumber,
              episodeNumber: row.episodeNumber,
            },
          },
          data: {
            episodeName: ep.name ?? null,
            airDate:     ep.airDate ?? null,
            stillPath:   ep.stillPath ?? null,
            runtime:     ep.runtime ?? null,
            overview:    ep.overview || null,
          },
        }).catch(() => {});
      })
    ).catch(() => {});
  }

  const ownedSet = new Set<number>();
  const sourcesPresent = new Set<string>();
  for (const row of ownedRows) {
    ownedSet.add(row.episodeNumber);
    sourcesPresent.add(row.source);
  }

  let source: TVSeasonResponse["source"] = null;
  if (sourcesPresent.has("plex") && sourcesPresent.has("jellyfin")) source = "both";
  else if (sourcesPresent.has("plex")) source = "plex";
  else if (sourcesPresent.has("jellyfin")) source = "jellyfin";

  return NextResponse.json({
    episodes,
    owned: Array.from(ownedSet).sort((a, b) => a - b),
    source,
  } satisfies TVSeasonResponse);
}
