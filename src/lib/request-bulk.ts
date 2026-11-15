import { prisma } from "@/lib/prisma";
import type { SummonarrSession } from "@/lib/api-auth";
import { runWithSerializableRetry } from "@/lib/serializable-retry";
import { emitSSE } from "@/lib/sse-emitter";
import { DOWNLOAD_CHECK_DELAY_MS, scheduleDownloadChecks } from "@/lib/download-check";
import { sanitizeForLog } from "@/lib/sanitize";
import { resolveMediaMeta } from "@/lib/request-meta";
import { getBlacklistSet } from "@/lib/blacklist";
import { getSyncableArrInstances } from "@/lib/arr-instance-registry";
import type { ResolvedQuota } from "@/lib/quota";
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
import { alertAdminsNewRequest, assertQuotaInTx, autoRouteSlug, detailsLoader, enforcedQuota, ratingCapsVerdict } from "@/lib/request-policy";
import { downloadChecksFor, pushApprovals, type FollowUpRow } from "@/lib/request-transition";

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
  // A self-request's Discord link, for the site-wide linked-account requirement.
  discordId: string | null;
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
  const [radarrConfigured, sonarrConfigured, mediaAccess] = await Promise.all([
    getSyncableArrInstances("radarr"),
    getSyncableArrInstances("sonarr"),
    getMediaInstanceAccessLists(),
  ]);
  const configuredByType = { MOVIE: radarrConfigured, TV: sonarrConfigured } as const;
  const bySlug = { MOVIE: indexBySlug(radarrConfigured), TV: indexBySlug(sonarrConfigured) } as const;
  const detailsOf = memoizedDetails();
  const routingActive =
    radarrConfigured.some((i) => i.slug !== "" && i.autoRoute) ||
    sonarrConfigured.some((i) => i.slug !== "" && i.autoRoute);
  const slugByKey = new Map<string, string>();
  let serverAll4k = false;
  if (routingActive) {
    await mapLimit(items, ARR_CONCURRENCY, async (it) => {
      const slug = await autoRouteSlug(configuredByType[it.mediaType], detailsOf(it));
      if (slug !== "") slugByKey.set(keyOf(it.tmdbId, it.mediaType), slug);
    });
    serverAll4k = (await prisma.setting.findUnique({ where: { key: "request4kAll" } }))?.value === "true";
    dropUnusableRoutes(ctx, items, slugByKey, (it, slug) => bySlug[it.mediaType].get(slug) ?? DEFAULT_ACCESS, serverAll4k);
  }
  const slugOf = (it: BulkItem) => slugByKey.get(keyOf(it.tmdbId, it.mediaType)) ?? "";
  // Access metadata for the routed instance; the default instance is open to any
  // base requester, so a missing registry entry safely degrades to that shape.
  const instOf = (it: BulkItem) => bySlug[it.mediaType].get(slugOf(it)) ?? DEFAULT_ACCESS;
  return { slugOf, instOf, serverAll4k, mediaAccess, detailsOf };
}

// The registry by slug, first entry winning — the order a `find` over the list read it.
function indexBySlug<T extends { slug: string }>(instances: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const inst of instances) if (!out.has(inst.slug)) out.set(inst.slug, inst);
  return out;
}

// Per-item TMDB details, read at most once across routing and the rating cap.
function memoizedDetails(): (it: BulkItem) => ReturnType<typeof detailsLoader> {
  const loaders = new Map<string, ReturnType<typeof detailsLoader>>();
  return (it) => {
    const k = keyOf(it.tmdbId, it.mediaType);
    let load = loaders.get(k);
    if (!load) loaders.set(k, (load = detailsLoader(it.tmdbId, it.mediaType)));
    return load;
  };
}

// An auto-routed instance the target (or a checked filer) can't use falls back
// to the default — removed here, before the availability, create and arr-push
// lookups all key off slugOf(), so the whole item runs on its effective slug.
// Bulk items are always auto-routed (never an explicit target), so there is no
// explicit-choice case to preserve as a hard reject.
function dropUnusableRoutes(
  ctx: BulkContext,
  items: BulkItem[],
  slugByKey: Map<string, string>,
  instanceFor: (it: BulkItem, slug: string) => InstanceAccess,
  serverAll4k: boolean,
): void {
  const { targetPerms, grants, filerMay } = ctx;
  for (const it of items) {
    const key = keyOf(it.tmdbId, it.mediaType);
    const routed = slugByKey.get(key);
    if (routed === undefined || routed === "") continue;
    const inst = instanceFor(it, routed);
    if (!canRequestInstance(targetPerms, inst, grants, it.mediaType, serverAll4k) || !filerMay(inst, it.mediaType, serverAll4k)) {
      slugByKey.delete(key); // slugOf() now returns "" (default instance)
    }
  }
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
  const [state, blacklistSet] = await Promise.all([loadItemState(ctx, items, routing, visible), getBlacklistSet()]);
  const skipped: CreateOutcome[] = [];
  const toCreate: BulkItem[] = [];
  const staleDeclinedIdByKey = new Map<string, string>();
  for (const it of items) {
    const k = keyOf(it.tmdbId, it.mediaType);
    const verdict = blacklistSet.has(k) ? "blacklisted" : itemVerdict(ctx, it, routing, state);
    if (verdict === "create") {
      toCreate.push(it);
    } else if (typeof verdict === "object") {
      // An ordinary (non-permanent) decline is re-requestable: the stale row is
      // deleted in the create transaction and a fresh one created.
      staleDeclinedIdByKey.set(k, verdict.replacing);
      toCreate.push(it);
    } else {
      skipped.push({ ...it, result: verdict });
    }
  }
  return { skipped, toCreate, staleDeclinedIdByKey, arrAvailSet: state.arrAvailSet };
}

// What the database already says about the items, every lookup scoped to each
// item's ROUTED instance and the target's visible servers.
interface ItemState {
  existingByKey: Map<string, { id: string; status: string; permanentlyDeclined: boolean }>;
  libraryAvailSet: Set<string>;
  arrAvailSet: Set<string>;
}

async function loadItemState(
  ctx: BulkContext,
  items: BulkItem[],
  routing: BulkRouting,
  visible: { plex: string[]; jellyfin: string[] },
): Promise<ItemState> {
  const { slugOf } = routing;
  const orPairs = items.map((i) => ({ tmdbId: i.tmdbId, mediaType: i.mediaType }));
  const instPairs = items.map((i) => ({ tmdbId: i.tmdbId, mediaType: i.mediaType, arrInstance: slugOf(i) }));
  const movieItems = items.filter((i) => i.mediaType === "MOVIE");
  const tvItems = items.filter((i) => i.mediaType === "TV");
  const [existingReqs, plexItems, jellyfinItems, radarrAvail, sonarrAvail] = await Promise.all([
    prisma.mediaRequest.findMany({
      where: { requestedBy: ctx.targetUserId, OR: instPairs },
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
  const libraryAvailSet = new Set<string>();
  for (const r of plexItems) libraryAvailSet.add(keyOf(r.tmdbId, r.mediaType));
  for (const r of jellyfinItems) libraryAvailSet.add(keyOf(r.tmdbId, r.mediaType));
  const arrAvailSet = new Set<string>();
  for (const r of radarrAvail) arrAvailSet.add(keyOf(r.tmdbId, "MOVIE"));
  for (const r of sonarrAvail) arrAvailSet.add(keyOf(r.tmdbId, "TV"));
  return { existingByKey: new Map(existingReqs.map((r) => [keyOf(r.tmdbId, r.mediaType), r])), libraryAvailSet, arrAvailSet };
}

// One item's verdict: create it, replace a stale ordinary decline, or skip it
// with the result the caller is told. APPROVED/AVAILABLE/PENDING requests of the
// target's own stay blocked.
function itemVerdict(
  ctx: BulkContext,
  it: BulkItem,
  routing: BulkRouting,
  state: ItemState,
): "create" | { replacing: string } | Exclude<ItemResult, "created" | "auto-approved" | "error"> {
  const { targetPerms, grants, filerMay } = ctx;
  const { instOf, serverAll4k } = routing;
  const k = keyOf(it.tmdbId, it.mediaType);
  const inst = instOf(it);
  if (!canRequestInstance(targetPerms, inst, grants, it.mediaType, serverAll4k) || !filerMay(inst, it.mediaType, serverAll4k)) {
    return "no-permission";
  }
  // skipLibraryCheck instances (e.g. 4K) ignore the shared Plex/Jellyfin
  // library — only that instance's own arr availability short-circuits.
  // The *arr-available cache short-circuits ONLY for a requester who would be
  // auto-approved — exactly request-create.ts (`isAutoApprove && arrHasInstance`),
  // which the Discord picker files through too. Everyone else files a normal
  // request, so the sync's arr marking pass can notify them when it lands.
  const arrAvailSet = state.arrAvailSet;
  const arrCounts = arrAvailSet.has(k) && canAutoApproveInstance(targetPerms, inst, grants, it.mediaType) && filerMay(inst, it.mediaType, serverAll4k, true);
  if ((!inst.skipLibraryCheck && state.libraryAvailSet.has(k)) || arrCounts) return "already-available";
  const ex = state.existingByKey.get(k);
  if (!ex) return "create";
  if (ex.permanentlyDeclined) return "skipped-declined";
  if (ex.status === "DECLINED") return { replacing: ex.id };
  return "already-requested";
}

/**
 * Parental control — drops any item whose US certification exceeds the TARGET
 * user's cap. Runs BEFORE the stale-DECLINED delete (in the create transaction),
 * like the single POST /api/requests, which gates blacklist + rating before
 * deleting the stale row: a rating-blocked re-request keeps its DECLINED row
 * (removed from `staleDeclinedIdByKey` here). Only capped, non-admin targets pay
 * the per-item certification fetch; unknown/unrated titles are allowed, and a
 * title whose certification could not be read is filed but never auto-approved
 * (`unverifiedKeys`, ratingCapsVerdict — the single route's rule).
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
): Promise<{ toCreate: BulkItem[]; ratingBlocked: CreateOutcome[]; unverifiedKeys: Set<string> }> {
  const { target, targetPerms, filerChecked, filerRow } = ctx;
  const caps = [
    target.maxContentRating && !hasPermission(targetPerms, Permission.ADMIN) ? target.maxContentRating : null,
    filerChecked ? filerRow?.maxContentRating ?? null : null,
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  if (caps.length === 0) return { toCreate, ratingBlocked: [], unverifiedKeys: new Set() };
  const checked = await mapLimit(toCreate, ARR_CONCURRENCY, async (it) => ({
    it,
    verdict: await ratingCapsVerdict(caps, routing.detailsOf(it)),
  }));
  const ratingBlocked = checked
    .filter((c) => c.verdict === "blocked")
    .map((c): CreateOutcome => ({ tmdbId: c.it.tmdbId, mediaType: c.it.mediaType, result: "rating-blocked" }));
  // A rating-blocked title is NOT being (re)created — keep its stale DECLINED row.
  for (const b of ratingBlocked) staleDeclinedIdByKey.delete(keyOf(b.tmdbId, b.mediaType));
  const unverifiedKeys = new Set(checked.filter((c) => c.verdict === "unverified").map((c) => keyOf(c.it.tmdbId, c.it.mediaType)));
  return { toCreate: checked.filter((c) => c.verdict !== "blocked").map((c) => c.it), ratingBlocked, unverifiedKeys };
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
 * stale DECLINED row (the same compensation the rating gate applies). An item
 * whose rating could not be verified (`unverifiedKeys`) is never auto-approved.
 */
export async function prepareItems(
  ctx: BulkContext,
  toCreate: BulkItem[],
  routing: BulkRouting,
  staleDeclinedIdByKey: Map<string, string>,
  unverifiedKeys: ReadonlySet<string> = new Set(),
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
            !unverifiedKeys.has(keyOf(r.it.tmdbId, r.it.mediaType)) &&
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

/**
 * The first of `awaiting` (caller's order) with no EARLIER pending request for
 * the same title and instance — the single route's dedupe (hasEarlierPending),
 * in two reads for the whole batch. A title someone else already has pending was
 * announced when theirs was filed. A failed read alerts for the first anyway: a
 * duplicate alert is cheaper than a lost one.
 */
async function firstUnannounced<P extends { tmdbId: number; mediaType: MediaType; arrInstance: string }>(
  awaiting: P[],
  idByKey: ReadonlyMap<string, string>,
): Promise<P | undefined> {
  if (awaiting.length === 0) return undefined;
  try {
    const ownIds = awaiting.map((p) => idByKey.get(keyOf(p.tmdbId, p.mediaType))!);
    const own = await prisma.mediaRequest.findMany({ where: { id: { in: ownIds } }, select: { id: true, createdAt: true } });
    const others = await prisma.mediaRequest.findMany({
      where: {
        status: "PENDING",
        id: { notIn: ownIds },
        OR: awaiting.map((p) => ({ tmdbId: p.tmdbId, mediaType: p.mediaType, arrInstance: p.arrInstance })),
      },
      select: { id: true, createdAt: true, tmdbId: true, mediaType: true, arrInstance: true },
    });
    const createdAtById = new Map(own.map((r) => [r.id, r.createdAt]));
    return awaiting.find((p) => {
      const id = idByKey.get(keyOf(p.tmdbId, p.mediaType))!;
      const createdAt = createdAtById.get(id);
      if (!createdAt) return true;
      return !others.some((o) =>
        o.tmdbId === p.tmdbId && o.mediaType === p.mediaType && o.arrInstance === p.arrInstance &&
        (o.createdAt < createdAt || (o.createdAt.getTime() === createdAt.getTime() && o.id < id)));
    });
  } catch (err) {
    console.error(`[requests/bulk] earlier-pending check failed, alerting anyway: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    return awaiting[0];
  }
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
 * The callback re-runs on a P2034 retry, so everything it decides is in what it
 * returns.
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
  const { session, isOnBehalf, targetUserId } = ctx;
  const { staleDeclinedIdByKey, arrAvailSet } = classified;
  const staleDeclinedIds = [...staleDeclinedIdByKey.values()];
  const quotas = await bulkQuotas(ctx, prepared);
  const createPairs = prepared.map((p) => ({ tmdbId: p.tmdbId, mediaType: p.mediaType, arrInstance: p.arrInstance }));
  const committed = await runWithSerializableRetry(() =>
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
        for (const q of quotas) await assertQuotaInTx(tx, q.userId, q.mediaType, q.quota, q.adding, q.whose);
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
        const mirroredKeys = new Set<string>();
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
        return { created, mirroredKeys };
      },
      { isolationLevel: "Serializable" },
    ),
  );
  return { createdRows: committed.created, mirroredKeys: committed.mirroredKeys };
}

interface QuotaCharge {
  userId: string;
  mediaType: MediaType;
  quota: ResolvedQuota;
  adding: number;
  whose: "target" | "filer";
}

/**
 * The quota windows the insert must fit, per media type: the target's, and a
 * non-ADMIN on-behalf filer's OWN (guardrail 6g) — the rows carry filedBy, and
 * quotaUsageWhere counts what a user filed for others beside what was filed for
 * them, so naming other users can't multiply what a delegate may file.
 */
async function bulkQuotas(ctx: BulkContext, prepared: PreparedItem[]): Promise<QuotaCharge[]> {
  const { session, target, targetUserId, targetPerms, filerChecked, filerRow } = ctx;
  const enforceQuota = !hasPermission(targetPerms, Permission.QUOTA_UNLIMITED);
  const enforceFilerQuota =
    filerChecked && filerRow !== null && !hasPermission(session.user.permissions, Permission.QUOTA_UNLIMITED);
  if (!enforceQuota && !enforceFilerQuota) return [];
  const qrows = await prisma.setting.findMany({ where: { key: { in: ["quotaLimit", "quotaPeriod"] } } });
  const quotaSettings: { quotaLimit?: string; quotaPeriod?: string } = Object.fromEntries(qrows.map((s) => [s.key, s.value]));
  const charges: QuotaCharge[] = [];
  for (const mt of ["MOVIE", "TV"] as MediaType[]) {
    const adding = prepared.filter((p) => p.mediaType === mt).length;
    if (adding === 0) continue;
    const targetQuota = enforceQuota ? enforcedQuota(targetPerms, mt, target, quotaSettings) : null;
    if (targetQuota) charges.push({ userId: targetUserId, mediaType: mt, quota: targetQuota, adding, whose: "target" });
    const filerQuota = enforceFilerQuota && filerRow ? enforcedQuota(session.user.permissions, mt, filerRow, quotaSettings) : null;
    if (filerQuota) charges.push({ userId: session.user.id, mediaType: mt, quota: filerQuota, adding, whose: "filer" });
  }
  return charges;
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
 * Pushes the auto-approved rows to *arr (bounded, post-commit) through the shared
 * state machine (request-transition.ts): a definite failure rolls the row back
 * to PENDING, an unknown outcome stays APPROVED. Every created row emits
 * request:new. Then ONE batched download check, and ONE admin alert for the
 * rows left PENDING (never one per row — a failing arr would otherwise flood every
 * admin channel on a 50-item "Request all").
 */
export async function pushAutoApproved(
  ctx: BulkContext,
  prepared: PreparedItem[],
  created: CreatedRows,
): Promise<CreateOutcome[]> {
  const { session, target, targetUserId } = ctx;
  const { createdRows, mirroredKeys } = created;
  const rowByKey = new Map(createdRows.map((r) => [keyOf(r.tmdbId, r.mediaType), r]));
  const outcomeByKey = new Map<string, CreateOutcome>();
  // Rows that end up PENDING, row id by key (created pending, or rolled back below).
  const awaitingReview = new Map<string, string>();
  const toPush: Array<FollowUpRow & { key: string }> = [];
  for (const p of prepared) {
    const key = keyOf(p.tmdbId, p.mediaType);
    const row = rowByKey.get(key);
    if (!row) {
      outcomeByKey.set(key, { tmdbId: p.tmdbId, mediaType: p.mediaType, result: "error" });
      continue;
    }
    emitSSE({ type: "request:new", requestId: row.id, userId: targetUserId });
    if (mirroredKeys.has(key)) {
      // Greenlit by another user's request, so already in *arr — re-pushing would
      // be a no-op at best. Mirrored rows are APPROVED by construction (never
      // AVAILABLE — see the create tx), so they read as auto-approved, not
      // already-available.
      outcomeByKey.set(key, { tmdbId: p.tmdbId, mediaType: p.mediaType, result: "auto-approved" });
    } else if (row.status !== "APPROVED") {
      outcomeByKey.set(key, { tmdbId: p.tmdbId, mediaType: p.mediaType, result: "created" });
      // Created for review: admins hear about it like a single request's.
      awaitingReview.set(key, row.id);
    } else {
      // No profile: bulk has no picker, so the instance default applies.
      toPush.push({ key, id: row.id, tmdbId: p.tmdbId, mediaType: p.mediaType, arrInstance: p.arrInstance, requestedBy: targetUserId, qualityProfileId: null, title: p.title, posterPath: p.posterPath });
    }
  }

  const settled = await pushApprovals(toPush, "Bulk auto-approve");
  for (const { row, outcome } of settled) {
    if (outcome.kind === "rolled-back") awaitingReview.set(row.key, row.id);
    // A rollback is reported as a request created for review; any other outcome
    // left the approval in place (an unknown push, or a rollback that did not
    // land because the row moved on), as the single route answers it.
    outcomeByKey.set(row.key, outcome.kind === "rolled-back"
      ? { tmdbId: row.tmdbId, mediaType: row.mediaType === "MOVIE" ? "MOVIE" : "TV", result: "created", pushFailed: true }
      : { tmdbId: row.tmdbId, mediaType: row.mediaType === "MOVIE" ? "MOVIE" : "TV", result: "auto-approved" });
  }

  // Run the pendingNotifyAt check PROMPTLY at ~90s instead of leaving it to the
  // orchestrator's next sweep, for every row that kept its armed backstop. One
  // batched job, not one per row — a 50-item bulk request would otherwise take
  // half the delayed-job run queue on its own.
  scheduleDownloadChecks(downloadChecksFor(settled), { name: "requests/bulk:90s-download-check" });

  // Rows left PENDING (created for review, or a rolled-back auto-approval with
  // its backstop cleared) sit in the admin queue, and nothing else will tell an
  // admin. One alert for the whole batch, naming the first in the caller's order
  // that admins have not already been told about (the single route's
  // first-PENDING-per-title rule); the queue lists them all.
  const firstAwaiting = await firstUnannounced(prepared.filter((p) => awaitingReview.has(keyOf(p.tmdbId, p.mediaType))), awaitingReview);
  if (firstAwaiting) {
    alertAdminsNewRequest({
      requestId: awaitingReview.get(keyOf(firstAwaiting.tmdbId, firstAwaiting.mediaType))!,
      tmdbId: firstAwaiting.tmdbId,
      mediaType: firstAwaiting.mediaType,
      instance: firstAwaiting.arrInstance,
      title: firstAwaiting.title,
      posterPath: firstAwaiting.posterPath ?? null,
      releaseYear: firstAwaiting.releaseYear ?? null,
      requestedBy: target.name ?? target.email ?? targetUserId,
      note: null,
      excludeUserId: session.user.id,
    });
  }
  // In the caller's order.
  return prepared.map(
    (p) => outcomeByKey.get(keyOf(p.tmdbId, p.mediaType)) ?? { tmdbId: p.tmdbId, mediaType: p.mediaType, result: "error" as const },
  );
}
