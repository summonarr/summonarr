import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { getVisibleServerInstances, visibleEpisodeSourcesFor } from "@/lib/media-visibility";

export interface TVSeasonInfo {
  seasonNumber: number;
  episodes: number[];
}

export interface TVAvailabilityResponse {
  source: "plex" | "jellyfin" | "both" | null;
  seasons: TVSeasonInfo[];
}

export const GET = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`tv-availability:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const raw = req.nextUrl.searchParams.get("tmdbId");
  if (!raw) return NextResponse.json({ error: "tmdbId is required" }, { status: 400 });
  const tmdbId = parseInt(raw, 10);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }

  const provider = session.user.provider;

  let providerSources: string[];
  if (provider === "plex") {
    providerSources = ["plex"];
  } else if (provider === "jellyfin" || provider === "jellyfin-quickconnect") {
    providerSources = ["jellyfin"];
  } else {
    providerSources = ["plex", "jellyfin"];
  }

  // TVEpisodeCache has no serverInstance column, so `source` alone would report
  // a RESTRICTED server's per-episode holdings to an ungranted caller — and this
  // route returns them as raw JSON. Gate on whether the viewer can see any
  // server of that type actually holding the title. See media-visibility.ts.
  const visible = await getVisibleServerInstances(session);
  const sources = await visibleEpisodeSourcesFor(tmdbId, visible, providerSources);
  if (sources.length === 0) return NextResponse.json({ source: null, seasons: [] });

  const rows = await prisma.tVEpisodeCache.findMany({
    where: { tmdbId, source: { in: sources } },
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

  const sourcesPresent = new Set(rows.map((r) => r.source));
  let source: TVAvailabilityResponse["source"] = null;
  if (sourcesPresent.has("plex") && sourcesPresent.has("jellyfin")) source = "both";
  else if (sourcesPresent.has("plex")) source = "plex";
  else if (sourcesPresent.has("jellyfin")) source = "jellyfin";

  return NextResponse.json({ source, seasons } satisfies TVAvailabilityResponse);
});
