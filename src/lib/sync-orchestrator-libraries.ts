// Sync orchestrator (sync-orchestrator.ts): the Plex and Jellyfin library arms —
// fetch every configured server, write its rows, then the episode cache.
import { prisma } from "./prisma";
import { getPlexTmdbIds, getPlexLibrarySections, getPlexTVEpisodes, type PlexLibraryItemData, type PlexTVEpisodeData, type PlexLegacyGuidRef } from "./plex";
import { resolvePlexLegacyGuids, mergeResolvedLegacyItems } from "./plex-legacy-resolve";
import { getPlexConfig } from "./plex-config";
import { buildSeriesItemIdIndex, getJellyfinSyncFolders, getJellyfinTmdbIds, getJellyfinTVEpisodes, type JellyfinLibraryItemData, type JellyfinTVEpisodeData } from "./jellyfin";
import { getJellyfinConfig } from "./jellyfin-config";
import { getSyncableMediaInstances, getMediaInstances, type MediaInstanceConfig } from "./media-instance-registry";
import { plexSettingKey, jellyfinSettingKey, DEFAULT_MEDIA_INSTANCE } from "./media-instances";
import { syncDownloadPolicies } from "./download-policy";
import { patchPlexShowFilePaths, replacePlexLibraryForInstances, replaceJellyfinLibraryForInstances, type PlexLibraryRow, type JellyfinLibraryRow } from "./library-staging";
import { replaceEpisodeCacheForSource } from "./episode-cache";
import { withAdvisoryLock, DOWNLOAD_POLICIES_LOCK_ID } from "./advisory-lock";
import { parseLibrarySelection, stampLibrarySyncSuccess } from "./library-resync";
import { deduplicatePlexRowsByRatingKey } from "./plex-dedupe";
import { plexLibraryRow, jellyfinLibraryRow } from "./library-rows";
import { warnOnChange, forgetWarnOnChange } from "./log-dedup";
import { plexHoldNeedsCounts, plexHoldReason } from "./plex-sync-guard";
import { jellyfinHoldNeedsCounts, jellyfinHoldReason } from "./jellyfin-sync-guard";
import { addPresence, removePresence, droppedTmdbIds, type SyncFlags, type WindDown } from "./sync-orchestrator-shared";

// The configured servers and each one's own library selection.
export async function readLibraryTargets(): Promise<{
  plexInstances: MediaInstanceConfig[];
  jellyfinInstances: MediaInstanceConfig[];
  librarySelections: Map<string, Set<string> | undefined>;
}> {
  const [plexInstances, jellyfinInstances] = await Promise.all([
    // Every configured, connection-ready Plex/Jellyfin server (multi-server support) —
    // each instance's own url/token is resolved via getPlexConfig(instance.slug) /
    // getJellyfinConfig(instance.slug) inside its arm below.
    getSyncableMediaInstances("plex"),
    getSyncableMediaInstances("jellyfin"),
  ]);

  // The library selection is PER SERVER, and must be: a Plex section key is a
  // small integer scoped to one server, so server A's "1,2" names different
  // libraries on server B. Applying one selection to every instance silently
  // ingested the wrong sections from B and excluded the right ones — and since
  // each instance's write is a scoped full replace, B's rows were then replaced
  // with nothing and everything on B read as unavailable. Jellyfin ids are GUIDs
  // so they collide less, but a single selection still cannot express "these
  // libraries on A, those on B" and filtered B down to nothing just the same.
  //
  // An instance with no selection stored syncs ALL of its libraries, which is
  // both the correct default and what every named instance gets until an admin
  // chooses otherwise. The default instance's key is byte-identical to the
  // legacy `plexLibraries`/`jellyfinLibraries`, so existing installs keep their
  // exact selection with no migration.
  const librarySelections = new Map<string, Set<string> | undefined>();
  const selectionKeys = [
    ...plexInstances.map((i) => plexSettingKey(i.slug, "Libraries")),
    ...jellyfinInstances.map((i) => jellyfinSettingKey(i.slug, "Libraries")),
  ];
  const selectionRows = selectionKeys.length
    ? await prisma.setting.findMany({ where: { key: { in: selectionKeys } }, select: { key: true, value: true } })
    : [];
  for (const row of selectionRows) librarySelections.set(row.key, parseLibrarySelection(row.value));
  return { plexInstances, jellyfinInstances, librarySelections };
}
export type LibraryTargets = Awaited<ReturnType<typeof readLibraryTargets>>;

// What one library arm (Plex or Jellyfin) produced, filled in as it runs.
// The union maps say "is this tmdbId on any configured server of the type";
// the *Slugs maps say WHICH servers hold it (the per-user visibility gate
// needs that). Same key set as the union by construction — both are filled
// from the same per-instance loop. `succeeded`: every configured instance's
// fetch AND the write succeeded this run (a COMPLETE picture).
export interface LibraryArm<D> {
  movieIds: Map<number, D>;
  tvIds: Map<number, D>;
  movieSlugs: Map<number, Set<string>>;
  tvSlugs: Map<number, Set<string>>;
  succeeded: boolean;
}
function emptyLibraryArm<D>(): LibraryArm<D> {
  return { movieIds: new Map(), tvIds: new Map(), movieSlugs: new Map(), tvSlugs: new Map(), succeeded: false };
}

// Union each fetched server into the arm's shared maps — downstream only asks
// "is this tmdbId in the map", so a plain per-key merge is correct whichever
// instance's value wins a collision. The parallel `*Slugs` maps record WHICH
// instance contributed each key: the collision-winner is arbitrary, so it
// cannot answer "does the requester see a server that actually holds this
// title" once an instance is restricted. Filled here, while the per-instance
// results are still separate.
function unionIntoArm<D>(arm: LibraryArm<D>, writable: readonly { slug: string; movieIds: Map<number, D>; tvIds: Map<number, D> }[]): void {
  for (const { slug, movieIds, tvIds } of writable) {
    for (const [tmdbId, d] of movieIds) {
      arm.movieIds.set(tmdbId, d);
      addPresence(arm.movieSlugs, tmdbId, slug);
    }
    for (const [tmdbId, d] of tvIds) {
      arm.tvIds.set(tmdbId, d);
      addPresence(arm.tvSlugs, tmdbId, slug);
    }
  }
}

// A failed library write: this run's union is not authoritative (the same
// signal demotion already keys off). The maps were filled BEFORE the
// transaction, so they are dropped — no later reader may treat a rolled-back
// write as library presence.
function clearArm(arm: LibraryArm<unknown>): void {
  arm.movieIds.clear();
  arm.tvIds.clear();
  arm.movieSlugs.clear();
  arm.tvSlugs.clear();
}

// Plex and Jellyfin library writes + download-policy enforcement run
// concurrently. Each arm never throws for a server failure (that server simply
// contributes nothing); a rejection here is a bug, logged and otherwise read as
// that arm contributing nothing. `signal` is the run's lock: the Plex and
// Jellyfin walks take it, so a lost lock stops them mid-listing (guardrail 41).
export async function syncLibraries(flags: SyncFlags, targets: LibraryTargets, windDownBefore: WindDown, signal: AbortSignal | undefined) {
  const plex = emptyLibraryArm<PlexLibraryItemData>();
  const jellyfin = emptyLibraryArm<JellyfinLibraryItemData>();
  const results = await Promise.allSettled([
    // DOWNLOAD_POLICIES_LOCK_ID serializes against the standalone /api/cron/sync-download-policies
    // run, whose read-then-reconcile prune would otherwise race this one. If that cron currently
    // holds the lock, skip the redundant pass — it will reconcile on its own.
    withAdvisoryLock(
      DOWNLOAD_POLICIES_LOCK_ID,
      (lockSignal) => syncDownloadPolicies(signal ? AbortSignal.any([lockSignal, signal]) : lockSignal),
      () => [],
    ),
    syncPlexLibraries(flags, targets, plex, windDownBefore, signal),
    syncJellyfinLibraries(flags, targets, jellyfin, windDownBefore, signal),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[sync] Unexpected top-level sync rejection:", result.reason);
    }
  }
  return { plex, jellyfin };
}

type PlexFetched = {
  slug: string;
  result: {
    serverUrl: string;
    token: string;
    sections: Awaited<ReturnType<typeof getPlexLibrarySections>>;
    movieIds: Map<number, PlexLibraryItemData>;
    tvIds: Map<number, PlexLibraryItemData>;
    ratingKeyToTmdb: Map<string, number[]>;
  } | null;
};

// A Plex hold's warn-once signature and message (guardrail 7b: the same hold
// restates itself every run). Rules: plex-sync-guard.ts.
function plexHoldWarning(slug: string, hold: NonNullable<ReturnType<typeof plexHoldReason>>): { signature: string; message: string } {
  const noun = (mediaType: "MOVIE" | "TV", plural: boolean) => (mediaType === "MOVIE" ? (plural ? "movies" : "movie") : (plural ? "shows" : "show"));
  if (hold.kind === "missing-section") {
    return {
      signature: `missing:${hold.mediaType}:${hold.keys.join(",")}`,
      message: `[sync] Plex instance "${slug}" returned no ${noun(hold.mediaType, true)} and a selected library is no longer on the server (section ${hold.keys.join(", ")}) — keeping its stored rows (a library recreated in Plex gets a new key: tick it in the Plex library settings; if it was removed on purpose, Resync the Plex source)`,
    };
  }
  if (hold.kind === "empty-type") {
    return {
      signature: `empty:${hold.mediaType}`,
      message: `[sync] Plex instance "${slug}" returned no ${noun(hold.mediaType, true)} but has stored ${noun(hold.mediaType, false)} rows — keeping them (check whether Plex is still scanning; Resync clears a library that really was emptied)`,
    };
  }
  return {
    signature: "empty",
    message: `[sync] Plex instance "${slug}" returned no movies or shows but has stored library rows — keeping them (check the selected libraries, or whether Plex is still scanning)`,
  };
}

// One Plex server's fetch: sections, the movie and show walks (with
// legacy-agent resolution), then the short-answer hold. `result: null` is a
// failed or held server — its stored rows stay, and the run is not a complete
// picture. A walk the lock's abort ended rejects (never a partial library) and
// lands here the same way. Never throws.
async function fetchPlexInstance(
  instance: MediaInstanceConfig,
  librarySelections: LibraryTargets["librarySelections"],
  signal: AbortSignal | undefined,
): Promise<PlexFetched> {
  try {
    const cfg = await getPlexConfig(instance.slug);
    if (!cfg.url || !cfg.token) return { slug: instance.slug, result: null }; // defensive; getSyncableMediaInstances already filters to configured ones
    const serverUrl = cfg.url.replace(/\/$/, "");
    const token = cfg.token;
    const sections = await getPlexLibrarySections(serverUrl, token, signal);
    // Respect the admin's selected Plex libraries — THIS server's own selection
    // (a section key is server-local). Without it the scheduled full sync
    // ingested EVERY section, marking media in an excluded library as owned.
    const selectedPlexKeys = librarySelections.get(plexSettingKey(instance.slug, "Libraries"));
    // ratingKeyToTmdb accumulates the show walk's ratingKey→ids mapping so the
    // episode pass reuses this type=2 listing instead of re-paging every show
    // section (per-instance — ratingKeys are server-local). The legacy maps
    // collect pre-2020-agent items (thetvdb://, imdb:// guids) for best-effort
    // tmdb resolution.
    const ratingKeyToTmdb = new Map<string, number[]>();
    const movieLegacy = new Map<string, PlexLegacyGuidRef>();
    const tvLegacy = new Map<string, PlexLegacyGuidRef>();
    // The show rows come back pathless (a show item carries no file); the
    // episode walk that follows captures the paths from the type=4 listing and
    // patches them onto the rows post-write (writePlexEpisodeCache).
    const [movieIds, tvIds] = await Promise.all([
      getPlexTmdbIds(serverUrl, token, "MOVIE", { selectedKeys: selectedPlexKeys, sections, legacyOut: movieLegacy, signal }),
      getPlexTmdbIds(serverUrl, token, "TV", {
        selectedKeys: selectedPlexKeys,
        sections,
        ratingKeyToTmdbOut: ratingKeyToTmdb,
        legacyOut: tvLegacy,
        signal,
      }),
    ]);
    // Resolve + merge legacy-agent items (self-catching, never throws): a
    // resolution failure degrades those items to their previous invisibility
    // rather than failing the instance's fetch.
    const [resolvedMovies, resolvedTv] = await Promise.all([
      resolvePlexLegacyGuids(movieLegacy, "MOVIE"),
      resolvePlexLegacyGuids(tvLegacy, "TV"),
    ]);
    mergeResolvedLegacyItems(resolvedMovies, movieIds);
    mergeResolvedLegacyItems(resolvedTv, tvIds, ratingKeyToTmdb);
    // A SHORT answer for a server we already hold rows for is not a complete
    // picture: a saved selection naming a library Plex recreated under a new
    // key, or a Plex that is mid-scan or just started, comes back with one type
    // (or both) empty and no error. Treated as a success it would wipe those
    // rows and demote AVAILABLE requests. Hold the instance back like a failed
    // fetch (its rows stay, the run is not stamped clean); a library that really
    // was emptied is cleared by the admin's Resync on the Plex source.
    const holdInput = { selectedKeys: selectedPlexKeys, sections, movieCount: movieIds.size, tvCount: tvIds.size };
    const warnKey = `sync:plex-empty:${instance.slug}`;
    if (plexHoldNeedsCounts(holdInput)) {
      const [heldMovieRows, heldTvRows] = await Promise.all([
        prisma.plexLibraryItem.count({ where: { serverInstance: instance.slug, mediaType: "MOVIE" } }),
        prisma.plexLibraryItem.count({ where: { serverInstance: instance.slug, mediaType: "TV" } }),
      ]);
      const hold = plexHoldReason({ ...holdInput, heldMovieRows, heldTvRows });
      if (hold) {
        const { signature, message } = plexHoldWarning(instance.slug, hold);
        warnOnChange(warnKey, signature, message);
        return { slug: instance.slug, result: null };
      }
    }
    forgetWarnOnChange(warnKey);
    return { slug: instance.slug, result: { serverUrl, token, sections, movieIds, tvIds, ratingKeyToTmdb } };
  } catch (err) {
    // A lost lock is not a Plex failure: the run's wind-down notice says why.
    if (!signal?.aborted) console.error(`[sync] Plex check failed for instance "${instance.slug}":`, err);
    return { slug: instance.slug, result: null };
  }
}

// The Plex arm: fetch every configured server, union their titles into `arm`,
// write each server's rows (staged swap), then the episode cache. Never throws
// for a server failure — that server simply contributes nothing.
//
// Unlike arr, there's no per-request instance to attribute a fetch failure to —
// availability is a union across all configured servers (see
// media-instances.ts) — so `arm.succeeded` (read by the revert and the
// stale-fallback, which need this run's union to be a COMPLETE picture)
// requires every configured instance's fetch AND the write to have succeeded.
async function syncPlexLibraries(
  flags: SyncFlags,
  { plexInstances, librarySelections }: LibraryTargets,
  arm: LibraryArm<PlexLibraryItemData>,
  windDownBefore: WindDown,
  signal: AbortSignal | undefined,
): Promise<void> {
  // Same shape as the not-enabled return, deliberately: an arm that
  // contributes nothing leaves `succeeded` false, and every consumer already
  // treats that as "this run's union is not a complete picture".
  if (windDownBefore("Plex library")) return;
  if (!flags.plexEnabled || plexInstances.length === 0) return;

  const fetched = await Promise.all(plexInstances.map((instance) => fetchPlexInstance(instance, librarySelections, signal)));
  // Guardrail 41, at the arm's fetch → write boundary: a lock lost while the
  // walks ran (an instance whose walk had already finished included) writes
  // nothing. The arm contributes nothing, exactly like a failed fetch — every
  // server's stored rows stay — and the sequencer winds the run down (and says
  // so) at its next phase boundary.
  if (signal?.aborted) return;
  const writable = fetched.flatMap((f) => (f.result ? [{ slug: f.slug, ...f.result }] : []));
  unionIntoArm(arm, writable);

  let libraryWriteSucceeded = true;
  if (writable.length > 0) {
    try {
      // Rows are built + deduped per instance BEFORE the transaction (the dedupe is
      // a DB read; doing it in-tx would hold the advisory lock across it for nothing).
      // Dedupe runs per instance batch (never across instances): two servers reusing
      // the same small integer ratingKey is legitimate, not conflation (guardrail 37b).
      const rowsByInstance = await Promise.all(
        writable.map(async ({ slug, movieIds, tvIds }) => {
          const movieRows = Array.from(movieIds.entries()).map(([tmdbId, d]) => plexLibraryRow(tmdbId, d, "MOVIE", slug));
          const tvRows    = Array.from(tvIds.entries()).map(([tmdbId, d])    => plexLibraryRow(tmdbId, d, "TV", slug));
          const finalMovieRows = await deduplicatePlexRowsByRatingKey(movieRows, "MOVIE", slug, "sync");
          const finalTvRows    = await deduplicatePlexRowsByRatingKey(tvRows, "TV", slug, "sync");
          return {
            slug,
            finalMovieRows,
            finalTvRows,
            droppedMovieIds: droppedTmdbIds(movieRows, finalMovieRows),
            droppedTvIds:    droppedTmdbIds(tvRows, finalTvRows),
          };
        }),
      );
      // The union above was filled from the RAW fetch maps; reconcile it with
      // what dedupe actually kept, so the marking pass can never announce an
      // id that has no library row.
      for (const { slug, droppedMovieIds, droppedTvIds } of rowsByInstance) {
        for (const tmdbId of droppedMovieIds) removePresence(arm.movieSlugs, arm.movieIds, tmdbId, slug);
        for (const tmdbId of droppedTvIds)    removePresence(arm.tvSlugs,    arm.tvIds,    tmdbId, slug);
      }
      // Staged swap (replacePlexLibraryForInstances): the rows are bulk-loaded
      // into PlexLibraryItemStaging OUTSIDE any transaction, then swapped across
      // under advisory lock 2001,1 (shared with /api/sync/plex so the two callers
      // can't race the same write) in a transaction that holds only the
      // per-instance scoped deletes and one INSERT ... SELECT. Only instances
      // whose fetch succeeded are touched at all (guardrail 13 — a failed
      // instance's existing rows are left intact, never wiped).
      await replacePlexLibraryForInstances(
        rowsByInstance.map(({ slug, finalMovieRows, finalTvRows }) => ({ slug, rows: (finalMovieRows as PlexLibraryRow[]).concat(finalTvRows) })),
      );
    } catch (err) {
      console.error("[sync] Plex library write failed:", err);
      libraryWriteSucceeded = false;
      clearArm(arm);
    }
  }

  arm.succeeded = libraryWriteSucceeded && fetched.every((f) => f.result !== null);
  // The notify fallback's staleness clock: "every configured instance synced clean this run."
  if (arm.succeeded) await stampLibrarySyncSuccess("plex", "sync");

  await writePlexEpisodeCache(writable, fetched.length, librarySelections, signal);
}

// TVEpisodeCache has no serverInstance column (episodes are TMDB-anchored, shared
// data — see media-instances.ts) — a per-instance episode-fetch failure can't be
// handled by leaving just THAT instance's rows stale the way the scoped library
// delete does, so any single failure here skips the WHOLE write and leaves
// existing rows untouched. Reaching the write with an empty result means the
// libraries genuinely have no episodes, so the stale rows must be cleared rather
// than left as phantom ownership. Every instance's rows are accumulated and the
// replace runs ONCE (a per-instance replace would wipe the previous instance's
// just-written rows). Each fetch runs against ITS OWN instance's sections —
// Plex ratingKeys are server-local and never leave the per-instance fetch.
async function writePlexEpisodeCache(
  writable: readonly { slug: string; serverUrl: string; token: string; sections: Awaited<ReturnType<typeof getPlexLibrarySections>>; ratingKeyToTmdb: Map<string, number[]> }[],
  fetchedCount: number,
  librarySelections: LibraryTargets["librarySelections"],
  signal: AbortSignal | undefined,
): Promise<void> {
  let allEpisodesFetched = true;
  const allPlexEpisodeRows: Array<{ source: "plex" } & PlexTVEpisodeData> = [];
  for (const { slug, serverUrl, token, sections, ratingKeyToTmdb } of writable) {
    // Guardrail 41: a lost lock stops the episode phase between instances (a
    // walk already running rejects at its next page). Nothing below is written.
    if (signal?.aborted) return;
    try {
      // The precomputed ratingKeyToTmdb map (built by this instance's own
      // type=2 walk) skips getPlexTVEpisodes' per-section re-walk of the
      // identical show listing.
      const episodeFilePaths = new Map<string, string>();
      const episodes = await getPlexTVEpisodes(serverUrl, token, librarySelections.get(plexSettingKey(slug, "Libraries")), sections, ratingKeyToTmdb, episodeFilePaths, { signal });
      // Element-wise, never `push(...array)`: spreading a library-sized array as
      // call arguments throws RangeError past V8's argument ceiling, and the
      // catch below would turn that into `allEpisodesFetched = false`, skipping
      // the whole-table rewrite on EVERY run for exactly the large libraries
      // this path exists to serve.
      for (const e of episodes) allPlexEpisodeRows.push({ source: "plex" as const, ...e });
      // Patch the show file paths (the TV walk reads none) onto the
      // just-written rows. Runs AFTER this instance's library write by
      // construction, is instance-scoped, and touches only rows still missing a
      // path — idempotent and harmless if a concurrent writer replaced the rows.
      // Best-effort: a failure leaves paths null until the next run. One
      // VALUES-joined statement per chunk (patchPlexShowFilePaths), never one
      // updateMany per show. Not once the lock is lost (guardrail 41).
      if (episodeFilePaths.size > 0 && !signal?.aborted) {
        try {
          await patchPlexShowFilePaths(slug, episodeFilePaths);
        } catch (err) {
          console.warn(`[sync] Plex show file-path patch failed for instance "${slug}":`, err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      if (!signal?.aborted) console.error(`[sync] Plex TV episode fetch failed for instance "${slug}":`, err);
      allEpisodesFetched = false;
    }
  }
  // `writable.length === fetchedCount` is load-bearing: an instance whose
  // LIBRARY fetch failed never enters `writable`, so its episodes were never
  // fetched — without it the whole-table rewrite would wipe that server's
  // episode rows for the length of its outage. A library-WRITE failure
  // deliberately does not veto (the fetched episode data is still complete).
  if (!episodesCoverEveryServer(allEpisodesFetched, writable.length, fetchedCount) || signal?.aborted) return;
  if (await unconfiguredNamedServerHoldsRows("plex", writable.map((w) => w.slug))) return;
  try {
    // Staged load + short atomic swap under advisory lock 2002,1 (shared with
    // /api/sync/tv-episodes and sync/plex). The rows never cross the wire
    // inside the transaction — see the helper.
    await replaceEpisodeCacheForSource("plex", allPlexEpisodeRows);
  } catch (err) {
    console.error("[sync] Plex TV episode cache failed:", err);
  }
}

// The whole-table episode rewrite runs only on a complete picture: every
// instance's library fetch succeeded (`writable === fetched`) and every
// episode fetch did too. Pure.
function episodesCoverEveryServer(allEpisodesFetched: boolean, writableCount: number, fetchedCount: number): boolean {
  return allEpisodesFetched && writableCount === fetchedCount && writableCount > 0;
}

// TVEpisodeCache has no serverInstance column, so the whole-table rewrite also
// replaces the episodes a REGISTERED-but-unconfigured named server contributed
// (an admin mid-edit, a blanked token) — while its library rows are deliberately
// kept (guardrail 35). Hold the rewrite while such a server still holds library
// rows: its episodes stay until it is reconfigured or de-registered. The same
// predicate as the demote veto (libraryCoverage); the synthesized default ("")
// is excluded for the same reason. A failed read holds too — never rewrite on a
// guess.
async function unconfiguredNamedServerHoldsRows(source: "plex" | "jellyfin", writtenSlugs: readonly string[]): Promise<boolean> {
  try {
    const written = new Set(writtenSlugs);
    const registered = await getMediaInstances(source);
    const missing = registered.filter((i) => i.slug !== DEFAULT_MEDIA_INSTANCE && !written.has(i.slug)).map((i) => i.slug);
    if (missing.length === 0) return false;
    const where = { serverInstance: { in: missing } };
    const held = source === "plex"
      ? await prisma.plexLibraryItem.findFirst({ where, select: { tmdbId: true } })
      : await prisma.jellyfinLibraryItem.findFirst({ where, select: { tmdbId: true } });
    if (!held) return false;
    warnOnChange(
      `episode-cache-held:${source}`,
      missing.join(","),
      `[sync] ${source} episode cache not rewritten: ${missing.length} registered server(s) are not configured but still hold library rows, ` +
        "so their episodes would be wiped. Reconfigure or remove them to resume.",
    );
    return true;
  } catch (err) {
    console.warn(`[sync] ${source} episode cache held: could not read the registered servers:`, err instanceof Error ? err.message : String(err));
    return true;
  }
}

type JellyfinFetched = {
  slug: string;
  result: { baseUrl: string; apiKey: string; movieIds: Map<number, JellyfinLibraryItemData>; tvIds: Map<number, JellyfinLibraryItemData> } | null;
};

// A Jellyfin hold's warn-once signature and message — the twin of plexHoldWarning.
// Rules: jellyfin-sync-guard.ts.
function jellyfinHoldWarning(slug: string, hold: NonNullable<ReturnType<typeof jellyfinHoldReason>>): { signature: string; message: string } {
  const noun = (mediaType: "MOVIE" | "TV") => (mediaType === "MOVIE" ? "movies" : "shows");
  if (hold.kind === "missing-library") {
    return {
      signature: `missing:${hold.mediaType}:${hold.ids.join(",")}`,
      message: `[sync] Jellyfin instance "${slug}" returned no ${noun(hold.mediaType)} and a selected library is no longer on the server (${hold.ids.join(", ")}) — keeping its stored rows (a library recreated in Jellyfin gets a new id: tick it in the Jellyfin library settings; if it was removed on purpose, Resync the Jellyfin source)`,
    };
  }
  if (hold.kind === "empty-type") {
    return {
      signature: `empty:${hold.mediaType}`,
      message: `[sync] Jellyfin instance "${slug}" returned no ${noun(hold.mediaType)} but has stored rows of them — keeping them (check whether Jellyfin is still scanning; Resync clears a library that really was emptied)`,
    };
  }
  return {
    signature: "empty",
    message: `[sync] Jellyfin instance "${slug}" returned no movies or shows but has stored library rows — keeping them (check the selected libraries, or whether Jellyfin is still scanning)`,
  };
}

// One Jellyfin server's fetch, then the short-answer hold — the twin of
// fetchPlexInstance, the lock's abort included: a walk it ended rejects (never
// a partial library) and lands in the catch. Never throws.
async function fetchJellyfinInstance(
  instance: MediaInstanceConfig,
  librarySelections: LibraryTargets["librarySelections"],
  signal: AbortSignal | undefined,
): Promise<JellyfinFetched> {
  try {
    const cfg = await getJellyfinConfig(instance.slug);
    if (!cfg.url || !cfg.apiKey) return { slug: instance.slug, result: null }; // defensive; getSyncableMediaInstances already filters to configured ones
    const baseUrl = cfg.url.replace(/\/$/, "");
    const apiKey = cfg.apiKey;
    // THIS server's own library selection; otherwise the scheduled full sync
    // ingests every library and marks excluded media as owned.
    const selectedJellyfinIds = librarySelections.get(jellyfinSettingKey(instance.slug, "Libraries"));
    const [movieIds, tvIds] = await Promise.all([
      getJellyfinTmdbIds(baseUrl, apiKey, "MOVIE", selectedJellyfinIds, undefined, signal),
      getJellyfinTmdbIds(baseUrl, apiKey, "TV", selectedJellyfinIds, undefined, signal),
    ]);
    // A SHORT answer for a server we already hold rows for is not a complete
    // picture (a library recreated under a new id, a server mid-scan): treated
    // as a success it would wipe the rows and the episode cache and demote
    // AVAILABLE requests. Hold the instance back like a failed fetch. The admin's
    // Resync (/api/sync/jellyfin, full) is the deliberate unguarded way to empty
    // a library.
    const holdInput = { selectedIds: selectedJellyfinIds, movieCount: movieIds.size, tvCount: tvIds.size };
    const warnKey = `sync:jellyfin-empty:${instance.slug}`;
    if (jellyfinHoldNeedsCounts(holdInput)) {
      const [heldMovieRows, heldTvRows] = await Promise.all([
        prisma.jellyfinLibraryItem.count({ where: { serverInstance: instance.slug, mediaType: "MOVIE" } }),
        prisma.jellyfinLibraryItem.count({ where: { serverInstance: instance.slug, mediaType: "TV" } }),
      ]);
      // The server's libraries only matter once something is stored to protect.
      // Mixed and untyped ones included: the guard counts them as either type.
      const folders = heldMovieRows > 0 || heldTvRows > 0 ? await getJellyfinSyncFolders(baseUrl, apiKey) : [];
      const hold = jellyfinHoldReason({ ...holdInput, folders, heldMovieRows, heldTvRows });
      if (hold) {
        const { signature, message } = jellyfinHoldWarning(instance.slug, hold);
        warnOnChange(warnKey, signature, message);
        return { slug: instance.slug, result: null };
      }
    }
    forgetWarnOnChange(warnKey);
    return { slug: instance.slug, result: { baseUrl, apiKey, movieIds, tvIds } };
  } catch (err) {
    // A lost lock is not a Jellyfin failure: the run's wind-down notice says why.
    if (!signal?.aborted) console.error(`[sync] Jellyfin check failed for instance "${instance.slug}":`, err);
    return { slug: instance.slug, result: null };
  }
}

// The Jellyfin arm — the twin of the Plex arm above.
async function syncJellyfinLibraries(
  flags: SyncFlags,
  { jellyfinInstances, librarySelections }: LibraryTargets,
  arm: LibraryArm<JellyfinLibraryItemData>,
  windDownBefore: WindDown,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (windDownBefore("Jellyfin library")) return;
  if (!flags.jellyfinEnabled || jellyfinInstances.length === 0) return;

  const fetched = await Promise.all(jellyfinInstances.map((instance) => fetchJellyfinInstance(instance, librarySelections, signal)));
  // Guardrail 41, at the arm's fetch → write boundary, as in the Plex arm: a
  // lock lost while the walks ran writes nothing and the arm contributes
  // nothing, so every server's stored rows stay.
  if (signal?.aborted) return;
  const writable = fetched.flatMap((f) => (f.result ? [{ slug: f.slug, ...f.result }] : []));
  unionIntoArm(arm, writable);

  let libraryWriteSucceeded = true;
  if (writable.length > 0) {
    try {
      // Staged swap (replaceJellyfinLibraryForInstances): rows bulk-loaded into
      // JellyfinLibraryItemStaging OUTSIDE any transaction, then swapped across
      // under advisory lock 2001,2 (shared with /api/sync/jellyfin) in a
      // transaction holding only the per-instance scoped deletes and one
      // INSERT ... SELECT. Only instances whose fetch succeeded are touched at
      // all (guardrail 13).
      await replaceJellyfinLibraryForInstances(
        writable.map(({ slug, movieIds, tvIds }) => {
          const movieRows = Array.from(movieIds.entries()).map(([tmdbId, d]) => jellyfinLibraryRow(tmdbId, d, "MOVIE", slug));
          const tvRows    = Array.from(tvIds.entries()).map(([tmdbId, d])    => jellyfinLibraryRow(tmdbId, d, "TV", slug));
          return { slug, rows: (movieRows as JellyfinLibraryRow[]).concat(tvRows) };
        }),
      );
    } catch (err) {
      console.error("[sync] Jellyfin library write failed:", err);
      libraryWriteSucceeded = false;
      clearArm(arm);
    }
  }

  arm.succeeded = libraryWriteSucceeded && fetched.every((f) => f.result !== null);
  if (arm.succeeded) await stampLibrarySyncSuccess("jellyfin", "sync");

  await writeJellyfinEpisodeCache(writable, fetched.length, librarySelections, signal);
}

// The Jellyfin twin of writePlexEpisodeCache: the same all-or-nothing whole-table
// rewrite, under advisory lock 2002,2.
async function writeJellyfinEpisodeCache(
  writable: readonly { slug: string; baseUrl: string; apiKey: string; tvIds: Map<number, JellyfinLibraryItemData> }[],
  fetchedCount: number,
  librarySelections: LibraryTargets["librarySelections"],
  signal: AbortSignal | undefined,
): Promise<void> {
  let allEpisodesFetched = true;
  const allEpisodeRows: Array<{ source: "jellyfin" } & JellyfinTVEpisodeData> = [];
  for (const { slug, baseUrl, apiKey, tvIds } of writable) {
    // Guardrail 41: a lost lock stops the episode phase between instances (a
    // walk already running rejects at its next page). Nothing below is written.
    if (signal?.aborted) return;
    // Built from THIS instance's own TV map, never the cross-instance union: Jellyfin
    // item ids are server-local and can collide across independently-administered
    // servers, so a global series map could resolve episodes onto the wrong show.
    // Keyed on every item id per series — a show in two of this server's libraries
    // files its episodes under two SeriesIds, and only one id survives into the row.
    const jfSeriesMap = buildSeriesItemIdIndex(tvIds);
    try {
      const episodes = await getJellyfinTVEpisodes(baseUrl, apiKey, librarySelections.get(jellyfinSettingKey(slug, "Libraries")), jfSeriesMap, signal);
      // Element-wise — see writePlexEpisodeCache.
      for (const e of episodes) allEpisodeRows.push({ source: "jellyfin" as const, ...e });
    } catch (err) {
      if (!signal?.aborted) console.error(`[sync] Jellyfin TV episode fetch failed for instance "${slug}":`, err);
      allEpisodesFetched = false;
    }
  }
  if (!episodesCoverEveryServer(allEpisodesFetched, writable.length, fetchedCount) || signal?.aborted) return;
  if (await unconfiguredNamedServerHoldsRows("jellyfin", writable.map((w) => w.slug))) return;
  try {
    await replaceEpisodeCacheForSource("jellyfin", allEpisodeRows);
  } catch (err) {
    console.error("[sync] Jellyfin TV episode cache failed:", err);
  }
}
