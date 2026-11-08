import "server-only";
import { prisma, type PrismaTxClient } from "./prisma";
import { Prisma, type MediaType } from "@/generated/prisma";
import { getSyncableMediaInstances, registeredSlugsForUpdateInTx } from "./media-instance-registry";
import { DEFAULT_MEDIA_INSTANCE } from "./media-instances";
import { linkedIdentityBranches } from "./my-watch-history";
import { getPlexConfig } from "./plex-config";
import { getJellyfinConfig } from "./jellyfin-config";
import { getPlexUser, getPlexWatchHistory } from "./plex";
import { getJellyfinFavorites, getJellyfinPlayedSince } from "./jellyfin";
import { SafeFetchError } from "./safe-fetch";
import { indexPlexRowsByKey } from "./plex-dedupe";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { BATCH_TX_TIMEOUT, batchCreateMany } from "./batch-write";
import { FOR_YOU_COWATCH_FEATURE_KEY, isFeatureEnabled } from "./features";
import {
  UNRESOLVED_HOLD_MS,
  foldJellyfinPlayed,
  foldPlexHistory,
  groupPlexHistoryByAccount,
  heldReadPoint,
  mergeServerWatchedRows,
  nextReadTo,
  sameServerWatchedRows,
  watchTitleKey,
  type FoldBounds,
  type FoldResult,
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
// the server's co-watching is built from everyone's viewing. "Linked" is the
// For You read side's own rule (linkedIdentityBranches, guardrail 34): the FK,
// or an account's provider subject on a row an admin has not pinned.
//
// A NAMED server removed while its import is in flight writes nothing after the
// removal: each identity's commit locks the registry row and re-checks the slug
// (stillRegisteredInTx, the upstream-watch-data.ts twin). The removal writes
// that row first, in the same transaction that deletes these rows.

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

type Source = "plex" | "jellyfin";

// Every account's provider subject on this source, through the read side's own
// linkage rule (linkedIdentityBranches): the second way an identity is linked.
// The 5s poller sets a Plex row's FK only at that person's next play, so a
// friend who signed up since their last one is linked here and not by the FK.
async function accountSubjects(source: Source): Promise<Set<string>> {
  const users = await prisma.user.findMany({
    where: source === "plex" ? { plexUserId: { not: null } } : { jellyfinUserId: { not: null } },
    select: { id: true, plexUserId: true, jellyfinUserId: true },
  });
  const out = new Set<string>();
  for (const u of users) {
    for (const b of linkedIdentityBranches(u)) {
      if ("source" in b && b.source === source) out.add(b.sourceUserId);
    }
  }
  return out;
}

// The where clause for whose history is read (see above). The subject branch
// carries manualUserLink: false, as linkedIdentityBranches' does: an admin's pin
// (or unpin) wins over a subject match.
function identityScope(source: Source, slug: string, everyone: boolean, subjects: ReadonlySet<string>): Prisma.MediaServerUserWhereInput {
  const base = { source, serverInstance: slug, active: true };
  if (everyone) return base;
  const linked: Prisma.MediaServerUserWhereInput[] = [{ userId: { not: null } }];
  if (subjects.size > 0) linked.push({ manualUserLink: false, sourceUserId: { in: [...subjects] } });
  return { ...base, OR: linked };
}

interface IdentityRow {
  id: string;
  sourceUserId: string;
  isServerAdmin: boolean;
  userId: string | null;
  manualUserLink: boolean;
  watchCursor: { readTo: Date | null } | null;
}

// The same rule, for one row already read (identityScope's two branches).
function isLinked(identity: IdentityRow, subjects: ReadonlySet<string>): boolean {
  return identity.userId !== null || (!identity.manualUserLink && subjects.has(identity.sourceUserId));
}

const IDENTITY_SELECT = {
  id: true,
  sourceUserId: true,
  isServerAdmin: true,
  userId: true,
  manualUserLink: true,
  watchCursor: { select: { readTo: true } },
} as const;

interface ResolvedTitle extends WatchTitle {
  // The library row's name; null when it has none (the stored row then carries
  // a placeholder until the library names it).
  title: string | null;
}

function titleNamer(names: ReadonlyMap<string, string>): (t: WatchTitle) => string | null {
  return (t) => names.get(watchTitleKey(t.tmdbId, t.mediaType)) ?? null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Whether a NAMED instance is still registered, read with its service's registry
// row LOCKED so a concurrent removal is ordered against this write (see the
// header). The default instance can never be removed. A missing or unreadable
// registry lists nothing. Same reader as stillRegisteredInTx in upstream-watch-data.ts.
async function stillRegisteredInTx(tx: PrismaTxClient, source: Source, slug: string): Promise<boolean> {
  if (slug === DEFAULT_MEDIA_INSTANCE) return true;
  return (await registeredSlugsForUpdateInTx(tx, source)).has(slug);
}

// "removed": the server was removed meanwhile. "stale": the read point is no
// longer the one the deltas were counted from. Either way nothing was written.
type CommitOutcome = "committed" | "removed" | "stale";

interface IdentityCommit {
  source: Source;
  slug: string;
  identityId: string;
  // The read point the deltas were folded FROM, and the one to store.
  fromReadTo: Date | null;
  readTo: Date | null;
  deltas: ReadonlyMap<string, PlayDelta>;
  // The full favorite set read this run; null when favorites weren't read.
  favorites: ReadonlySet<string> | null;
  names: ReadonlyMap<string, string>;
}

// Write one identity's merged rows and its read point together, so a failure
// leaves both as they were and the same plays are read — and counted — once.
//
// The read point is a compare-and-swap on `fromReadTo`, the one the deltas were
// folded from. Another import that read the same window and committed first
// (possible once the advisory lock is lost mid-run: advisory-lock.ts) already
// counted these plays, so this one writes nothing. The swap goes first: from
// then on the cursor row is locked to this transaction, and the stored rows,
// read after it, are the ones the merge adds to.
async function commitIdentity(c: IdentityCommit): Promise<CommitOutcome> {
  // Nothing to write: no plays, no favorites read and the read point unmoved.
  // Skipped so an idle identity doesn't lock the registry row for nothing
  // (the cursor's importedAt is not read anywhere).
  if (c.deltas.size === 0 && c.favorites === null && c.fromReadTo?.getTime() === c.readTo?.getTime()) return "committed";
  return prisma.$transaction(
    async (tx): Promise<CommitOutcome> => {
      if (!(await stillRegisteredInTx(tx, c.source, c.slug))) return "removed";
      if (!(await swapReadPointInTx(tx, c.identityId, c.fromReadTo, c.readTo))) return "stale";
      if (c.deltas.size > 0 || c.favorites !== null) {
        const existing: WatchedTitleRow[] = await tx.serverWatchedTitle.findMany({
          where: { mediaServerUserId: c.identityId },
          select: { tmdbId: true, mediaType: true, title: true, plays: true, lastWatchedAt: true, favorite: true },
        });
        const merged = mergeServerWatchedRows(existing, c.deltas, c.favorites, titleNamer(c.names));
        if (!sameServerWatchedRows(existing, merged)) await writeRowChangesInTx(tx, c.identityId, existing, merged);
      }
      return "committed";
    },
    { timeout: BATCH_TX_TIMEOUT },
  );
}

async function swapReadPointInTx(tx: PrismaTxClient, identityId: string, fromReadTo: Date | null, readTo: Date | null): Promise<boolean> {
  const importedAt = new Date();
  const swapped = (await tx.serverWatchCursor.updateMany({
    where: { mediaServerUserId: identityId, readTo: fromReadTo },
    data: { readTo, importedAt },
  })).count === 1;
  if (swapped || fromReadTo !== null) return swapped;
  // Never read: no cursor row yet. A concurrent first commit's insert wins.
  return (await tx.serverWatchCursor.createMany({
    data: [{ mediaServerUserId: identityId, readTo, importedAt }],
    skipDuplicates: true,
  })).count === 1;
}

// Past this many changed rows a full rewrite is cheaper than row-by-row updates
// (a first import, or a rename sweep across the library).
const MAX_ROW_UPDATES = 200;

// Only what changed: removed titles are deleted, changed ones updated, new ones
// inserted. One new play is one UPDATE, not a rewrite of up to
// MAX_SERVER_WATCHED_TITLES rows while the registry row is locked. Every query
// awaits the last (guardrail 23c).
async function writeRowChangesInTx(
  tx: PrismaTxClient,
  identityId: string,
  existing: readonly WatchedTitleRow[],
  merged: readonly WatchedTitleRow[],
): Promise<void> {
  const before = new Map(existing.map((r) => [watchTitleKey(r.tmdbId, r.mediaType), r]));
  const after = new Map(merged.map((r) => [watchTitleKey(r.tmdbId, r.mediaType), r]));
  const removed = existing.filter((r) => !after.has(watchTitleKey(r.tmdbId, r.mediaType)));
  const added = merged.filter((r) => !before.has(watchTitleKey(r.tmdbId, r.mediaType)));
  const changed = merged.filter((r) => {
    const o = before.get(watchTitleKey(r.tmdbId, r.mediaType));
    return o !== undefined && !sameServerWatchedRows([o], [r]);
  });

  if (changed.length > MAX_ROW_UPDATES) {
    await tx.serverWatchedTitle.deleteMany({ where: { mediaServerUserId: identityId } });
    if (merged.length > 0) {
      await batchCreateMany(tx.serverWatchedTitle, merged.map((r) => ({ ...r, mediaServerUserId: identityId })));
    }
    return;
  }
  for (const type of ["MOVIE", "TV"] as const) {
    const ids = removed.filter((r) => r.mediaType === type).map((r) => r.tmdbId);
    if (ids.length > 0) {
      await tx.serverWatchedTitle.deleteMany({ where: { mediaServerUserId: identityId, mediaType: type, tmdbId: { in: ids } } });
    }
  }
  for (const r of changed) {
    await tx.serverWatchedTitle.updateMany({
      where: { mediaServerUserId: identityId, tmdbId: r.tmdbId, mediaType: r.mediaType },
      data: { title: r.title, plays: r.plays, lastWatchedAt: r.lastWatchedAt, favorite: r.favorite },
    });
  }
  if (added.length > 0) {
    await batchCreateMany(tx.serverWatchedTitle, added.map((r) => ({ ...r, mediaServerUserId: identityId })));
  }
}

// One identity's fold, holding its read point below a play whose item the
// library doesn't know yet (UNRESOLVED_HOLD_MS): the read point stops just
// before it and only plays up to there are counted, so that play — and the
// ones after it — are read again, and counted once, next run.
function foldHeld(
  fold: (bounds: FoldBounds) => FoldResult,
  readTo: Date | null,
  next: Date | null,
  now: Date,
): { fold: FoldResult; next: Date | null } {
  const first = fold({ holdUnresolvedSince: new Date(now.getTime() - UNRESOLVED_HOLD_MS) });
  if (first.heldAt === null) return { fold: first, next };
  const held = heldReadPoint(next, first.heldAt, readTo);
  return { fold: fold({ readUntil: held }), next: held };
}

// The commit and its bookkeeping, shared by both servers. False when the server
// was removed meanwhile: the caller stops, as the rest would be skipped too.
async function commitAndCount(c: IdentityCommit, result: ServerHistoryImportResult): Promise<boolean> {
  const outcome = await commitIdentity(c);
  if (outcome === "removed") return false;
  if (outcome === "stale") warnStale(c.source, c.identityId);
  else result.identities++;
  return true;
}

function warnStale(source: Source, identityId: string): void {
  console.warn(`[server-history] ${source} server user ${identityId}: its read point moved during this import (another run counted these plays); nothing written`);
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
  for (const [k, r] of index) out.set(k, { tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title?.trim() || null });
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
          out.set(id, { tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title?.trim() || null });
        }
      }
    }
  }
  return out;
}

// Only real names: a title the library can't name keeps whatever is stored.
function namesOf(titles: Iterable<ResolvedTitle>): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of titles) if (t.title !== null) out.set(watchTitleKey(t.tmdbId, t.mediaType), t.title);
  return out;
}

async function importPlexServer(slug: string, everyone: boolean, signal: AbortSignal, result: ServerHistoryImportResult): Promise<void> {
  const cfg = await getPlexConfig(slug);
  const url = cfg.url?.trim();
  const token = cfg.token?.trim();
  if (!url || !token) return;

  // Plex reads no favorites, so co-watch ON needs no subjects.
  const subjects = everyone ? new Set<string>() : await accountSubjects("plex");
  const identities: IdentityRow[] = await prisma.mediaServerUser.findMany({
    where: identityScope("plex", slug, everyone, subjects),
    select: IDENTITY_SELECT,
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
  // Split by account once, so each identity folds only its own records.
  const byAccount = groupPlexHistoryByAccount(history.entries, owner);
  const now = new Date();

  for (const identity of eligible) {
    if (signal.aborted) {
      result.aborted = true;
      return;
    }
    const readTo = identity.watchCursor?.readTo ?? null;
    const own = byAccount.get(identity.sourceUserId) ?? [];
    // The walk covered everything up to its newest record for EVERY identity,
    // including ones with nothing new. A server with no dated history at all
    // anchors at the walk's start so the next run is incremental, not full.
    const held = foldHeld(
      (bounds) => foldPlexHistory(own, identity.sourceUserId, owner, readTo, titleFor, bounds),
      readTo,
      nextReadTo(readTo, [walkNewest]) ?? walkStartedAt,
      now,
    );
    const { deltas, unresolved } = held.fold;
    result.unresolved += unresolved;
    const next = held.next;
    if (deltas.size === 0 && readTo !== null && next !== null && next.getTime() === readTo.getTime()) continue;
    try {
      const commit = { source: "plex" as const, slug, identityId: identity.id, fromReadTo: readTo, readTo: next, deltas, favorites: null, names };
      if (!(await commitAndCount(commit, result))) return;
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

  // Read either way: the favorites gate below uses them too.
  const subjects = await accountSubjects("jellyfin");
  const identities: IdentityRow[] = await prisma.mediaServerUser.findMany({
    where: identityScope("jellyfin", slug, everyone, subjects),
    select: IDENTITY_SELECT,
  });
  if (identities.length === 0) return;
  result.servers++;

  // One user at a time: these are small requests and the point is to stay light.
  for (const identity of identities) {
    if (signal.aborted) {
      result.aborted = true;
      return;
    }
    try {
      if (!(await importJellyfinIdentity(url, apiKey, slug, identity, isLinked(identity, subjects), signal, result))) return;
    } catch (err) {
      // An unreachable server would fail every identity the same way: that is
      // the SERVER's failure, counted and logged once by the run (guardrail 7b).
      if (isTransportFailure(err)) throw err;
      result.failedIdentities++;
      console.error(`[server-history] Jellyfin history read failed for server user ${identity.id}: ${errorText(err)}`);
    }
  }
}

function isTransportFailure(err: unknown): boolean {
  return err instanceof SafeFetchError && (err.reason === "network" || err.reason === "timeout");
}

// One Jellyfin user's played items since their read point (and, for a person
// with an account, their favorites), folded and committed. False when the run
// should stop for this server (removed meanwhile, or aborted).
async function importJellyfinIdentity(
  url: string,
  apiKey: string,
  slug: string,
  identity: IdentityRow,
  linked: boolean,
  signal: AbortSignal,
  result: ServerHistoryImportResult,
): Promise<boolean> {
  const readTo = identity.watchCursor?.readTo ?? null;
  const readStartedAt = new Date();
  const played = await getJellyfinPlayedSince(url, apiKey, identity.sourceUserId, readTo ? { since: readTo, signal } : { signal });
  // Favorites only matter for a person with an account (they seed THEIR
  // shelf); an unlinked identity's history still feeds co-watching.
  const favorites = linked ? await getJellyfinFavorites(url, apiKey, identity.sourceUserId, { signal }) : null;
  if (signal.aborted) {
    result.aborted = true;
    return false;
  }

  const ids: string[] = [];
  for (const p of played) {
    const id = p.kind === "movie" ? p.itemKey : p.showKey;
    if (id) ids.push(id);
  }
  for (const f of favorites ?? []) ids.push(f.itemId);
  const titles = await jellyfinTitles(slug, ids);
  const titleFor = (id: string) => titles.get(id) ?? null;
  // A full read that found nothing dated anchors at its own start, so the
  // next read is incremental instead of re-reading the whole list.
  const held = foldHeld(
    (bounds) => foldJellyfinPlayed(played, readTo, titleFor, bounds),
    readTo,
    nextReadTo(readTo, played.map((p) => p.lastPlayedAt)) ?? (readTo === null ? readStartedAt : null),
    readStartedAt,
  );
  result.unresolved += held.fold.unresolved;

  let favoriteKeys: Set<string> | null = null;
  if (favorites !== null) {
    favoriteKeys = new Set();
    for (const f of favorites) {
      const t = titles.get(f.itemId);
      if (t && t.mediaType === (f.kind === "movie" ? "MOVIE" : "TV")) favoriteKeys.add(watchTitleKey(t.tmdbId, t.mediaType));
    }
  }
  return commitAndCount(
    {
      source: "jellyfin",
      slug,
      identityId: identity.id,
      fromReadTo: readTo,
      readTo: held.next,
      deltas: held.fold.deltas,
      favorites: favoriteKeys,
      names: namesOf(titles.values()),
    },
    result,
  );
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
  const everyone = await isFeatureEnabled(FOR_YOU_COWATCH_FEATURE_KEY).catch((err: unknown) => {
    console.warn(`[server-history] could not read the co-watch switch, importing linked identities only: ${errorText(err)}`);
    return false;
  });
  await run("plex", (slug) => importPlexServer(slug, everyone, signal, result));
  await run("jellyfin", (slug) => importJellyfinServer(slug, everyone, signal, result));
  if (signal.aborted) result.aborted = true;
  return result;
}
