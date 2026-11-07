import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { addMovieToRadarr, addSeriesToSonarr, arrWriteOutcomeUnknown, listQualityProfiles, type AddProgress } from "@/lib/arr";
import { Prisma, type MediaRequest } from "@/generated/prisma";
import type { SummonarrSession } from "@/lib/api-auth";
import { runWithSerializableRetry } from "@/lib/serializable-retry";
import { emitSSE } from "@/lib/sse-emitter";
import { DOWNLOAD_CHECK_DELAY_MS, scheduleDownloadCheck } from "@/lib/download-check";
import { sanitizeForLog, sanitizeOptional } from "@/lib/sanitize";
import { canAutoApproveInstance, parseInstanceGrants, hasPermission, Permission } from "@/lib/permissions";
import { getArrInstancesWithConfigured } from "@/lib/arr-instance-registry";
import { getVisibleServerInstances } from "@/lib/media-visibility";
import { translateQuotaWindow } from "@/lib/quota";
import { resolveMediaMeta } from "@/lib/request-meta";
import { isBlacklisted } from "@/lib/blacklist";
import { instanceDefaultLocale, translatorFor } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { greenlitPeerStatuses } from "@/lib/request-mirror";
import { dropStaleDeclined, restoreThread } from "@/lib/request-comment-carry";
import {
  QuotaExceededError,
  alertAdminsNewRequest,
  assertQuotaInTx,
  blockedByRatingCap,
  detailsLoader,
  enforcedQuota,
  hasEarlierPending,
  quotaUsed,
  resolveTargetInstance,
  type AfterResponse,
} from "@/lib/request-policy";

// The request chokepoint — everything POST /api/requests does once the caller is
// authenticated, rate-limited and its body validated: instance resolution and
// access (guardrail 32), the quality-profile override, quota, TMDB verification,
// the blacklist and content-rating gates, duplicate handling, the Serializable
// create (guardrail 23), auto-approve + approvedAt (guardrail 34a) with the
// Radarr/Sonarr push and its rollback, and the admin notify fan-out.
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
  // auto-approve role). Never takes one away.
  autoApprove?: boolean;
  // The title's TMDB metadata when the caller already holds it from a
  // server-side TMDB read (the Discord search results), so it is not re-fetched.
  // Never a client-supplied value: the web route always verifies.
  meta?: { title: string; posterPath: string | null; releaseYear: string | null };
}

function fail(status: number, error: string, reason: CreateMediaRequestFailure): CreateMediaRequestResult {
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
  const body = input;
  const { tmdbId, mediaType, note } = input;

  // The TMDB details, read at most once: auto-routing and the content-rating cap
  // both want them.
  const loadDetails = detailsLoader(tmdbId, mediaType);

  // Resolve which Radarr/Sonarr instance this request targets, and whether the
  // requester may use it (guardrail 32). One registry read + one batched
  // connection probe serve every branch: explicit-slug validation needs the FULL
  // list, auto-routing the configured subset.
  const service = mediaType === "MOVIE" ? "radarr" : "sonarr";
  const { all: instances, configured: configuredSlugs } = await getArrInstancesWithConfigured(service);
  const grants = parseInstanceGrants(userRecord?.instanceGrants);
  const target = await resolveTargetInstance({
    instances,
    configured: configuredSlugs,
    arrInstance: body.arrInstance,
    is4k: body.is4k,
    loadDetails,
    perms: session.user.permissions,
    grants,
    mediaType,
    request4kAll: settings.request4kAll === "true",
  });
  if (!target.ok) {
    if (target.reason === "forbidden") return fail(403, t("apiUser.create.forbidden"), "forbidden");
    return target.instanceName !== undefined
      ? fail(400, t("apiUser.create.instanceNotConfigured", { name: target.instanceName }), "instance-unavailable")
      : fail(400, t("apiUser.create.instanceUnavailable"), "instance-unavailable");
  }
  const instance = target.instance;
  const instanceSlug = instance.slug;
  // Whether the client explicitly targeted an instance (arrInstance or the legacy
  // is4k flag) vs. the server auto-routing it. Matters for the quality-profile
  // override below: an explicit target means the client knew which instance's
  // profile list it picked from; an auto-route means it didn't.
  const instanceExplicit = target.explicit;

  // Advanced request option: an explicit quality profile is honored only for
  // REQUEST_ADVANCED holders (ADMIN passes via the superbit) and is validated
  // against the target instance's profiles, so a client can't smuggle an arbitrary
  // id into the ARR add. Absent ⇒ the instance's configured default is used.
  let chosenQualityProfileId: number | undefined;
  if (body.qualityProfileId !== undefined) {
    if (!Number.isInteger(body.qualityProfileId) || body.qualityProfileId <= 0) {
      return fail(400, t("apiUser.requests.qualityProfileIdInvalid"), "invalid-quality-profile");
    }
    if (!hasPermission(session.user.permissions, Permission.REQUEST_ADVANCED)) {
      return fail(403, t("apiUser.create.profileForbidden"), "forbidden");
    }
    if (!instanceExplicit && instanceSlug !== "") {
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
    } else {
      // An unreachable/erroring ARR instance must not 500 the request. Mirror the
      // quality-profiles route: map a fetch failure to a clean 502. A request WITHOUT
      // a profile skips this block entirely, so it still succeeds during an outage.
      let profileList: Awaited<ReturnType<typeof listQualityProfiles>>;
      try {
        profileList = await listQualityProfiles(service, instanceSlug);
      } catch (err) {
        console.error(`[requests] Failed to fetch ${service} profiles:`, err);
        return fail(502, t("apiUser.common.couldNotConnect", { service }), "arr-unreachable");
      }
      if (!profileList || !profileList.profiles.some((p) => p.id === body.qualityProfileId)) {
        return fail(400, t("apiUser.create.profileInvalid"), "invalid-quality-profile");
      }
      chosenQualityProfileId = body.qualityProfileId;
    }
  }

  // Per-media-type quota. QUOTA_UNLIMITED (and ADMIN) bypass; otherwise resolve
  // the per-user override → global Settings window and pre-check before the
  // (more expensive) TMDB verification below. Re-checked inside the tx.
  const quota = enforcedQuota(session.user.permissions, mediaType, userRecord, settings);
  const quotaRefusal = (rq: { limit: number; windowLabel: string }): CreateMediaRequestResult => ({
    ok: false,
    status: 429,
    error: t("apiUser.create.quota", { limit: rq.limit, window: translateQuotaWindow(t, rq.windowLabel) }),
    reason: "quota",
    quota: { limit: rq.limit, windowLabel: rq.windowLabel },
  });
  if (quota && (await quotaUsed(prisma, session.user.id, mediaType, quota)) >= quota.limit) {
    return quotaRefusal(quota);
  }

  if (note !== undefined && (typeof note !== "string" || note.length > 500)) {
    return fail(400, t("apiUser.create.noteTooLong"), "invalid-note");
  }
  const sanitizedNote = sanitizeOptional(note);

  let verified: { title: string; posterPath: string | null; releaseYear: string | null } | null = opts.meta ?? null;
  if (!verified) {
    try {
      verified = await resolveMediaMeta(tmdbId, mediaType);
    } catch {
      return fail(422, t("apiUser.common.tmdbUnverified"), "tmdb-unverified");
    }
    if (!verified) {
      return fail(422, t("apiUser.common.tmdbUnverified"), "tmdb-unverified");
    }
  }
  const meta = verified;

  // Blacklist gate — an admin-blocked title can never be requested. This is the
  // authoritative block (discovery hiding is best-effort UX) and must run before
  // any request row is created.
  if (await isBlacklisted(tmdbId, mediaType)) {
    return fail(403, t("apiUser.create.blacklisted"), "blacklisted");
  }

  // Parental control — block a request whose US certification exceeds the user's
  // cap. Only capped, non-admin users pay the (cached) certification fetch;
  // unknown/unrated titles are allowed (see content-rating.ts).
  if (await blockedByRatingCap(session.user.permissions, userRecord?.maxContentRating, loadDetails)) {
    return fail(403, t("apiUser.create.ratingCap"), "rating-cap");
  }

  const existing = await prisma.mediaRequest.findFirst({
    where: { tmdbId, mediaType, requestedBy: session.user.id, arrInstance: instanceSlug },
  });

  // Deferred until the create actually happens (inside the tx below) — deleting here
  // destroyed the row (and the admin's adminNote) on every path that then aborts without
  // creating a replacement: alreadyAvailable (deterministic once the title lands in the
  // library), the in-tx quota re-check 429, and the P2002 409.
  let staleDeclinedId: string | null = null;

  if (existing) {
    if (existing.permanentlyDeclined) {
      return fail(403, t("apiUser.create.permanentlyDeclined"), "permanently-declined");
    }
    // An ordinary (non-permanent) decline is not terminal — let the user
    // re-request: remember the stale DECLINED row (it is deleted inside the tx
    // below) and fall through to a fresh create. APPROVED/AVAILABLE/PENDING
    // still block with a 409.
    if (existing.status === "DECLINED") {
      staleDeclinedId = existing.id;
    } else {
      return fail(409, t("apiUser.create.alreadyRequested"), "already-requested");
    }
  }

  const isAutoApprove = opts.autoApprove === true || canAutoApproveInstance(session.user.permissions, instance, grants, mediaType);

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
  const skipLibraryCheck = instance.skipLibraryCheck;
  const visible = await getVisibleServerInstances(session);
  // The instance's *arr-available cache is read for every requester: an auto-approver
  // treats a hit as already-here, and the mirror branch below needs it as the only
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
  const arrAvailable = isAutoApprove && arrHasInstance;
  // Check BOTH libraries — a Jellyfin-only install has no PlexLibraryItem rows, so
  // a Plex-only check let users re-request titles already in their Jellyfin library
  // (skipped for skipLibraryCheck instances, same reasoning as Plex above).
  const alreadyAvailable = !!plexItem || !!jellyfinItem || arrAvailable;

  const baseData = { tmdbId, mediaType, arrInstance: instanceSlug, qualityProfileId: chosenQualityProfileId ?? null, title: meta.title, posterPath: meta.posterPath, releaseYear: meta.releaseYear, note: sanitizedNote ?? null, requestedBy: session.user.id } as const;

  let committed: CreateTxResult;
  try {
    // Serializable + P2034 retry: concurrent creates at the quota boundary conflict
    // on the count+create and Postgres aborts one; without the retry that's a 500
    // instead of the correct 429/409. (request-bulk.ts wraps its tx the same way.)
    // The callback re-runs on a retry, so everything it decides is in what it returns.
    committed = await runWithSerializableRetry(() => prisma.$transaction(async (tx): Promise<CreateTxResult> => {
      // Re-check quota inside the transaction to prevent races on concurrent
      // requests. A full window throws, rolling the transaction back (guardrail 23).
      if (quota) await assertQuotaInTx(tx, session.user.id, mediaType, quota);

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
          // release" backstop (sync/route.ts overdue scan only looks at rows with it set).
          // Web auto-approve previously had no backstop — unlike admin PATCH approve
          // (requests/[id]/route.ts) — so a stuck request never got a follow-up notification.
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
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return quotaRefusal(err);
    }

    if (isPrismaErrorCode(err, "P2002")) {
      return fail(409, t("apiUser.create.alreadyRequested"), "already-requested");
    }
    throw err;
  }

  if (committed.kind === "available") {
    return { ok: true, kind: "already-available", title: meta.title };
  }

  const { request, branch: createdBranch } = committed;
  const afterResponse = opts.afterResponse ?? after;

  // Admin fan-out for a row that ends up PENDING. Shared by the normal pending branch
  // below and the auto-approve rollback — a failed ARR push leaves a PENDING request that
  // otherwise reached admins through no out-of-band channel at all (the earlier
  // request:new SSE only lands for admins with the web app already open).
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
    }, afterResponse);

  // The auto-approve rollback turns a committed row PENDING after the fact, so its
  // dedupe can only be a post-commit read: alert unless an EARLIER pending request
  // for (tmdbId, mediaType, arrInstance) exists. A failed read alerts anyway — a
  // duplicate alert is cheaper than a lost one, and the row is already committed,
  // so a throw here would answer 500 for a request that exists (and its retry 409).
  const announceRolledBackToAdmins = async () => {
    let earlierPending = false;
    try {
      earlierPending = await hasEarlierPending({ id: request.id, createdAt: request.createdAt, tmdbId, mediaType, arrInstance: instanceSlug });
    } catch (err) {
      console.error(`[requests] earlier-pending check failed, alerting anyway: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    }
    if (!earlierPending) announceToAdmins();
  };

  // A request and a deletion vote for the same title are contradictory. The vote route
  // already blocks voting when you've requested; mirror it here by clearing the caller's
  // own delete-vote on request, so a vote-then-request can't leave both rows persisting.
  // .catch is required, not decorative: a Prisma model method returns a LAZY
  // PrismaPromise that only dispatches once a continuation is attached, so a bare
  // `void deleteMany(...)` never ran at all. It also handles the rejection, which —
  // detached after the response — would otherwise escape as a process-level
  // unhandledRejection with no request context (same shape as requests/bulk).
  void prisma.deletionVote
    .deleteMany({ where: { userId: session.user.id, tmdbId, mediaType } })
    .catch((err) =>
      console.error(
        `[requests] deletionVote cleanup failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`,
      ),
    );

  if (createdBranch === "auto-approve") {
    emitSSE({ type: "request:new", requestId: request.id, userId: session.user.id });

    let pushedTvdbId: number | null = null;
    let pushOutcomeUnknown = false;
    const pushProgress: AddProgress = { sent: false };
    try {
      if (mediaType === "MOVIE") {
        await addMovieToRadarr(tmdbId, instanceSlug, chosenQualityProfileId, session.user.id, pushProgress);
      } else {
        pushedTvdbId = await addSeriesToSonarr(tmdbId, instanceSlug, chosenQualityProfileId, session.user.id, pushProgress);
      }
    } catch (err) {
      const message = sanitizeForLog(err instanceof Error ? err.message : String(err));
      // Unknown only once the add itself was sent: a failure before it (a lookup,
      // a dark arr refusing the connection) added nothing.
      if (pushProgress.sent && arrWriteOutcomeUnknown(err)) {
        // No definite answer: Radarr/Sonarr may well have added the title and be
        // downloading it. Rolling back to PENDING would show admins a request to
        // review for a title already on its way (declining it leaves it
        // downloading). It stays APPROVED with the 90s backstop armed; the sync
        // re-pushes an APPROVED title the arr doesn't hold, so an add that never
        // landed is retried there.
        console.error(`[arr] Auto-approve push outcome unknown, left APPROVED: ${message}`);
        pushOutcomeUnknown = true;
      } else {
        console.error(`[arr] Auto-approve push failed: ${message}`);
        // CAS on status: only roll back if still APPROVED. A concurrent webhook/sync could
        // have flipped this freshly-created row to AVAILABLE; a blind update would clobber
        // that back to PENDING. Clear the pendingNotifyAt too — the ARR push failed, so
        // there's no download to pend. A failed write is logged, not thrown: the row is
        // committed, so a throw would answer 500 for a request that exists.
        const rolledBack = await prisma.mediaRequest
          .updateMany({ where: { id: request.id, status: "APPROVED" }, data: { status: "PENDING", pendingNotifyAt: null } })
          .catch((rbErr: unknown) => {
            console.error(`[requests] rollback to PENDING failed: ${sanitizeForLog(rbErr instanceof Error ? rbErr.message : String(rbErr))}`);
            return { count: 0 };
          });
        if (rolledBack.count === 1) {
          // The client already saw request:new with status APPROVED; emit a corrective
          // update so it reflects the rolled-back PENDING state, and return the PENDING
          // shape rather than the stale APPROVED row (mirrors the PATCH rollback path).
          emitSSE({ type: "request:updated", requestId: request.id, status: "PENDING", userId: session.user.id });
          // The row now sits in the admin queue exactly like a normal pending request, so it
          // must be announced like one — and it can't rely on the pendingNotifyAt backstop
          // (cleared just above), leaving this the only alert admins get.
          await announceRolledBackToAdmins();
          // Both rolled-back fields, like the PATCH rollback body (requests/[id]): the
          // row's pendingNotifyAt is null now, so the body must not carry the armed one.
          return { ok: true, kind: "created", branch: "auto-approve", pushFailed: true, pushOutcomeUnknown: false, request: { ...request, status: "PENDING", pendingNotifyAt: null } };
        }
        // Not rolled back: the row moved on (a webhook flipped it AVAILABLE, or it was
        // deleted) or the write failed. Whatever it is, it is not PENDING, so it is not
        // announced; an APPROVED row the arr lacks is re-pushed by the sync, and its
        // armed backstop is consumed by the check below.
      }
    }

    // Bookkeeping write kept OUT of the try above: Sonarr has already accepted the series
    // by this point, so a P2025 (row deleted mid-push) or transient DB error must not trip
    // the APPROVED->PENDING rollback and leave Sonarr grabbing content the DB says is
    // pending. updateMany no-ops on a concurrently deleted row instead of throwing, and a
    // failed write is logged rather than thrown: the push landed, so the request still
    // answers 201 and its download check is still queued.
    if (pushedTvdbId !== null) {
      await prisma.mediaRequest
        .updateMany({ where: { id: request.id }, data: { tvdbId: pushedTvdbId } })
        .catch((err: unknown) => {
          console.error(`[requests] tvdbId stamp failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
        });
    }

    // Run the pendingNotifyAt check PROMPTLY at ~90s instead of leaving it to the
    // orchestrator's next sweep. Scheduled whenever the row kept its armed
    // pendingNotifyAt — never after the rollback above, which returned early having
    // cleared it, so a job queued for it would have nothing to do.
    scheduleDownloadCheck({
      requestId: request.id,
      tmdbId,
      mediaType,
      arrInstance: instanceSlug,
      requestedBy: session.user.id,
      title: request.title,
    }, { name: "requests:auto-approve-90s-download-check" });

    return { ok: true, kind: "created", branch: createdBranch, pushFailed: false, pushOutcomeUnknown, request };
  }

  if (createdBranch === "mirror-approved") {
    // Content is already greenlit by an earlier request — no arr push (already
    // done) and no admin "new request" alert (nothing to review). The requester
    // is still tracked, so the sync's "now available" pass notifies them just
    // like the original requester.
    emitSSE({ type: "request:new", requestId: request.id, userId: session.user.id });
    return { ok: true, kind: "created", branch: createdBranch, pushFailed: false, pushOutcomeUnknown: false, request };
  }

  emitSSE({ type: "request:new", requestId: request.id, userId: session.user.id });

  if (committed.announce) announceToAdmins();
  return { ok: true, kind: "created", branch: createdBranch, pushFailed: false, pushOutcomeUnknown: false, request };
}
