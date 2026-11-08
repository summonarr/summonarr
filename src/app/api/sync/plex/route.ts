import { NextRequest, NextResponse } from "next/server";
import { readJsonCappedOr } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { getPlexTmdbIds, getPlexTVEpisodes, getPlexLibrarySections, type PlexLegacyGuidRef, type PlexSection, type PlexTVEpisodeData } from "@/lib/plex";
import { plexLibraryRow } from "@/lib/library-rows";
import { resolvePlexLegacyGuids, mergeResolvedLegacyItems } from "@/lib/plex-legacy-resolve";
import { getPlexConfig } from "@/lib/plex-config";
import { type MediaInstanceKey, DEFAULT_MEDIA_INSTANCE, plexSettingKey } from "@/lib/media-instances";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { logAudit } from "@/lib/audit";
import { getCronActor, type CronActor } from "@/lib/cron-auth";
import { cronSkippedResponse, withCronRunRecording } from "@/lib/cron-history";
import { BATCH_TX_TIMEOUT, batchCreateMany } from "@/lib/batch-write";
import { mergeRecentEpisodesForSource, replaceEpisodeCacheForSource } from "@/lib/episode-cache";
import { lockLibraryInTx, patchPlexShowFilePaths, replacePlexLibraryForInstances, type PlexLibraryRow } from "@/lib/library-staging";
import { markResyncedLibrary } from "@/lib/available-marking";
import { deduplicatePlexRowsByRatingKey } from "@/lib/plex-dedupe";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { PLEX_RESYNC_LOCK_ID } from "@/lib/advisory-lock";
import { libraryJobResponse, startLibraryJob, wantsBackgroundRun } from "@/lib/library-sync-jobs";
import {
  RECENT_WINDOW_MS,
  noteEpisodeCacheOwner,
  ownsEpisodeCache,
  parseLibrarySelection,
  resyncJobKey,
  resyncTarget,
  resyncWindDownResponse,
  runResyncHoldingLock,
  stampLibrarySyncSuccess,
  type HoldLock,
} from "@/lib/library-resync";

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
  // of walking the whole Plex library again beside the first. The lock is held
  // until the episode-cache refresh has finished too, though the caller is
  // answered as soon as the library half is done (runResyncHoldingLock).
  const run = () => withCronRunRecording("plex-sync", () => runResyncHoldingLock(
    PLEX_RESYNC_LOCK_ID,
    (signal, hold) => syncPlex(request, rawBody, actor, signal, hold),
    // X-Cron-Skipped keeps a busy answer out of the ledger (no run happened).
    () => cronSkippedResponse("plex sync already running"),
  ));
  // An admin's { async: true } runs in the background and is polled with GET
  // ?job= (library-sync-jobs.ts): a full walk outlasts a reverse proxy's hold.
  // Every other caller keeps the synchronous answer.
  if (actor.trigger === "admin" && wantsBackgroundRun(rawBody)) {
    return startLibraryJob(actor.userId, resyncJobKey("plex", rawBody), run);
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

type PlexServer = { serverUrl: string; token: string; selectedKeys: Set<string> | undefined };
type PlexFetch = {
  sections: PlexSection[];
  movieIds: Awaited<ReturnType<typeof getPlexTmdbIds>>;
  tvIds: Awaited<ReturnType<typeof getPlexTmdbIds>>;
  /** The show walk's ratingKey → tmdb ids (legacy-agent shows resolved). */
  ratingKeyToTmdb: Map<string, number[]>;
};

// Resyncs ONE Plex server — the default ("") unless the body names another via
// `instance`. Every library read/delete is scoped to that server's
// serverInstance, so resyncing one can never wipe or mask another's rows.
//
// TVEpisodeCache is the exception that needs care: it has NO serverInstance
// column, so every Plex server's episodes share one `source: "plex"` namespace
// and the only correct rewrite is a whole-table one built from EVERY server (the
// orchestrator's job, where it is gated on all instances having been fetched).
// A single-server resync cannot produce that union, so it rewrites the cache
// ONLY when it is the sole configured Plex server. With more than one it leaves
// the cache alone — rewriting from this server alone would destroy every other
// Plex server's episode rows until the next orchestrator run.
async function syncPlex(request: NextRequest, rawBody: Record<string, unknown>, actor: CronActor, signal: AbortSignal, hold: HoldLock): Promise<Response> {
  const t = translatorForRequest(request);
  const target = resyncTarget(rawBody);
  if (!target) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidInstance") }, { status: 400 });
  }
  const { recentOnly, instance } = target;

  // getMediaInstances, NOT getSyncableMediaInstances: the latter probes each
  // instance with a setting.findMany, and this path is held to the same
  // findUnique-only read shape as the other per-instance config readers
  // (guardrail 35).
  const [plexConfig, librariesRow, plexInstances] = await Promise.all([
    getPlexConfig(instance),
    prisma.setting.findUnique({ where: { key: plexSettingKey(instance, "Libraries") } }),
    getMediaInstances("plex"),
  ]);

  if (!plexConfig.url || !plexConfig.token) {
    return NextResponse.json({ error: t("apiAdmin.common.plexNotConfigured") }, { status: 400 });
  }

  // The slug must be REGISTERED, not merely shape-valid: leftover Setting rows
  // from a pre-cleanup de-registration can still satisfy the config check, and
  // an unregistered slug would skip the restricted-visibility gate (the registry
  // entry carries `restricted`) and — on a deployment whose registry holds only
  // the default — take the episode-cache-owner branch and rewrite the shared
  // TVEpisodeCache from a ghost server.
  if (instance !== DEFAULT_MEDIA_INSTANCE && !plexInstances.some((i) => i.slug === instance)) {
    return NextResponse.json({ error: t("apiAdmin.sync.unknownPlexInstance") }, { status: 400 });
  }

  const server: PlexServer = {
    serverUrl: plexConfig.url.replace(/\/$/, ""),
    token: plexConfig.token,
    selectedKeys: parseLibrarySelection(librariesRow?.value),
  };
  const ownsCache = ownsEpisodeCache(plexInstances.length);

  let fetched: PlexFetch;
  try {
    fetched = await fetchPlexLibrary(server, recentOnly, signal);
  } catch (err) {
    // Guardrail 41: a walk the lock's abort ended REJECTS (never a partial
    // library) before anything was written, so the stored rows stand. Plex did
    // not fail — the lock went — so the answer is the wind-down, not 502.
    if (signal.aborted) return resyncWindDownResponse(t);
    console.error("[sync/plex] Failed to fetch library:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: t("apiAdmin.sync.plexUnreachable") }, { status: 502 });
  }
  const { movieIds, tvIds } = fetched;

  // Guardrail 41: the lock is gone (timed out, or its connection dropped), so a
  // second resync may already be running. Stop before writing anything; return,
  // never throw.
  if (signal.aborted) return resyncWindDownResponse(t);

  noteEpisodeCacheOwner("plex", plexInstances.length);
  // As the only Plex server this resync also maintains the shared episode
  // cache: a full resync rewrites it, a recentOnly one merges in the episodes of
  // the shows its window returned (insert-only, guardrail 13) — never a crawl
  // of the whole library. The crawl starts now, beside the library write below,
  // and is HELD: the lock stays taken until it has written
  // (runResyncHoldingLock). It captures the show file paths on the way.
  const filePaths = new Map<string, string>();
  const cacheWalk = ownsCache
    ? walkPlexEpisodes(server, fetched.sections, async () => fetched.ratingKeyToTmdb, { signal, filePathsOut: filePaths })
    : null;
  if (cacheWalk) hold(cacheWalk.then((episodes) => writePlexEpisodeCache(episodes, recentOnly, signal)));

  const { finalMovieRows, finalTvRows, droppedMovieIds, droppedTvIds } = await dedupedPlexRows(fetched, instance);
  const writtenShows = recentOnly
    ? await insertRecentPlexRows(instance, finalMovieRows, finalTvRows)
    : await replaceInstanceRows(instance, finalMovieRows, finalTvRows);

  // The TV rows just written carry no file path (a show item has none); the
  // type=4 episode listing does. The cache crawl captures them when it runs;
  // otherwise a walk of only the shows this run wrote reads them — never one
  // request per show. Registered AFTER the awaited library write above — that
  // ordering is what guarantees the full replace can't delete the patched rows.
  const pathWalk = cacheWalk ?? (writtenShows.size > 0
    ? walkPlexEpisodes(server, fetched.sections, async () => onlyShows(fetched.ratingKeyToTmdb, writtenShows), { signal, filePathsOut: filePaths })
    : null);
  if (pathWalk) hold(pathWalk.then((episodes) => patchShowFilePaths(instance, episodes, onlyShows(filePaths, writtenShows), signal)));

  // Stamp last-success so the orchestrator's 24h-stale fallback doesn't fire
  // falsely on deployments where the admin runs the per-source resync more
  // recently than the orchestrator. ONLY for the shape whose success the
  // orchestrator's own stamp means — every registered Plex server synced clean:
  // a FULL replace of the DEFAULT instance when it is the ONLY one. A named
  // instance's resync says nothing about the default server the fallback is
  // waiting on (an hourly `{instance:"remote"}` call would keep the stamp fresh
  // while the default stayed down, so `plexStale` could never fire); the
  // default's resync says nothing about a named server that is down; and a
  // recentOnly insert-only run is not a complete picture of the library.
  if (instance === DEFAULT_MEDIA_INSTANCE && !recentOnly && plexInstances.length <= 1) {
    await stampLibrarySyncSuccess("plex", "sync/plex");
  }

  if (signal.aborted) return resyncWindDownResponse(t);

  // Ids the dedupe dropped never get a library row, so they must not reach the
  // marking pass — it would flip requests AVAILABLE (and notify) for titles
  // every badge reader calls missing (mirrors the orchestrator's removePresence
  // reconciliation).
  const { checked, marked } = await markResyncedLibrary({
    source: "plex",
    instance: plexInstances.find((i) => i.slug === instance),
    library: { movieIds, tvIds },
    dropped: { movieIds: droppedMovieIds, tvIds: droppedTvIds },
    scopeToLibrary: recentOnly,
    logScope: "sync/plex",
  });

  // Attribution comes from the SAME DB-checked session read that authorized the
  // request (getCronActor in POST): a stale/revoked admin JWT can't
  // mis-attribute the audit row, and the verify isn't paid twice. A CRON_SECRET
  // run has no session to attribute.
  if (actor.trigger === "admin") {
    void logAudit({
      userId: actor.userId,
      userName: actor.userName,
      action: "LIBRARY_SYNC",
      target: "sync:plex",
      // `full` mirrors the Jellyfin twin's row, so the audit log can tell a full
      // replace from an incremental add for BOTH sources.
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

// The movie and show walks plus legacy-agent resolution — the same wiring as the
// orchestrator's Plex arm. recentOnly reads /recentlyAdded bounded by
// RECENT_WINDOW_MS (addedAt-desc, early-stop once a whole page predates it);
// without the bound the "incremental" path would page the ENTIRE section.
// Throws on any upstream failure, and when `signal` (the resync's lock) aborts
// mid-walk.
async function fetchPlexLibrary(
  { serverUrl, token, selectedKeys }: PlexServer,
  recentOnly: boolean,
  signal: AbortSignal,
): Promise<PlexFetch> {
  const recentSinceEpochSec = recentOnly ? Math.floor((Date.now() - RECENT_WINDOW_MS) / 1000) : undefined;
  const ratingKeyToTmdb = new Map<string, number[]>();
  const movieLegacy = new Map<string, PlexLegacyGuidRef>();
  const tvLegacy = new Map<string, PlexLegacyGuidRef>();
  const sections = await getPlexLibrarySections(serverUrl, token, signal);
  const [movieIds, tvIds] = await Promise.all([
    getPlexTmdbIds(serverUrl, token, "MOVIE", { recentOnly, selectedKeys, sections, legacyOut: movieLegacy, recentSinceEpochSec, signal }),
    getPlexTmdbIds(serverUrl, token, "TV", {
      recentOnly,
      selectedKeys,
      sections,
      ratingKeyToTmdbOut: ratingKeyToTmdb,
      legacyOut: tvLegacy,
      recentSinceEpochSec,
      signal,
    }),
  ]);
  const [resolvedMovies, resolvedTv] = await Promise.all([
    resolvePlexLegacyGuids(movieLegacy, "MOVIE"),
    resolvePlexLegacyGuids(tvLegacy, "TV"),
  ]);
  mergeResolvedLegacyItems(resolvedMovies, movieIds);
  mergeResolvedLegacyItems(resolvedTv, tvIds, ratingKeyToTmdb);
  return { sections, movieIds, tvIds, ratingKeyToTmdb };
}

// `serverInstance` is NOT optional on these rows. Every delete on this path is
// scoped to `instance`, so omitting it on the insert would make a named-instance
// resync delete that server's rows and re-insert them under the schema default
// "" — moving the whole library onto the DEFAULT server. That silently
// un-restricts a `restricted` server (slug "" is visible to everyone) and drops
// its server-local ratingKeys into the default's namespace, where a later
// fix-match would address the wrong server. The row shape is shared with the
// orchestrator (library-rows.ts); the ratingKey dedupe too (guardrail 37b).
async function dedupedPlexRows({ movieIds, tvIds }: PlexFetch, instance: MediaInstanceKey) {
  const movieRows = Array.from(movieIds.entries()).map(([tmdbId, d]) => plexLibraryRow(tmdbId, d, "MOVIE", instance));
  const tvRows    = Array.from(tvIds.entries()).map(([tmdbId, d])    => plexLibraryRow(tmdbId, d, "TV", instance));
  const finalMovieRows = await deduplicatePlexRowsByRatingKey(movieRows, "MOVIE", instance, "sync/plex");
  const finalTvRows    = await deduplicatePlexRowsByRatingKey(tvRows,    "TV",    instance, "sync/plex");
  const dropped = (rows: { tmdbId: number }[], kept: { tmdbId: number }[]): Set<number> => {
    const keptIds = new Set(kept.map((r) => r.tmdbId));
    return new Set(rows.filter((r) => !keptIds.has(r.tmdbId)).map((r) => r.tmdbId));
  };
  return {
    finalMovieRows,
    finalTvRows,
    droppedMovieIds: dropped(movieRows, finalMovieRows),
    droppedTvIds: dropped(tvRows, finalTvRows),
  };
}

// Full replace of the rows belonging to `instance` ONLY; every other server's
// rows survive untouched. The shared staged swap takes advisory lock 2001,1
// inside its own short transaction — the same helper the orchestrator's Plex
// arm uses, so the two can never disagree. Returns the shows written.
async function replaceInstanceRows(instance: MediaInstanceKey, movieRows: PlexLibraryRow[], tvRows: PlexLibraryRow[]): Promise<Set<string>> {
  await replacePlexLibraryForInstances([{ slug: instance, rows: movieRows.concat(tvRows) }]);
  return showKeysOf(tvRows);
}

// recentOnly is INSERT-ONLY (guardrail 13): never a delete of this server's
// library — an empty window would nuke it. The one delete is the stale
// plexRatingKey → tmdbId mapping for a ratingKey about to be re-inserted under
// another title (an item Plex re-identified), scoped to EXACTLY those keys.
// Returns the shows it inserted: the only rows whose file path this run fills,
// so a stored row stays as the run found it.
async function insertRecentPlexRows(instance: MediaInstanceKey, movieRows: PlexLibraryRow[], tvRows: PlexLibraryRow[]): Promise<Set<string>> {
  // The already-present check is scoped to the instance being written: another
  // server's row for the same tmdbId must not mask inserting this server's own.
  const [existingMovies, existingTv] = await Promise.all([
    prisma.plexLibraryItem.findMany({
      where: { mediaType: "MOVIE", serverInstance: instance, tmdbId: { in: movieRows.map((r) => r.tmdbId) } },
      select: { tmdbId: true },
    }),
    prisma.plexLibraryItem.findMany({
      where: { mediaType: "TV", serverInstance: instance, tmdbId: { in: tvRows.map((r) => r.tmdbId) } },
      select: { tmdbId: true },
    }),
  ]);
  const existingMovieSet = new Set(existingMovies.map((r) => r.tmdbId));
  const existingTvSet    = new Set(existingTv.map((r) => r.tmdbId));
  const newMovieRows = movieRows.filter((r) => !existingMovieSet.has(r.tmdbId));
  const newTvRows    = tvRows.filter((r)    => !existingTvSet.has(r.tmdbId));
  const incomingRatingKeys = [...newMovieRows, ...newTvRows]
    .map((r) => r.plexRatingKey)
    .filter((k): k is string => !!k);

  // Advisory lock 2001,1 serializes this with the orchestrator's swap and
  // fix-match (lockLibraryInTx).
  await prisma.$transaction(async (tx) => {
    await lockLibraryInTx(tx, "plex");
    if (incomingRatingKeys.length > 0) {
      // Scoped to the instance being written: the same small integer ratingKey
      // can legitimately exist on another server — only THIS server's mapping
      // is stale.
      await tx.plexLibraryItem.deleteMany({ where: { serverInstance: instance, plexRatingKey: { in: incomingRatingKeys } } });
    }
    if (newMovieRows.length > 0) await batchCreateMany(tx.plexLibraryItem, newMovieRows);
    if (newTvRows.length    > 0) await batchCreateMany(tx.plexLibraryItem, newTvRows);
  }, { timeout: BATCH_TX_TIMEOUT });
  return showKeysOf(newTvRows);
}

// The ratingKeys of the TV rows a write produced: the rows the file-path patch
// may fill (it matches on plexRatingKey, the stored copy's key).
function showKeysOf(tvRows: readonly PlexLibraryRow[]): Set<string> {
  const keys = new Set<string>();
  for (const row of tvRows) if (row.plexRatingKey) keys.add(row.plexRatingKey);
  return keys;
}

// `map` narrowed to the given shows. Pure.
function onlyShows<V>(map: ReadonlyMap<string, V>, shows: ReadonlySet<string>): Map<string, V> {
  const out = new Map<string, V>();
  for (const [key, value] of map) if (shows.has(key)) out.set(key, value);
  return out;
}

// The type=4 episode walk over `showKeys`, capturing each show's first file
// path into `filePathsOut`. A failure logs and returns null (the cache and the
// paths stay as they were); an empty list therefore really means "no
// episodes". When the lock is lost (guardrail 41) the walk stops — it rejects
// at its next page — and returns null without logging a failure.
async function walkPlexEpisodes(
  { serverUrl, token, selectedKeys }: PlexServer,
  sections: PlexSection[],
  showKeys: () => Promise<Map<string, number[]>>,
  { signal, filePathsOut }: { signal: AbortSignal; filePathsOut: Map<string, string> },
): Promise<PlexTVEpisodeData[] | null> {
  try {
    const keys = await showKeys();
    if (signal.aborted) return null;
    return await getPlexTVEpisodes(serverUrl, token, selectedKeys, sections, keys, filePathsOut, { signal });
  } catch (err) {
    if (!signal.aborted) console.error("[sync/plex] Episode walk failed:", err);
    return null;
  }
}

// Advisory lock 2002,1 — Plex TVEpisodeCache coordination, taken inside both
// helpers' transactions and shared with the orchestrator and
// /api/sync/tv-episodes. Skipped once the resync's lock is lost. A full resync
// replaces the source's rows; recentOnly only merges the window's episodes in,
// so its smaller walk can never erase a show it did not read.
async function writePlexEpisodeCache(episodes: PlexTVEpisodeData[] | null, recentOnly: boolean, signal: AbortSignal): Promise<void> {
  if (episodes === null || signal.aborted) return;
  await (recentOnly ? mergeRecentEpisodesForSource("plex", episodes) : replaceEpisodeCacheForSource("plex", episodes))
    .catch((err) => console.error("[sync/plex] Episode cache failed:", err));
}

// filePath:null-scoped, so a concurrent writer makes it a no-op; a failure
// leaves paths null until the next run. One VALUES-joined statement per chunk
// (patchPlexShowFilePaths), never one updateMany per show. Skipped once the
// resync's lock is lost (guardrail 41).
async function patchShowFilePaths(
  instance: MediaInstanceKey,
  episodes: PlexTVEpisodeData[] | null,
  paths: Map<string, string>,
  signal: AbortSignal,
): Promise<void> {
  if (episodes === null || paths.size === 0 || signal.aborted) return;
  await patchPlexShowFilePaths(instance, paths)
    .catch((err) => console.warn("[sync/plex] show file-path patch failed:", err instanceof Error ? err.message : err));
}
