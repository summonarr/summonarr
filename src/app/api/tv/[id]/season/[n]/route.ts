import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { getTVSeasonEpisodes } from "@/lib/tmdb";
import type { TmdbEpisode } from "@/lib/tmdb-types";
import { checkRateLimit } from "@/lib/rate-limit";
import { settleLimit } from "@/lib/concurrency";
import { getVisibleServerInstances, visibleEpisodeSourcesFor } from "@/lib/media-visibility";

export interface TVSeasonResponse {
  episodes: TmdbEpisode[];
  owned: number[];
  source: "plex" | "jellyfin" | "both" | null;
}

export const GET = withAuth(async (
  _req,
  { params }: { params: Promise<{ id: string; n: string }> },
  session
) => {
  if (!checkRateLimit(`tv-season:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
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
  let providerSources: string[];
  if (provider === "plex") providerSources = ["plex"];
  else if (provider === "jellyfin" || provider === "jellyfin-quickconnect") providerSources = ["jellyfin"];
  else providerSources = ["plex", "jellyfin"];

  // TVEpisodeCache has no serverInstance column, so `source` alone would report
  // a RESTRICTED server's per-episode holdings to an ungranted caller — as raw
  // JSON on this route. Gate on whether the viewer can see any server of that
  // type actually holding the title. See media-visibility.ts.
  const visible = await getVisibleServerInstances(session);
  const sources = await visibleEpisodeSourcesFor(tmdbId, visible, providerSources);

  const ownedRows = sources.length === 0 ? [] : await prisma.tVEpisodeCache.findMany({
    where: { tmdbId, seasonNumber, source: { in: sources } },
    select: {
      episodeNumber: true,
      source: true,
      episodeName: true,
      airDate: true,
      stillPath: true,
      runtime: true,
      overview: true,
    },
  });

  // Fire-and-forget cache warm: backfill owned episodes' cached metadata from the
  // fresh TMDB fetch. Unawaited by design — it's not part of the response, and a
  // failed update self-heals on the next fetch. Errors swallowed intentionally.
  // Bounded (guardrail 31): `ownedRows` scales with season size × visible sources,
  // and rows whose cached metadata already matches are skipped, so a warm cache
  // issues zero writes.
  if (ownedRows.length > 0 && episodes.length > 0) {
    const metaMap = new Map(episodes.map((e) => [e.episodeNumber, e]));
    void settleLimit(ownedRows, 5, async (row) => {
      const ep = metaMap.get(row.episodeNumber);
      if (!ep) return;
      const next = {
        episodeName: ep.name ?? null,
        airDate:     ep.airDate ?? null,
        stillPath:   ep.stillPath ?? null,
        runtime:     ep.runtime ?? null,
        overview:    ep.overview || null,
      };
      if (
        row.episodeName === next.episodeName
        && row.airDate === next.airDate
        && row.stillPath === next.stillPath
        && row.runtime === next.runtime
        && row.overview === next.overview
      ) return;
      await prisma.tVEpisodeCache.update({
        where: {
          source_tmdbId_seasonNumber_episodeNumber: {
            source: row.source,
            tmdbId,
            seasonNumber,
            episodeNumber: row.episodeNumber,
          },
        },
        data: next,
      }).catch(() => {});
    });
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
});
