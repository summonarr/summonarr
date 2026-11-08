import { NextRequest, NextResponse } from "next/server";
import { readJsonCappedOr } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { buildSeriesItemIdIndex, getJellyfinTmdbIds, getJellyfinTVEpisodes, getJellyfinEpisodesForShow } from "@/lib/jellyfin";
import { mapLimit } from "@/lib/concurrency";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { jellyfinLibraryRow } from "@/lib/library-rows";
import { type MediaInstanceKey, DEFAULT_MEDIA_INSTANCE, jellyfinSettingKey } from "@/lib/media-instances";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { logAudit } from "@/lib/audit";
import { getCronActor, type CronActor } from "@/lib/cron-auth";
import { cronSkippedResponse, withCronRunRecording } from "@/lib/cron-history";
import { BATCH_TX_TIMEOUT, batchCreateMany } from "@/lib/batch-write";
import { mergeRecentEpisodesForSource, replaceEpisodeCacheForSource } from "@/lib/episode-cache";
import { lockLibraryInTx, replaceJellyfinLibraryForInstances, type JellyfinLibraryRow } from "@/lib/library-staging";
import { markResyncedLibrary } from "@/lib/available-marking";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { JELLYFIN_RESYNC_LOCK_ID } from "@/lib/advisory-lock";
import { libraryJobResponse, startLibraryJob, wantsBackgroundRun } from "@/lib/library-sync-jobs";
import {
  RECENT_WINDOW_MS,
  noteEpisodeCacheOwner,
  ownsEpisodeCache,
  parseLibrarySelection,
  resyncJobKey,
  resyncTarget,
  reidentifiedJellyfinRows,
  resyncWindDownResponse,
  runResyncHoldingLock,
  stampLibrarySyncSuccess,
  type HoldLock,
} from "@/lib/library-resync";

// recentOnly episode refresh: at or below this many windowed series, fetch each
// series' episodes directly (ParentId-scoped) instead of page-walking EVERY
// episode in the library to client-filter down to 1-2 shows. Above it (a bulk
// import) the single full walk is the cheaper shape again.
const PER_SERIES_EPISODE_REFRESH_MAX = 50;

export async function POST(request: NextRequest) {
  const t = translatorForRequest(request);
  const actor = await getCronActor(request);
  if (!actor) {
    return NextResponse.json({ error: t("apiAdmin.common.forbidden") }, { status: 403 });
  }

  // Read here, before the run: the background flag is decided by it.
  const rawBody = await readJsonCappedOr<Record<string, unknown>>(request, 8192, {});
  if (rawBody instanceof NextResponse) return rawBody;

  // Single-flight: a second resync (two admin clicks, a cron call) skips instead
  // of walking the whole Jellyfin library again beside the first — including
  // while this one's episode-cache refresh is still running (see the Plex twin).
  const run = () => withCronRunRecording("jellyfin-sync", () => runResyncHoldingLock(
    JELLYFIN_RESYNC_LOCK_ID,
    (signal, hold) => syncJellyfin(request, rawBody, actor, signal, hold),
    // X-Cron-Skipped keeps a busy answer out of the ledger (no run happened).
    () => cronSkippedResponse("jellyfin sync already running"),
  ));
  // An admin's { async: true } runs in the background — see the Plex twin.
  if (actor.trigger === "admin" && wantsBackgroundRun(rawBody)) {
    return startLibraryJob(actor.userId, resyncJobKey("jellyfin", rawBody), run);
  }
  return run();
}

// The background resync's answer, for the admin who started it.
export async function GET(request: NextRequest) {
  const t = translatorForRequest(request);
  const actor = await getCronActor(request);
  if (!actor || actor.trigger !== "admin") {
    return NextResponse.json({ error: t("apiAdmin.common.forbidden") }, { status: 403 });
  }
  return libraryJobResponse(actor.userId, request.nextUrl.searchParams.get("job") ?? "", t);
}

type JellyfinServer = { baseUrl: string; apiKey: string; selectedIds: Set<string> | undefined };

// Fetches the Jellyfin library (movies + TV), writes JellyfinLibraryItem rows
// (recentOnly insert-only within the 2h window, or a full delete+replace), then
// flips matching pending/approved requests to AVAILABLE and fires notifications.
//
// Resyncs ONE Jellyfin server — the default ("") unless the body names another
// via `instance`. Every library read/delete is scoped to that server's
// serverInstance, so resyncing one can never wipe or mask another's rows.
//
// TVEpisodeCache is the exception (see the Plex counterpart for the full
// reasoning): no serverInstance column, one shared `source: "jellyfin"`
// namespace, so a single-server resync cannot produce the whole-table union a
// correct rewrite needs. It therefore rewrites the cache ONLY when it is the
// sole configured Jellyfin server — even the recentOnly path's scoped delete
// removes another server's episodes for a show both of them hold.
async function syncJellyfin(request: NextRequest, rawBody: Record<string, unknown>, actor: CronActor, signal: AbortSignal, hold: HoldLock): Promise<Response> {
  const t = translatorForRequest(request);
  const target = resyncTarget(rawBody);
  if (!target) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidInstance") }, { status: 400 });
  }
  const { recentOnly, instance } = target;

  // getMediaInstances, NOT getSyncableMediaInstances: this path is held to the
  // findUnique-only read shape of the other per-instance config readers
  // (guardrail 35).
  const [jellyfinConfig, librariesRow, jellyfinInstances] = await Promise.all([
    getJellyfinConfig(instance),
    prisma.setting.findUnique({ where: { key: jellyfinSettingKey(instance, "Libraries") } }),
    getMediaInstances("jellyfin"),
  ]);

  if (!jellyfinConfig.url || !jellyfinConfig.apiKey) {
    return NextResponse.json({ error: t("apiAdmin.common.jellyfinNotConfigured") }, { status: 400 });
  }

  // The slug must be REGISTERED, not merely shape-valid: leftover Setting rows
  // from a pre-cleanup de-registration can still satisfy the config check, and
  // an unregistered slug would skip the restricted-visibility gate (the registry
  // entry carries `restricted`) and — on a deployment whose registry holds only
  // the default — take the episode-cache-owner branch and wipe the shared
  // TVEpisodeCache's jellyfin rows in favour of a ghost server's holdings.
  if (instance !== DEFAULT_MEDIA_INSTANCE && !jellyfinInstances.some((i) => i.slug === instance)) {
    return NextResponse.json({ error: t("apiAdmin.sync.unknownJellyfinInstance") }, { status: 400 });
  }

  const server: JellyfinServer = {
    baseUrl: jellyfinConfig.url.replace(/\/$/, ""),
    apiKey: jellyfinConfig.apiKey,
    selectedIds: parseLibrarySelection(librariesRow?.value),
  };
  const minDateLastSaved = recentOnly ? new Date(Date.now() - RECENT_WINDOW_MS) : undefined;

  let movieIds: Awaited<ReturnType<typeof getJellyfinTmdbIds>>;
  let tvIds:    Awaited<ReturnType<typeof getJellyfinTmdbIds>>;
  try {
    [movieIds, tvIds] = await Promise.all([
      getJellyfinTmdbIds(server.baseUrl, server.apiKey, "MOVIE", server.selectedIds, minDateLastSaved),
      getJellyfinTmdbIds(server.baseUrl, server.apiKey, "TV", server.selectedIds, minDateLastSaved),
    ]);
  } catch (err) {
    console.error("[sync/jellyfin] Failed to fetch library:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: t("apiAdmin.sync.jellyfinUnreachable") }, { status: 502 });
  }

  // Guardrail 41: the lock is gone (timed out, or its connection dropped), so a
  // second resync may already be running. Stop before writing anything; return,
  // never throw.
  if (signal.aborted) return resyncWindDownResponse(t);

  // Decided before the episode fetch: deciding afterwards page-walked every
  // Episode in the library first, then threw the result away on any
  // multi-server install. The refresh runs beside the library write below and
  // is HELD: the lock stays taken until it has written.
  noteEpisodeCacheOwner("jellyfin", jellyfinInstances.length);
  if (ownsEpisodeCache(jellyfinInstances.length)) {
    hold(refreshJellyfinEpisodes(server, buildSeriesItemIdIndex(tvIds), { recentOnly, signal }));
  }

  // `serverInstance` is NOT optional here — see the Plex twin. The deletes below are
  // scoped to `instance`, so omitting it made a named-instance resync delete that
  // server's rows and re-insert the whole library under the schema default "",
  // moving it onto the DEFAULT server and un-restricting a `restricted` one.
  // The row shape is shared with the orchestrator (library-rows.ts).
  const movieRows = Array.from(movieIds.entries()).map(([tmdbId, d]) => jellyfinLibraryRow(tmdbId, d, "MOVIE", instance));
  const tvRows    = Array.from(tvIds.entries()).map(([tmdbId, d])    => jellyfinLibraryRow(tmdbId, d, "TV", instance));
  if (recentOnly) {
    await insertRecentJellyfinRows(instance, movieRows, tvRows);
  } else {
    // Full replace of THIS instance's rows only (guardrail 13) — an unscoped delete
    // would wipe every other server's rows and repopulate only this one's. The
    // shared staged swap takes advisory lock 2001,2 inside its own short
    // transaction — the same helper the orchestrator's Jellyfin arm uses.
    await replaceJellyfinLibraryForInstances([{ slug: instance, rows: (movieRows as JellyfinLibraryRow[]).concat(tvRows) }]);
  }

  // Stamp last-success for the orchestrator's 24h-stale fallback ONLY for the
  // shape whose success the orchestrator's own stamp means — a FULL replace of
  // the DEFAULT instance when it is the ONLY one (see the Plex twin for the
  // starvation a named-instance, multi-server or recentOnly stamp causes).
  if (instance === DEFAULT_MEDIA_INSTANCE && !recentOnly && jellyfinInstances.length <= 1) {
    await stampLibrarySyncSuccess("jellyfin", "sync/jellyfin");
  }

  if (signal.aborted) return resyncWindDownResponse(t);

  const { checked, marked } = await markResyncedLibrary({
    source: "jellyfin",
    instance: jellyfinInstances.find((i) => i.slug === instance),
    library: { movieIds, tvIds },
    scopeToLibrary: recentOnly,
    logScope: "sync/jellyfin",
  });

  // Attribution comes from the SAME DB-checked session read that authorized the
  // request (getCronActor in POST), consistent with the orchestrator/plex sync.
  // A CRON_SECRET run has no session to attribute.
  if (actor.trigger === "admin") {
    void logAudit({
      userId: actor.userId,
      userName: actor.userName,
      action: "LIBRARY_SYNC",
      target: "sync:jellyfin",
      details: { movies: movieIds.size, tv: tvIds.size, marked, full: !recentOnly },
    });
  }

  return NextResponse.json({
    scanned: { movies: movieIds.size, tv: tvIds.size },
    checked,
    marked,
    full: !recentOnly,
  });
}

// recentOnly is INSERT-ONLY (guardrail 13): never a delete of this server's
// library — an empty window would nuke it. The one delete, the Plex twin's
// stale-mapping clear: a stored row every copy of which now arrives under
// ANOTHER title (an item Jellyfin re-identified) — otherwise the old title kept
// reading as available until the next full sync. It reads only the rows
// holding an incoming item id, inside the lock, so it is bounded by the batch.
type JellyfinRow = ReturnType<typeof jellyfinLibraryRow>;
async function insertRecentJellyfinRows(instance: MediaInstanceKey, movieRows: JellyfinRow[], tvRows: JellyfinRow[]): Promise<void> {
  // The already-present check is scoped to `instance`: another server's row for
  // the same tmdbId must not stop this server's own row from being inserted.
  const [existingMovies, existingTv] = await Promise.all([
    prisma.jellyfinLibraryItem.findMany({
      where: { mediaType: "MOVIE", serverInstance: instance, tmdbId: { in: movieRows.map((r) => r.tmdbId) } },
      select: { tmdbId: true },
    }),
    prisma.jellyfinLibraryItem.findMany({
      where: { mediaType: "TV", serverInstance: instance, tmdbId: { in: tvRows.map((r) => r.tmdbId) } },
      select: { tmdbId: true },
    }),
  ]);
  const existingMovieSet = new Set(existingMovies.map((r) => r.tmdbId));
  const existingTvSet    = new Set(existingTv.map((r) => r.tmdbId));
  const newMovieRows = movieRows.filter((r) => !existingMovieSet.has(r.tmdbId));
  const newTvRows    = tvRows.filter((r)    => !existingTvSet.has(r.tmdbId));
  if (newMovieRows.length === 0 && newTvRows.length === 0) return;

  const incomingItemIds = new Set<string>();
  for (const r of [...newMovieRows, ...newTvRows]) {
    if (r.jellyfinItemId) incomingItemIds.add(r.jellyfinItemId);
    for (const id of r.jellyfinItemIds) incomingItemIds.add(id);
  }

  // Advisory lock 2001,2 serializes this with the orchestrator's swap and
  // fix-match. Queries run one at a time on the transaction (guardrail 23c).
  await prisma.$transaction(async (tx) => {
    await lockLibraryInTx(tx, "jellyfin");
    if (incomingItemIds.size > 0) {
      const holders = await tx.jellyfinLibraryItem.findMany({
        where: { serverInstance: instance, jellyfinItemId: { in: [...incomingItemIds] } },
        select: { tmdbId: true, mediaType: true, jellyfinItemId: true, jellyfinItemIds: true },
      });
      const stale = reidentifiedJellyfinRows(holders, incomingItemIds);
      if (stale.length > 0) {
        await tx.jellyfinLibraryItem.deleteMany({
          where: { serverInstance: instance, OR: stale.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType })) },
        });
      }
    }
    if (newMovieRows.length > 0) await batchCreateMany(tx.jellyfinLibraryItem, newMovieRows);
    if (newTvRows.length    > 0) await batchCreateMany(tx.jellyfinLibraryItem, newTvRows);
  }, { timeout: BATCH_TX_TIMEOUT });
}

// The episode refresh: fetch, then write once the lock is still ours. Fetch
// and write failures are logged; nothing is thrown (it runs held, beside the
// library write).
async function refreshJellyfinEpisodes(
  { baseUrl, apiKey, selectedIds }: JellyfinServer,
  seriesIndex: Map<string, number>,
  { recentOnly, signal }: { recentOnly: boolean; signal: AbortSignal },
): Promise<void> {
  try {
    const episodes = recentOnly && seriesIndex.size > 0 && seriesIndex.size <= PER_SERIES_EPISODE_REFRESH_MAX
      // Bounded per-series fan-out (at most 3 shows fetched at once, matching
      // the library walker's MAX_PARALLEL_PAGES). It returns the same episodes
      // the full walk would after filtering by SeriesId. size === 0 falls
      // through to getJellyfinTVEpisodes, which returns [] without fetching.
      ? (await mapLimit(Array.from(seriesIndex.entries()), 3, ([itemId, tmdbId]) =>
          getJellyfinEpisodesForShow(baseUrl, apiKey, itemId, tmdbId),
        )).flat()
      : await getJellyfinTVEpisodes(baseUrl, apiKey, selectedIds, seriesIndex);
    if (signal.aborted) return;
    if (recentOnly) {
      // Insert-only, scoped to the re-inserted tuples (guardrail 13).
      await mergeRecentEpisodesForSource("jellyfin", episodes);
    } else {
      // A fetch failure threw above, so an empty full result is a genuinely
      // empty library whose stale episode rows must be cleared. The staged load
      // + short swap (same lock, inside the helper) keeps the whole library off
      // the wire mid-transaction.
      await replaceEpisodeCacheForSource("jellyfin", episodes);
    }
  } catch (err) {
    console.error("[sync/jellyfin] Episode cache failed:", err);
  }
}

