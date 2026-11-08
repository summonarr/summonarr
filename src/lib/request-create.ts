import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { listQualityProfiles } from "@/lib/arr";
import { Prisma, type MediaRequest } from "@/generated/prisma";
import type { SummonarrSession } from "@/lib/api-auth";
import { runWithSerializableRetry } from "@/lib/serializable-retry";
import { emitSSE } from "@/lib/sse-emitter";
import { DOWNLOAD_CHECK_DELAY_MS, scheduleDownloadCheck } from "@/lib/download-check";
import { sanitizeForLog, sanitizeOptional } from "@/lib/sanitize";
import { parseInstanceGrants, hasPermission, Permission, type InstanceGrants } from "@/lib/permissions";
import { getArrInstancesWithConfigured } from "@/lib/arr-instance-registry";
import type { ArrInstanceConfig } from "@/lib/arr-instances";
import { getVisibleServerInstances } from "@/lib/media-visibility";
import { translateQuotaWindow, type ResolvedQuota } from "@/lib/quota";
import { resolveMediaMeta } from "@/lib/request-meta";
import { isBlacklisted } from "@/lib/blacklist";
import { instanceDefaultLocale, translatorFor } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { greenlitPeerStatuses } from "@/lib/request-mirror";
import { dropStaleDeclined, restoreThread } from "@/lib/request-comment-carry";
import { REQUEST_NOTE_MAX } from "@/lib/request-limits";
import { pushApproval } from "@/lib/request-transition";
import {
  QuotaExceededError,
  alertAdminsNewRequest,
  assertQuotaInTx,
  autoApprovesOn,
  detailsLoader,
  enforcedQuota,
  hasEarlierPending,
  quotaUsed,
  ratingCapVerdict,
  resolveTargetInstance,
  type AfterResponse,
} from "@/lib/request-policy";

// The request chokepoint — everything POST /api/requests does once the caller is
// authenticated, rate-limited and its body validated: instance resolution and
// access (guardrail 32), the quality-profile override, quota, TMDB verification,
// the blacklist and content-rating gates, duplicate handling, the Serializable
// create (guardrail 23), auto-approve + approvedAt (guardrail 34a) with the
// Radarr/Sonarr push and its rollback (the shared state machine in
// request-transition.ts), and the admin notify fan-out.
//
// Extracted from src/app/api/requests/route.ts so the watchlist auto-request
// (src/lib/auto-request.ts) files requests through EXACTLY the same path rather
// than a second copy of it. The route maps the result onto its unchanged HTTP
// responses; tests/requests-route.test.mts pins that wire contract.
//
// Must run inside a request scope unless the caller passes its own
// `afterResponse`: the pending branch schedules the admin notify with after().
// The route and the auto-request are route handlers; the Discord picker, which
// has already answered Discord, runs the alerts itself.

// The Setting keys and User columns a request decision reads — one read serves
// the route's own pre-body gates (rate limit, Discord link) and this module.
const REQUEST_CONTEXT_SETTING_KEYS = ["rateLimitRequests", "discordRequireLinkedAccountSite", "quotaLimit", "quotaPeriod", "request4kAll"];

export type RequestContextSettings = Record<string, string | undefined>;
export interface RequestContextUser {
  discordId: string | null;
  movieQuotaLimit: number | null;
  movieQuotaDays: number | null;
  tvQuotaLimit: number | null;
  tvQuotaDays: number | null;
  maxContentRating: string | null;
  instanceGrants: Prisma.JsonValue | null;
}
export interface RequestContext {
  settings: RequestContextSettings;
  userRecord: RequestContextUser | null;
}

export async function loadRequestContext(userId: string): Promise<RequestContext> {
  const [settingsRows, userRecord] = await Promise.all([
    prisma.setting.findMany({
      where: { key: { in: REQUEST_CONTEXT_SETTING_KEYS } },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        discordId: true,
        movieQuotaLimit: true,
        movieQuotaDays: true,
        tvQuotaLimit: true,
        tvQuotaDays: true,
        maxContentRating: true,
        instanceGrants: true,
      },
    }),
  ]);
  const settings: RequestContextSettings = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));
  return { settings, userRecord };
}

// Why a request was refused: the HTTP status/message the route has always
// answered, plus a stable code the auto-request ledger keys its retry rule on.
export type CreateMediaRequestFailure =
  | "instance-unavailable"
  | "forbidden"
  | "invalid-quality-profile"
  | "arr-unreachable"
  | "quota"
  | "invalid-note"
  | "tmdb-unverified"
  | "blacklisted"
  | "rating-cap"
  | "permanently-declined"
  | "already-requested";

export type CreateMediaRequestBranch = "auto-approve" | "pending" | "mirror-approved";

export type CreateMediaRequestResult =
  | {
      ok: false;
      status: number;
      error: string;
      reason: CreateMediaRequestFailure;
      // The window that ran out, on a "quota" refusal — for a caller that words
      // its own reply (the Discord picker).
      quota?: { limit: number; windowLabel: string };
    }
  | { ok: true; kind: "already-available"; title: string }
  | {
      ok: true;
      kind: "created";
      branch: CreateMediaRequestBranch;
      // The auto-approve push failed and the row was rolled back to PENDING.
      pushFailed: boolean;
      // The auto-approve add was sent and got no definite answer (a timeout, a
      // dropped connection, a gateway 502/504 — arrWriteOutcomeUnknown): Radarr/Sonarr
      // may have added the title. The row stays APPROVED; the sync re-pushes an
      // APPROVED title the arr doesn't hold.
      pushOutcomeUnknown: boolean;
      // The row as the route answers it (status already PENDING after a rollback).
      request: MediaRequest;
    };

export interface CreateMediaRequestInput {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  // The remaining fields are validated below, exactly as the route always did —
  // their static types are the route body's compile-time cast, not a guarantee.
  note?: string;
  is4k?: boolean;
  arrInstance?: string;
  qualityProfileId?: number;
}

// What only some callers need. The web route and the auto-request pass none.
export interface CreateMediaRequestOptions {
  // Where the admin alerts run once the response is sent. Default after(), which
  // needs a request scope; the Discord picker, already answered, runs them itself.
  afterResponse?: AfterResponse;
  // An auto-approve grant on top of the requester's permission (a Discord
  // auto-approve role): the global auto-approve bit, never the 4K or a
  // restricted instance's grant (autoApprovesOn). Never takes one away.
  autoApprove?: boolean;
  // The title's TMDB metadata when the caller already holds it from a
  // server-side TMDB read (the Discord search results), so it is not re-fetched.
  // Never a client-supplied value: the web route always verifies.
  meta?: { title: string; posterPath: string | null; releaseYear: string | null };
}

type Refusal = Extract<CreateMediaRequestResult, { ok: false }>;

function fail(status: number, error: string, reason: CreateMediaRequestFailure): Refusal {
  return { ok: false, status, error, reason };
}

// Re-exported for imports from before it moved to request-policy.ts.
export { alertAdminsNewRequest };

// What the create transaction committed: nothing (the title is already here), or
// the row it created and on which branch. `announce`: a pending row that is the
// first PENDING request for the title, so the admins are alerted.
type CreateTxResult =
  | { kind: "available" }
  | { kind: "created"; branch: CreateMediaRequestBranch; request: MediaRequest; announce: boolean };

function quotaRefusal(t: Translator, rq: { limit: number; windowLabel: string }): Refusal {
  return {
    ok: false,
    status: 429,
    error: t("apiUser.create.quota", { limit: rq.limit, window: translateQuotaWindow(t, rq.windowLabel) }),
    reason: "quota",
    quota: { limit: rq.limit, windowLabel: rq.windowLabel },
  };
}

export async function createMediaRequest(
  session: SummonarrSession,
  ctx: RequestContext,
  input: CreateMediaRequestInput,
  // The language of the refusal `error` text — the route passes the caller's
  // (translatorForRequest), the auto-request the user's. Only that text is
  // translated; `reason` and `status` are the machine-readable half.
  t: Translator = translatorFor(instanceDefaultLocale()),
  opts: CreateMediaRequestOptions = {},
): Promise<CreateMediaRequestResult> {
  const { settings, userRecord } = ctx;
  const { tmdbId, mediaType, note } = input;

  // The pure input check first: a malformed note costs no registry read, quota
  // count or Radarr/Sonarr call.
  if (note !== undefined && (typeof note !== "string" || note.length > REQUEST_NOTE_MAX)) {
    return fail(400, t("apiUser.create.noteTooLong"), "invalid-note");
  }
  const sanitizedNote = sanitizeOptional(note);

  // The TMDB details, read at most once: auto-routing and the content-rating cap
  // both want them.
  const loadDetails = detailsLoader(tmdbId, mediaType);
  const target = await resolveRequestInstance(session, ctx, input, loadDetails, t);
  if (!target.ok) return target.refusal;
  const { instance, grants } = target;
  const instanceSlug = instance.slug;
  const service = mediaType === "MOVIE" ? "radarr" : "sonarr";

  const profile = profileOverride(session, input, instanceSlug, target.explicit, t);
  if (profile.kind === "refused") return profile.refusal;

  // Per-media-type quota. QUOTA_UNLIMITED (and ADMIN) bypass; otherwise resolve
  // the per-user override → global Settings window and pre-check before the
  // (more expensive) Radarr/Sonarr and TMDB reads below. Re-checked inside the tx.
  const quota = enforcedQuota(session.user.permissions, mediaType, userRecord, settings);
  if (quota && (await quotaUsed(prisma, session.user.id, mediaType, quota)) >= quota.limit) {
    return quotaRefusal(t, quota);
  }

  const chosenQualityProfileId = profile.kind === "verify" ? profile.qualityProfileId : undefined;
  if (chosenQualityProfileId !== undefined) {
    const refusal = await verifyQualityProfile(service, instanceSlug, chosenQualityProfileId, t);
    if (refusal) return refusal;
  }

  const meta = opts.meta ?? (await verifiedMeta(tmdbId, mediaType));
  if (!meta) return fail(422, t("apiUser.common.tmdbUnverified"), "tmdb-unverified");

  // Blacklist gate — an admin-blocked title can never be requested. This is the
  // authoritative block (discovery hiding is best-effort UX) and must run before
  // any request row is created.
  if (await isBlacklisted(tmdbId, mediaType)) {
    return fail(403, t("apiUser.create.blacklisted"), "blacklisted");
  }

  // Parental control — block a request whose US certification exceeds the user's
  // cap. A certification that could not be read is not refused, but it is not
  // auto-approved either (ratingCapsVerdict).
  const rating = await ratingCapVerdict(session.user.permissions, userRecord?.maxContentRating, loadDetails);
  if (rating === "blocked") return fail(403, t("apiUser.create.ratingCap"), "rating-cap");

  const prior = await priorRequestGate(session.user.id, tmdbId, mediaType, instanceSlug, t);
  if (!prior.ok) return prior.refusal;

  // A Discord auto-approve role adds the global auto-approve bit, never more
  // (autoApprovesOn).
  const isAutoApprove = rating !== "unverified" &&
    autoApprovesOn(session.user.permissions, instance, grants, mediaType, opts.autoApprove === true);
  const availability = await availabilityFor(session, instance, tmdbId, mediaType, isAutoApprove);

  const baseData = { tmdbId, mediaType, arrInstance: instanceSlug, qualityProfileId: chosenQualityProfileId ?? null, title: meta.title, posterPath: meta.posterPath, releaseYear: meta.releaseYear, note: sanitizedNote ?? null, requestedBy: session.user.id } as const;

  const committed = await commitRequest({
    userId: session.user.id,
    tmdbId,
    mediaType,
    instanceSlug,
    quota,
    staleDeclinedId: prior.staleDeclinedId,
    isAutoApprove,
    availability,
    baseData,
    t,
  });
  if (!committed.ok) return committed.refusal;
  if (committed.result.kind === "available") {
    return { ok: true, kind: "already-available", title: meta.title };
  }

  const { request, branch } = committed.result;
  clearOwnDeletionVote(session.user.id, tmdbId, mediaType);
  emitSSE({ type: "request:new", requestId: request.id, userId: session.user.id });

  // Admin fan-out for a row that ends up PENDING. Shared by the normal pending
  // branch and the auto-approve rollback — a failed ARR push leaves a PENDING
  // request that otherwise reached admins through no out-of-band channel at all
  // (the request:new SSE only lands for admins with the web app already open).
  const announceToAdmins = () =>
    alertAdminsNewRequest({
      requestId: request.id,
      tmdbId,
      mediaType,
      instance: instanceSlug,
      title: meta.title,
      posterPath: meta.posterPath ?? null,
      releaseYear: meta.releaseYear ?? null,
      requestedBy: session.user.name ?? session.user.email ?? session.user.id,
      note: sanitizedNote ?? null,
      excludeUserId: session.user.id,
    }, opts.afterResponse ?? after);

  if (branch === "auto-approve") return finishAutoApproval(request, announceToAdmins);
  // mirror-approved: the content is already greenlit by an earlier request — no
  // arr push (already done) and no admin "new request" alert (nothing to
  // review). The requester is still tracked, so the sync's "now available" pass
  // notifies them just like the original requester.
  if (branch === "pending" && committed.result.announce) announceToAdmins();
  return { ok: true, kind: "created", branch, pushFailed: false, pushOutcomeUnknown: false, request };
}

// Resolve which Radarr/Sonarr instance this request targets, and whether the
// requester may use it (guardrail 32). One registry read + one batched
// connection probe serve every branch: explicit-slug validation needs the FULL
// list, auto-routing the configured subset.
async function resolveRequestInstance(
  session: SummonarrSession,
  ctx: RequestContext,
  input: CreateMediaRequestInput,
  loadDetails: () => Promise<TmdbMedia>,
  t: Translator,
): Promise<{ ok: true; instance: ArrInstanceConfig; grants: InstanceGrants; explicit: boolean } | { ok: false; refusal: Refusal }> {
  const service = input.mediaType === "MOVIE" ? "radarr" : "sonarr";
  const { all: instances, configured } = await getArrInstancesWithConfigured(service);
  const grants = parseInstanceGrants(ctx.userRecord?.instanceGrants);
  const target = await resolveTargetInstance({
    instances,
    configured,
    arrInstance: input.arrInstance,
    is4k: input.is4k,
    loadDetails,
    perms: session.user.permissions,
    grants,
    mediaType: input.mediaType,
    request4kAll: ctx.settings.request4kAll === "true",
  });
  if (target.ok) return { ok: true, instance: target.instance, grants, explicit: target.explicit };
  if (target.reason === "forbidden") return { ok: false, refusal: fail(403, t("apiUser.create.forbidden"), "forbidden") };
  return {
    ok: false,
    refusal: target.instanceName !== undefined
      ? fail(400, t("apiUser.create.instanceNotConfigured", { name: target.instanceName }), "instance-unavailable")
      : fail(400, t("apiUser.create.instanceUnavailable"), "instance-unavailable"),
  };
}

// Advanced request option: an explicit quality profile is honored only for
// REQUEST_ADVANCED holders (ADMIN passes via the superbit), and only once
// verified against the target instance's profiles (verifyQualityProfile), so a
// client can't smuggle an arbitrary id into the ARR add. Absent ⇒ the instance's
// configured default.
function profileOverride(
  session: SummonarrSession,
  input: CreateMediaRequestInput,
  instanceSlug: string,
  // Whether the client explicitly targeted the instance (arrInstance or the
  // legacy is4k flag) rather than the server auto-routing it.
  explicit: boolean,
  t: Translator,
): { kind: "none" } | { kind: "verify"; qualityProfileId: number } | { kind: "refused"; refusal: Refusal } {
  const id = input.qualityProfileId;
  if (id === undefined) return { kind: "none" };
  if (!Number.isInteger(id) || id <= 0) {
    return { kind: "refused", refusal: fail(400, t("apiUser.requests.qualityProfileIdInvalid"), "invalid-quality-profile") };
  }
  if (!hasPermission(session.user.permissions, Permission.REQUEST_ADVANCED)) {
    return { kind: "refused", refusal: fail(403, t("apiUser.create.profileForbidden"), "forbidden") };
  }
  if (!explicit && instanceSlug !== "") {
    // The request was AUTO-ROUTED to a non-default instance, but the client's
    // profile picker (instance-blind /api/requests/quality-profiles) listed the
    // DEFAULT instance's profiles — the picked id is meaningless here. Validating
    // it against the routed instance either dead-ends the request (400 with no
    // way to pick a valid id) or, on an id collision, silently applies a
    // different profile. Drop the override and use the routed instance's
    // configured default instead.
    console.warn(
      `[requests] dropping quality-profile override (picked against the default instance) for auto-routed instance "${instanceSlug}"`,
    );
    return { kind: "none" };
  }
  return { kind: "verify", qualityProfileId: id };
}

// The picked profile must be one the instance lists. An unreachable/erroring ARR
// instance must not 500 the request: like the quality-profiles route, a fetch
// failure is a clean 502. A request WITHOUT a profile never gets here, so it
// still succeeds during an outage.
async function verifyQualityProfile(service: "radarr" | "sonarr", instanceSlug: string, qualityProfileId: number, t: Translator): Promise<Refusal | null> {
  let profileList: Awaited<ReturnType<typeof listQualityProfiles>>;
  try {
    profileList = await listQualityProfiles(service, instanceSlug);
  } catch (err) {
    console.error(`[requests] Failed to fetch ${service} profiles:`, err);
    return fail(502, t("apiUser.common.couldNotConnect", { service }), "arr-unreachable");
  }
  if (!profileList || !profileList.profiles.some((p) => p.id === qualityProfileId)) {
    return fail(400, t("apiUser.create.profileInvalid"), "invalid-quality-profile");
  }
  return null;
}

// The title's metadata, verified against TMDB (a cached core row counts); null
// when TMDB can't vouch for the id.
async function verifiedMeta(tmdbId: number, mediaType: "MOVIE" | "TV"): Promise<{ title: string; posterPath: string | null; releaseYear: string | null } | null> {
  try {
    return await resolveMediaMeta(tmdbId, mediaType);
  } catch {
    return null;
  }
}

// The requester's own earlier request for this title on this instance.
// APPROVED/AVAILABLE/PENDING block with a 409; a permanent decline with a 403. An
// ordinary decline is not terminal: its row is remembered and deleted in the
// create transaction (commitRequest) — deleting it here destroyed the row (and
// the admin's adminNote) on every path that then aborts without creating a
// replacement: alreadyAvailable, the in-tx quota re-check 429, and the P2002 409.
async function priorRequestGate(
  userId: string,
  tmdbId: number,
  mediaType: "MOVIE" | "TV",
  instanceSlug: string,
  t: Translator,
): Promise<{ ok: true; staleDeclinedId: string | null } | { ok: false; refusal: Refusal }> {
  const existing = await prisma.mediaRequest.findFirst({
    where: { tmdbId, mediaType, requestedBy: userId, arrInstance: instanceSlug },
  });
  if (!existing) return { ok: true, staleDeclinedId: null };
  if (existing.permanentlyDeclined) {
    return { ok: false, refusal: fail(403, t("apiUser.create.permanentlyDeclined"), "permanently-declined") };
  }
  if (existing.status === "DECLINED") return { ok: true, staleDeclinedId: existing.id };
  return { ok: false, refusal: fail(409, t("apiUser.create.alreadyRequested"), "already-requested") };
}

interface Availability {
  // A visible library copy, or (for an auto-approver) the instance's *arr cache.
  alreadyAvailable: boolean;
  // The instance's *arr-available cache holds the title.
  arrHasInstance: boolean;
}

// Default-instance request: a Plex/Jellyfin library hit OR the default *arr-available
// cache counts as already-here. An instance with skipLibraryCheck (4K/opt-in) ignores
// the shared library — a copy at another quality must not block requesting this one —
// and only that instance's available cache counts.
//
// The library half is scoped to the servers THIS requester can see: a copy sitting on a
// restricted server they hold no grant for must not reject their request. Telling someone
// a title is "already available" when they cannot watch it leaves them no path forward,
// which is the whole reason visibility is per-user rather than global. Same shape as
// skipLibraryCheck above — an instance the requester can't reach doesn't block them.
async function availabilityFor(
  session: SummonarrSession,
  instance: ArrInstanceConfig,
  tmdbId: number,
  mediaType: "MOVIE" | "TV",
  isAutoApprove: boolean,
): Promise<Availability> {
  const skipLibraryCheck = instance.skipLibraryCheck;
  const instanceSlug = instance.slug;
  const visible = await getVisibleServerInstances(session);
  // The instance's *arr-available cache is read for every requester: an auto-approver
  // treats a hit as already-here, and the mirror branch needs it as the only
  // evidence (short of a visible library copy, which already returned) that an AVAILABLE
  // peer's status is true for THIS requester too.
  const [plexItem, jellyfinItem, arrHasInstance] = await Promise.all([
    skipLibraryCheck
      ? Promise.resolve(null)
      : prisma.plexLibraryItem.findFirst({ where: { tmdbId, mediaType, serverInstance: { in: visible.plex } } }),
    skipLibraryCheck
      ? Promise.resolve(null)
      : prisma.jellyfinLibraryItem.findFirst({ where: { tmdbId, mediaType, serverInstance: { in: visible.jellyfin } } }),
    mediaType === "MOVIE"
      ? prisma.radarrAvailableItem.findUnique({ where: { tmdbId_arrInstance: { tmdbId, arrInstance: instanceSlug } } }).then(r => r !== null)
      : prisma.sonarrAvailableItem.findUnique({ where: { tmdbId_arrInstance: { tmdbId, arrInstance: instanceSlug } } }).then(r => r !== null),
  ]);
  // Check BOTH libraries — a Jellyfin-only install has no PlexLibraryItem rows, so
  // a Plex-only check let users re-request titles already in their Jellyfin library.
  // The *arr cache counts only for an auto-approver: everyone else files a normal
  // request, so the sync's arr marking pass can notify them when it lands.
  return { alreadyAvailable: !!plexItem || !!jellyfinItem || (isAutoApprove && arrHasInstance), arrHasInstance };
}

// The Serializable create: the in-tx quota re-check, the stale-decline swap and
// the branch (auto-approve, mirror a greenlit peer, or pending). Serializable +
// P2034 retry: concurrent creates at the quota boundary conflict on the
// count+create and Postgres aborts one; without the retry that's a 500 instead
// of the correct 429/409. (request-bulk.ts wraps its tx the same way.) The
// callback re-runs on a retry, so everything it decides is in what it returns.
async function commitRequest(args: {
  userId: string;
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  instanceSlug: string;
  quota: ResolvedQuota | null;
  staleDeclinedId: string | null;
  isAutoApprove: boolean;
  availability: Availability;
  baseData: Prisma.MediaRequestUncheckedCreateInput;
  t: Translator;
}): Promise<{ ok: true; result: CreateTxResult } | { ok: false; refusal: Refusal }> {
  const { userId, tmdbId, mediaType, instanceSlug, quota, staleDeclinedId, isAutoApprove, baseData, t } = args;
  const { alreadyAvailable, arrHasInstance } = args.availability;
  try {
    const result = await runWithSerializableRetry(() => prisma.$transaction(async (tx): Promise<CreateTxResult> => {
      // Re-check quota inside the transaction to prevent races on concurrent
      // requests. A full window throws, rolling the transaction back (guardrail 23).
      if (quota) await assertQuotaInTx(tx, userId, mediaType, quota);

      if (alreadyAvailable) {
        return { kind: "available" };
      }

      // Clear the stale DECLINED row only now that a create is guaranteed to follow, in
      // the same tx — an abort past this point rolls the delete back with it.
      //
      // deleteMany (not delete) — on a concurrent double re-request the second
      // delete would throw P2025 (500); deleteMany no-ops, and the create below
      // then surfaces a clean 409 via its P2002 catch instead. (It cannot swallow a
      // write error mid-tx either, so guardrail 23 is satisfied.)
      //
      // CAS on status + permanentlyDeclined: if an admin re-approved or made the decline
      // permanent between the read and here, the predicate no-ops the delete — the create
      // below then 409s on the surviving row rather than orphaning an APPROVED row's ARR
      // grab or evading a fresh permanent ban.
      //
      // The declined row's comment thread would cascade with it; it is read first and
      // written back onto whichever row the branch below creates (request-comment-carry.ts).
      const carried = await dropStaleDeclined(tx, staleDeclinedId);

      if (isAutoApprove) {
        // create (NOT upsert update:{}): a concurrent duplicate must hit the unique
        // constraint and surface as P2002 -> 409 below, exactly like the pending and
        // mirror-approved branches. The no-op upsert update let two concurrent
        // auto-approvals BOTH "succeed" and both fire ARR side effects + a 201/SSE
        // for the same row (guardrail 23).
        const request = await tx.mediaRequest.create({
          // pendingNotifyAt arms the orchestrator's 90s "download pending / awaiting
          // release" backstop (sync/route.ts overdue scan only looks at rows with it set),
          // like every admin approval (request-transition.ts).
          // approvedAt: auto-approve is an approval (MediaRequest.approvedAt).
          data: { ...baseData, status: "APPROVED", approvedAt: new Date(), pendingNotifyAt: new Date(Date.now() + DOWNLOAD_CHECK_DELAY_MS) },
        });
        await restoreThread(tx, request.id, carried);
        return { kind: "created", branch: "auto-approve", request, announce: false };
      }

      // If another request for this exact title (+ same instance) is already
      // greenlit (greenlitPeerStatuses: APPROVED, or AVAILABLE with this instance's
      // *arr holding it), there is nothing for an admin to review. Mirror that status
      // so this requester is tracked and still receives the "now available"
      // notification (the sync notifies every APPROVED row's requester), while
      // skipping the admin "new request" alert.
      //
      // No approvedAt: the copy made no decision of its own. The watch grade
      // counts it through the approval of the request it copied (per title).
      //
      // A row stamped `cleanedUpAt` is a REMOVAL, not a greenlight (guardrail
      // 14b): an admin deliberately took the title off this instance. Copying it
      // would create an APPROVED row the sync re-pushes, re-downloading what was
      // deleted with no admin decision — so it goes to review like any request.
      //
      // An AVAILABLE peer counts only when the title is available to THIS requester:
      // no visible library copy exists (that returned above), so the instance's
      // *arr-available cache is the remaining evidence. Without it the peer may have
      // been marked off a restricted server (guardrail 35) or off the HD copy of a 4K
      // request — not an approval, so this request goes to review like any other.
      const greenlit = await tx.mediaRequest.findFirst({
        where: { tmdbId, mediaType, arrInstance: instanceSlug, status: { in: greenlitPeerStatuses(arrHasInstance) }, cleanedUpAt: null },
        select: { status: true },
      });
      if (greenlit) {
        const mirrorStatus = greenlit.status;
        const request = await tx.mediaRequest.create({
          data: {
            ...baseData,
            status: mirrorStatus,
            // Mirror an already-AVAILABLE title's availability timestamp so this
            // row matches the original's shape (the sync's "now available" pass
            // and availability sorts read availableAt).
            ...(mirrorStatus === "AVAILABLE" ? { availableAt: new Date() } : {}),
          },
        });
        await restoreThread(tx, request.id, carried);
        return { kind: "created", branch: "mirror-approved", request, announce: false };
      }

      // Only the first PENDING request for (tmdbId, mediaType, instance) alerts the
      // admins. Decided here, in the Serializable tx, rather than after the commit:
      // two concurrent requests for one title (different users) that each read "no
      // PENDING peer" and insert one form a read/write cycle Postgres aborts
      // (P2034), and the retry sees the committed peer. Checked after the commit,
      // an interleaving where neither saw the other alerted twice.
      const pendingPeer = await tx.mediaRequest.findFirst({
        where: { tmdbId, mediaType, arrInstance: instanceSlug, status: "PENDING" },
        select: { id: true },
      });
      const request = await tx.mediaRequest.create({ data: baseData });
      await restoreThread(tx, request.id, carried);
      return { kind: "created", branch: "pending", request, announce: !pendingPeer };
    }, { isolationLevel: "Serializable" }));
    return { ok: true, result };
  } catch (err) {
    if (err instanceof QuotaExceededError) return { ok: false, refusal: quotaRefusal(t, err) };
    if (isPrismaErrorCode(err, "P2002")) {
      return { ok: false, refusal: fail(409, t("apiUser.create.alreadyRequested"), "already-requested") };
    }
    throw err;
  }
}

// A request and a deletion vote for the same title are contradictory. The vote route
// already blocks voting when you've requested; mirror it here by clearing the caller's
// own delete-vote on request, so a vote-then-request can't leave both rows persisting.
// .catch is required, not decorative: a Prisma model method returns a LAZY
// PrismaPromise that only dispatches once a continuation is attached, so a bare
// `void deleteMany(...)` never ran at all. It also handles the rejection, which —
// detached after the response — would otherwise escape as a process-level
// unhandledRejection with no request context (same shape as requests/bulk).
function clearOwnDeletionVote(userId: string, tmdbId: number, mediaType: "MOVIE" | "TV"): void {
  void prisma.deletionVote
    .deleteMany({ where: { userId, tmdbId, mediaType } })
    .catch((err) =>
      console.error(
        `[requests] deletionVote cleanup failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`,
      ),
    );
}

// The auto-approved row's push, through the shared state machine
// (request-transition.ts). A rollback answers the PENDING row and tells the
// admins; otherwise the row keeps its armed backstop, and the 90s check runs
// PROMPTLY instead of waiting for the orchestrator's next sweep.
async function finishAutoApproval(request: MediaRequest, announceToAdmins: () => void): Promise<CreateMediaRequestResult> {
  const outcome = await pushApproval(request, "Auto-approve");
  if (outcome.kind === "rolled-back") {
    // The row now sits in the admin queue exactly like a normal pending request,
    // so it must be announced like one — and it can't rely on the pendingNotifyAt
    // backstop (cleared by the rollback), leaving this the only alert admins get.
    // Its dedupe can only be a post-commit read: alert unless an EARLIER pending
    // request for the title exists. A failed read alerts anyway — a duplicate
    // alert is cheaper than a lost one, and the row is committed, so a throw here
    // would answer 500 for a request that exists (and its retry 409).
    let earlierPending = false;
    try {
      earlierPending = await hasEarlierPending(request);
    } catch (err) {
      console.error(`[requests] earlier-pending check failed, alerting anyway: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    }
    if (!earlierPending) announceToAdmins();
    // Both rolled-back fields, like the PATCH rollback body (requests/[id]).
    return { ok: true, kind: "created", branch: "auto-approve", pushFailed: true, pushOutcomeUnknown: false, request: { ...request, status: "PENDING", pendingNotifyAt: null } };
  }
  // Not rolled back. Pushed, or an add with no definite answer (left APPROVED:
  // the sync re-pushes an APPROVED title the arr doesn't hold), or a failure
  // whose rollback did not land: the row moved on or the write failed — it is
  // not PENDING, so it is not announced, and its armed backstop is consumed by
  // the check.
  scheduleDownloadCheck({
    requestId: request.id,
    tmdbId: request.tmdbId,
    mediaType: request.mediaType,
    arrInstance: request.arrInstance,
    requestedBy: request.requestedBy,
    title: request.title,
  }, { name: "requests:auto-approve-90s-download-check" });
  return { ok: true, kind: "created", branch: "auto-approve", pushFailed: false, pushOutcomeUnknown: outcome.kind === "unknown", request };
}
