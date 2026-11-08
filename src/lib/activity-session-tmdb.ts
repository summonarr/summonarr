// tmdbId resolution for the Activity overview's live sessions. ActiveSession
// rows the poller couldn't map carry no tmdbId, so the now-playing cards would
// have no poster and no link. The lookup chain, in order of authority:
//   1. the session's own server item in play history (an earlier play of it),
//   2. the session's own server item in the library tables,
//   3. the session's (title, mediaType) in play history — display only.
// Only 1 and 2 may be persisted back onto the session (sessionBackfill).
import { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { indexPlexRowsByKey } from "./plex-dedupe";
import {
  collectUnmappedPairs,
  lookupTitleResolution,
  sessionBackfill,
  toActivityMediaType,
  type ActivityMediaType,
  type TitleResolveMap,
} from "./activity-title-resolve";
import { resolveTitlesToTmdb } from "./activity-title-resolve-data";

export interface SessionTmdbFields {
  source: string;
  serverInstance: string;
  sourceItemId: string | null;
  title: string;
  tmdbId: number | null;
  mediaType: string | null;
}

// The item-level answers carry the matched row's own type, null when the
// history row had none (never guessed as "TV").
export interface ItemResolution {
  tmdbId: number;
  mediaType: string | null;
}
export type ItemResolutionMap = Map<string, ItemResolution>;

export type EffectiveSession<T> = T & {
  effectiveTmdbId: number | null;
  effectiveMediaType: string | null;
  backfill: { tmdbId: number; mediaType: ActivityMediaType } | null;
};

// A sourceItemId is server-local: two servers reuse the same ids, so every key
// carries the instance. Reads and writes go through this one builder.
export function sessionItemKey(serverInstance: string, sourceItemId: string): string {
  return `item:${serverInstance}:${sourceItemId}`;
}

function itemFor(s: SessionTmdbFields, items: ItemResolutionMap): ItemResolution | undefined {
  return s.sourceItemId ? items.get(sessionItemKey(s.serverInstance, s.sourceItemId)) : undefined;
}

// Step 1: the newest mapped play of each session item. Per source, so the
// [source, sourceItemId, …] index serves it — the id alone matches no index's
// leading column — and DISTINCT ON per (serverInstance, sourceItemId) returns
// one row per item instead of every past play of it.
async function historyItemMatches(withItem: readonly (SessionTmdbFields & { sourceItemId: string })[]): Promise<ItemResolutionMap> {
  const out: ItemResolutionMap = new Map();
  const arms = (["plex", "jellyfin"] as const)
    .map((src) => ({ src, ids: withItem.filter((s) => s.source === src).map((s) => s.sourceItemId) }))
    .filter((arm) => arm.ids.length > 0)
    .map((arm) => Prisma.sql`("source" = ${arm.src} AND "sourceItemId" IN (${Prisma.join(arm.ids)}))`);
  if (arms.length === 0) return out;
  const rows = await prisma.$queryRaw<{ serverInstance: string; sourceItemId: string; tmdbId: number; mediaType: string | null }[]>(Prisma.sql`
    SELECT DISTINCT ON ("serverInstance", "sourceItemId") "serverInstance", "sourceItemId", "tmdbId", "mediaType"::text AS "mediaType"
    FROM "PlayHistory"
    WHERE "tmdbId" IS NOT NULL AND (${Prisma.join(arms, " OR ")})
    ORDER BY "serverInstance", "sourceItemId", "startedAt" DESC
  `);
  for (const h of rows) out.set(sessionItemKey(h.serverInstance, h.sourceItemId), { tmdbId: h.tmdbId, mediaType: h.mediaType });
  return out;
}

// Step 2: the library row holding the session's item, both id columns per
// server (guardrails 37 and 37c): a title in two libraries has an id per copy
// and only one is the stored canonical id. Rows predating the array columns are
// `[]`, so the canonical branch stays.
async function libraryItemMatches(stillNeed: readonly (SessionTmdbFields & { sourceItemId: string })[]): Promise<ItemResolutionMap> {
  const out: ItemResolutionMap = new Map();
  const plexPairs = stillNeed
    .filter((s) => s.source === "plex")
    .flatMap((s) => [
      { plexRatingKey: s.sourceItemId, serverInstance: s.serverInstance },
      { plexRatingKeys: { has: s.sourceItemId }, serverInstance: s.serverInstance },
    ]);
  const jellyfinPairs = stillNeed
    .filter((s) => s.source === "jellyfin")
    .flatMap((s) => [
      { jellyfinItemId: s.sourceItemId, serverInstance: s.serverInstance },
      { jellyfinItemIds: { has: s.sourceItemId }, serverInstance: s.serverInstance },
    ]);
  const [plexItems, jellyfinItems] = await Promise.all([
    plexPairs.length > 0
      ? prisma.plexLibraryItem.findMany({
          where: { OR: plexPairs },
          select: { tmdbId: true, mediaType: true, plexRatingKey: true, plexRatingKeys: true, serverInstance: true },
        })
      : [],
    jellyfinPairs.length > 0
      ? prisma.jellyfinLibraryItem.findMany({
          where: { OR: jellyfinPairs },
          select: { tmdbId: true, mediaType: true, jellyfinItemId: true, jellyfinItemIds: true, serverInstance: true },
        })
      : [],
  ]);
  // Each key resolves to its ONE owner per instance (canonical holder, else
  // lowest tmdbId — `indexPlexRowsByKey`), never last-write-wins: an array
  // entry overwriting another row's canonical key made the answer follow
  // findMany's row order, and the overview's backfill PERSISTS it.
  const plexByInstance = new Map<string, Array<(typeof plexItems)[number]>>();
  for (const i of plexItems) {
    const list = plexByInstance.get(i.serverInstance);
    if (list) list.push(i);
    else plexByInstance.set(i.serverInstance, [i]);
  }
  for (const [inst, rows] of plexByInstance) {
    for (const [k, i] of indexPlexRowsByKey(rows)) {
      out.set(sessionItemKey(inst, k), { tmdbId: i.tmdbId, mediaType: i.mediaType });
    }
  }
  for (const i of jellyfinItems) {
    // Every id the row answers to — the session's sourceItemId may be any of them.
    const ids = i.jellyfinItemId ? [i.jellyfinItemId, ...i.jellyfinItemIds] : i.jellyfinItemIds;
    for (const id of ids) out.set(sessionItemKey(i.serverInstance, id), { tmdbId: i.tmdbId, mediaType: i.mediaType });
  }
  return out;
}

/**
 * Applies the lookups to one session. Pure. A session with its own tmdbId is
 * untouched; an item match may be backfilled; a title match feeds the poster
 * and the link only, and the session's own known type is never overwritten by
 * it (activity-title-resolve rule).
 */
export function applySessionResolution<T extends SessionTmdbFields>(
  s: T,
  items: ItemResolutionMap,
  titleResolved: TitleResolveMap,
): EffectiveSession<T> {
  if (s.tmdbId != null) return { ...s, effectiveTmdbId: s.tmdbId, effectiveMediaType: s.mediaType, backfill: null };
  const byItem = itemFor(s, items);
  if (byItem) {
    return {
      ...s,
      effectiveTmdbId: byItem.tmdbId,
      effectiveMediaType: byItem.mediaType ?? s.mediaType,
      backfill: sessionBackfill(s.mediaType, { ...byItem, via: "item" }),
    };
  }
  const byTitle = lookupTitleResolution(titleResolved, s.title, s.mediaType);
  return {
    ...s,
    effectiveTmdbId: byTitle?.tmdbId ?? null,
    effectiveMediaType: toActivityMediaType(s.mediaType) ?? byTitle?.mediaType ?? s.mediaType,
    backfill: null,
  };
}

/** Every session with its effective tmdbId/mediaType and what may be backfilled. */
export async function resolveActiveSessionTmdb<T extends SessionTmdbFields>(
  sessions: readonly T[],
): Promise<EffectiveSession<T>[]> {
  const needing = sessions.filter((s) => s.tmdbId == null);
  const items: ItemResolutionMap = new Map();
  let titleResolved: TitleResolveMap = {};
  if (needing.length > 0) {
    const withItem = needing.filter((s): s is T & { sourceItemId: string } => !!s.sourceItemId);
    for (const [k, v] of await historyItemMatches(withItem)) items.set(k, v);
    const stillNeedLibrary = withItem.filter((s) => !itemFor(s, items));
    if (stillNeedLibrary.length > 0) {
      for (const [k, v] of await libraryItemMatches(stillNeedLibrary)) items.set(k, v);
    }
    // Keyed on (title, mediaType), never the bare title: a TV session titled
    // "Fargo" must not pick up the MOVIE "Fargo"'s tmdbId. Play history only,
    // as before — the library fallback is the per-user page's.
    const stillNeedTitle = needing.filter((s) => !itemFor(s, items));
    titleResolved = await resolveTitlesToTmdb(collectUnmappedPairs(stillNeedTitle), { libraryFallback: false });
  }
  return sessions.map((s) => applySessionResolution(s, items, titleResolved));
}
