import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { emitNotificationEvent } from "@/lib/notify-agents";
import { notifyAdminsNewRequest } from "@/lib/email";
import { notifyAdminsNewRequestPush } from "@/lib/push";
import { notifyAdminsNewRequestDiscord } from "@/lib/discord-notify";
import { getMovieDetails, getTVDetails } from "@/lib/tmdb";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { routeMediaToSlug, type ArrInstanceConfig, type RoutableMedia } from "@/lib/arr-instances";
import { exceedsCap } from "@/lib/content-rating";
import { canAutoApproveInstance, canRequestInstance, hasPermission, Permission, type InstanceAccess, type InstanceGrants } from "@/lib/permissions";
import { resolveUserQuota, parseQuotaLimit, quotaUsageWhere, type ResolvedQuota } from "@/lib/quota";

// The policy steps every request-creation path shares — the web/auto-request
// chokepoint (request-create.ts), the bulk route (request-bulk.ts) and, through
// the chokepoint, the Discord picker. One copy of each rule, so a change to it
// reaches every path (they used to be three hand-kept copies that drifted).

type MediaType = "MOVIE" | "TV";

/**
 * Thrown inside a create transaction when the quota re-count finds the window
 * full: the throw rolls the transaction back (guardrail 23), and the caller
 * answers the refusal from these fields. Not retryable — runWithSerializableRetry
 * retries P2034 only.
 *
 * Fields are declared and assigned explicitly rather than via constructor
 * parameter properties: the unit suite runs source through Node's strip-only TS
 * mode, which rejects that sugar outright.
 */
export class QuotaExceededError extends Error {
  readonly mediaType: MediaType;
  readonly limit: number;
  readonly windowLabel: string;
  readonly used: number;
  // Whose quota ran out: the requester's, or (on behalf) the FILER's own.
  readonly whose: "target" | "filer";

  constructor(mediaType: MediaType, limit: number, windowLabel: string, used: number, whose: "target" | "filer" = "target") {
    super("QUOTA_EXCEEDED");
    this.name = "QuotaExceededError";
    this.mediaType = mediaType;
    this.limit = limit;
    this.windowLabel = windowLabel;
    this.used = used;
    this.whose = whose;
  }
}

/**
 * A TMDB details reader that fetches at most once: routing and the rating cap
 * both want the details. A failure is not kept, so the next caller retries,
 * exactly as each site did when it fetched on its own.
 */
export function detailsLoader(tmdbId: number, mediaType: MediaType): () => Promise<TmdbMedia> {
  let pending: Promise<TmdbMedia> | null = null;
  return () =>
    (pending ??= (mediaType === "MOVIE" ? getMovieDetails(tmdbId) : getTVDetails(tmdbId)).catch((err: unknown) => {
      pending = null;
      throw err;
    }));
}

// What the auto-route rules read from a title's TMDB details.
export function routableFrom(detail: TmdbMedia): RoutableMedia {
  return {
    genreIds: detail.genreList?.map((g) => g.id) ?? [],
    originalLanguage: detail.originalLanguage ?? null,
    // ISO codes from the normalized details (populated since the
    // originCountryCodes field landed; older cached rows lack it and
    // degrade to [] — exactly the previous behavior — until TTL refresh).
    originCountries: detail.originCountryCodes ?? [],
  };
}

/**
 * The instance a request with no explicit target routes to: the first
 * CONFIGURED non-default instance whose auto-route rule matches the title, else
 * the default (""). Only pays the TMDB details fetch when such an instance
 * carries a rule; TMDB unavailable ⇒ the default instance.
 */
export async function autoRouteSlug(
  configured: readonly ArrInstanceConfig[],
  loadDetails: () => Promise<TmdbMedia>,
): Promise<string> {
  if (!configured.some((i) => i.slug !== "" && i.autoRoute)) return "";
  let routable: RoutableMedia = { genreIds: [], originalLanguage: null, originCountries: [] };
  try {
    routable = routableFrom(await loadDetails());
  } catch {
    // TMDB details unavailable ⇒ fall back to the default instance.
  }
  return routeMediaToSlug(configured, routable);
}

export type TargetInstanceResult =
  | { ok: true; instance: ArrInstanceConfig; explicit: boolean }
  | { ok: false; reason: "instance-unavailable"; instanceName?: string }
  | { ok: false; reason: "forbidden" };

/**
 * Which Radarr/Sonarr instance a request targets (guardrail 32). Precedence:
 * an explicit `arrInstance` slug (validated) > the legacy `is4k: true` (→ "4k")
 * > auto-route over the configured instances > the default instance ("").
 *
 * An EXPLICIT target the requester can't use is refused. An AUTO-ROUTED one
 * falls back to the default instance — a base requester is never blocked by a
 * server-side routing decision — but only after re-checking the default: the
 * base REQUEST bit gates every instance, so without the re-check a
 * request-revoked user could bypass it by omitting the target.
 */
export async function resolveTargetInstance(opts: {
  instances: readonly ArrInstanceConfig[];
  configured: ReadonlySet<string>;
  arrInstance?: string;
  is4k?: boolean;
  loadDetails: () => Promise<TmdbMedia>;
  perms: bigint;
  grants: InstanceGrants;
  mediaType: MediaType;
  request4kAll: boolean;
}): Promise<TargetInstanceResult> {
  const { instances, configured } = opts;
  const rawInstance = typeof opts.arrInstance === "string" ? opts.arrInstance.trim() : undefined;
  const explicit = rawInstance !== undefined || opts.is4k === true;
  const slug =
    rawInstance !== undefined
      ? rawInstance
      : opts.is4k === true
        ? "4k"
        : await autoRouteSlug(instances.filter((i) => configured.has(i.slug)), opts.loadDetails);

  const instance = instances.find((i) => i.slug === slug);
  if (!instance) return { ok: false, reason: "instance-unavailable" };
  // A non-default instance must have a configured connection (url + apiKey). The
  // default ("") is always allowed — with no arr configured the request stays pending.
  if (slug !== "" && !configured.has(slug)) return { ok: false, reason: "instance-unavailable", instanceName: instance.name };

  const may = (inst: ArrInstanceConfig) => canRequestInstance(opts.perms, inst, opts.grants, opts.mediaType, opts.request4kAll);
  if (may(instance)) return { ok: true, instance, explicit };
  if (explicit) return { ok: false, reason: "forbidden" };
  const defaultInstance = instances.find((i) => i.slug === "");
  if (!defaultInstance || !may(defaultInstance)) return { ok: false, reason: "forbidden" };
  return { ok: true, instance: defaultInstance, explicit };
}

/**
 * What content-rating caps make of a title:
 *   allowed     no cap applies, or the title is within every cap. An unknown or
 *               unrated certification is allowed (content-rating.ts).
 *   blocked     the title exceeds a cap: refused.
 *   unverified  the certification could not be read (TMDB down, a timeout).
 *               Not refused — a TMDB outage must not block every capped user —
 *               but never auto-approved: an admin reviews it, so an outage can't
 *               slip a title past a cap and straight into Radarr/Sonarr.
 * Only a request with a cap pays the (cached) certification fetch.
 */
export type RatingCapVerdict = "allowed" | "blocked" | "unverified";

export async function ratingCapsVerdict(
  caps: readonly string[],
  loadDetails: () => Promise<TmdbMedia>,
): Promise<RatingCapVerdict> {
  if (caps.length === 0) return "allowed";
  let cert: string | undefined;
  try {
    cert = (await loadDetails()).certification;
  } catch {
    return "unverified";
  }
  return caps.some((cap) => exceedsCap(cert, cap)) ? "blocked" : "allowed";
}

/** The verdict for one requester's own cap; an ADMIN has none. */
export function ratingCapVerdict(
  perms: bigint,
  cap: string | null | undefined,
  loadDetails: () => Promise<TmdbMedia>,
): Promise<RatingCapVerdict> {
  return ratingCapsVerdict(cap && !hasPermission(perms, Permission.ADMIN) ? [cap] : [], loadDetails);
}

/**
 * Whether a request auto-approves on `instance` (canAutoApproveInstance). A
 * Discord auto-approve role (`roleGrant`) counts as the global AUTO_APPROVE bit
 * and nothing more: like that bit, it never reaches the 4K instance (the
 * AUTO_APPROVE_4K bits) or a restricted named instance (a per-user grant).
 */
export function autoApprovesOn(
  perms: bigint,
  instance: InstanceAccess,
  grants: InstanceGrants,
  mediaType: MediaType,
  roleGrant = false,
): boolean {
  return canAutoApproveInstance(roleGrant ? perms | Permission.AUTO_APPROVE : perms, instance, grants, mediaType);
}

export interface QuotaFields {
  movieQuotaLimit: number | null;
  movieQuotaDays: number | null;
  tvQuotaLimit: number | null;
  tvQuotaDays: number | null;
}

/**
 * The quota a request is held to: the per-user override, else the global
 * window. Null when nothing is enforced — QUOTA_UNLIMITED (ADMIN passes via the
 * superbit) or a limit of 0.
 */
export function enforcedQuota(
  perms: bigint,
  mediaType: MediaType,
  user: Partial<QuotaFields> | null | undefined,
  settings: { quotaLimit?: string | null; quotaPeriod?: string | null },
): ResolvedQuota | null {
  if (hasPermission(perms, Permission.QUOTA_UNLIMITED)) return null;
  const rq = resolveUserQuota(
    mediaType,
    {
      movieQuotaLimit: user?.movieQuotaLimit ?? null,
      movieQuotaDays: user?.movieQuotaDays ?? null,
      tvQuotaLimit: user?.tvQuotaLimit ?? null,
      tvQuotaDays: user?.tvQuotaDays ?? null,
    },
    parseQuotaLimit(settings.quotaLimit ?? undefined),
    settings.quotaPeriod ?? "week",
  );
  return rq.limit > 0 ? rq : null;
}

type QuotaCounter = { mediaRequest: { count: (args: { where: ReturnType<typeof quotaUsageWhere> }) => Promise<number> } };

// How many requests the user's window already counts (guardrail 6g: what was
// filed for them plus what they filed for others).
export function quotaUsed(db: QuotaCounter, userId: string, mediaType: MediaType, rq: ResolvedQuota): Promise<number> {
  return db.mediaRequest.count({ where: quotaUsageWhere(userId, mediaType, rq.since) });
}

/**
 * The in-transaction quota re-check: throws QuotaExceededError when `adding`
 * more requests would pass the limit, rolling the transaction back. The
 * pre-transaction check is the early answer; this one is authoritative.
 */
export async function assertQuotaInTx(
  tx: QuotaCounter,
  userId: string,
  mediaType: MediaType,
  rq: ResolvedQuota,
  adding = 1,
  whose: "target" | "filer" = "target",
): Promise<void> {
  const used = await quotaUsed(tx, userId, mediaType, rq);
  if (used + adding > rq.limit) throw new QuotaExceededError(mediaType, rq.limit, rq.windowLabel, used, whose);
}

// Runs a task once the response is sent (next/server after()). A caller with no
// response to wait for — the Discord handler, already answered — passes its own.
export type AfterResponse = (task: () => Promise<void>) => void;

/**
 * The admin "new request" alert for one PENDING request: the outbound channels
 * (through emitNotificationEvent, guardrail 14c) plus the admin email, push and
 * Discord notifiers, after the response. `excludeUserId` is the account that
 * acted, which needs no alert about it. `schedule` defaults to after(), which
 * needs a request scope.
 */
export function alertAdminsNewRequest(
  r: {
    requestId: string;
    tmdbId: number;
    mediaType: MediaType;
    instance: string;
    title: string;
    posterPath: string | null;
    releaseYear: string | null;
    requestedBy: string;
    note: string | null;
    excludeUserId: string;
  },
  schedule: AfterResponse = after,
): void {
  schedule(async () => {
    emitNotificationEvent({
      event: "request.created",
      media: { type: r.mediaType, tmdbId: r.tmdbId, title: r.title, year: r.releaseYear, posterPath: r.posterPath },
      request: { id: r.requestId, instance: r.instance },
      actor: { name: r.requestedBy },
      text: r.note,
    });
    await Promise.allSettled([
      notifyAdminsNewRequest({ title: r.title, mediaType: r.mediaType, requestedBy: r.requestedBy, note: r.note, posterPath: r.posterPath, tmdbId: r.tmdbId, releaseYear: r.releaseYear, excludeUserId: r.excludeUserId }),
      notifyAdminsNewRequestPush({ title: r.title, mediaType: r.mediaType, tmdbId: r.tmdbId, requestedBy: r.requestedBy, requestId: r.requestId, excludeUserId: r.excludeUserId }),
      notifyAdminsNewRequestDiscord({ requestId: r.requestId, title: r.title, mediaType: r.mediaType, tmdbId: r.tmdbId, requestedBy: r.requestedBy, note: r.note, posterPath: r.posterPath }),
    ]);
  });
}

/**
 * Whether an EARLIER pending request exists for the same title and instance,
 * ordered by (createdAt, id). An auto-approve rollback turns a committed row
 * PENDING after the fact, so its "first PENDING request alerts" dedupe can only
 * be this post-commit read (the plain pending create decides it inside its
 * Serializable transaction instead).
 */
export async function hasEarlierPending(request: {
  id: string;
  createdAt: Date;
  tmdbId: number;
  mediaType: MediaType;
  arrInstance: string;
}): Promise<boolean> {
  const earlier = await prisma.mediaRequest.findFirst({
    where: {
      tmdbId: request.tmdbId,
      mediaType: request.mediaType,
      arrInstance: request.arrInstance,
      status: "PENDING",
      id: { not: request.id },
      OR: [
        { createdAt: { lt: request.createdAt } },
        { createdAt: request.createdAt, id: { lt: request.id } },
      ],
    },
    select: { id: true },
  });
  return earlier !== null;
}
