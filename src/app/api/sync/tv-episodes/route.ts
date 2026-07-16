import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getPlexTVEpisodes, getPlexLibrarySections } from "@/lib/plex";
import { getPlexConfig } from "@/lib/plex-config";
import { getJellyfinTVEpisodes } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
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
  const [plexConfig, jellyfinConfig, plexLibrariesRow, jellyfinLibrariesRow] =
    await Promise.all([
      getPlexConfig(),
      getJellyfinConfig(),
      prisma.setting.findUnique({ where: { key: "plexLibraries" } }),
      prisma.setting.findUnique({ where: { key: "jellyfinLibraries" } }),
    ]);

  const results = { plex: 0, jellyfin: 0, errors: [] as string[] };

  if (plexConfig.url && plexConfig.token) {
    const serverUrl = plexConfig.url.replace(/\/$/, "");
    const token = plexConfig.token;
    const selectedPlexKeys = plexLibrariesRow?.value
      ? new Set(plexLibrariesRow.value.split(",").map((k) => k.trim()).filter(Boolean))
      : undefined;

    try {
      const sections = await getPlexLibrarySections(serverUrl, token);
      const episodes = await getPlexTVEpisodes(serverUrl, token, selectedPlexKeys, sections);
      // Full replace: clear unconditionally then insert. getPlexTVEpisodes THROWS on a
      // fetch failure (caught below → no clear), so an empty result here is a genuinely
      // empty library and the stale episode ownership must be cleared rather than left.
      await prisma.$transaction(
        async (tx) => {
          // Advisory lock 2002,1 serializes every wholesale Plex TVEpisodeCache rewrite — the
          // orchestrator, this cron, the admin "Resync Plex" path, and sync/plex's recentOnly
          // delete all share it. Without it, two concurrent runs can interleave delete/insert
          // phases and leave the cache temporarily empty or with duplicate rows.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 1)`;
          await tx.tVEpisodeCache.deleteMany({ where: { source: "plex" } });
          if (episodes.length > 0) {
            await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source: "plex" as const, ...e })));
          }
        },
        { timeout: BATCH_TX_TIMEOUT },
      );
      results.plex = episodes.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[sync/tv-episodes] Plex episode sync failed:", msg);
      results.errors.push(`Plex: ${msg}`);
    }
  }

  if (jellyfinConfig.url && jellyfinConfig.apiKey) {
    const baseUrl = jellyfinConfig.url.replace(/\/$/, "");
    const apiKey = jellyfinConfig.apiKey;
    const selectedJellyfinIds = jellyfinLibrariesRow?.value
      ? new Set(jellyfinLibrariesRow.value.split(",").map((k) => k.trim()).filter(Boolean))
      : undefined;

    try {
      const episodes = await getJellyfinTVEpisodes(baseUrl, apiKey, selectedJellyfinIds);
      // Full replace: clear unconditionally then insert (see the Plex block above).
      // getJellyfinTVEpisodes throws on a fetch failure (caught below → no clear), so an
      // empty result is a genuinely empty library and stale ownership must be cleared.
      await prisma.$transaction(
        async (tx) => {
          // Advisory lock 2002,2 — Jellyfin counterpart to the Plex lock above.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 2)`;
          await tx.tVEpisodeCache.deleteMany({ where: { source: "jellyfin" } });
          if (episodes.length > 0) {
            await batchCreateMany(
              tx.tVEpisodeCache,
              episodes.map((e) => ({ source: "jellyfin" as const, ...e })),
            );
          }
        },
        { timeout: BATCH_TX_TIMEOUT },
      );
      results.jellyfin = episodes.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[sync/tv-episodes] Jellyfin episode sync failed:", msg);
      results.errors.push(`Jellyfin: ${msg}`);
    }
  }

  return NextResponse.json(results);
}
