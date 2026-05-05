import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isCronAuthorized, recordCronRun } from "@/lib/cron-auth";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import {
  getJellyfinUserPlayHistory,
  getJellyfinPlaybackReporting,
  getJellyfinEpisodeSeriesIds,
  getJellyfinAllUsers,
} from "@/lib/jellyfin";
import { resolveShowTmdbId, resolveMediaServerUser, clearActivityCache } from "@/lib/play-history";
import { emitSSE } from "@/lib/sse-emitter";
import type { MediaType } from "@/generated/prisma";

export const dynamic = "force-dynamic";

// Resolve TMDB ID for a movie item using provider IDs or library lookup.
async function resolveTmdbForMovie(itemId: string, providerIds?: Record<string, string>): Promise<{ tmdbId: number | null; mediaType: MediaType | null }> {
  const tmdbRaw = providerIds?.Tmdb ?? providerIds?.tmdb;
  const parsed = tmdbRaw ? parseInt(tmdbRaw, 10) : NaN;
  if (Number.isFinite(parsed)) return { tmdbId: parsed, mediaType: "MOVIE" };

  const lib = await prisma.jellyfinLibraryItem.findFirst({
    where: { jellyfinItemId: itemId, mediaType: "MOVIE" },
    select: { tmdbId: true, mediaType: true },
  });
  return { tmdbId: lib?.tmdbId ?? null, mediaType: (lib?.mediaType as MediaType) ?? null };
}

// ── PlaybackReporting plugin path ────────────────────────────────────────────
// Requires the Jellyfin PlaybackReporting plugin. Returns every individual
// play session with accurate play durations. When the plugin is absent the
// function returns null and we fall through to the IsPlayed path.
async function importFromPlaybackReporting(
  baseUrl: string,
  apiKey: string,
  userMap: Map<string, string>,  // jellyfin userId → mediaServerUser.id
  lastSyncDate?: string,
): Promise<{ imported: number; errors: number } | null> {
  const rows = await getJellyfinPlaybackReporting(baseUrl, apiKey, lastSyncDate);
  if (!rows) return null; // plugin absent

  // Batch-resolve seriesId for all episode itemIds in one round-trip set.
  const episodeItemIds = [...new Set(rows.filter((r) => r.itemType === "Episode").map((r) => r.itemId))];
  const seriesInfoMap = episodeItemIds.length > 0
    ? await getJellyfinEpisodeSeriesIds(baseUrl, apiKey, episodeItemIds)
    : new Map();

  // Cache TMDB lookups: seriesId → tmdbId, movieItemId → tmdbId
  const tmdbCache = new Map<string, number | null>();
  const resolveSeries = async (seriesId: string) => {
    if (!tmdbCache.has(seriesId)) {
      tmdbCache.set(seriesId, await resolveShowTmdbId("jellyfin", seriesId));
    }
    return tmdbCache.get(seriesId) ?? null;
  };
  const resolveMovieItem = async (itemId: string) => {
    const key = `movie:${itemId}`;
    if (!tmdbCache.has(key)) {
      const { tmdbId } = await resolveTmdbForMovie(itemId);
      tmdbCache.set(key, tmdbId);
    }
    return tmdbCache.get(key) ?? null;
  };

  let imported = 0;
  let errors = 0;

  for (const row of rows) {
    const msUserId = userMap.get(row.userId);
    if (!msUserId) continue;

    try {
      let tmdbId: number | null = null;
      let mediaType: MediaType | null = null;
      let title = row.itemName;
      let seasonNumber: number | null = null;
      let episodeNumber: number | null = null;
      let episodeTitle: string | null = null;
      let year: string | null = null;

      if (row.itemType === "Episode") {
        mediaType = "TV";
        const info = seriesInfoMap.get(row.itemId);
        if (info?.seriesId) {
          tmdbId = await resolveSeries(info.seriesId);
          title = info.seriesName ?? row.itemName;
          seasonNumber = info.seasonNumber ?? null;
          episodeNumber = info.episodeNumber ?? null;
          episodeTitle = info.episodeName ?? null;
          year = info.year != null ? String(info.year) : null;
        }
      } else if (row.itemType === "Movie") {
        mediaType = "MOVIE";
        tmdbId = await resolveMovieItem(row.itemId);
      } else {
        continue; // skip non-video types (music, etc.)
      }

      const playedAt = new Date(row.date);
      const playDurationS = Math.max(0, Math.floor(row.playDuration));
      const stoppedAt = new Date(playedAt.getTime() + playDurationS * 1000);

      // Unique key: one row per session (date+user+item combination)
      const sourceSessionId = `jf-pr:${row.userId}:${row.itemId}:${row.date}`;

      await prisma.playHistory.upsert({
        where: { source_sourceSessionId: { source: "jellyfin", sourceSessionId } },
        create: {
          source: "jellyfin",
          startedAt: playedAt,
          stoppedAt,
          duration: playDurationS,
          playDuration: playDurationS,
          pausedDuration: 0,
          watched: playDurationS >= 90,
          completed: false, // can't compute without total duration from reporting API
          mediaServerUserId: msUserId,
          tmdbId,
          mediaType,
          title,
          year,
          seasonNumber,
          episodeNumber,
          episodeTitle,
          sourceSessionId,
          sourceItemId: row.itemId,
          playMethod: row.playbackMethod || null,
          player: row.clientName || null,
          device: row.deviceName || null,
        },
        update: {},
      });
      imported++;
    } catch (err) {
      console.warn(`[jf-history/pr] item ${row.itemId}:`, err instanceof Error ? err.message : String(err));
      errors++;
    }
  }

  return { imported, errors };
}

// ── IsPlayed fallback path ───────────────────────────────────────────────────
// Always available. Uses Jellyfin's per-user "IsPlayed" item list.
// Only records the most recent play of each item — no per-session granularity.
async function importFromIsPlayed(
  baseUrl: string,
  apiKey: string,
  users: Array<{ id: string; sourceUserId: string; username: string }>,
): Promise<{ imported: number; errors: number }> {
  let imported = 0;
  let errors = 0;

  for (const user of users) {
    try {
      await getJellyfinUserPlayHistory(baseUrl, apiKey, user.sourceUserId, async (items) => {
        for (const item of items) {
          try {
            const datePlayed = item.datePlayed ? new Date(item.datePlayed) : null;
            if (!datePlayed) continue;

            let tmdbId: number | null = null;
            let mediaType: MediaType | null = item.itemType === "Episode" ? "TV"
              : item.itemType === "Movie" ? "MOVIE"
              : null;

            if (!mediaType) continue;

            if (item.itemType === "Episode" && item.seriesId) {
              tmdbId = await resolveShowTmdbId("jellyfin", item.seriesId);
            } else if (item.itemType !== "Episode") {
              const resolved = await resolveTmdbForMovie(item.itemId, item.providerIds);
              tmdbId = resolved.tmdbId;
              mediaType = resolved.mediaType ?? mediaType;
            }

            const durationS = item.durationTicks
              ? Math.max(0, Math.floor(item.durationTicks / 10_000_000))
              : 0;
            const stoppedAt = new Date(datePlayed.getTime() + durationS * 1000);

            const title = item.itemType === "Episode"
              ? (item.seriesName ?? item.title.split(" — ")[0] ?? item.title)
              : item.title;
            const episodeTitle = item.itemType === "Episode" && item.title.includes(" — ")
              ? item.title.split(" — ")[1] ?? null
              : null;

            // One entry per user+item — idempotent, latest play date wins.
            const sourceSessionId = `jf-hist:${user.sourceUserId}:${item.itemId}`;

            await prisma.playHistory.upsert({
              where: { source_sourceSessionId: { source: "jellyfin", sourceSessionId } },
              create: {
                source: "jellyfin",
                startedAt: datePlayed,
                stoppedAt,
                duration: durationS,
                playDuration: durationS,
                pausedDuration: 0,
                watched: true, // Jellyfin marked it played
                completed: true,
                mediaServerUserId: user.id,
                tmdbId,
                mediaType,
                title,
                year: item.year != null ? String(item.year) : null,
                seasonNumber: item.seasonNumber ?? null,
                episodeNumber: item.episodeNumber ?? null,
                episodeTitle,
                sourceSessionId,
                sourceItemId: item.itemId,
              },
              update: {},
            });
            imported++;
          } catch (itemErr) {
            console.warn(`[jf-history/played] item ${item.itemId}:`, itemErr instanceof Error ? itemErr.message : String(itemErr));
            errors++;
          }
        }
      });
    } catch (userErr) {
      console.warn(`[jf-history/played] user ${user.username}:`, userErr instanceof Error ? userErr.message : String(userErr));
      errors++;
    }
  }

  return { imported, errors };
}

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return withAdvisoryLock(
    2011,
    async () => {
      const startTime = Date.now();

      const [urlRow, keyRow] = await Promise.all([
        prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
        prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
      ]);

      if (!urlRow?.value || !keyRow?.value) {
        return NextResponse.json({ skipped: true, reason: "Jellyfin not configured" });
      }

      const baseUrl = urlRow.value.replace(/\/$/, "");
      const apiKey = keyRow.value;

      // Always fetch the server user list so new Jellyfin users are discovered every run.
      // resolveMediaServerUser is idempotent — existing users get a no-op upsert.
      const serverUsers = await getJellyfinAllUsers(baseUrl, apiKey).catch(() => [] as Awaited<ReturnType<typeof getJellyfinAllUsers>>);
      for (const u of serverUsers) {
        await resolveMediaServerUser({
          source: "jellyfin",
          sourceUserId: u.id,
          username: u.name,
          email: u.email,
        }).catch(() => null);
      }

      const jellyfinUsers = await prisma.mediaServerUser.findMany({
        where: { source: "jellyfin" },
        select: { id: true, sourceUserId: true, username: true },
      });

      if (jellyfinUsers.length === 0) {
        return NextResponse.json({
          skipped: true,
          reason: "No Jellyfin users — watch something first or check jellyfinApiKey",
        });
      }

      // Build userId → mediaServerUser.id map for the PlaybackReporting path.
      const userMap = new Map(jellyfinUsers.map((u) => [u.sourceUserId, u.id]));

      // Try PlaybackReporting plugin first (richer: one row per session with play duration).
      // Falls back to IsPlayed (one row per item, last play only) when plugin is absent.
      const lastSyncSetting = await prisma.setting.findUnique({
        where: { key: "jellyfinHistoryLastSync" },
      });
      const lastSyncDate = lastSyncSetting?.value ?? undefined;

      let method: "playback-reporting" | "is-played";
      let imported: number;
      let errors: number;

      const prResult = await importFromPlaybackReporting(baseUrl, apiKey, userMap, lastSyncDate);

      if (prResult) {
        method = "playback-reporting";
        imported = prResult.imported;
        errors = prResult.errors;
      } else {
        method = "is-played";
        const isPlayedResult = await importFromIsPlayed(baseUrl, apiKey, jellyfinUsers);
        imported = isPlayedResult.imported;
        errors = isPlayedResult.errors;
      }

      // Only stamp on the PlaybackReporting path — it uses the timestamp as an incremental lower bound.
      // Stamping on the IsPlayed path would advance the window without any PlaybackReporting data
      // having been fetched, causing the next PlaybackReporting run to miss sessions from that gap.
      if (method === "playback-reporting") {
        const now = new Date().toISOString();
        await prisma.setting.upsert({
          where: { key: "jellyfinHistoryLastSync" },
          create: { key: "jellyfinHistoryLastSync", value: now },
          update: { value: now },
        });
      }

      const durationMs = Date.now() - startTime;

      if (imported > 0) {
        clearActivityCache();
        emitSSE({ type: "activity:history-updated" });
      }

      await recordCronRun("jellyfin-history", durationMs);

      return NextResponse.json({ method, imported, errors, users: jellyfinUsers.length, durationMs });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
