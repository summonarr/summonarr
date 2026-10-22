import "server-only";
// Watch sync, Plex → Jellyfin — the DATA half (prisma + the two servers). The
// rules live in watch-sync.ts; read its header first. Run by the watch-sync
// cron (/api/cron/watch-sync, lock WATCH_SYNC_LOCK_ID) and by the admin page's
// "Run now", always under that one lock.
//
// One run, in two phases:
//   1. PLAN. Per Plex server with an enabled pair: read Plex's history once —
//      the whole history when any pair on it is new, otherwise back to the
//      oldest pair's read point minus the overlap — then for each pair resolve
//      its plays to Jellyfin item ids and insert them "pending" in the pair's
//      ledger (WatchSyncMark, createMany skipDuplicates: an item is planned once
//      per pair, ever). The pair's read point only moves after its plan was
//      queued in full; a failed Jellyfin lookup holds it, so the next run
//      re-reads rather than skipping episodes it could not place.
//   2. APPLY. Per pair: up to WATCH_SYNC_BATCH pending (or retryable failed)
//      items. The Jellyfin user's played list is read first, and an item they
//      already played is recorded "already" without a call — marking it would
//      bump its PlayCount (markJellyfinPlayed's note).
//
// Every phase observes the lock's AbortSignal and RETURNS on abort (guardrail 41).

import { prisma } from "./prisma";
import { mapLimit } from "./concurrency";
import { getPlexConfig } from "./plex-config";
import { getJellyfinConfig } from "./jellyfin-config";
import { getPlexUser, getPlexWatchHistory } from "./plex";
import { getJellyfinEpisodeIds, getJellyfinUserPlayedItems, markJellyfinPlayed } from "./jellyfin";
import { indexPlexRowsByKey } from "./plex-dedupe";
import type { PlexHistoryEntry } from "./upstream-watch";
import {
  WATCH_SYNC_BATCH,
  WATCH_SYNC_MAX_ATTEMPTS,
  historyStopBefore,
  indexEpisodes,
  newestViewedAt,
  planMarks,
  playsForPair,
  safeWatchSyncError,
  seriesNeeded,
  type EpisodeIdRow,
  type JellyfinTargets,
  type PlexTitle,
  type WatchSyncPairInput,
  type WatchSyncPlay,
} from "./watch-sync";

export const WATCH_SYNC_FEATURE_KEY = "feature.admin.watchSync";

// Ledger inserts are idempotent (skipDuplicates) and need no transaction, so
// they are chunked here directly rather than through batchCreateMany, whose
// void return can't report how many rows were new.
const LEDGER_INSERT_CHUNK = 5_000;
// Concurrent Jellyfin calls while applying one pair's batch.
const APPLY_CONCURRENCY = 4;

export interface WatchSyncPairResult {
  pairId: string;
  // Newly queued items this run.
  queued: number;
  // This account's Plex plays whose title isn't in the Plex library cache.
  unresolved: number;
  // Plays whose title or episode isn't on the pair's Jellyfin server.
  unmatched: number;
  marked: number;
  already: number;
  missing: number;
  failed: number;
  error?: string;
}

export interface WatchSyncRunResult {
  pairs: WatchSyncPairResult[];
  aborted: boolean;
}

export function watchSyncProblems(result: WatchSyncRunResult): number {
  return result.pairs.filter((p) => p.error !== undefined || p.failed > 0).length;
}

type PairRow = {
  id: string;
  historyReadTo: Date | null;
  plexUser: { source: string; serverInstance: string; sourceUserId: string; isServerAdmin: boolean };
  jellyfinUser: { source: string; serverInstance: string; sourceUserId: string; active: boolean };
};

function emptyResult(pairId: string): WatchSyncPairResult {
  return { pairId, queued: 0, unresolved: 0, unmatched: 0, marked: 0, already: 0, missing: 0, failed: 0 };
}

export async function runWatchSync({ signal, pairIds }: { signal?: AbortSignal; pairIds?: readonly string[] } = {}): Promise<WatchSyncRunResult> {
  const out: WatchSyncRunResult = { pairs: [], aborted: false };
  if (signal?.aborted) return { ...out, aborted: true };

  const pairs: PairRow[] = await prisma.watchSyncPair.findMany({
    where: { enabled: true, ...(pairIds ? { id: { in: [...pairIds] } } : {}) },
    select: {
      id: true,
      historyReadTo: true,
      plexUser: { select: { source: true, serverInstance: true, sourceUserId: true, isServerAdmin: true } },
      jellyfinUser: { select: { source: true, serverInstance: true, sourceUserId: true, active: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (pairs.length === 0) return out;

  const results = new Map<string, WatchSyncPairResult>(pairs.map((p) => [p.id, emptyResult(p.id)]));
  const fail = (id: string, err: unknown) => {
    const r = results.get(id);
    if (r && r.error === undefined) r.error = typeof err === "string" ? err : safeWatchSyncError(err);
  };

  // A pair whose rows are not (plex, jellyfin) can't come from the admin route,
  // but a hand-edited row must not reach a server.
  const valid = pairs.filter((p) => {
    if (p.plexUser.source === "plex" && p.jellyfinUser.source === "jellyfin") return true;
    fail(p.id, "Pair does not link a Plex account to a Jellyfin user");
    return false;
  });

  const jellyfin = new JellyfinLookups(signal);

  // ── 1. PLAN ────────────────────────────────────────────────────────────────
  const byPlex = new Map<string, PairRow[]>();
  for (const p of valid) {
    const list = byPlex.get(p.plexUser.serverInstance);
    if (list) list.push(p);
    else byPlex.set(p.plexUser.serverInstance, [p]);
  }
  for (const [slug, group] of byPlex) {
    if (signal?.aborted) return finish(out, results, true);
    await planPlexServer(slug, group, jellyfin, results, fail, signal);
  }

  // ── 2. APPLY ───────────────────────────────────────────────────────────────
  for (const p of valid) {
    if (signal?.aborted) return finish(out, results, true);
    await applyPair(p, results.get(p.id)!, fail, signal);
  }

  const done = finish(out, results, signal?.aborted === true);
  // Recorded per pair for the admin page. Best-effort: a failed write must not
  // turn a run that marked items into an error.
  const now = new Date();
  for (const r of done.pairs) {
    await prisma.watchSyncPair
      .update({ where: { id: r.pairId }, data: { lastRunAt: now, lastResult: { ...r } } })
      .catch((err) => console.error("[watch-sync] could not record a pair's result:", safeWatchSyncError(err)));
  }
  return done;
}

function finish(out: WatchSyncRunResult, results: Map<string, WatchSyncPairResult>, aborted: boolean): WatchSyncRunResult {
  return { pairs: [...results.values()], aborted: aborted || out.aborted };
}

async function planPlexServer(
  slug: string,
  group: PairRow[],
  jellyfin: JellyfinLookups,
  results: Map<string, WatchSyncPairResult>,
  fail: (id: string, err: unknown) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  const failAll = (msg: unknown) => { for (const p of group) fail(p.id, msg); };
  // getPlexConfig's findUnique reads (guardrail 35's Plex note).
  const cfg = await getPlexConfig(slug);
  if (!cfg.url || !cfg.token) { failAll("Plex server is not configured"); return; }

  const inputs: WatchSyncPairInput[] = group.map((p) => ({ id: p.id, plexAccountId: p.plexUser.sourceUserId, historyReadTo: p.historyReadTo }));

  let entries: PlexHistoryEntry[];
  let owner: string | null;
  try {
    // The owner's plays are recorded under "1" (normalizePlexAccountId). A failed
    // lookup only means the owner's plays wait for a later run: pairs whose read
    // point would move past them are held below.
    owner = await getPlexUser(cfg.token).then((u) => u.id, () => null);
    const stopBefore = historyStopBefore(inputs);
    const history = await getPlexWatchHistory(cfg.url, cfg.token, stopBefore ? { signal, stopBefore } : { signal });
    entries = history.entries;
  } catch (err) {
    failAll(err);
    return;
  }
  if (signal?.aborted) return;

  const readTo = newestViewedAt(entries);
  const ownerUnresolved = owner === null && entries.some((e) => e.accountId === "1");

  // The Plex library cache, only for keys this run's plays name.
  const keys = new Set<string>();
  for (const e of entries) {
    if (e.kind === "movie") keys.add(e.itemKey);
    else if (e.showKey) keys.add(e.showKey);
  }
  const keyList = [...keys];
  const plexRows = keyList.length === 0
    ? []
    : await prisma.plexLibraryItem.findMany({
        where: { serverInstance: slug, OR: [{ plexRatingKey: { in: keyList } }, { plexRatingKeys: { hasSome: keyList } }] },
        select: { tmdbId: true, mediaType: true, plexRatingKey: true, plexRatingKeys: true },
      });
  const plexIndex = indexPlexRowsByKey(plexRows);
  const plexTitleForKey = (k: string): PlexTitle | null => {
    const row = plexIndex.get(k);
    return row ? { tmdbId: row.tmdbId, mediaType: row.mediaType } : null;
  };

  for (let i = 0; i < group.length; i++) {
    if (signal?.aborted) return;
    const pair = group[i];
    const r = results.get(pair.id)!;
    if (!pair.jellyfinUser.active) { fail(pair.id, "Jellyfin user is no longer on the server"); continue; }
    const { plays, unresolved } = playsForPair(entries, inputs[i], owner, plexTitleForKey);
    r.unresolved = unresolved;

    let targets: JellyfinTargets;
    try {
      targets = await jellyfin.targetsFor(pair.jellyfinUser.serverInstance, plays);
    } catch (err) {
      // Read point held: the next run re-plans this window.
      fail(pair.id, err);
      continue;
    }
    if (signal?.aborted) return;
    const plan = planMarks(plays, targets);
    r.unmatched = plan.unmatched;

    try {
      for (let s = 0; s < plan.marks.length; s += LEDGER_INSERT_CHUNK) {
        const chunk = plan.marks.slice(s, s + LEDGER_INSERT_CHUNK);
        const res = await prisma.watchSyncMark.createMany({
          data: chunk.map((m) => ({ pairId: pair.id, jellyfinItemId: m.jellyfinItemId, datePlayed: m.datePlayed })),
          skipDuplicates: true,
        });
        r.queued += res.count;
      }
    } catch (err) {
      fail(pair.id, err);
      continue;
    }

    // The owner's plays (account "1") couldn't be attributed this run: the
    // owner's pair keeps its read point so they are planned on a later run.
    if (ownerUnresolved && pair.plexUser.isServerAdmin) {
      fail(pair.id, "Couldn't identify the Plex server owner this run; will retry");
      continue;
    }
    if (readTo && (!pair.historyReadTo || readTo > pair.historyReadTo)) {
      await prisma.watchSyncPair.update({ where: { id: pair.id }, data: { historyReadTo: readTo } });
    }
  }
}

async function applyPair(
  pair: PairRow,
  r: WatchSyncPairResult,
  fail: (id: string, err: unknown) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!pair.jellyfinUser.active) return;
  const batch = await prisma.watchSyncMark.findMany({
    where: {
      pairId: pair.id,
      OR: [{ status: "pending" }, { status: "failed", attempts: { lt: WATCH_SYNC_MAX_ATTEMPTS } }],
    },
    select: { jellyfinItemId: true, datePlayed: true },
    orderBy: { createdAt: "asc" },
    take: WATCH_SYNC_BATCH,
  });
  if (batch.length === 0) return;

  const cfg = await getJellyfinConfig(pair.jellyfinUser.serverInstance);
  if (!cfg.url || !cfg.apiKey) { fail(pair.id, "Jellyfin server is not configured"); return; }
  const { url, apiKey } = cfg;
  const userId = pair.jellyfinUser.sourceUserId;

  let played: Set<string>;
  try {
    const list = await getJellyfinUserPlayedItems(url, apiKey, userId, "IsPlayed", { signal });
    played = new Set(list.items.map((i) => i.itemKey));
  } catch (err) {
    // Without the played list a mark could double a PlayCount; try next run.
    fail(pair.id, err);
    return;
  }
  if (signal?.aborted) return;

  const already: string[] = [];
  const marked: string[] = [];
  const missing: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  await mapLimit(batch, APPLY_CONCURRENCY, async (m) => {
    if (signal?.aborted) return;
    if (played.has(m.jellyfinItemId)) { already.push(m.jellyfinItemId); return; }
    try {
      const res = await markJellyfinPlayed(url, apiKey, userId, m.jellyfinItemId, m.datePlayed);
      (res === "marked" ? marked : missing).push(m.jellyfinItemId);
    } catch (err) {
      failed.push({ id: m.jellyfinItemId, error: safeWatchSyncError(err) });
    }
  });

  // Recorded even on abort: what was applied must not be re-applied.
  const setStatus = async (ids: string[], status: string) => {
    if (ids.length === 0) return;
    await prisma.watchSyncMark.updateMany({
      where: { pairId: pair.id, jellyfinItemId: { in: ids } },
      data: { status, lastError: null },
    });
  };
  await setStatus(marked, "marked");
  await setStatus(already, "already");
  await setStatus(missing, "missing");
  for (const f of failed) {
    await prisma.watchSyncMark.update({
      where: { pairId_jellyfinItemId: { pairId: pair.id, jellyfinItemId: f.id } },
      data: { status: "failed", attempts: { increment: 1 }, lastError: f.error },
    });
  }
  r.marked += marked.length;
  r.already += already.length;
  r.missing += missing.length;
  r.failed += failed.length;
}

// Per-run Jellyfin lookups, shared across pairs: library rows per server and
// episode lists per series item, each read at most once.
class JellyfinLookups {
  private readonly signal: AbortSignal | undefined;
  private readonly configs = new Map<string, Promise<{ url: string; apiKey: string }>>();
  private readonly episodes = new Map<string, Promise<EpisodeIdRow[]>>();

  constructor(signal: AbortSignal | undefined) {
    this.signal = signal;
  }

  private config(slug: string): Promise<{ url: string; apiKey: string }> {
    let p = this.configs.get(slug);
    if (!p) {
      p = getJellyfinConfig(slug).then((c) => {
        if (!c.url || !c.apiKey) throw new Error("Jellyfin server is not configured");
        return { url: c.url, apiKey: c.apiKey };
      });
      this.configs.set(slug, p);
    }
    return p;
  }

  private episodesOf(slug: string, seriesId: string): Promise<EpisodeIdRow[]> {
    const key = `${slug}\u0000${seriesId}`;
    let p = this.episodes.get(key);
    if (!p) {
      p = this.config(slug).then((c) => getJellyfinEpisodeIds(c.url, c.apiKey, seriesId));
      // A failure is not cached: the next pair (or run) may succeed.
      p.catch(() => this.episodes.delete(key));
      this.episodes.set(key, p);
    }
    return p;
  }

  async targetsFor(slug: string, plays: readonly WatchSyncPlay[]): Promise<JellyfinTargets> {
    const movieIds = [...new Set(plays.filter((p) => p.mediaType === "MOVIE").map((p) => p.tmdbId))];
    const tvIds = seriesNeeded(plays);
    const movies = new Map<number, string[]>();
    const episodes = new Map<number, Map<string, string[]>>();
    if (movieIds.length === 0 && tvIds.length === 0) return { movies, episodes };
    await this.config(slug);

    const rows = await prisma.jellyfinLibraryItem.findMany({
      where: {
        serverInstance: slug,
        OR: [
          ...(movieIds.length > 0 ? [{ mediaType: "MOVIE" as const, tmdbId: { in: movieIds } }] : []),
          ...(tvIds.length > 0 ? [{ mediaType: "TV" as const, tmdbId: { in: tvIds } }] : []),
        ],
      },
      select: { tmdbId: true, mediaType: true, jellyfinItemId: true, jellyfinItemIds: true },
    });
    // Every copy of a title (guardrail 37: OR the two columns).
    const idsOf = (r: { jellyfinItemId: string | null; jellyfinItemIds: string[] }) =>
      [...new Set([...(r.jellyfinItemId ? [r.jellyfinItemId] : []), ...(r.jellyfinItemIds ?? []).filter(Boolean)])];

    for (const r of rows) {
      if (r.mediaType === "MOVIE") movies.set(r.tmdbId, idsOf(r));
    }
    // Series one at a time: each is a paged Jellyfin walk.
    for (const r of rows) {
      if (r.mediaType !== "TV") continue;
      if (this.signal?.aborted) break;
      const all: EpisodeIdRow[] = [];
      for (const seriesId of idsOf(r)) {
        for (const ep of await this.episodesOf(slug, seriesId)) all.push(ep);
      }
      episodes.set(r.tmdbId, indexEpisodes(all));
    }
    return { movies, episodes };
  }
}

// ── admin page reads ─────────────────────────────────────────────────────────

export interface WatchSyncMarkCounts {
  pending: number;
  marked: number;
  already: number;
  missing: number;
  failed: number;
}

export async function markCountsByPair(pairIds: readonly string[]): Promise<Map<string, WatchSyncMarkCounts>> {
  const out = new Map<string, WatchSyncMarkCounts>();
  for (const id of pairIds) out.set(id, { pending: 0, marked: 0, already: 0, missing: 0, failed: 0 });
  if (pairIds.length === 0) return out;
  const rows = await prisma.watchSyncMark.groupBy({
    by: ["pairId", "status"],
    where: { pairId: { in: [...pairIds] } },
    _count: { _all: true },
  });
  for (const row of rows) {
    const c = out.get(row.pairId);
    if (!c) continue;
    const n = row._count._all;
    if (row.status === "pending") c.pending += n;
    else if (row.status === "marked") c.marked += n;
    else if (row.status === "already") c.already += n;
    else if (row.status === "missing") c.missing += n;
    else if (row.status === "failed") c.failed += n;
  }
  return out;
}
