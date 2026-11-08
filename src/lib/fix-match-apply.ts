import { prisma } from "@/lib/prisma";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { getPlexEpisodesForShow } from "@/lib/plex";
import { getJellyfinEpisodesForShow } from "@/lib/jellyfin";
import { batchCreateMany, BATCH_TX_TIMEOUT, type LibraryTxClient } from "@/lib/batch-write";
import { lockEpisodeCacheInTx, type EpisodeCacheRow } from "@/lib/episode-cache";
import { lockLibraryInTx } from "@/lib/library-staging";
import { logAudit, type auditContext } from "@/lib/audit";
import { FixMatchError, type FixMatchJobResult, type FixMatchReport } from "@/lib/fix-match-jobs";
import type { Translator } from "@/lib/i18n/translate";
import { carryMeta, JELLYFIN_META_KEYS, LIBRARY_META_KEYS, remainingOnOldRow, unionKeys } from "@/lib/fix-match-rows";
import { dropMatchFlagInTx, moveItemToTitleInTx, type MovedTitleDisplay } from "@/lib/library-match-data";
import { fixPlexMatch, plexCopyClaim, type PlexRemapResult } from "@/lib/fix-match-plex";
import { fixJellyfinMatch, sanitizeJellyfinId } from "@/lib/fix-match-jellyfin";

// The three fix-match modes — Plex title, Jellyfin title, one flagged item —
// each a remote remap (fix-match-plex.ts / fix-match-jellyfin.ts) followed by
// the cache-row transaction, the audit row and, for TV, the episode re-cache.
// fix-match-run.ts picks the mode and maps failures for the client.

export type FixMatchInput = {
  server: "plex" | "jellyfin";
  // Item mode: the item's current TMDB id from the match report, 0 when it has none.
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  correctTmdbId: number;
  canonicalGuid?: string;
  serverInstance: string;
  // Item mode (see the route's FixMatchBody.itemKey) — set only from a stored match flag.
  itemKey?: string;
  itemPath?: string | null;
  // Item mode: the title Radarr/Sonarr holds for the flagged item's folder.
  itemArr?: { tmdbId: number | null; title: string | null; year: number | null } | null;
};
// Who ran the fix, plus the request context (IP, user agent, provider) every
// admin audit row carries — spread at the top level of each FIX_MATCH row.
export type FixMatchActor = { userId: string; userName: string | null | undefined; ctx: ReturnType<typeof auditContext> };
export type RunOpts = { background: boolean; report?: FixMatchReport };
// The remap is inherently two-phase: the remote library server must be
// rewritten first (to learn the new item id), then the local cache row is
// updated in a DB transaction. If the remote rewrite succeeds but the DB
// transaction then fails, the library server and the cache disagree. Each mode
// sets `remoteRemapped` the moment its remote phase commits, so the caller can
// tell the operator the remap landed remotely and a re-sync will reconcile the
// cache, rather than implying nothing happened. `plexKeysTouched` names the
// Plex items a run set out to remap, the moment it knows them — the cached
// candidate lists that go stale (fix-match-candidate-cache.ts).
export type RunState = { remoteRemapped: boolean; plexKeysTouched: string[] };

type Source = "plex" | "jellyfin";

function auditFixMatch(actor: FixMatchActor, target: string, details: Record<string, unknown>): void {
  void logAudit({ ...actor.ctx, userId: actor.userId, userName: actor.userName, action: "FIX_MATCH", target, details });
}

// Plays recorded while the item carried the wrong id keep it forever otherwise:
// resolveShowTmdbId / the poller read the library row at RECORD time, so a watch
// of the mismatched item landed on the old tmdbId, and after the remap the watch
// grade (guardrail 34a) still scores the request unwatched while activity views
// attribute the plays to the wrong title. Scoped to THIS source + instance —
// another server may legitimately hold the old id (guardrail 35) — and never by
// tmdbId alone. A movie play's `sourceItemId` is the item's own ratingKey /
// item id, so movies are pinned to the moved ids. An EPISODE play's
// `sourceItemId` is the episode's key, so TV goes by the show: when every copy
// left the old row, by the row's own key (tmdbId, mediaType, serverInstance) —
// the only row a play on this instance could have resolved the old id through,
// which also covers plays recorded before `sourceShowId` existed. When some
// copy stayed (it failed, or Plex says it is another title), only plays whose
// `sourceShowId` names a moved copy move; the rest stay with the old row.
export function playReattributionWhere(
  source: Source,
  serverInstance: string,
  mediaType: "MOVIE" | "TV",
  tmdbId: number,
  movedIds: string[],
  everyCopyMoved: boolean,
) {
  if (mediaType === "MOVIE") return { source, serverInstance, tmdbId, mediaType: "MOVIE" as const, sourceItemId: { in: movedIds } };
  if (everyCopyMoved) return { source, serverInstance, tmdbId, mediaType: "TV" as const };
  return { source, serverInstance, tmdbId, mediaType: "TV" as const, sourceShowId: { in: movedIds } };
}

type PlayTx = Pick<LibraryTxClient, "playHistory" | "activeSession">;

async function reattributePlaysInTx(tx: PlayTx, where: ReturnType<typeof playReattributionWhere> | ItemPlaysWhere, correctTmdbId: number): Promise<void> {
  await tx.playHistory.updateMany({ where, data: { tmdbId: correctTmdbId } });
  await tx.activeSession.updateMany({ where, data: { tmdbId: correctTmdbId } });
}

// Stale episode cache references the old tmdbId; it must be cleared so the
// re-cache picks up the correct id. TV only: TVEpisodeCache has no mediaType
// column and TMDB's movie and TV ids overlap, so a MOVIE fix purging by its old
// id wiped the episodes of whatever show shares that number. Skipped while this
// instance's old row survives (copies that failed still hold the old id and
// their episodes). TVEpisodeCache has NO serverInstance column either, so the
// purge would also erase another server's legitimately-matched rows for the old
// id: only purge when no other instance still holds it; otherwise the sync
// orchestrator's union rebuild owns the shared namespace.
async function purgeOldEpisodeCacheInTx(
  tx: Pick<LibraryTxClient, "plexLibraryItem" | "jellyfinLibraryItem" | "tVEpisodeCache">,
  source: Source,
  oldTmdbId: number,
  mediaType: "MOVIE" | "TV",
  serverInstance: string,
  oldRowRemoved: boolean,
): Promise<void> {
  if (mediaType !== "TV" || !oldRowRemoved) return;
  const where = { tmdbId: oldTmdbId, mediaType, serverInstance: { not: serverInstance } };
  const othersHoldOldId = source === "plex"
    ? await tx.plexLibraryItem.count({ where })
    : await tx.jellyfinLibraryItem.count({ where });
  if (othersHoldOldId === 0) {
    await tx.tVEpisodeCache.deleteMany({ where: { source, tmdbId: oldTmdbId } });
  }
}

// Repopulates the corrected show's episode cache from the server just fixed, in
// the background. TVEpisodeCache has NO serverInstance column: every server of a
// source shares one namespace for a given show, so repopulating from the one
// server we just re-matched DELETES any other server's rows for this show. Only
// safe to own when this is the sole registered server of its source; otherwise
// leave the show to the sync orchestrator, which rebuilds from the union of all
// of them.
function recacheEpisodesInBackground(source: Source, load: () => Promise<EpisodeCacheRow[]>, correctTmdbId: number): void {
  load()
    .then(async (episodes) => {
      if (episodes.length === 0) return;
      if ((await getMediaInstances(source)).length > 1) return;
      await prisma.$transaction(async (tx) => {
        await lockEpisodeCacheInTx(tx, source);
        await tx.tVEpisodeCache.deleteMany({ where: { source, tmdbId: correctTmdbId } });
        await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source, ...e })));
      }, { timeout: BATCH_TX_TIMEOUT });
    })
    .catch((err) => console.error("[fix-match]", `${source === "plex" ? "Plex" : "Jellyfin"} episode re-cache failed:`, err));
}

const rowKey = (tmdbId: number, mediaType: "MOVIE" | "TV", serverInstance: string) =>
  ({ tmdbId_mediaType_serverInstance: { tmdbId, mediaType, serverInstance } });

// ── Item mode ────────────────────────────────────────────────────────────────

type ItemPlaysWhere =
  | { source: Source; serverInstance: string; mediaType: "MOVIE"; sourceItemId: { in: string[] } }
  | { source: Source; serverInstance: string; mediaType: "TV"; sourceShowId: { in: string[] } };

// A target row the move creates starts with the arr's title and year when the
// fix lands on the arr's own id, so it reads as a title before the next sync.
export function itemDisplay(input: FixMatchInput): MovedTitleDisplay | undefined {
  const arr = input.itemArr;
  if (!arr || arr.tmdbId === null || arr.tmdbId !== input.correctTmdbId) return undefined;
  return { title: arr.title, year: arr.year != null ? String(arr.year) : null };
}

// Item mode (the library match check's Fix, guardrail 37e): ONE server item,
// never every copy holding `tmdbId` — a title can hold a correct copy beside the
// wrong one. Its key, path and current id come from the stored flag.
export async function runItemMode(
  input: FixMatchInput, itemKey: string, actor: FixMatchActor, opts: RunOpts, t: Translator, state: RunState,
): Promise<FixMatchJobResult> {
  const { server, tmdbId, mediaType, correctTmdbId, canonicalGuid, serverInstance } = input;
  let newKey = itemKey;
  let conflatedWarning: string | null = null;
  // The remote helpers own the progress phase from their first step.
  if (server === "plex") {
    state.plexKeysTouched = [itemKey];
    const plexResult = await fixPlexMatch({
      ratingKey: itemKey, correctTmdbId, mediaType, instance: serverInstance, preselectedGuid: canonicalGuid, report: opts.report, cleanBundles: true,
    });
    if (plexResult.conflated) conflatedWarning = t("apiAdmin.fixMatch.plexConflated", { tmdbId: correctTmdbId });
  } else {
    newKey = (await fixJellyfinMatch({
      itemId: itemKey, correctTmdbId, mediaType, instance: serverInstance, filePath: input.itemPath ?? null,
      previousTmdbId: tmdbId, background: opts.background, report: opts.report,
    })).newItemId;
  }
  state.remoteRemapped = true;
  const keys = Array.from(new Set([itemKey, newKey]));
  await prisma.$transaction(async (tx) => {
    // The sync's library lock, so a concurrent sync can't interleave. The
    // episode cache is left to the next full sync: it has no item key, so
    // one copy's episodes can't be moved out of a shared title.
    await lockLibraryInTx(tx, server);
    await moveItemToTitleInTx(tx, server, serverInstance, mediaType, itemKey, newKey, correctTmdbId, input.itemPath ?? null, itemDisplay(input));
    // Plays of THIS item only, whatever id they were recorded under (none,
    // for an unmatched item): a movie by its own key, an episode by its show's.
    const plays: ItemPlaysWhere = mediaType === "MOVIE"
      ? { source: server, serverInstance, mediaType: "MOVIE", sourceItemId: { in: keys } }
      : { source: server, serverInstance, mediaType: "TV", sourceShowId: { in: keys } };
    await reattributePlaysInTx(tx, plays, correctTmdbId);
    await dropMatchFlagInTx(tx, server, serverInstance, itemKey);
  }, { timeout: BATCH_TX_TIMEOUT });
  auditFixMatch(actor, `tmdb:${tmdbId > 0 ? tmdbId : correctTmdbId}`, {
    type: "fix-match", mode: "item", source: server, itemKey, fromTmdbId: tmdbId > 0 ? tmdbId : null, toTmdbId: correctTmdbId, mediaType, serverInstance,
  });
  return conflatedWarning ? { ok: true, warning: conflatedWarning } : { ok: true };
}

// ── Plex title mode ──────────────────────────────────────────────────────────

type PlexCopies = {
  result: PlexRemapResult;
  // `moved` join the corrected row and have their plays reattributed.
  // `dropped` leave the old row: the moved ones plus any key Plex says is a
  // third title, which must not be merged onto the correction or its plays
  // rewritten. `failed` stay on the old row.
  moved: Set<string>;
  dropped: Set<string>;
  failed: string[];
};

// The canonical copy (the one the admin picked a candidate for) first — its
// failure aborts the job. Then every OTHER copy of the title (guardrail 37c),
// the Plex twin of the Jellyfin loop: left on the old match, the next sync could
// elect an unfixed copy and revert the correction. Serial, like Jellyfin's, and
// a copy is only remapped if Plex says it still carries the old id. The
// library-wide bundle clean runs for the first copy only.
async function remapPlexCopies(
  input: FixMatchInput, canonicalKey: string, extraKeys: string[], opts: RunOpts, state: RunState,
): Promise<PlexCopies> {
  const { tmdbId, mediaType, correctTmdbId, canonicalGuid, serverInstance } = input;
  const copies = 1 + extraKeys.length;
  // Tag every progress report with which copy is being worked on.
  const copyReport = (copy: number): FixMatchReport => (p) => opts.report?.({ ...p, copy, copies });
  const remap = (ratingKey: string, copy: number, cleanBundles: boolean) => fixPlexMatch({
    ratingKey, correctTmdbId, mediaType, instance: serverInstance, preselectedGuid: canonicalGuid, report: copyReport(copy), cleanBundles,
  });
  const result = await remap(canonicalKey, 1, true);
  state.remoteRemapped = true;

  const moved = new Set<string>([canonicalKey]);
  const dropped = new Set<string>([canonicalKey]);
  const failed: string[] = [];
  for (const [idx, key] of extraKeys.entries()) {
    try {
      const claim = await plexCopyClaim(serverInstance, key, tmdbId, correctTmdbId);
      if (claim === null) { failed.push(key); continue; }
      // A different title: drop it from this row and leave its own row, its
      // Plex item, and its plays untouched.
      if (claim === "other") { dropped.add(key); continue; }
      if (claim === "old") await remap(key, idx + 2, false);
      moved.add(key);
      dropped.add(key);
    } catch (err) {
      console.error("[fix-match]", `plex copy ${key} failed:`, err instanceof Error ? err.message : err);
      failed.push(key);
    }
  }
  return { result, moved, dropped, failed };
}

async function writePlexRemapInTx(
  tx: LibraryTxClient,
  input: FixMatchInput,
  copies: PlexCopies,
  item: { plexRatingKey: string; filePath: string | null },
): Promise<void> {
  const { tmdbId, mediaType, correctTmdbId, serverInstance } = input;
  // The same locks the sync orchestrator takes (library, then episode cache —
  // one global order, so no deadlock): a concurrent sync can't clobber or
  // interleave this manual remap.
  await lockLibraryInTx(tx, "plex");
  await lockEpisodeCacheInTx(tx, "plex");
  // Both rows are read here, under the lock, BEFORE either is touched: the
  // remote work above ran unlocked for minutes, so a sync may have removed the
  // old row or changed its keys since the route read it. Its descriptive
  // columns carry over, and the target's own keys are merged, not replaced.
  const oldWhere = rowKey(tmdbId, mediaType, serverInstance);
  const targetWhere = rowKey(correctTmdbId, mediaType, serverInstance);
  const removed = await tx.plexLibraryItem.findUnique({ where: oldWhere });
  const target = await tx.plexLibraryItem.findUnique({ where: targetWhere });
  const remainder = remainingOnOldRow(removed?.plexRatingKey ?? null, unionKeys(removed?.plexRatingKeys), copies.dropped);
  const oldRowWhere = { tmdbId, mediaType, serverInstance };
  if (remainder.delete) {
    // deleteMany, NOT delete: a missing row (a sync already reconciled it)
    // must be a no-op — `delete` throws P2025 and would report a landed remap
    // as a failed job (guardrail 37a).
    await tx.plexLibraryItem.deleteMany({ where: oldRowWhere });
  } else {
    // Copies that could not be remapped still carry the old match: they stay
    // on the old row so their plays keep resolving. updateMany for the same
    // reason as above. The file path leaves only with the copy it belongs to.
    const pathMoved = !!removed?.plexRatingKey && copies.dropped.has(removed.plexRatingKey);
    await tx.plexLibraryItem.updateMany({
      where: oldRowWhere,
      data: { plexRatingKey: remainder.canonicalKey, plexRatingKeys: remainder.keys, ...(pathMoved ? { filePath: null } : {}) },
    });
  }
  const movedList = [...copies.moved];
  const canonicalKey = item.plexRatingKey;
  const mergedKeys = unionKeys([target?.plexRatingKey ?? canonicalKey], target?.plexRatingKeys, movedList);
  const meta = carryMeta(LIBRARY_META_KEYS, target, removed);
  await tx.plexLibraryItem.upsert({
    where: targetWhere,
    create: { tmdbId: correctTmdbId, mediaType, serverInstance, filePath: item.filePath, plexRatingKey: canonicalKey, plexRatingKeys: mergedKeys, ...meta },
    // filePath follows the ratingKey: a pre-existing row for the corrected
    // id (a correctly matched copy) otherwise kept ANOTHER file's path
    // beside this item's key until the next full sync. The target's own
    // canonical key stays canonical; this run's keys join its set.
    update: { plexRatingKey: target?.plexRatingKey ?? canonicalKey, plexRatingKeys: mergedKeys, filePath: target?.plexRatingKey ? (target.filePath ?? item.filePath) : item.filePath, ...meta },
  });
  // Same tx as the row rewrite so the cache and the history never disagree
  // about which title this item is.
  const everyCopyMoved = remainder.delete && copies.dropped.size === copies.moved.size;
  await reattributePlaysInTx(tx, playReattributionWhere("plex", serverInstance, mediaType, tmdbId, movedList, everyCopyMoved), correctTmdbId);
  await purgeOldEpisodeCacheInTx(tx, "plex", tmdbId, mediaType, serverInstance, remainder.delete);
}

export async function runPlexTitleMode(
  input: FixMatchInput, actor: FixMatchActor, opts: RunOpts, t: Translator, state: RunState,
): Promise<FixMatchJobResult> {
  const { tmdbId, mediaType, correctTmdbId, serverInstance } = input;
  const item = await prisma.plexLibraryItem.findFirst({
    where: { tmdbId, mediaType, serverInstance },
    select: { plexRatingKey: true, plexRatingKeys: true, filePath: true },
  });
  if (!item?.plexRatingKey) {
    throw new FixMatchError(t("apiAdmin.fixMatch.plexRatingKeyNotFound"), 404);
  }
  const canonicalKey = item.plexRatingKey;
  const extraKeys = unionKeys(item.plexRatingKeys).filter((k) => k !== canonicalKey);
  state.plexKeysTouched = [canonicalKey, ...extraKeys];
  const copies = await remapPlexCopies(input, canonicalKey, extraKeys, opts, state);
  const partialWarning = copies.failed.length > 0
    ? t("apiAdmin.fixMatch.plexPartial", {
      tmdbId: correctTmdbId, applied: copies.moved.size, total: copies.moved.size + copies.failed.length, failed: copies.failed.length,
    })
    : null;

  await prisma.$transaction(
    (tx) => writePlexRemapInTx(tx, input, copies, { plexRatingKey: canonicalKey, filePath: item.filePath }),
    { timeout: BATCH_TX_TIMEOUT },
  );
  auditFixMatch(actor, `tmdb:${tmdbId}`, { type: "fix-match", source: "plex", fromTmdbId: tmdbId, toTmdbId: correctTmdbId, mediaType, serverInstance });

  if (mediaType === "TV") {
    const { serverUrl, token } = copies.result;
    recacheEpisodesInBackground("plex", () => getPlexEpisodesForShow(serverUrl, token, canonicalKey, correctTmdbId), correctTmdbId);
  }
  if (copies.result.conflated) {
    const conflated = t("apiAdmin.fixMatch.plexConflated", { tmdbId: correctTmdbId });
    return { ok: true, warning: partialWarning ? `${conflated} ${partialWarning}` : conflated };
  }
  return partialWarning ? { ok: true, warning: partialWarning } : { ok: true };
}

// ── Jellyfin title mode ──────────────────────────────────────────────────────

type JellyfinApplied = { originalId: string; newItemId: string; baseUrl: string; apiKey: string };

// EVERY copy, not just the stored id (guardrail 37), one after another: each
// call drives a FullRefresh on the server and then polls for confirmation, and
// hammering a Jellyfin box with parallel metadata refreshes is how these calls
// start timing out. A copy that fails is recorded and the rest still run; the
// first failure is kept so a title whose every copy failed can say why.
async function remapJellyfinCopies(
  input: FixMatchInput, targetItemIds: string[], canonical: { id: string | null; filePath: string | null }, opts: RunOpts,
): Promise<{ applied: JellyfinApplied[]; failed: string[]; firstError: unknown }> {
  const { tmdbId, mediaType, correctTmdbId, serverInstance } = input;
  const applied: JellyfinApplied[] = [];
  const failed: string[] = [];
  let firstError: unknown = null;
  const safeCopyIds = targetItemIds.map(sanitizeJellyfinId);
  for (const [copyIdx, targetId] of targetItemIds.entries()) {
    const report: FixMatchReport = (p) => opts.report?.({ ...p, copy: copyIdx + 1, copies: targetItemIds.length });
    // The row's filePath belongs to the canonical copy (`jellyfinItemId`) —
    // it is written from the same winning item. Handing it to another copy
    // pointed that copy's fallback search at the canonical one, so only the
    // canonical copy gets it; the others confirm by reading themselves.
    const filePath = targetId === canonical.id ? canonical.filePath : null;
    const safeTarget = sanitizeJellyfinId(targetId);
    try {
      const result = await fixJellyfinMatch({
        itemId: targetId, correctTmdbId, mediaType, instance: serverInstance, filePath, previousTmdbId: tmdbId,
        background: opts.background, report, siblingItemIds: new Set(safeCopyIds.filter((id) => id !== safeTarget)),
      });
      applied.push({ originalId: targetId, ...result });
    } catch (err) {
      console.error("[fix-match]", `jellyfin copy ${targetId} failed:`, err instanceof Error ? err.message : String(err));
      failed.push(targetId);
      if (failed.length === 1) firstError = err;
    }
  }
  return { applied, failed, firstError };
}

async function writeJellyfinRemapInTx(
  tx: LibraryTxClient,
  input: FixMatchInput,
  applied: JellyfinApplied[],
  movedFilePath: string | null,
): Promise<void> {
  const { tmdbId, mediaType, correctTmdbId, serverInstance } = input;
  const resolvedItemId = applied[0].newItemId;
  const resolvedItemIds = unionKeys(applied.map((r) => r.newItemId));
  // The copies that moved, under the ids the old row knew them by. A copy that
  // failed still carries the old match on the server: it stays on the old row
  // (guardrail 37a's "copies that fail stay on the old row", as in the Plex
  // twin) and its plays stay where they are.
  const movedOriginalIds = new Set(applied.map((r) => r.originalId));
  // Same locks as the sync orchestrator (library, then episode cache), so a
  // concurrent sync can't clobber/interleave this manual remap.
  await lockLibraryInTx(tx, "jellyfin");
  await lockEpisodeCacheInTx(tx, "jellyfin");
  const oldWhere = rowKey(tmdbId, mediaType, serverInstance);
  const targetWhere = rowKey(correctTmdbId, mediaType, serverInstance);
  // The old row as it is NOW, under the lock: the confirmation poll ran
  // unlocked for up to ~10 minutes in background mode, so a library sync may
  // have reconciled the row or changed its ids since the route read it.
  const removedRow = await tx.jellyfinLibraryItem.findUnique({ where: oldWhere });
  const remainder = remainingOnOldRow(removedRow?.jellyfinItemId ?? null, unionKeys(removedRow?.jellyfinItemIds), movedOriginalIds);
  const oldRowWhere = { tmdbId, mediaType, serverInstance };
  if (remainder.delete) {
    // deleteMany, NOT delete: a row already gone must be a no-op, never a
    // P2025 that reports a landed remap as a failed job (guardrail 37a).
    await tx.jellyfinLibraryItem.deleteMany({ where: oldRowWhere });
  } else {
    // updateMany for the same reason. The file path leaves only with the
    // canonical copy.
    const canonicalMoved = !!removedRow?.jellyfinItemId && movedOriginalIds.has(removedRow.jellyfinItemId);
    await tx.jellyfinLibraryItem.updateMany({
      where: oldRowWhere,
      data: { jellyfinItemId: remainder.canonicalKey, jellyfinItemIds: remainder.keys, ...(canonicalMoved ? { filePath: null } : {}) },
    });
  }
  // The target row may already exist — a correctly matched copy of the
  // same title, or the copy a previous partial run DID move (the retry the
  // jellyfinPartial warning itself invites). Its ids are copies this run
  // never touched; REPLACING them dropped them, and until the next full sync
  // rewrote the row the 5s poller's has/hasSome lookup no longer recognised
  // their SeriesId — guardrail 37's exact failure. Write the UNION, its own
  // canonical id included (a legacy row's array can be empty), and keep that
  // canonical id and its file path canonical, as the Plex twin does.
  const existingTarget = await tx.jellyfinLibraryItem.findUnique({ where: targetWhere });
  const meta = carryMeta(JELLYFIN_META_KEYS, existingTarget, removedRow);
  const mergedItemIds = unionKeys([existingTarget?.jellyfinItemId], existingTarget?.jellyfinItemIds, resolvedItemIds);
  await tx.jellyfinLibraryItem.upsert({
    where: targetWhere,
    create: { tmdbId: correctTmdbId, mediaType, serverInstance, filePath: movedFilePath, jellyfinItemId: resolvedItemId, jellyfinItemIds: resolvedItemIds, ...meta },
    update: {
      jellyfinItemId: existingTarget?.jellyfinItemId ?? resolvedItemId,
      jellyfinItemIds: mergedItemIds,
      filePath: existingTarget?.jellyfinItemId ? (existingTarget.filePath ?? movedFilePath) : movedFilePath,
      ...meta,
    },
  });
  // The ids a play could carry are the moved copies as they were BEFORE the
  // remap plus whatever Jellyfin reports them as now — never a copy that
  // failed and still carries the old match.
  const movedIds = unionKeys([...movedOriginalIds], resolvedItemIds);
  await reattributePlaysInTx(tx, playReattributionWhere("jellyfin", serverInstance, mediaType, tmdbId, movedIds, remainder.delete), correctTmdbId);
  await purgeOldEpisodeCacheInTx(tx, "jellyfin", tmdbId, mediaType, serverInstance, remainder.delete);
}

export async function runJellyfinTitleMode(
  input: FixMatchInput, actor: FixMatchActor, opts: RunOpts, t: Translator, state: RunState,
): Promise<FixMatchJobResult> {
  const { tmdbId, mediaType, correctTmdbId, serverInstance } = input;
  const item = await prisma.jellyfinLibraryItem.findFirst({
    where: { tmdbId, mediaType, serverInstance },
    select: { jellyfinItemId: true, jellyfinItemIds: true, filePath: true },
  });
  // EVERY copy, not just the stored id (guardrail 37). A title in two
  // libraries is mismatched on the server in both places; remapping one left
  // the other reporting the old tmdbId, so the very next library sync could
  // elect the unfixed copy and the admin's correction silently reverted.
  // Deduped and ordered with the stored id first — `jellyfinItemIds` already
  // contains it on any row written since that column landed.
  const targetItemIds = unionKeys([item?.jellyfinItemId], item?.jellyfinItemIds);
  if (targetItemIds.length === 0) {
    throw new FixMatchError(t("apiAdmin.fixMatch.jellyfinItemNotFound"), 404);
  }
  const canonical = { id: item?.jellyfinItemId ?? null, filePath: item?.filePath ?? null };
  const { applied, failed, firstError } = await remapJellyfinCopies(input, targetItemIds, canonical, opts);
  // Only a total failure aborts, with the first copy's own error so its
  // diagnosis reaches the admin (one copy: exactly that copy's failure). With
  // several, refusing to record the copies that DID move would leave the DB
  // claiming a match the server no longer has.
  if (applied.length === 0) throw firstError;
  state.remoteRemapped = true;
  const partialWarning = failed.length > 0
    ? t("apiAdmin.fixMatch.jellyfinPartial", { tmdbId: correctTmdbId, applied: applied.length, total: targetItemIds.length, failed: failed.length })
    : null;
  // The row's filePath is the canonical copy's: it moves only with that copy.
  const canonicalMoved = !!canonical.id && applied.some((r) => r.originalId === canonical.id);
  const movedFilePath = canonicalMoved ? canonical.filePath : null;

  await prisma.$transaction(
    (tx) => writeJellyfinRemapInTx(tx, input, applied, movedFilePath),
    { timeout: BATCH_TX_TIMEOUT },
  );
  auditFixMatch(actor, `tmdb:${tmdbId}`, { type: "fix-match", source: "jellyfin", fromTmdbId: tmdbId, toTmdbId: correctTmdbId, mediaType, serverInstance });

  if (mediaType === "TV") {
    const { baseUrl, apiKey, newItemId } = applied[0];
    recacheEpisodesInBackground("jellyfin", () => getJellyfinEpisodesForShow(baseUrl, apiKey, newItemId, correctTmdbId), correctTmdbId);
  }
  return partialWarning ? { ok: true, warning: partialWarning } : { ok: true };
}
