import { prisma } from "@/lib/prisma";
import type { SummonarrSession } from "@/lib/api-auth";
import { runWithSerializableRetry } from "@/lib/serializable-retry";
import { addMovieToRadarr, addSeriesToSonarr, arrWriteOutcomeUnknown, type AddProgress } from "@/lib/arr";
import { exceedsCap } from "@/lib/content-rating";
import { emitSSE } from "@/lib/sse-emitter";
import { DOWNLOAD_CHECK_DELAY_MS, scheduleDownloadChecks, type DownloadCheckTarget } from "@/lib/download-check";
import { sanitizeForLog } from "@/lib/sanitize";
import { resolveMediaMeta } from "@/lib/request-meta";
import { getBlacklistSet } from "@/lib/blacklist";
import { getSyncableArrInstances } from "@/lib/arr-instance-registry";
import {
  canRequestInstance,
  canAutoApproveInstance,
  parseInstanceGrants,
  parseMediaServerGrants,
  hasPermission,
  Permission,
  type InstanceGrants,
} from "@/lib/permissions";
import { getMediaInstanceAccessLists, visibleInstancesFor } from "@/lib/media-visibility";
import { mapLimit } from "@/lib/concurrency";
import { greenlitPeerStatuses } from "@/lib/request-mirror";
import { dropStaleDeclinedMany, restoreThread } from "@/lib/request-comment-carry";
import { alertAdminsNewRequest, assertQuotaInTx, autoRouteSlug, detailsLoader, enforcedQuota } from "@/lib/request-policy";

// The phases of POST /api/requests/bulk (the collection "Request all" button and
// the admin "request on behalf of" flow), in the order the route runs them:
// filer → routing → visibility → classification → rating caps → metadata →
// the Serializable create → the Radarr/Sonarr push. The route keeps the HTTP
// half (body, target, refusals, audit, response). Each phase takes the call's
// BulkContext and returns what the next one reads — no shared mutable maps.
//
// The shared request rules (quota, routing, the TMDB details read, the admin
// alert) are request-policy.ts's, the same ones request-create.ts uses.

export const ARR_CONCURRENCY = 5;

export type MediaType = "MOVIE" | "TV";
// Every per-item verdict the route answers. request-button.tsx's
// ON_BEHALF_MESSAGES mirrors this union (tests/request-button-on-behalf.test.mts).
export type ItemResult =
  | "created"
  | "auto-approved"
  | "already-available"
  | "already-requested"
  | "skipped-declined"
  | "no-permission"
  | "blacklisted"
  | "rating-blocked"
  | "error";

export interface CreateOutcome {
  tmdbId: number;
  mediaType: MediaType;
  result: ItemResult;
  // Additive: an auto-approval whose push failed; the row went back to PENDING
  // (result "created").
  pushFailed?: true;
}

export interface BulkItem {
  tmdbId: number;
  mediaType: MediaType;
}

export const keyOf = (tmdbId: number, mediaType: string) => `${tmdbId}:${mediaType}`;

// The target user's row: every gate is evaluated against the TARGET's rights.
export const BULK_TARGET_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  permissions: true,
  discordId: true,
  deactivatedAt: true,
  movieQuotaLimit: true,
  movieQuotaDays: true,
  tvQuotaLimit: true,
  tvQuotaDays: true,
  maxContentRating: true,
  instanceGrants: true,
  mediaServerGrants: true,
} as const;

export interface BulkTarget {
  id: string;
  name: string | null;
  email: string;
  movieQuotaLimit: number | null;
  movieQuotaDays: number | null;
  tvQuotaLimit: number | null;
  tvQuotaDays: number | null;
  maxContentRating: string | null;
  mediaServerGrants: unknown;
}

interface FilerRow {
  instanceGrants: unknown;
  mediaServerGrants: unknown;
  maxContentRating: string | null;
  movieQuotaLimit: number | null;
  movieQuotaDays: number | null;
  tvQuotaLimit: number | null;
  tvQuotaDays: number | null;
}

type InstanceAccess = { slug: string; restricted: boolean; serverAll: boolean };
type FilerMay = (inst: InstanceAccess, mediaType: MediaType, serverAll4k: boolean, autoApprove?: boolean) => boolean;

// What every phase reads about the call: who files, for whom, with which rights.
export interface BulkContext {
  session: SummonarrSession;
  isOnBehalf: boolean;
  target: BulkTarget;
  targetUserId: string;
  targetPerms: bigint;
  grants: InstanceGrants;
  filerChecked: boolean;
  filerRow: FilerRow | null;
  filerMay: FilerMay;
}

/**
 * The on-behalf filer's own limits. Named-instance grants and media-server grants
 * are NOT permission bits, so the route's permission-subset check cannot see
 * them. A non-ADMIN on-behalf filer may only use a named instance they could
 * request on / auto-approve on themselves (grant only what you hold), and only
 * sees "already available" for servers they can view themselves (the per-item
 * results would otherwise leak a restricted library).
 */
export async function loadFiler(
  session: SummonarrSession,
  isOnBehalf: boolean,
): Promise<{ filerChecked: boolean; filerRow: FilerRow | null; filerMay: FilerMay }> {
  const filerChecked = isOnBehalf && !hasPermission(session.user.permissions, Permission.ADMIN);
  const filerRow = filerChecked
    ? await prisma.user.findUnique({
        where: { id: session.user.id },
        select: {
          instanceGrants: true,
          mediaServerGrants: true,
          maxContentRating: true,
          movieQuotaLimit: true,
          movieQuotaDays: true,
          tvQuotaLimit: true,
          tvQuotaDays: true,
        },
      })
    : null;
  const filerGrants = parseInstanceGrants(filerRow?.instanceGrants);
  const filerMay: FilerMay = (inst, mediaType, serverAll4k, autoApprove = false) =>
    !filerChecked ||
    inst.slug === "" ||
    (autoApprove
      ? canAutoApproveInstance(session.user.permissions, inst, filerGrants, mediaType)
      : canRequestInstance(session.user.permissions, inst, filerGrants, mediaType, serverAll4k));
  return { filerChecked, filerRow, filerMay };
}

const DEFAULT_ACCESS = { slug: "", restricted: false, serverAll: false, skipLibraryCheck: false };

export interface BulkRouting {
  slugOf: (it: BulkItem) => string;
  instOf: (it: BulkItem) => InstanceAccess & { skipLibraryCheck: boolean };
  serverAll4k: boolean;
  mediaAccess: Awaited<ReturnType<typeof getMediaInstanceAccessLists>>;
  // Per-item TMDB details, read at most once across routing and the rating cap.
  detailsOf: (it: BulkItem) => ReturnType<typeof detailsLoader>;
}

/**
 * Per-item instance routing (auto-route only — bulk has no explicit-instance
 * input), like the single POST /api/requests: an item routes to a configured
 * named instance only when one carries a matching auto-route rule, else the
 * default. An auto-routed instance the target (or a checked filer) can't use
 * falls back to the default — a base requester is never blocked by a
 * server-side routing decision; an item they can't request at all is refused
 * "no-permission" by the classification. The media-server registry rides along
 * (the availability lookup needs it) so resolving visibility costs nothing extra.
 */
export async function routeItems(ctx: BulkContext, items: BulkItem[]): Promise<BulkRouting> {
  const { targetPerms, grants, filerMay } = ctx;
  const [radarrConfigured, sonarrConfigured, mediaAccess] = await Promise.all([
    getSyncableArrInstances("radarr"),
    getSyncableArrInstances("sonarr"),
    getMediaInstanceAccessLists(),
  ]);
  const configuredByType = { MOVIE: radarrConfigured, TV: sonarrConfigured } as const;
  const loaders = new Map<string, ReturnType<typeof detailsLoader>>();
  const detailsOf = (it: BulkItem) => {
    const k = keyOf(it.tmdbId, it.mediaType);
    let load = loaders.get(k);
    if (!load) loaders.set(k, (load = detailsLoader(it.tmdbId, it.mediaType)));
    return load;
  };
  const routingActive =
    radarrConfigured.some((i) => i.slug !== "" && i.autoRoute) ||
    sonarrConfigured.some((i) => i.slug !== "" && i.autoRoute);
  const slugByKey = new Map<string, string>();
  if (routingActive) {
    await mapLimit(items, ARR_CONCURRENCY, async (it) => {
      const slug = await autoRouteSlug(configuredByType[it.mediaType], detailsOf(it));
      if (slug !== "") slugByKey.set(keyOf(it.tmdbId, it.mediaType), slug);
    });
  }
  const request4kAllRow = routingActive
    ? await prisma.setting.findUnique({ where: { key: "request4kAll" } })
    : null;
  const serverAll4k = request4kAllRow?.value === "true";

  // Remapped HERE — before the availability, create, and arr-push lookups all key
  // off slugOf() — so the whole item runs on its effective (default) slug. Bulk
  // items are always auto-routed (never an explicit target), so there is no
  // explicit-choice case to preserve as a hard reject.
  if (routingActive) {
    for (const it of items) {
      const key = keyOf(it.tmdbId, it.mediaType);
      const routed = slugByKey.get(key);
      if (routed === undefined || routed === "") continue;
      const inst = configuredByType[it.mediaType].find((i) => i.slug === routed) ?? DEFAULT_ACCESS;
      if (!canRequestInstance(targetPerms, inst, grants, it.mediaType, serverAll4k) || !filerMay(inst, it.mediaType, serverAll4k)) {
        slugByKey.delete(key); // slugOf() now returns "" (default instance)
      }
    }
  }
  const slugOf = (it: BulkItem) => slugByKey.get(keyOf(it.tmdbId, it.mediaType)) ?? "";
  // Access metadata for the routed instance; the default instance is open to any
  // base requester, so a missing registry entry safely degrades to that shape.
  const instOf = (it: BulkItem) =>
    configuredByType[it.mediaType].find((i) => i.slug === slugOf(it)) ?? DEFAULT_ACCESS;
  return { slugOf, instOf, serverAll4k, mediaAccess, detailsOf };
}

/**
 * Media-server visibility of the TARGET, never the caller: every classification
 * decides what lands in the target's request list, so a restricted server the
 * CALLER can see must not make an item read "already available" for a target who
 * holds no grant on it (and vice versa). A checked filer only sees what both of
 * them can (guardrail 35).
 */
export function bulkVisibleServers(ctx: BulkContext, mediaAccess: BulkRouting["mediaAccess"]): { plex: string[]; jellyfin: string[] } {
  const { session, target, targetPerms, filerChecked, filerRow } = ctx;
  const targetVisible = visibleInstancesFor(
    targetPerms,
    parseMediaServerGrants(target.mediaServerGrants),
    mediaAccess.plex,
    mediaAccess.jellyfin,
  );
  const filerVisible = filerChecked
    ? visibleInstancesFor(
        session.user.permissions,
        parseMediaServerGrants(filerRow?.mediaServerGrants),
        mediaAccess.plex,
        mediaAccess.jellyfin,
      )
    : null;
  return filerVisible
    ? {
        plex: targetVisible.plex.filter((x) => filerVisible.plex.includes(x)),
        jellyfin: targetVisible.jellyfin.filter((x) => filerVisible.jellyfin.includes(x)),
      }
    : targetVisible;
}

export interface Classified {
  skipped: CreateOutcome[];
  toCreate: BulkItem[];
  // Stale, non-permanent DECLINED rows to drop so a fresh request can be created
  // (the @@unique constraint would otherwise make createMany skip them). Keyed by
  // (tmdbId:mediaType) so the later gates can EXCLUDE a refused re-request from
  // the delete set — deleting a DECLINED row for an item that is then refused
  // would erase the user's history with no replacement created.
  staleDeclinedIdByKey: Map<string, string>;
  // Items the routed instance's *arr-available cache holds.
  arrAvailSet: Set<string>;
}

/**
 * The authoritative existing-state lookup — never trust client-supplied
 * availability — and the per-item verdict. Every mediaRequest / arr-availability
 * query is scoped to each item's ROUTED instance, so a target who holds only a
 * request for the same title on a different instance isn't wrongly classified
 * "already-requested".
 */
export async function classifyItems(
  ctx: BulkContext,
  items: BulkItem[],
  routing: BulkRouting,
  visible: { plex: string[]; jellyfin: string[] },
): Promise<Classified> {
  const { targetUserId, targetPerms, grants, filerMay } = ctx;
  const { slugOf, instOf, serverAll4k } = routing;
  const orPairs = items.map((i) => ({ tmdbId: i.tmdbId, mediaType: i.mediaType }));
  const instPairs = items.map((i) => ({ tmdbId: i.tmdbId, mediaType: i.mediaType, arrInstance: slugOf(i) }));
  const movieItems = items.filter((i) => i.mediaType === "MOVIE");
  const tvItems = items.filter((i) => i.mediaType === "TV");
  const [existingReqs, plexItems, jellyfinItems, radarrAvail, sonarrAvail] = await Promise.all([
    prisma.mediaRequest.findMany({
      where: { requestedBy: targetUserId, OR: instPairs },
      select: { id: true, tmdbId: true, mediaType: true, status: true, permanentlyDeclined: true },
    }),
    prisma.plexLibraryItem.findMany({
      where: { OR: orPairs, serverInstance: { in: visible.plex } },
      select: { tmdbId: true, mediaType: true },
    }),
    prisma.jellyfinLibraryItem.findMany({
      where: { OR: orPairs, serverInstance: { in: visible.jellyfin } },
      select: { tmdbId: true, mediaType: true },
    }),
    movieItems.length
      ? prisma.radarrAvailableItem.findMany({
          where: { OR: movieItems.map((i) => ({ tmdbId: i.tmdbId, arrInstance: slugOf(i) })) },
          select: { tmdbId: true },
        })
      : Promise.resolve([]),
    tvItems.length
      ? prisma.sonarrAvailableItem.findMany({
          where: { OR: tvItems.map((i) => ({ tmdbId: i.tmdbId, arrInstance: slugOf(i) })) },
          select: { tmdbId: true },
        })
      : Promise.resolve([]),
  ]);

  const existingMap = new Map(existingReqs.map((r) => [keyOf(r.tmdbId, r.mediaType), r]));
  const libraryAvailSet = new Set<string>();
  for (const r of plexItems) libraryAvailSet.add(keyOf(r.tmdbId, r.mediaType));
  for (const r of jellyfinItems) libraryAvailSet.add(keyOf(r.tmdbId, r.mediaType));
  const arrAvailSet = new Set<string>();
  for (const r of radarrAvail) arrAvailSet.add(keyOf(r.tmdbId, "MOVIE"));
  for (const r of sonarrAvail) arrAvailSet.add(keyOf(r.tmdbId, "TV"));

  const skipped: CreateOutcome[] = [];
  const toCreate: BulkItem[] = [];
  const staleDeclinedIdByKey = new Map<string, string>();
  const blacklistSet = await getBlacklistSet();
  for (const it of items) {
    const k = keyOf(it.tmdbId, it.mediaType);
    if (blacklistSet.has(k)) {
      skipped.push({ ...it, result: "blacklisted" });
      continue;
    }
    const inst = instOf(it);
    if (!canRequestInstance(targetPerms, inst, grants, it.mediaType, serverAll4k) || !filerMay(inst, it.mediaType, serverAll4k)) {
      skipped.push({ ...it, result: "no-permission" });
      continue;
    }
    // skipLibraryCheck instances (e.g. 4K) ignore the shared Plex/Jellyfin
    // library — only that instance's own arr availability short-circuits.
    // The *arr-available cache short-circuits ONLY for a requester who would be
    // auto-approved — exactly request-create.ts (`isAutoApprove && arrHasInstance`),
    // which the Discord picker files through too. Everyone else files a normal
    // request, so the sync's arr marking pass can notify them when it lands.
    const arrCounts = arrAvailSet.has(k) && canAutoApproveInstance(targetPerms, inst, grants, it.mediaType) && filerMay(inst, it.mediaType, serverAll4k, true);
    if ((!inst.skipLibraryCheck && libraryAvailSet.has(k)) || arrCounts) {
      skipped.push({ ...it, result: "already-available" });
      continue;
    }
    const ex = existingMap.get(k);
    if (ex) {
      if (ex.permanentlyDeclined) {
        skipped.push({ ...it, result: "skipped-declined" });
        continue;
      }
      // An ordinary (non-permanent) decline is re-requestable: delete the stale
      // row in the create transaction and create fresh. APPROVED/AVAILABLE/PENDING
      // stay blocked.
      if (ex.status === "DECLINED") {
        staleDeclinedIdByKey.set(k, ex.id);
        toCreate.push(it);
        continue;
      }
      skipped.push({ ...it, result: "already-requested" });
      continue;
    }
    toCreate.push(it);
  }
  return { skipped, toCreate, staleDeclinedIdByKey, arrAvailSet };
}

/**
 * Parental control — drops any item whose US certification exceeds the TARGET
 * user's cap. Runs BEFORE the stale-DECLINED delete (in the create transaction),
 * like the single POST /api/requests, which gates blacklist + rating before
 * deleting the stale row: a rating-blocked re-request keeps its DECLINED row
 * (removed from `staleDeclinedIdByKey` here). Only capped, non-admin targets pay
 * the per-item certification fetch; unknown/unrated titles are allowed.
 *
 * A non-ADMIN on-behalf filer's OWN cap applies too (the stricter wins): the
 * permission-bit subset rule can't see a cap, so a capped delegate could
 * otherwise file titles above their own rating by naming an uncapped user — and
 * with AUTO_APPROVE on both, straight into Radarr/Sonarr.
 */
export async function applyRatingCaps(
  ctx: BulkContext,
  toCreate: BulkItem[],
  routing: BulkRouting,
  staleDeclinedIdByKey: Map<string, string>,
): Promise<{ toCreate: BulkItem[]; ratingBlocked: CreateOutcome[] }> {
  const { target, targetPerms, filerChecked, filerRow } = ctx;
  const caps = [
    target.maxContentRating && !hasPermission(targetPerms, Permission.ADMIN) ? target.maxContentRating : null,
    filerChecked ? filerRow?.maxContentRating ?? null : null,
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  if (caps.length === 0) return { toCreate, ratingBlocked: [] };
  const checked = await mapLimit(toCreate, ARR_CONCURRENCY, async (it) => {
    let cert: string | undefined;
    try {
      cert = (await routing.detailsOf(it)()).certification;
    } catch {
      cert = undefined;
    }
    return { it, blocked: caps.some((cap) => exceedsCap(cert, cap)) };
  });
  const ratingBlocked = checked
    .filter((c) => c.blocked)
    .map((c): CreateOutcome => ({ tmdbId: c.it.tmdbId, mediaType: c.it.mediaType, result: "rating-blocked" }));
  // A rating-blocked title is NOT being (re)created — keep its stale DECLINED row.
  for (const b of ratingBlocked) staleDeclinedIdByKey.delete(keyOf(b.tmdbId, b.mediaType));
  return { toCreate: checked.filter((c) => !c.blocked).map((c) => c.it), ratingBlocked };
}

export interface PreparedItem {
  tmdbId: number;
  mediaType: MediaType;
  arrInstance: string;
  title: string;
  posterPath: string | null;
  releaseYear: string;
  autoApprove: boolean;
}

/**
 * TMDB metadata, resolved up front (bounded) so the create transaction holds no
 * network calls. Items whose meta can't resolve become "error", and keep their
 * stale DECLINED row (the same compensation the rating gate applies).
 */
export async function prepareItems(
  ctx: BulkContext,
  toCreate: BulkItem[],
  routing: BulkRouting,
  staleDeclinedIdByKey: Map<string, string>,
): Promise<{ prepared: PreparedItem[]; metaFailed: CreateOutcome[] }> {
  const { targetPerms, grants, filerMay } = ctx;
  const { slugOf, instOf, serverAll4k } = routing;
  const resolved = await mapLimit(toCreate, ARR_CONCURRENCY, async (it) => {
    try {
      const meta = await resolveMediaMeta(it.tmdbId, it.mediaType);
      return { it, meta };
    } catch (err) {
      console.error(`[requests/bulk] meta resolve failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
      return { it, meta: null };
    }
  });
  const prepared = resolved.flatMap((r) =>
    r.meta
      ? [{
          tmdbId: r.it.tmdbId,
          mediaType: r.it.mediaType,
          arrInstance: slugOf(r.it),
          title: r.meta.title,
          posterPath: r.meta.posterPath,
          releaseYear: r.meta.releaseYear,
          autoApprove:
            canAutoApproveInstance(targetPerms, instOf(r.it), grants, r.it.mediaType) &&
            filerMay(instOf(r.it), r.it.mediaType, serverAll4k, true),
        }]
      : [],
  );
  const metaFailed = resolved
    .filter((r) => !r.meta)
    .map((r): CreateOutcome => ({ tmdbId: r.it.tmdbId, mediaType: r.it.mediaType, result: "error" }));
  for (const m of metaFailed) staleDeclinedIdByKey.delete(keyOf(m.tmdbId, m.mediaType));
  return { prepared, metaFailed };
}

export interface CreatedRows {
  createdRows: { id: string; tmdbId: number; mediaType: MediaType; status: string }[];
  // Keys (tmdbId:mediaType) whose status was mirrored from another user's already
  // APPROVED/AVAILABLE request — already greenlit, so the push phase must NOT
  // re-push them to *arr.
  mirroredKeys: Set<string>;
}

/**
 * The quota re-check + insert, atomic under Serializable. This closes the TOCTOU:
 * a concurrent batch (or a single POST /api/requests) for the same target can't
 * both pass the quota gate and overshoot — the two count→insert transactions form
 * a read-write cycle and Postgres aborts one (retried). createMany with
 * skipDuplicates so a racing duplicate doesn't abort the batch (a P2002 inside a
 * tx would); re-query to recover row ids for the *arr phase. Queries run one at a
 * time on the transaction (guardrail 23c), and a full quota THROWS
 * QuotaExceededError out of it so the whole transaction rolls back (guardrail 23).
 *
 * The stale DECLINED rows are deleted INSIDE the transaction, never before it:
 * the delete has to roll back with the inserts. Committed up front, a quota
 * refusal or a P2034 retry-exhaustion would erase the admin's decline + adminNote
 * with no replacement row created.
 */
export async function createRowsTx(
  ctx: BulkContext,
  prepared: PreparedItem[],
  classified: Pick<Classified, "staleDeclinedIdByKey" | "arrAvailSet">,
): Promise<CreatedRows> {
  const { session, isOnBehalf, target, targetUserId, targetPerms, filerChecked, filerRow } = ctx;
  const { staleDeclinedIdByKey, arrAvailSet } = classified;
  const staleDeclinedIds = [...staleDeclinedIdByKey.values()];
  // A non-ADMIN on-behalf filer's OWN quota is charged too (guardrail 6g): the
  // rows carry filedBy, and quotaUsageWhere counts what a user filed for others
  // beside what was filed for them — so naming other users can't multiply what
  // a delegate may file.
  const enforceQuota = !hasPermission(targetPerms, Permission.QUOTA_UNLIMITED);
  const enforceFilerQuota =
    filerChecked && filerRow !== null && !hasPermission(session.user.permissions, Permission.QUOTA_UNLIMITED);
  let quotaSettings: { quotaLimit?: string; quotaPeriod?: string } = {};
  if (enforceQuota || enforceFilerQuota) {
    const qrows = await prisma.setting.findMany({ where: { key: { in: ["quotaLimit", "quotaPeriod"] } } });
    quotaSettings = Object.fromEntries(qrows.map((s) => [s.key, s.value]));
  }
  const createPairs = prepared.map((p) => ({ tmdbId: p.tmdbId, mediaType: p.mediaType, arrInstance: p.arrInstance }));
  const mirroredKeys = new Set<string>();
  const createdRows = await runWithSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // First write: drop the stale, non-permanent DECLINED rows the inserts
        // below would otherwise collide with on the unique
        // (tmdbId, mediaType, requestedBy, arrInstance). CAS on status +
        // permanentlyDeclined so an admin who re-approved or made the decline
        // permanent since the snapshot keeps that row intact — createMany
        // skipDuplicates then simply doesn't recreate it, rather than orphaning
        // its ARR grab or evading a permanent ban. Each dropped row's comment
        // thread is read first (it would cascade) and restored below onto the
        // row created for the same key (request-comment-carry.ts).
        const carriedThreads = await dropStaleDeclinedMany(tx, staleDeclinedIds);
        for (const mt of ["MOVIE", "TV"] as MediaType[]) {
          const n = prepared.filter((p) => p.mediaType === mt).length;
          if (n === 0) continue;
          const targetQuota = enforceQuota ? enforcedQuota(targetPerms, mt, target, quotaSettings) : null;
          if (targetQuota) await assertQuotaInTx(tx, targetUserId, mt, targetQuota, n);
          const filerQuota = enforceFilerQuota && filerRow ? enforcedQuota(session.user.permissions, mt, filerRow, quotaSettings) : null;
          if (filerQuota) await assertQuotaInTx(tx, session.user.id, mt, filerQuota, n, "filer");
        }
        // Capture rows that existed BEFORE this insert so the side effects
        // (SSE + ARR push) fire ONLY for rows THIS request created. Two concurrent
        // bulk requests with overlapping items would otherwise both re-query the
        // same skipDuplicates rows and both push/notify. With Serializable + retry,
        // a duplicate's retry re-snapshots, sees the other's committed rows in
        // `before`, and emits nothing. (Bulk analog of the requests/route fix.)
        const before = await tx.mediaRequest.findMany({
          where: { requestedBy: targetUserId, OR: createPairs },
          select: { id: true },
        });
        const beforeIds = new Set(before.map((r) => r.id));

        // If another user's request for the same title ON THE SAME INSTANCE is
        // already APPROVED or AVAILABLE, the content is greenlit/fulfilled — mirror
        // that status so the bulk requester is tracked (and gets the "now available"
        // ping) instead of queuing a duplicate PENDING for an admin to re-review.
        // Matches the single POST /api/requests "mirror-approved" branch,
        // including its `cleanedUpAt: null`: a stamped row records a
        // deliberate removal, not a greenlight (guardrail 14b) — mirroring it
        // as APPROVED would let the sync re-push the deleted title.
        const greenlit = await tx.mediaRequest.findMany({
          where: { status: { in: ["APPROVED", "AVAILABLE"] }, cleanedUpAt: null, OR: createPairs },
          select: { tmdbId: true, mediaType: true, status: true },
        });
        // Which peers count is greenlitPeerStatuses, the single route's rule
        // (request-create.ts): an APPROVED peer always; an AVAILABLE one only when
        // the routed instance's *arr-available cache holds the title. Without that
        // the peer may have been marked off a restricted server this target has no
        // grant for (guardrail 35) or off the HD copy of a 4K request — not an
        // approval, and an APPROVED copy of it would be re-pushed by the sync with
        // no admin decision. Every item here has already been found absent from
        // the target's visible libraries. A copy is always created APPROVED (never
        // AVAILABLE): with the *arr holding the title the sync's arr marking pass
        // promotes and notifies it, and the re-push skips it.
        const greenlitKeys = new Set<string>();
        for (const g of greenlit) {
          const k = keyOf(g.tmdbId, g.mediaType);
          if ((greenlitPeerStatuses(arrAvailSet.has(k)) as string[]).includes(g.status)) greenlitKeys.add(k);
        }
        mirroredKeys.clear(); // the callback re-runs on a P2034 retry
        const now = new Date();
        await tx.mediaRequest.createMany({
          data: prepared.map((p) => {
            const k = keyOf(p.tmdbId, p.mediaType);
            const mirror = greenlitKeys.has(k);
            if (mirror) mirroredKeys.add(k);
            const status = mirror || p.autoApprove ? "APPROVED" : "PENDING";
            // Auto-approved (non-mirrored) rows arm the orchestrator's 90s
            // download-pending backstop, matching the single POST route. Mirrored
            // rows skip it — the original greenlit row drives notifications.
            const isAutoApproved = !mirror && p.autoApprove;
            return {
              tmdbId: p.tmdbId,
              mediaType: p.mediaType,
              arrInstance: p.arrInstance,
              title: p.title,
              posterPath: p.posterPath,
              releaseYear: p.releaseYear,
              note: null,
              requestedBy: targetUserId,
              // Who filed it, when on behalf — the filer's quota key (guardrail 6g).
              ...(isOnBehalf ? { filedBy: session.user.id } : {}),
              status,
              // No availableAt: a mirrored row is never created AVAILABLE (above).
              // Auto-approve is an approval (MediaRequest.approvedAt). A mirrored
              // row gets none of its own: the watch grade counts it through the
              // approval of the request it copied.
              ...(isAutoApproved ? { approvedAt: now, pendingNotifyAt: new Date(now.getTime() + DOWNLOAD_CHECK_DELAY_MS) } : {}),
            };
          }),
          skipDuplicates: true,
        });
        const after = await tx.mediaRequest.findMany({
          where: { requestedBy: targetUserId, OR: createPairs },
          select: { id: true, tmdbId: true, mediaType: true, status: true },
        });
        const created = after.filter((r) => !beforeIds.has(r.id));
        // Only a row this call created can take a thread: while the old row
        // still holds the key, skipDuplicates creates nothing for it.
        for (const r of created) {
          const staleId = staleDeclinedIdByKey.get(keyOf(r.tmdbId, r.mediaType));
          if (staleId) await restoreThread(tx, r.id, carriedThreads.get(staleId));
        }
        return created;
      },
      { isolationLevel: "Serializable" },
    ),
  );
  return { createdRows: createdRows as CreatedRows["createdRows"], mirroredKeys };
}

/**
 * Clears delete-votes for the titles just requested — a request and a deletion
 * vote are contradictory, and the vote route already blocks the reverse
 * direction. On behalf, that includes the filer: they requested it too
 * (filedBy), so their vote must go with the target's. Detached; its own catch.
 */
export function clearRequestedDeletionVotes(ctx: BulkContext, prepared: PreparedItem[]): void {
  const { session, isOnBehalf, targetUserId } = ctx;
  const pairs = prepared.map((p) => ({ tmdbId: p.tmdbId, mediaType: p.mediaType }));
  // .catch is required, not decorative: this is detached after the response is
  // sent, so an unhandled rejection (pool timeout under a concurrent sync) has no
  // request context to surface in and escapes as a process-level unhandledRejection.
  void prisma.deletionVote
    .deleteMany({
      where: {
        userId: { in: isOnBehalf ? [targetUserId, session.user.id] : [targetUserId] },
        OR: pairs,
      },
    })
    .catch((err) =>
      console.error(
        `[requests/bulk] deletionVote cleanup failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`,
      ),
    );
}

/**
 * Pushes the auto-approved rows to *arr (bounded, post-commit), rolling back to
 * PENDING on a definite push failure like the single route (an unknown outcome
 * stays APPROVED). Every created row emits request:new. Then ONE batched
 * download check, and ONE admin alert for the rolled-back rows (never one per
 * row — a failing arr would otherwise flood every admin channel on a 50-item
 * "Request all").
 */
export async function pushAutoApproved(
  ctx: BulkContext,
  prepared: PreparedItem[],
  created: CreatedRows,
): Promise<CreateOutcome[]> {
  const { session, target, targetUserId } = ctx;
  const { createdRows, mirroredKeys } = created;
  const rowByKey = new Map(createdRows.map((r) => [keyOf(r.tmdbId, r.mediaType), r]));
  // Rows that armed pendingNotifyAt AND landed in *arr — collected here rather than
  // derived from the outcomes, which cannot distinguish an auto-approved row that was
  // pushed from a mirrored one that deliberately skipped both the push and the flag.
  const downloadChecks: DownloadCheckTarget[] = [];
  // Auto-approvals whose push failed and rolled back to PENDING, row id by
  // (tmdbId:mediaType) — for the one admin alert after the loop.
  const rolledBack = new Map<string, string>();
  const outcomes = await mapLimit(prepared, ARR_CONCURRENCY, async (p): Promise<CreateOutcome> => {
    const row = rowByKey.get(keyOf(p.tmdbId, p.mediaType));
    if (!row) return { tmdbId: p.tmdbId, mediaType: p.mediaType, result: "error" };

    emitSSE({ type: "request:new", requestId: row.id, userId: targetUserId });

    // Mirrored rows (greenlit by another user) are already in *arr — re-pushing
    // would be a no-op at best; just track the row.
    if (mirroredKeys.has(keyOf(p.tmdbId, p.mediaType))) {
      // Mirrored rows are APPROVED by construction (never AVAILABLE — see the
      // create tx), so they read as auto-approved, not already-available.
      return { tmdbId: p.tmdbId, mediaType: p.mediaType, result: "auto-approved" };
    }

    if (row.status !== "APPROVED") {
      return { tmdbId: p.tmdbId, mediaType: p.mediaType, result: "created" };
    }
    let pushedTvdbId: number | null = null;
    const pushProgress: AddProgress = { sent: false };
    try {
      if (p.mediaType === "MOVIE") {
        await addMovieToRadarr(p.tmdbId, p.arrInstance, undefined, targetUserId, pushProgress);
      } else {
        pushedTvdbId = await addSeriesToSonarr(p.tmdbId, p.arrInstance, undefined, targetUserId, pushProgress);
      }
    } catch (err) {
      const message = sanitizeForLog(err instanceof Error ? err.message : String(err));
      // Unknown only once the add itself was sent (AddProgress).
      if (pushProgress.sent && arrWriteOutcomeUnknown(err)) {
        // No definite answer (a timeout, a dropped connection, a gateway 502/504):
        // the arr may have added it. Left APPROVED, like the single route; the sync
        // re-pushes an APPROVED title the arr doesn't hold. Falls through to the
        // auto-approved bookkeeping below (the armed backstop is still consumed).
        console.error(`[requests/bulk] auto-approve push outcome unknown, left APPROVED: ${message}`);
      } else {
        console.error(`[requests/bulk] auto-approve push failed: ${message}`);
        // CAS on status: only roll back if still APPROVED — a concurrent webhook/sync
        // may have flipped this row to AVAILABLE. Clear pendingNotifyAt too.
        const rb = await prisma.mediaRequest
          .updateMany({ where: { id: row.id, status: "APPROVED" }, data: { status: "PENDING", pendingNotifyAt: null } })
          .catch((rbErr: unknown) => {
            console.error(`[requests/bulk] rollback to PENDING failed: ${sanitizeForLog(rbErr instanceof Error ? rbErr.message : String(rbErr))}`);
            return { count: 0 };
          });
        // The client already saw request:new for an APPROVED row; emit a corrective
        // update so it reflects the rolled-back PENDING state (mirrors the single route).
        emitSSE({ type: "request:updated", requestId: row.id, status: "PENDING", userId: targetUserId });
        // Only a row that really went back to PENDING is the admins' to review.
        if (rb.count === 1) rolledBack.set(keyOf(p.tmdbId, p.mediaType), row.id);
        return { tmdbId: p.tmdbId, mediaType: p.mediaType, result: "created", pushFailed: true };
      }
    }

    // Bookkeeping write kept OUT of the try above: Sonarr has already accepted the series
    // by this point, so a P2025 (row deleted mid-push) or transient DB error must not trip
    // the APPROVED->PENDING rollback and leave Sonarr grabbing content the DB says is
    // pending. updateMany no-ops on a concurrently deleted row instead of throwing.
    // The task must still self-catch: mapLimit is a bounded Promise.all (guardrail 31),
    // so an escaping error here would reject the whole bulk run.
    if (pushedTvdbId !== null) {
      await prisma.mediaRequest
        .updateMany({ where: { id: row.id }, data: { tvdbId: pushedTvdbId } })
        .catch((err) =>
          console.error(
            `[requests/bulk] tvdbId bookkeeping write failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`,
          ),
        );
    }

    downloadChecks.push({
      requestId: row.id,
      tmdbId: p.tmdbId,
      mediaType: p.mediaType,
      arrInstance: p.arrInstance,
      requestedBy: targetUserId,
      title: p.title,
    });
    return { tmdbId: p.tmdbId, mediaType: p.mediaType, result: "auto-approved" };
  });

  // Run the pendingNotifyAt check PROMPTLY at ~90s instead of leaving it to the
  // orchestrator's next sweep. One batched job, not one per row — a 50-item bulk
  // request would otherwise take half the delayed-job run queue on its own.
  scheduleDownloadChecks(downloadChecks, { name: "requests/bulk:90s-download-check" });

  // The rolled-back auto-approvals sit in the admin queue with their backstop
  // cleared, and nothing else will tell an admin (the single route announces its
  // one). It names the first in the caller's order; the queue lists them all.
  const firstRolledBack = prepared.find((p) => rolledBack.has(keyOf(p.tmdbId, p.mediaType)));
  if (firstRolledBack) {
    alertAdminsNewRequest({
      requestId: rolledBack.get(keyOf(firstRolledBack.tmdbId, firstRolledBack.mediaType))!,
      tmdbId: firstRolledBack.tmdbId,
      mediaType: firstRolledBack.mediaType,
      instance: firstRolledBack.arrInstance,
      title: firstRolledBack.title,
      posterPath: firstRolledBack.posterPath ?? null,
      releaseYear: firstRolledBack.releaseYear ?? null,
      requestedBy: target.name ?? target.email ?? targetUserId,
      note: null,
      excludeUserId: session.user.id,
    });
  }
  return outcomes;
}
