// Moving MediaRequest rows to AVAILABLE off library or Radarr/Sonarr presence:
// ONE implementation behind the orchestrator's four marking passes (/api/sync)
// and the per-source Resync routes (/api/sync/plex, /api/sync/jellyfin). Each
// route used to carry its own copy of the notify / flip-only / already-notified
// split, and the copies had drifted (the Resync routes trusted the snapshot's
// claim flag and read the requesters twice).
//
// What stays with the CALLERS, on purpose: reading the snapshot once per run
// (guardrail 15) and every gate that decides WHETHER a row is a candidate —
// presence, the Sonarr completeness hold (14a), media-server visibility (35).
// Each of those runs before anything here, so a gated row never reaches the
// claim and its once-only notifiedAvailable is never burned (guardrail 14).
import { prisma } from "./prisma";
import { claimAvailableNotifications, clearDeletionVotesForTmdbs } from "./notify-available";
import { fanOutAvailableWinners } from "./request-notifications";
import { canViewMediaInstance, effectivePermissions, parseMediaServerGrants, type MediaInstanceAccess } from "./permissions";
import { arrRowKey, sonarrIncompleteKeys } from "./arr-availability";

export type LibrarySource = "plex" | "jellyfin";

/** A PENDING/APPROVED request as every marking pass reads it. */
export interface PendingRequest {
  id: string;
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  arrInstance: string;
  requestedBy: string;
  title: string;
  posterPath: string | null;
  notifiedAvailable: boolean;
}

export const PENDING_REQUEST_SELECT = {
  id: true,
  tmdbId: true,
  mediaType: true,
  arrInstance: true,
  requestedBy: true,
  title: true,
  posterPath: true,
  notifiedAvailable: true,
} as const;

// Above this many titles the narrowed read below is no cheaper than the full
// one, and an `IN` list must stay far below Postgres's 32,766 bind parameters
// (guardrail 23c).
export const PENDING_SCOPE_MAX_TITLES = 5_000;

/**
 * Every PENDING/APPROVED request. With `titles`, only the requests for those
 * titles: a recent-only Resync saw a handful of titles and can match nothing
 * else, so it need not read the whole backlog. No titles ⇒ no candidates ⇒ no
 * query. A scope too large to be worth it falls back to the full read.
 */
export async function readPendingRequests(
  titles?: { movieIds: Iterable<number>; tvIds: Iterable<number> },
): Promise<PendingRequest[]> {
  const status = { in: ["PENDING" as const, "APPROVED" as const] };
  if (!titles) {
    return prisma.mediaRequest.findMany({ where: { status }, select: PENDING_REQUEST_SELECT });
  }
  const movieIds = [...new Set(titles.movieIds)];
  const tvIds = [...new Set(titles.tvIds)];
  if (movieIds.length === 0 && tvIds.length === 0) return [];
  if (movieIds.length + tvIds.length > PENDING_SCOPE_MAX_TITLES) {
    return prisma.mediaRequest.findMany({ where: { status }, select: PENDING_REQUEST_SELECT });
  }
  const OR = [
    ...(movieIds.length > 0 ? [{ mediaType: "MOVIE" as const, tmdbId: { in: movieIds } }] : []),
    ...(tvIds.length > 0 ? [{ mediaType: "TV" as const, tmdbId: { in: tvIds } }] : []),
  ];
  return prisma.mediaRequest.findMany({ where: { status, OR }, select: PENDING_REQUEST_SELECT });
}

/**
 * The requests whose title is in the library (minus any id in `exclude`). Pure.
 */
export function inLibrary<R extends { tmdbId: number; mediaType: string }>(
  requests: readonly R[],
  library: { movieIds: { has(id: number): boolean }; tvIds: { has(id: number): boolean } },
  exclude?: { movieIds?: ReadonlySet<number>; tvIds?: ReadonlySet<number> },
): R[] {
  return requests.filter((req) =>
    req.mediaType === "MOVIE"
      ? library.movieIds.has(req.tmdbId) && !exclude?.movieIds?.has(req.tmdbId)
      : library.tvIds.has(req.tmdbId) && !exclude?.tvIds?.has(req.tmdbId),
  );
}

/**
 * Drops the TV requests the Sonarr completeness gate holds (guardrail 14a):
 * `held` is sonarrIncompleteKeys' arrRowKey set. A held series is not a
 * candidate at all, whatever the library holds — it stays PENDING/APPROVED,
 * un-notified and un-claimed, and is re-evaluated next run. Pure.
 */
export function withoutSonarrHeld<R extends { tmdbId: number; mediaType: string; arrInstance: string }>(
  requests: readonly R[],
  held: ReadonlySet<string>,
): R[] {
  if (held.size === 0) return [...requests];
  return requests.filter((req) => req.mediaType !== "TV" || !held.has(arrRowKey(req.tmdbId, req.arrInstance)));
}

// ── requesters ──────────────────────────────────────────────────────────────

/**
 * The requester columns every per-user decision reads: `mediaServer` (which
 * source may notify) and the visibility gate's inputs. `role` is NOT optional:
 * the raw `permissions` column is @default(0) and seeded only by a manual
 * one-shot script, so an upgraded deployment can hold role="ADMIN" with
 * permissions=0. Gating on the raw column would deny that admin here while
 * every read path grants them (effectivePermissions), stranding their own
 * requests as PENDING while the UI says the title is available.
 */
export const REQUESTER_SELECT = { id: true, mediaServer: true, role: true, permissions: true, mediaServerGrants: true } as const;

export interface RequesterRow {
  id: string;
  mediaServer: string | null;
  role: string;
  permissions: bigint;
  mediaServerGrants: unknown;
}

/** One run's requester rows: each user is read at most once, in batched queries. */
export interface RequesterCache {
  /** Reads the users not read yet (one query), then returns every row read so far. */
  load(userIds: Iterable<string>): Promise<ReadonlyMap<string, RequesterRow>>;
  /** A row already read; undefined when the user was never read or no longer exists. */
  get(userId: string): RequesterRow | undefined;
}

export function createRequesterCache(): RequesterCache {
  const rows = new Map<string, RequesterRow>();
  const looked = new Set<string>();
  return {
    async load(userIds) {
      const missing = [...new Set(userIds)].filter((id) => !looked.has(id));
      if (missing.length > 0) {
        const found = await prisma.user.findMany({ where: { id: { in: missing } }, select: REQUESTER_SELECT });
        for (const id of missing) looked.add(id);
        for (const u of found) rows.set(u.id, u);
      }
      return rows;
    },
    get: (userId) => rows.get(userId),
  };
}

/** A requester's effective permissions; a missing row is the least-privileged answer. */
export function requesterPermissions(u: RequesterRow | undefined): bigint {
  return u ? effectivePermissions(u.role, u.permissions) : 0n;
}

/**
 * The per-source Resync's visibility gate (guardrail 35): that route describes
 * ONE server, so the question is the same for every title — may this requester
 * see `instance`? Only a restricted instance can answer no, so an unrestricted
 * one (the default always is) costs no query. A requester whose row vanished
 * mid-run fails closed.
 */
export async function keepVisibleOnInstance<R extends { requestedBy: string }>(
  rows: R[],
  instance: MediaInstanceAccess | undefined,
  service: LibrarySource,
  requesters: RequesterCache,
): Promise<R[]> {
  if (instance?.restricted !== true || rows.length === 0) return rows;
  const byId = await requesters.load(rows.map((r) => r.requestedBy));
  return rows.filter((r) => {
    const u = byId.get(r.requestedBy);
    if (!u) return false;
    return canViewMediaInstance(requesterPermissions(u), instance, parseMediaServerGrants(u.mediaServerGrants), service);
  });
}

/**
 * Splits unnotified rows by the requester's preferred media server: a user with
 * no preference is notified by whichever source sees the title first; one who
 * prefers the OTHER source has the row flipped AVAILABLE here but is notified
 * by their own source (or the orchestrator's fallback). Pure.
 */
export function splitByPreferredSource<R extends { requestedBy: string }>(
  rows: readonly R[],
  source: LibrarySource,
  requesters: ReadonlyMap<string, { mediaServer: string | null }>,
): { toNotify: R[]; toMarkOnly: R[] } {
  const toNotify: R[] = [];
  const toMarkOnly: R[] = [];
  for (const r of rows) {
    const ms = requesters.get(r.requestedBy)?.mediaServer ?? null;
    if (!ms || ms === source) toNotify.push(r);
    else toMarkOnly.push(r);
  }
  return { toNotify, toMarkOnly };
}

// ── the writes ──────────────────────────────────────────────────────────────

type MarkRow = {
  id: string;
  requestedBy: string;
  title: string;
  mediaType: string;
  tmdbId: number;
  posterPath: string | null;
  arrInstance: string;
};

/**
 * Claims `rows` with the notifiedAvailable compare-and-swap (guardrail 14 —
 * the claim also sets status AVAILABLE) and announces the winners.
 *
 * `claimed` is every row the CAS flipped; `deliverable` drops disabled
 * requesters (guardrail 33). Every consequence of the TRANSITION keys off
 * `claimed` — the pendingNotifyAt disarm and the deletion-vote wipe — because a
 * disabled requester's row went AVAILABLE too and its claim is burned, so no
 * later run would make them up. Only the notification keys off `deliverable`,
 * through the one fan-out (guardrail 14c).
 */
export async function claimAndAnnounce<R extends MarkRow>(
  rows: readonly R[],
  logScope: string,
): Promise<{ claimed: R[]; deliverable: R[] }> {
  if (rows.length === 0) return { claimed: [], deliverable: [] };
  const { claimed, deliverable } = await claimAvailableNotifications(rows, { markAvailable: true });
  if (claimed.length > 0) {
    // The claim sets status/availableAt/notifiedAvailable but not
    // pendingNotifyAt: disarm the 90s "still pending" backstop on the same
    // transition.
    await prisma.mediaRequest.updateMany({
      where: { id: { in: claimed.map((w) => w.id) } },
      data: { pendingNotifyAt: null },
    });
    void clearDeletionVotesForTmdbs(claimed.map((w) => ({ tmdbId: w.tmdbId, mediaType: w.mediaType as "MOVIE" | "TV" })));
  }
  if (deliverable.length > 0) void fanOutAvailableWinners(deliverable, logScope);
  return { claimed, deliverable };
}

/**
 * Flips `rows` to AVAILABLE WITHOUT notifying. `status IN (PENDING, APPROVED)`
 * allows only forward transitions: it keeps availableAt from being rewritten
 * on every tick and never resurrects a row an admin DECLINED after the
 * snapshot (AVAILABLE is terminal). `onlyNotified` additionally requires the
 * claim to be burned already, so a row that still owes its notification is
 * never moved past the claim that would send it. An AVAILABLE transition wipes
 * stale deletion votes, gated on rows actually moving. Returns how many moved.
 */
export async function flipToAvailable(
  rows: readonly { id: string; tmdbId: number; mediaType: string }[],
  opts: { onlyNotified?: boolean } = {},
): Promise<number> {
  if (rows.length === 0) return 0;
  const flipped = await prisma.mediaRequest.updateMany({
    where: {
      id: { in: rows.map((r) => r.id) },
      ...(opts.onlyNotified ? { notifiedAvailable: true } : {}),
      status: { in: ["PENDING", "APPROVED"] },
    },
    data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
  });
  if (flipped.count > 0) {
    void clearDeletionVotesForTmdbs(rows.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType as "MOVIE" | "TV" })));
  }
  return flipped.count;
}

/**
 * The library marking pass: moves `toMark` — requests whose title is in
 * `source`'s library, already past every gate — to AVAILABLE, notifying the
 * ones this source may notify.
 *
 * The claim flag is re-read rather than trusted from the caller's snapshot: an
 * earlier pass of the same run (the orchestrator's Plex pass before its
 * Jellyfin pass) or a concurrent webhook may have claimed a row since. Read
 * stale, that row would go to the claim, lose it, and stay un-flipped until the
 * next run.
 */
export async function markAvailableFromLibrary<R extends PendingRequest>(
  toMark: readonly R[],
  source: LibrarySource,
  opts: { requesters: RequesterCache; logScope: string },
): Promise<void> {
  if (toMark.length === 0) return;
  const fresh = await prisma.mediaRequest.findMany({
    where: { id: { in: toMark.map((r) => r.id) } },
    select: { id: true, notifiedAvailable: true },
  });
  const alreadyNotifiedIds = new Set(fresh.filter((r) => r.notifiedAvailable).map((r) => r.id));
  const unnotified = toMark.filter((r) => !alreadyNotifiedIds.has(r.id));
  if (unnotified.length > 0) {
    const requesters = await opts.requesters.load(unnotified.map((r) => r.requestedBy));
    const { toNotify, toMarkOnly } = splitByPreferredSource(unnotified, source, requesters);
    await claimAndAnnounce(toNotify, opts.logScope);
    await flipToAvailable(toMarkOnly);
  }
  await flipToAvailable(toMark.filter((r) => alreadyNotifiedIds.has(r.id)));
}

/**
 * The per-source Resync's marking pass over ONE server's freshly written
 * library: read the pending requests (only those for the titles seen, on a
 * recent-only run), keep the ones in the library and not held by Sonarr
 * (guardrail 14a, read for the candidates alone), apply the server's
 * visibility gate, then mark. `checked` is how many requests were read and
 * `marked` how many matched the library past every gate — the counts the
 * route reports.
 */
export async function markResyncedLibrary(opts: {
  source: LibrarySource;
  instance: MediaInstanceAccess | undefined;
  library: { movieIds: ReadonlyMap<number, unknown>; tvIds: ReadonlyMap<number, unknown> };
  /** Ids the library write dropped (the Plex ratingKey dedupe): never present, whatever the fetch said. */
  dropped?: { movieIds?: ReadonlySet<number>; tvIds?: ReadonlySet<number> };
  /** Read only the requests for the titles in `library` (a recent-only run). */
  scopeToLibrary: boolean;
  logScope: string;
}): Promise<{ checked: number; marked: number }> {
  const { source, library } = opts;
  const requests = await readPendingRequests(
    opts.scopeToLibrary ? { movieIds: library.movieIds.keys(), tvIds: library.tvIds.keys() } : undefined,
  );
  const present = inLibrary(requests, library, opts.dropped);
  const held = await sonarrIncompleteKeys(present);
  const requesters = createRequesterCache();
  const toMark = await keepVisibleOnInstance(withoutSonarrHeld(present, held), opts.instance, source, requesters);
  await markAvailableFromLibrary(toMark, source, { requesters, logScope: opts.logScope });
  return { checked: requests.length, marked: toMark.length };
}

/**
 * The orchestrator's notify fallback for an AVAILABLE row whose notification
 * is still owed: may it be sent now? A requester with no preference is
 * notified when either server holds the title for them, or when neither can
 * prove anything. One who prefers a server is notified when that server holds
 * it — or, when that server is "unusable" (unconfigured, failing past the
 * stale window, or showing them nothing), when the other holds it or is
 * unusable too. A source that synced fine is NOT unusable, so its "absent"
 * still blocks a false notify. Pure.
 */
export function fallbackShouldNotify(r: {
  preferred: string | null;
  inPlex: boolean;
  inJellyfin: boolean;
  plexUnusable: boolean;
  jellyfinUnusable: boolean;
}): boolean {
  if (!r.preferred) return r.inPlex || r.inJellyfin || (r.plexUnusable && r.jellyfinUnusable);
  if (r.preferred === "plex") return r.inPlex || (r.plexUnusable && (r.inJellyfin || r.jellyfinUnusable));
  if (r.preferred === "jellyfin") return r.inJellyfin || (r.jellyfinUnusable && (r.inPlex || r.plexUnusable));
  return false;
}
