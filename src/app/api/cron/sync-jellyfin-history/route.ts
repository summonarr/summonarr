import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import {
  getJellyfinUserPlayHistory,
  getJellyfinPlaybackReporting,
  getJellyfinEpisodeSeriesIds,
  getJellyfinItemRuntimes,
  getJellyfinAllUsers,
} from "@/lib/jellyfin";
import {
  resolveShowTmdbId,
  resolveMediaServerUser,
  clearActivityCache,
  calculateWatched,
  getWatchedThreshold,
  MediaServerMismatchError,
} from "@/lib/play-history";
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

  // Pick any Jellyfin userId to scope the /Users/{userId}/Items lookups. The
  // bare /Items endpoint returns empty on several Jellyfin server versions
  // even with an admin token — when the runtime/series-info maps came back
  // empty, durationMs was 0 and every PlaybackReporting-imported row was
  // written with watched=false regardless of actual playback. Any user the
  // admin token can read works; we just need a valid id in the URL.
  const lookupUserId = userMap.keys().next().value ?? "";

  // One-time-ish backfill: rows imported before the /Users/{userId}/Items fix
  // sit in the DB with duration=0 and watched=false. The PR cron only fetches
  // *new* play activity (since jellyfinHistoryLastSync), so the upsert below
  // would never revisit those old rows on its own. Collect their itemIds and
  // include them in the runtime lookup batch; after the lookup, update each
  // broken row in place. Cheap when there's nothing to fix (one COUNT-style
  // query returns []) so it can stay in the steady-state cron path.
  const brokenRows = lookupUserId
    ? await prisma.playHistory.findMany({
        where: {
          source: "jellyfin",
          duration: 0,
          sourceSessionId: { startsWith: "jf-pr:" },
          sourceItemId: { not: null },
        },
        select: { id: true, sourceItemId: true, playDuration: true },
      }).catch(() => [])
    : [];

  // Batch-resolve seriesId for all episode itemIds in one round-trip set.
  const episodeItemIds = [...new Set(rows.filter((r) => r.itemType === "Episode").map((r) => r.itemId))];
  const seriesInfoMap = episodeItemIds.length > 0 && lookupUserId
    ? await getJellyfinEpisodeSeriesIds(baseUrl, apiKey, lookupUserId, episodeItemIds)
    : new Map();

  // Batch-fetch RunTimeTicks for every distinct item. PlaybackReporting only reports
  // PlayDuration (time spent playing); without the item's runtime we can't compute the
  // completion ratio. Before this fetch we wrote duration = playDuration on every row,
  // which made every imported play look like a 100% completion.
  // Merge the new-import itemIds with the broken-row itemIds so the runtime
  // lookup is a single round-trip set rather than two passes.
  const newItemIds = rows.map((r) => r.itemId);
  const brokenItemIds = brokenRows.map((r) => r.sourceItemId!).filter((v): v is string => !!v);
  const allItemIds = [...new Set([...newItemIds, ...brokenItemIds])];
  const runtimeMap = allItemIds.length > 0 && lookupUserId
    ? await getJellyfinItemRuntimes(baseUrl, apiKey, lookupUserId, allItemIds)
    : new Map<string, number>();
  const watchedThreshold = await getWatchedThreshold();

  // Apply the backfill before walking the new-import rows. We only update when
  // a real runtime came back — items the server genuinely has no RunTimeTicks
  // for (live TV, unidentified) stay at duration=0/watched=false honestly,
  // they aren't actually broken.
  let backfilled = 0;
  for (const broken of brokenRows) {
    if (!broken.sourceItemId) continue;
    const durationMs = runtimeMap.get(broken.sourceItemId);
    if (!durationMs || durationMs <= 0) continue;
    const durationS = Math.floor(durationMs / 1000);
    const playDurationMs = broken.playDuration * 1000;
    const watched = calculateWatched(playDurationMs, durationMs, watchedThreshold);
    const completed = playDurationMs / durationMs >= 0.95;
    await prisma.playHistory.update({
      where: { id: broken.id },
      data: { duration: durationS, watched, completed },
    }).catch(() => {});
    backfilled++;
  }
  if (backfilled > 0) {
    console.warn(`[jf-history/pr] backfilled watched/duration on ${backfilled} previously broken PR row(s)`);
  }

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

      // Use the real runtime where Jellyfin gave us one; otherwise 0 means "unknown"
      // and the row is honestly not credited toward completion stats.
      const durationMs = runtimeMap.get(row.itemId) ?? 0;
      const durationS = Math.floor(durationMs / 1000);
      const playDurationMs = playDurationS * 1000;
      const watched = calculateWatched(playDurationMs, durationMs, watchedThreshold);
      // 0.95 matches recordCompletedSession's per-arc completed boundary.
      const completed = durationMs > 0 && playDurationMs / durationMs >= 0.95;

      // Unique key: one row per session (date+user+item combination)
      const sourceSessionId = `jf-pr:${row.userId}:${row.itemId}:${row.date}`;

      await prisma.playHistory.upsert({
        where: { source_sourceSessionId: { source: "jellyfin", sourceSessionId } },
        create: {
          source: "jellyfin",
          startedAt: playedAt,
          stoppedAt,
          duration: durationS,
          playDuration: playDurationS,
          pausedDuration: 0,
          watched,
          completed,
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
        // Self-heal rows that were imported before the /Users/{userId}/Items
        // fix: when an earlier run wrote duration=0 (because the bare /Items
        // lookup returned empty on this Jellyfin version), the watched flag
        // was forced to false regardless of actual playback. Re-derive both
        // when we now have a real runtime; leave the row untouched if we
        // still can't resolve one (legit zero-runtime items like live TV
        // would otherwise get clobbered).
        update: durationS > 0
          ? { duration: durationS, watched, completed }
          : {},
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

  return withCronRunRecording("jellyfin-history", () => withAdvisoryLock(
    2011,
    async () => {
      const startTime = Date.now();

      const [urlRow, keyRow, machineIdRow] = await Promise.all([
        prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
        prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
        prisma.setting.findUnique({ where: { key: "jellyfinServerMachineId" } }),
      ]);

      if (!urlRow?.value || !keyRow?.value) {
        return NextResponse.json({ skipped: true, reason: "Jellyfin not configured" });
      }

      const baseUrl = urlRow.value.replace(/\/$/, "");
      const apiKey = keyRow.value;
      const serverMachineId = machineIdRow?.value ?? null;
      if (!serverMachineId) {
        console.warn("[cron/sync-jellyfin-history] jellyfinServerMachineId not configured — pin will not be set");
      }

      // Always fetch the server user list so new Jellyfin users are discovered every run.
      // resolveMediaServerUser is idempotent — existing users get a no-op upsert.
      // Only swallow generic upsert failures; surface MediaServerMismatchError so the
      // H-3 defense-in-depth check (refuses an incoming Jellyfin machineId that
      // doesn't match the pinned one on the row) is actually visible in logs
      // instead of being silently dropped.
      const serverUsers = await getJellyfinAllUsers(baseUrl, apiKey).catch(() => [] as Awaited<ReturnType<typeof getJellyfinAllUsers>>);
      for (const u of serverUsers) {
        try {
          await resolveMediaServerUser({
            source: "jellyfin",
            sourceUserId: u.id,
            username: u.name,
            email: u.email,
            ...(serverMachineId ? { serverMachineId } : {}),
          });
        } catch (err) {
          if (err instanceof MediaServerMismatchError) {
            console.error(
              `[cron/sync-jellyfin-history] machineId mismatch refusing upsert for jellyfin user ${u.id} — investigate which server is delivering the webhook/sync`,
              err,
            );
          }
          // Other errors are best-effort — next sync run retries.
        }
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

      // Non-2xx on error so withCronRunRecording marks ok=false.
      const status = errors > 0 ? 500 : 200;
      return NextResponse.json({ method, imported, errors, users: jellyfinUsers.length, durationMs }, { status });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  ));
}
