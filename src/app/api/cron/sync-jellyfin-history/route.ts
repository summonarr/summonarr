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
  getJellyfinServerMachineId,
} from "@/lib/jellyfin";
import {
  resolveShowTmdbId,
  resolveMediaServerUser,
  clearActivityCache,
  calculateWatched,
  getWatchedThreshold,
  isPlayHistoryEnabled,
  isSourceEnabled,
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

// ── Live-vs-cron dedup ───────────────────────────────────────────────────────
// The 5s live poller (src/app/api/sync/play-history) is the canonical, metadata-
// rich writer for Jellyfin completed sessions — it captures codec/transcode/
// resolution/device/IP that PlaybackReporting and IsPlayed don't. This cron is a
// *backfill* that must only insert plays the live poller never saw (server
// downtime, history that predates install). Without this guard the same watch
// lands twice: once live (`sessionKey:startedAt`) and once here (`jf-pr:`/
// `jf-hist:`), inflating play counts and watch hours on admin/activity.
//
// Margin absorbs the gap between when the poller first *saw* the session
// (ActiveSession.startedAt ≈ first-poll observation) and PlaybackReporting's
// recorded start, plus clock skew between Summonarr and the Jellyfin host.
const LIVE_DEDUP_MARGIN_MS = 10 * 60 * 1000;

type LiveInterval = { startMs: number; endMs: number };

// Load live-origin (non-cron) Jellyfin PlayHistory intervals, keyed
// `${mediaServerUserId}:${sourceItemId}`. Cron-written rows (jf-pr:/jf-hist:)
// are excluded so a prior backfill can't suppress a later one.
async function loadLiveJellyfinIntervals(
  msUserIds: string[],
  itemIds: string[] | null,
): Promise<Map<string, LiveInterval[]>> {
  const map = new Map<string, LiveInterval[]>();
  if (msUserIds.length === 0) return map;
  const rows = await prisma.playHistory.findMany({
    where: {
      source: "jellyfin",
      mediaServerUserId: { in: msUserIds },
      ...(itemIds && itemIds.length > 0
        ? { sourceItemId: { in: itemIds } }
        : { sourceItemId: { not: null } }),
      NOT: [
        { sourceSessionId: { startsWith: "jf-pr:" } },
        { sourceSessionId: { startsWith: "jf-hist:" } },
      ],
    },
    select: { mediaServerUserId: true, sourceItemId: true, startedAt: true, stoppedAt: true },
  }).catch(() => [] as { mediaServerUserId: string; sourceItemId: string | null; startedAt: Date; stoppedAt: Date }[]);
  for (const r of rows) {
    if (!r.sourceItemId) continue;
    const key = `${r.mediaServerUserId}:${r.sourceItemId}`;
    const arr = map.get(key) ?? [];
    arr.push({ startMs: r.startedAt.getTime(), endMs: r.stoppedAt.getTime() });
    map.set(key, arr);
  }
  return map;
}

// True when a live row's [start, end] window overlaps the imported play's
// [start, end] window once both are widened by LIVE_DEDUP_MARGIN_MS.
function liveCovers(
  intervals: LiveInterval[] | undefined,
  playStartMs: number,
  playEndMs: number,
): boolean {
  if (!intervals) return false;
  return intervals.some(
    (iv) =>
      iv.startMs <= playEndMs + LIVE_DEDUP_MARGIN_MS &&
      iv.endMs >= playStartMs - LIVE_DEDUP_MARGIN_MS,
  );
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
): Promise<{ imported: number; errors: number; deduped: number } | null> {
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

  // Prefetch live-captured rows for the (user, item) pairs in this import batch
  // so we can skip any play the canonical live poller already recorded.
  const importMsUserIds = [...new Set(rows.map((r) => userMap.get(r.userId)).filter((v): v is string => !!v))];
  const importItemIds = [...new Set(rows.map((r) => r.itemId).filter((v): v is string => !!v))];
  const liveIntervals = await loadLiveJellyfinIntervals(importMsUserIds, importItemIds);

  let imported = 0;
  let errors = 0;
  let deduped = 0;

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

      // Skip plays the canonical live poller already captured (richer metadata).
      // This cron only backfills sessions the poller never saw.
      if (liveCovers(liveIntervals.get(`${msUserId}:${row.itemId}`), playedAt.getTime(), stoppedAt.getTime())) {
        deduped++;
        continue;
      }

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

  return { imported, errors, deduped };
}

// ── IsPlayed fallback path ───────────────────────────────────────────────────
// Always available. Uses Jellyfin's per-user "IsPlayed" item list.
// Only records the most recent play of each item — no per-session granularity.
async function importFromIsPlayed(
  baseUrl: string,
  apiKey: string,
  users: Array<{ id: string; sourceUserId: string; username: string }>,
): Promise<{ imported: number; errors: number; deduped: number }> {
  let imported = 0;
  let errors = 0;
  let deduped = 0;

  // Prefetch live-captured rows for these users so the coarse IsPlayed backfill
  // (one row per item, last play only) doesn't duplicate a watch the live poller
  // already recorded with full metadata. itemIds are unknown until we stream the
  // pages, so this is keyed on user only and filtered per-item in the loop.
  const liveIntervals = await loadLiveJellyfinIntervals(users.map((u) => u.id), null);

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

            // Skip if the live poller already captured this watch. datePlayed is
            // Jellyfin's LastPlayedDate (≈ the end of the play); treat the play
            // window as [datePlayed - runtime, datePlayed].
            if (liveCovers(liveIntervals.get(`${user.id}:${item.itemId}`), datePlayed.getTime() - durationS * 1000, datePlayed.getTime())) {
              deduped++;
              continue;
            }

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

  return { imported, errors, deduped };
}

// DISABLED — pending removal.
//
// The live 5s poller (/api/sync/play-history) is now the canonical writer for
// Jellyfin play history and captures every watch while the app is up, with full
// metadata. This backfill cron only ever added value for plays the poller can't
// see — pre-install history and watches during downtime — which we've decided we
// no longer need. The route is gated off here rather than deleted so the
// PlaybackReporting / IsPlayed import paths and the liveCovers() dedup guard
// stay available if we change our minds before removing them outright. See
// CLAUDE.md guardrail 19.
const BACKFILL_DISABLED = true;

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (BACKFILL_DISABLED) {
    return NextResponse.json({
      skipped: true,
      reason: "Jellyfin history backfill disabled (pending removal) — live poller is canonical",
    });
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

      // Respect the admin play-history toggles. The live poller already gates on
      // these in /api/sync/play-history; without the same check here, turning
      // Jellyfin (or all) play history off in settings wouldn't stop this cron
      // from importing — the toggle would be a half-measure.
      if (!(await isPlayHistoryEnabled()) || !(await isSourceEnabled("jellyfin"))) {
        return NextResponse.json({ skipped: true, reason: "Jellyfin play history disabled" });
      }

      const baseUrl = urlRow.value.replace(/\/$/, "");
      const apiKey = keyRow.value;
      // Self-bootstrap the machineId pin. The H-3 defense-in-depth check on
      // MediaServerUser.serverMachineId only activates once a value is present
      // — without one, an attacker with a leaked Jellyfin webhook secret could
      // spoof user payloads from a different Jellyfin instance. Lazy-fetch from
      // /System/Info on first run and persist; subsequent runs short-circuit
      // with the cached Setting value.
      let serverMachineId = machineIdRow?.value ?? null;
      if (!serverMachineId) {
        serverMachineId = await getJellyfinServerMachineId(baseUrl, apiKey);
        if (serverMachineId) {
          await prisma.setting.upsert({
            where: { key: "jellyfinServerMachineId" },
            create: { key: "jellyfinServerMachineId", value: serverMachineId },
            update: { value: serverMachineId },
          });
        } else {
          console.warn("[cron/sync-jellyfin-history] /System/Info returned no Id — pin will not be set this run");
        }
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
      let deduped: number;

      const prResult = await importFromPlaybackReporting(baseUrl, apiKey, userMap, lastSyncDate);

      if (prResult) {
        method = "playback-reporting";
        imported = prResult.imported;
        errors = prResult.errors;
        deduped = prResult.deduped;
      } else {
        method = "is-played";
        const isPlayedResult = await importFromIsPlayed(baseUrl, apiKey, jellyfinUsers);
        imported = isPlayedResult.imported;
        errors = isPlayedResult.errors;
        deduped = isPlayedResult.deduped;
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
      return NextResponse.json({ method, imported, deduped, errors, users: jellyfinUsers.length, durationMs }, { status });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  ));
}
