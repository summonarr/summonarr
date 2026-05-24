import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getPlexTVEpisodes, getPlexLibrarySections } from "@/lib/plex";
import { getJellyfinTVEpisodes } from "@/lib/jellyfin";
import { isCronAuthorized, BATCH_TX_TIMEOUT, batchCreateMany, withCronRunRecording } from "@/lib/cron-auth";

// 5-minute timeout: fetching episodes for large TV libraries can be slow
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return withCronRunRecording("tv-episodes-sync", () => syncTvEpisodes());
}

async function syncTvEpisodes() {
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
            // Advisory lock 2002,1 serializes every wholesale Plex TVEpisodeCache rewrite — the
            // orchestrator, this cron, the admin "Resync Plex" path, and sync/plex's recentOnly
            // delete all share it. Without it, two concurrent runs can interleave delete/insert
            // phases and leave the cache temporarily empty or with duplicate rows.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 1)`;
            await tx.tVEpisodeCache.deleteMany({ where: { source: "plex" } });
            await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source: "plex" as const, ...e })));
          },
          { timeout: BATCH_TX_TIMEOUT },
        );
      }
      results.plex = episodes.length;
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
            // Advisory lock 2002,2 — Jellyfin counterpart to the Plex lock above.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 2)`;
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[sync/tv-episodes] Jellyfin episode sync failed:", msg);
      results.errors.push(`Jellyfin: ${msg}`);
    }
  }

  return NextResponse.json(results);
}
