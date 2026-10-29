import "server-only";
import { prisma } from "./prisma";
import type { MediaType } from "@/generated/prisma";
import { getSyncableMediaInstances } from "./media-instance-registry";
import { getPlexConfig } from "./plex-config";
import { getJellyfinConfig } from "./jellyfin-config";
import { getPlexUser, getPlexWatchHistory } from "./plex";
import { getJellyfinFavorites, getJellyfinPlayedSince } from "./jellyfin";
import { indexPlexRowsByKey } from "./plex-dedupe";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { BATCH_TX_TIMEOUT, batchCreateMany } from "./cron-auth";
import { FOR_YOU_COWATCH_FEATURE_KEY, isFeatureEnabled } from "./features";
import {
  foldJellyfinPlayed,
  foldPlexHistory,
  mergeServerWatchedRows,
  nextReadTo,
  sameServerWatchedRows,
  watchTitleKey,
  type PlayDelta,
  type WatchTitle,
  type WatchedTitleRow,
} from "./server-watch-history";

// Reads each person's watch history (and Jellyfin favorites) from the media
// servers' own records into ServerWatchedTitle — "For You" input only, never a
// play (guardrail 40c; the rules are in server-watch-history.ts).
//
// Runs as phase 0 of the warm-recommendations cron, so it reads the servers at
// that cron's 12-hour cadence and no more often. Light by construction:
//   - Plex: ONE history walk per server, back only to the oldest identity's
//     read point — after the first import that is a page or two;
//   - Jellyfin: per active user, the items played since their read point (one
//     request when nothing changed) plus, for a user linked to an account, one
//     favorites request.
// Best-effort: a server or identity that fails keeps its previous rows and read
// point, and the recommendation run carries on with them.
//
// WHOSE history is read follows the co-watch switch (guardrail 40c). With it
// OFF — the default — only identities linked to a Summonarr account are
// imported: a shelf is built from its own viewer's records, so an unlinked
// identity's history would be stored for nothing (and a Jellyfin one would cost
// a request each run). With it ON, every active identity is imported, because
// the server's co-watching is built from everyone's viewing.

// The import's own share of the warm run. A first import of a big Plex history
// is the long case (~1,000 records per request); later runs take seconds. On
// the budget the run stops between identities — what finished is committed, the
// rest is read next run.
export const SERVER_HISTORY_RUN_BUDGET_MS = 10 * 60 * 1000;
// Plex records read by one walk. A first import of a very long history keeps
// the newest this many plays (the ones that matter for taste) and says so once.
export const PLEX_HISTORY_IMPORT_MAX = 200_000;
// Ids per library lookup (IN / hasSome lists).
const KEY_LOOKUP_PAGE = 500;

export interface ServerHistoryImportResult {
  servers: number;
  // Identities whose rows or read point were written this run.
  identities: number;
  failedServers: number;
  failedIdentities: number;
  // Plays whose item is not in the library cache (deleted since, or unmatched).
  unresolved: number;
  aborted: boolean;
}

// The where clause for whose history is read (see above).
function identityScope(source: "plex" | "jellyfin", slug: string, everyone: boolean) {
  return { source, serverInstance: slug, active: true, ...(everyone ? {} : { userId: { not: null } }) };
}

interface IdentityRow {
  id: string;
  sourceUserId: string;
  isServerAdmin: boolean;
  userId: string | null;
  watchCursor: { readTo: Date | null } | null;
}

interface ResolvedTitle extends WatchTitle {
  title: string;
}

function titleNamer(names: ReadonlyMap<string, string>): (t: WatchTitle) => string {
  return (t) => names.get(watchTitleKey(t.tmdbId, t.mediaType)) ?? `TMDB #${t.tmdbId}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Write one identity's merged rows and its read point together, so a failure
// leaves both as they were and the same plays are read — and counted — once.
// The stored rows are read INSIDE the transaction: the merge adds to them.
async function commitIdentity(
  identityId: string,
  deltas: ReadonlyMap<string, PlayDelta>,
  favorites: ReadonlySet<string> | null,
  names: ReadonlyMap<string, string>,
  readTo: Date | null,
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      if (deltas.size > 0 || favorites !== null) {
        const existing: WatchedTitleRow[] = await tx.serverWatchedTitle.findMany({
          where: { mediaServerUserId: identityId },
          select: { tmdbId: true, mediaType: true, title: true, plays: true, lastWatchedAt: true, favorite: true },
        });
        const merged = mergeServerWatchedRows(existing, deltas, favorites, titleNamer(names));
        if (!sameServerWatchedRows(existing, merged)) {
          await tx.serverWatchedTitle.deleteMany({ where: { mediaServerUserId: identityId } });
          if (merged.length > 0) {
            await batchCreateMany(
              tx.serverWatchedTitle,
              merged.map((r) => ({ ...r, mediaServerUserId: identityId })),
            );
          }
        }
      }
      await tx.serverWatchCursor.upsert({
        where: { mediaServerUserId: identityId },
        create: { mediaServerUserId: identityId, readTo, importedAt: new Date() },
        update: { readTo, importedAt: new Date() },
      });
    },
    { timeout: BATCH_TX_TIMEOUT },
  );
}

// Plex ratingKey (a movie's own, or a show's) → its title on THIS server,
// through the library cache (37c: both key columns, one owner per key — 37b).
async function plexTitles(slug: string, keys: readonly string[]): Promise<Map<string, ResolvedTitle>> {
  const list = [...new Set(keys)];
  const rows: { tmdbId: number; mediaType: MediaType; plexRatingKey: string | null; plexRatingKeys: string[]; title: string | null }[] = [];
  for (let i = 0; i < list.length; i += KEY_LOOKUP_PAGE) {
    const page = list.slice(i, i + KEY_LOOKUP_PAGE);
    for (const r of await prisma.plexLibraryItem.findMany({
      where: { serverInstance: slug, OR: [{ plexRatingKey: { in: page } }, { plexRatingKeys: { hasSome: page } }] },
      select: { tmdbId: true, mediaType: true, plexRatingKey: true, plexRatingKeys: true, title: true },
    })) rows.push(r);
  }
  const index = indexPlexRowsByKey(rows);
  const out = new Map<string, ResolvedTitle>();
  for (const [k, r] of index) out.set(k, { tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title?.trim() || `TMDB #${r.tmdbId}` });
  return out;
}

// Jellyfin item id (a movie's own, or a series id) → its title on THIS server
// (guardrail 37: both id columns). An id held by several titles resolves to the
// lowest tmdbId, the same on every run.
async function jellyfinTitles(slug: string, ids: readonly string[]): Promise<Map<string, ResolvedTitle>> {
  const list = [...new Set(ids)];
  const out = new Map<string, ResolvedTitle>();
  for (let i = 0; i < list.length; i += KEY_LOOKUP_PAGE) {
    const page = list.slice(i, i + KEY_LOOKUP_PAGE);
    const rows = await prisma.jellyfinLibraryItem.findMany({
      where: { serverInstance: slug, OR: [{ jellyfinItemId: { in: page } }, { jellyfinItemIds: { hasSome: page } }] },
      select: { tmdbId: true, mediaType: true, jellyfinItemId: true, jellyfinItemIds: true, title: true },
      orderBy: { tmdbId: "asc" },
    });
    const wanted = new Set(page);
    for (const r of rows) {
      for (const id of [r.jellyfinItemId, ...(r.jellyfinItemIds ?? [])]) {
        if (id && wanted.has(id) && !out.has(id)) {
          out.set(id, { tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title?.trim() || `TMDB #${r.tmdbId}` });
        }
      }
    }
  }
  return out;
}

function namesOf(titles: Iterable<ResolvedTitle>): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of titles) out.set(watchTitleKey(t.tmdbId, t.mediaType), t.title);
  return out;
}

async function importPlexServer(slug: string, everyone: boolean, signal: AbortSignal, result: ServerHistoryImportResult): Promise<void> {
  const cfg = await getPlexConfig(slug);
  const url = cfg.url?.trim();
  const token = cfg.token?.trim();
  if (!url || !token) return;

  const identities: IdentityRow[] = await prisma.mediaServerUser.findMany({
    where: identityScope("plex", slug, everyone),
    select: { id: true, sourceUserId: true, isServerAdmin: true, userId: true, watchCursor: { select: { readTo: true } } },
  });
  if (identities.length === 0) return;
  result.servers++;

  // The owner's plays are recorded under the local account id "1". When
  // plex.tv can't say who the owner is, the owner's read point HOLDS — reading
  // past those plays now would skip them for good (the watch-sync rule).
  const owner = await getPlexUser(token).then((u) => u.id, () => null);
  const eligible = identities.filter((i) => !(owner === null && i.isServerAdmin));
  if (eligible.length === 0) return;

  // Back to the OLDEST read point, so every identity's unread window is inside
  // the walk; an identity never read forces one full walk.
  let stopBefore: Date | undefined;
  for (const i of eligible) {
    const readTo = i.watchCursor?.readTo ?? null;
    if (readTo === null) {
      stopBefore = undefined;
      break;
    }
    if (!stopBefore || readTo < stopBefore) stopBefore = readTo;
  }
  const walkStartedAt = new Date();
  const history = await getPlexWatchHistory(url, token, {
    signal,
    maxItems: PLEX_HISTORY_IMPORT_MAX,
    ...(stopBefore ? { stopBefore } : {}),
  });
  // A walk cut short by the budget is discarded whole: nothing is written and
  // no read point moves, so the next run reads the same window again.
  if (signal.aborted) return;
  if (history.truncated) {
    warnOnChange(
      `server-history:plex:${slug}:truncated`,
      "truncated",
      `[server-history] Plex server "${slug || "default"}" has more than ${PLEX_HISTORY_IMPORT_MAX} history records; For You reads the newest ${PLEX_HISTORY_IMPORT_MAX}`,
    );
  } else {
    forgetWarnOnChange(`server-history:plex:${slug}:truncated`);
  }

  const keys: string[] = [];
  for (const e of history.entries) {
    if (e.kind === "movie") keys.push(e.itemKey);
    else if (e.showKey) keys.push(e.showKey);
  }
  const titles = await plexTitles(slug, keys);
  const names = namesOf(titles.values());
  const titleFor = (k: string) => titles.get(k) ?? null;
  const walkNewest = nextReadTo(null, history.entries.map((e) => e.viewedAt));

  for (const identity of eligible) {
    if (signal.aborted) {
      result.aborted = true;
      return;
    }
    const readTo = identity.watchCursor?.readTo ?? null;
    const { deltas, unresolved } = foldPlexHistory(history.entries, identity.sourceUserId, owner, readTo, titleFor);
    result.unresolved += unresolved;
    // The walk covered everything up to its newest record for EVERY identity,
    // including ones with nothing new. A server with no dated history at all
    // anchors at the walk's start so the next run is incremental, not full.
    const next = nextReadTo(readTo, [walkNewest]) ?? walkStartedAt;
    if (deltas.size === 0 && readTo !== null && next.getTime() === readTo.getTime()) continue;
    try {
      await commitIdentity(identity.id, deltas, null, names, next);
      result.identities++;
    } catch (err) {
      result.failedIdentities++;
      console.error(`[server-history] Plex history write failed for server user ${identity.id}: ${errorText(err)}`);
    }
  }
}

async function importJellyfinServer(slug: string, everyone: boolean, signal: AbortSignal, result: ServerHistoryImportResult): Promise<void> {
  const cfg = await getJellyfinConfig(slug);
  const url = cfg.url?.trim();
  const apiKey = cfg.apiKey?.trim();
  if (!url || !apiKey) return;

  const identities: IdentityRow[] = await prisma.mediaServerUser.findMany({
    where: identityScope("jellyfin", slug, everyone),
    select: { id: true, sourceUserId: true, isServerAdmin: true, userId: true, watchCursor: { select: { readTo: true } } },
  });
  if (identities.length === 0) return;
  result.servers++;

  // One user at a time: these are small requests and the point is to stay light.
  for (const identity of identities) {
    if (signal.aborted) {
      result.aborted = true;
      return;
    }
    const readTo = identity.watchCursor?.readTo ?? null;
    const readStartedAt = new Date();
    try {
      const played = await getJellyfinPlayedSince(url, apiKey, identity.sourceUserId, readTo ? { since: readTo, signal } : { signal });
      // Favorites only matter for a person with an account (they seed THEIR
      // shelf); an unlinked identity's history still feeds co-watching.
      const favorites = identity.userId ? await getJellyfinFavorites(url, apiKey, identity.sourceUserId, { signal }) : null;
      if (signal.aborted) {
        result.aborted = true;
        return;
      }

      const ids: string[] = [];
      for (const p of played) {
        const id = p.kind === "movie" ? p.itemKey : p.showKey;
        if (id) ids.push(id);
      }
      for (const f of favorites ?? []) ids.push(f.itemId);
      const titles = await jellyfinTitles(slug, ids);
      const { deltas, unresolved } = foldJellyfinPlayed(played, readTo, (id) => titles.get(id) ?? null);
      result.unresolved += unresolved;

      let favoriteKeys: Set<string> | null = null;
      if (favorites !== null) {
        favoriteKeys = new Set();
        for (const f of favorites) {
          const t = titles.get(f.itemId);
          if (t && t.mediaType === (f.kind === "movie" ? "MOVIE" : "TV")) favoriteKeys.add(watchTitleKey(t.tmdbId, t.mediaType));
        }
      }
      // A full read that found nothing dated anchors at its own start, so the
      // next read is incremental instead of re-reading the whole list.
      const next = nextReadTo(readTo, played.map((p) => p.lastPlayedAt)) ?? (readTo === null ? readStartedAt : null);
      await commitIdentity(identity.id, deltas, favoriteKeys, namesOf(titles.values()), next);
      result.identities++;
    } catch (err) {
      result.failedIdentities++;
      console.error(`[server-history] Jellyfin history read failed for server user ${identity.id}: ${errorText(err)}`);
    }
  }
}

// One pass over every configured Plex and Jellyfin server. Never throws: a
// failure is counted and logged, and the caller (the warm-recommendations run)
// carries on with whatever is already stored.
export async function importServerWatchHistory(opts: { signal?: AbortSignal; budgetMs?: number } = {}): Promise<ServerHistoryImportResult> {
  const result: ServerHistoryImportResult = { servers: 0, identities: 0, failedServers: 0, failedIdentities: 0, unresolved: 0, aborted: false };
  const budget = AbortSignal.timeout(opts.budgetMs ?? SERVER_HISTORY_RUN_BUDGET_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, budget]) : budget;

  const run = async (service: "plex" | "jellyfin", importOne: (slug: string) => Promise<void>) => {
    let instances: { slug: string }[];
    try {
      instances = await getSyncableMediaInstances(service);
    } catch (err) {
      result.failedServers++;
      console.error(`[server-history] could not list ${service} servers: ${errorText(err)}`);
      return;
    }
    for (const inst of instances) {
      if (signal.aborted) {
        result.aborted = true;
        return;
      }
      const warnKey = `server-history:${service}:${inst.slug}:failed`;
      try {
        await importOne(inst.slug);
        forgetWarnOnChange(warnKey);
      } catch (err) {
        result.failedServers++;
        // The same unreachable server would say so every run (guardrail 7b).
        warnOnChange(
          warnKey,
          errorText(err),
          `[server-history] could not read ${service} server "${inst.slug || "default"}" history; For You keeps what it already has: ${errorText(err)}`,
        );
      }
    }
  };

  // Unreadable flag ⇒ the narrower, viewer-only scope.
  const everyone = await isFeatureEnabled(FOR_YOU_COWATCH_FEATURE_KEY).catch(() => false);
  await run("plex", (slug) => importPlexServer(slug, everyone, signal, result));
  await run("jellyfin", (slug) => importJellyfinServer(slug, everyone, signal, result));
  if (signal.aborted) result.aborted = true;
  return result;
}
