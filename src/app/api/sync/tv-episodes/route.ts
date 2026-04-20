import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getPlexTVEpisodes, getPlexLibrarySections } from "@/lib/plex";
import { getJellyfinTVEpisodes } from "@/lib/jellyfin";
import { isCronAuthorized, BATCH_TX_TIMEOUT, batchCreateMany } from "@/lib/cron-auth";

// 5-minute timeout: fetching episodes for large TV libraries can be slow
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [plexUrlRow, plexTokenRow, plexLibrariesRow, jellyfinUrlRow, jellyfinKeyRow, jellyfinLibrariesRow] =
    await Promise.all([
      prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
      prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
      prisma.setting.findUnique({ where: { key: "plexLibraries" } }),
      prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
      prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
      prisma.setting.findUnique({ where: { key: "jellyfinLibraries" } }),
    ]);

  const results = { plex: 0, jellyfin: 0, errors: [] as string[] };

  if (plexUrlRow?.value && plexTokenRow?.value) {
    const serverUrl = plexUrlRow.value.replace(/\/$/, "");
    const token = plexTokenRow.value;
    const selectedPlexKeys = plexLibrariesRow?.value
      ? new Set(plexLibrariesRow.value.split(",").map((k) => k.trim()).filter(Boolean))
      : undefined;

    try {
      const sections = await getPlexLibrarySections(serverUrl, token);
      const episodes = await getPlexTVEpisodes(serverUrl, token, selectedPlexKeys, sections);
      if (episodes.length > 0) {
        await prisma.$transaction(
          async (tx) => {
            await tx.tVEpisodeCache.deleteMany({ where: { source: "plex" } });
            await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source: "plex" as const, ...e })));
          },
          { timeout: BATCH_TX_TIMEOUT },
        );
      }
      results.plex = episodes.length;
      console.log(`[sync/tv-episodes] Plex: cached ${episodes.length} episodes`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[sync/tv-episodes] Plex episode sync failed:", msg);
      results.errors.push(`Plex: ${msg}`);
    }
  }

  if (jellyfinUrlRow?.value && jellyfinKeyRow?.value) {
    const baseUrl = jellyfinUrlRow.value.replace(/\/$/, "");
    const apiKey = jellyfinKeyRow.value;
    const selectedJellyfinIds = jellyfinLibrariesRow?.value
      ? new Set(jellyfinLibrariesRow.value.split(",").map((k) => k.trim()).filter(Boolean))
      : undefined;

    try {
      const episodes = await getJellyfinTVEpisodes(baseUrl, apiKey, selectedJellyfinIds);
      if (episodes.length > 0) {
        await prisma.$transaction(
          async (tx) => {
            await tx.tVEpisodeCache.deleteMany({ where: { source: "jellyfin" } });
            await batchCreateMany(
              tx.tVEpisodeCache,
              episodes.map((e) => ({ source: "jellyfin" as const, ...e })),
            );
          },
          { timeout: BATCH_TX_TIMEOUT },
        );
      }
      results.jellyfin = episodes.length;
      console.log(`[sync/tv-episodes] Jellyfin: cached ${episodes.length} episodes`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[sync/tv-episodes] Jellyfin episode sync failed:", msg);
      results.errors.push(`Jellyfin: ${msg}`);
    }
  }

  return NextResponse.json(results);
}
