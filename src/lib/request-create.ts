import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { addMovieToRadarr, addSeriesToSonarr, listQualityProfiles } from "@/lib/arr";
import { Prisma, type MediaRequest } from "@/generated/prisma";
import type { SummonarrSession } from "@/lib/api-auth";
import { runWithSerializableRetry } from "@/lib/serializable-retry";
import { emitSSE } from "@/lib/sse-emitter";
import { scheduleDownloadCheck } from "@/lib/download-check";
import { notifyAdminsNewRequest } from "@/lib/email";
import { notifyAdminsNewRequestPush } from "@/lib/push";
import { notifyAdminsNewRequestDiscord } from "@/lib/discord-notify";
import { sanitizeForLog, sanitizeOptional } from "@/lib/sanitize";
import { canRequestInstance, canAutoApproveInstance, parseInstanceGrants, hasPermission, Permission } from "@/lib/permissions";
import { getArrInstancesWithConfigured } from "@/lib/arr-instance-registry";
import { getVisibleServerInstances } from "@/lib/media-visibility";
import { routeMediaToSlug, type RoutableMedia } from "@/lib/arr-instances";
import { resolveUserQuota, parseQuotaLimit, type ResolvedQuota } from "@/lib/quota";
import { resolveMediaMeta } from "@/lib/request-meta";
import { isBlacklisted } from "@/lib/blacklist";
import { exceedsCap } from "@/lib/content-rating";
import { getMovieDetails, getTVDetails } from "@/lib/tmdb";

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
// Must run inside a request scope: the pending branch schedules the admin notify
// with after(). Both callers are route handlers.

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
  | { ok: false; status: number; error: string; reason: CreateMediaRequestFailure }
  | { ok: true; kind: "already-available"; title: string }
  | {
      ok: true;
      kind: "created";
      branch: CreateMediaRequestBranch;
      // The auto-approve push failed and the row was rolled back to PENDING.
      pushFailed: boolean;
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

function fail(status: number, error: string, reason: CreateMediaRequestFailure): CreateMediaRequestResult {
  return { ok: false, status, error, reason };
}

export async function createMediaRequest(
  session: SummonarrSession,
  ctx: RequestContext,
  input: CreateMediaRequestInput,
): Promise<CreateMediaRequestResult> {
  const { settings, userRecord } = ctx;
  const body = input;
  const { tmdbId, mediaType, note } = input;

  // Resolve which Radarr/Sonarr instance this request targets. Precedence:
  //   explicit `arrInstance` slug (validated) > legacy `is4k:true` (→ "4k") >
  //   auto-route by TMDB metadata (anime/genre/language rules) > default instance ("").
  const service = mediaType === "MOVIE" ? "radarr" : "sonarr";
  // One registry read + one batched connection probe serve every branch below:
  // explicit-slug validation needs the FULL list, auto-routing the configured subset.
  const { all: instances, configured: configuredSlugs } = await getArrInstancesWithConfigured(service);
  const rawInstance = typeof body.arrInstance === "string" ? body.arrInstance.trim() : undefined;

  let instanceSlug: string;
  if (rawInstance !== undefined) {
    // Explicit target (including "" for the default). Validated against the registry below.
    instanceSlug = rawInstance;
  } else if (body.is4k === true) {
    // Legacy 4K button / native clients — shorthand for the "4k" instance.
    instanceSlug = "4k";
  } else {
    // No explicit target — auto-route. Only pay the TMDB details fetch when at least
    // one REGISTERED non-default instance carries an autoRoute rule; otherwise default.
    // (Configured-ness is applied below, over the same already-read list.)
    const autoCandidates = instances.filter((i) => i.slug !== "" && i.autoRoute);
    if (autoCandidates.length === 0) {
      instanceSlug = "";
    } else {
      let routable: RoutableMedia = { genreIds: [], originalLanguage: null, originCountries: [] };
      try {
        const detail = mediaType === "MOVIE" ? await getMovieDetails(tmdbId) : await getTVDetails(tmdbId);
        routable = {
          genreIds: detail.genreList?.map((g) => g.id) ?? [],
          originalLanguage: detail.originalLanguage ?? null,
          // ISO codes from the normalized details (populated since the
          // originCountryCodes field landed; older cached rows lack it and
          // degrade to [] — exactly the previous behavior — until TTL refresh).
          originCountries: detail.originCountryCodes ?? [],
        };
      } catch {
        // TMDB details unavailable ⇒ fall back to the default instance.
      }
      // Route only over configured instances so we never auto-select an unconfigured
      // target — the subset of the list already read above, no second registry read.
      const configured = instances.filter((i) => configuredSlugs.has(i.slug));
      instanceSlug = routeMediaToSlug(configured, routable);
    }
  }

  // Whether the client explicitly targeted an instance (arrInstance or the legacy
  // is4k flag) vs. the server auto-routing it. Matters for the quality-profile
  // override below: an explicit target means the client knew which instance's
  // profile list it picked from; an auto-route means it didn't.
  const instanceExplicit = rawInstance !== undefined || body.is4k === true;

  let instance = instances.find((i) => i.slug === instanceSlug);
  if (!instance) {
    return fail(400, "That instance isn't available for requests", "instance-unavailable");
  }
  // A non-default instance must have a configured connection (url + apiKey). The default
  // instance ("") is always allowed — a request with no arr configured simply stays pending.
  if (instanceSlug !== "" && !configuredSlugs.has(instanceSlug)) {
    return fail(400, `Requests to "${instance.name}" aren't available — that instance isn't configured`, "instance-unavailable");
  }

  // Capability gate — the permission bitmask is authoritative (admins pass via the ADMIN
  // superbit). The default instance is open to any base requester; "4k" gates on the
  // REQUEST_4K* bits / request4kAll toggle; named instances gate on serverAll or a
  // per-user instance grant.
  const grants = parseInstanceGrants(userRecord?.instanceGrants);
  if (!canRequestInstance(session.user.permissions, instance, grants, mediaType, settings.request4kAll === "true")) {
    // An EXPLICITLY targeted instance the user can't access is a hard 403. An
    // AUTO-ROUTED one falls back to the default instance instead: a base requester is
    // never blocked by a server-side routing decision (the default is open to any
    // requester, and an admin still reviews the resulting request). Auto-routing only
    // ever selects a CONFIGURED instance, so the default fallback is always valid.
    // Mirrors the Discord (interactions) and bulk request paths.
    if (instanceExplicit) {
      return fail(403, "You don't have permission to request this", "forbidden");
    }
    const defaultInstance = instances.find((i) => i.slug === "");
    // Re-check against the DEFAULT instance before falling back. canRequestInstance
    // gates on the base REQUEST/REQUEST_{MOVIE,TV} bit FIRST (permissions.ts) — a user
    // who lacks it fails for EVERY instance, default included. Without this re-check a
    // request-revoked user could bypass the base capability entirely by omitting the
    // instance target: the auto-route sends them to a named instance they can't access,
    // and the unconditional default fallback then created the request anyway. The
    // fallback exists only for a *base requester* who merely lacks a NAMED-instance grant.
    if (
      !defaultInstance ||
      !canRequestInstance(session.user.permissions, defaultInstance, grants, mediaType, settings.request4kAll === "true")
    ) {
      return fail(403, "You don't have permission to request this", "forbidden");
    }
    instanceSlug = "";
    instance = defaultInstance;
  }

  // Advanced request option: an explicit quality profile is honored only for
  // REQUEST_ADVANCED holders (ADMIN passes via the superbit) and is validated
  // against the target instance's profiles, so a client can't smuggle an arbitrary
  // id into the ARR add. Absent ⇒ the instance's configured default is used.
  let chosenQualityProfileId: number | undefined;
  if (body.qualityProfileId !== undefined) {
    if (!Number.isInteger(body.qualityProfileId) || body.qualityProfileId <= 0) {
      return fail(400, "qualityProfileId must be a positive integer", "invalid-quality-profile");
    }
    if (!hasPermission(session.user.permissions, Permission.REQUEST_ADVANCED)) {
      return fail(403, "You don't have permission to choose a quality profile", "forbidden");
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
        return fail(502, `Could not connect to ${service}`, "arr-unreachable");
      }
      if (!profileList || !profileList.profiles.some((p) => p.id === body.qualityProfileId)) {
        return fail(400, "Invalid quality profile for this request", "invalid-quality-profile");
      }
      chosenQualityProfileId = body.qualityProfileId;
    }
  }

  // Per-media-type quota. QUOTA_UNLIMITED (and ADMIN) bypass; otherwise resolve
  // the per-user override → global Settings window and pre-check before the
  // (more expensive) TMDB verification below. Re-checked inside the tx.
  const quotaApplies = !hasPermission(session.user.permissions, Permission.QUOTA_UNLIMITED);
  let resolvedQuota: ResolvedQuota | null = null;
  let enforceQuota = false;
  if (quotaApplies) {
    resolvedQuota = resolveUserQuota(
      mediaType,
      {
        movieQuotaLimit: userRecord?.movieQuotaLimit ?? null,
        movieQuotaDays: userRecord?.movieQuotaDays ?? null,
        tvQuotaLimit: userRecord?.tvQuotaLimit ?? null,
        tvQuotaDays: userRecord?.tvQuotaDays ?? null,
      },
      parseQuotaLimit(settings.quotaLimit),
      settings.quotaPeriod ?? "week",
    );
    enforceQuota = resolvedQuota.limit > 0;
    if (enforceQuota) {
      const preCount = await prisma.mediaRequest.count({
        where: { requestedBy: session.user.id, mediaType, createdAt: { gte: resolvedQuota.since }, status: { notIn: ["DECLINED"] } },
      });
      if (preCount >= resolvedQuota.limit) {
        return fail(429, `You have reached your request quota of ${resolvedQuota.limit} per ${resolvedQuota.windowLabel}`, "quota");
      }
    }
  }

  if (note !== undefined && (typeof note !== "string" || note.length > 500)) {
    return fail(400, "note must be a string under 500 characters", "invalid-note");
  }
  const sanitizedNote = sanitizeOptional(note);

  let verified: Awaited<ReturnType<typeof resolveMediaMeta>> = null;
  try {
    verified = await resolveMediaMeta(tmdbId, mediaType);
  } catch {
    return fail(422, "Could not verify media with TMDB", "tmdb-unverified");
  }
  if (!verified) {
    return fail(422, "Could not verify media with TMDB", "tmdb-unverified");
  }

  // Blacklist gate — an admin-blocked title can never be requested. This is the
  // authoritative block (discovery hiding is best-effort UX) and must run before
  // any request row is created.
  if (await isBlacklisted(tmdbId, mediaType)) {
    return fail(403, "This title has been blocked by an administrator", "blacklisted");
  }

  // Parental control — block a request whose US certification exceeds the user's
  // cap. Only capped, non-admin users pay the (cached) certification fetch;
  // unknown/unrated titles are allowed (see content-rating.ts).
  if (userRecord?.maxContentRating && !hasPermission(session.user.permissions, Permission.ADMIN)) {
    let cert: string | undefined;
    try {
      const detail = mediaType === "MOVIE" ? await getMovieDetails(tmdbId) : await getTVDetails(tmdbId);
      cert = detail.certification;
    } catch {
      cert = undefined;
    }
    if (exceedsCap(cert, userRecord.maxContentRating)) {
      return fail(403, "This title's rating exceeds your account's limit", "rating-cap");
    }
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
      return fail(403, "This request has been permanently denied", "permanently-declined");
    }
    // An ordinary (non-permanent) decline is not terminal — let the user
    // re-request: remember the stale DECLINED row (it is deleted inside the tx
    // below) and fall through to a fresh create. APPROVED/AVAILABLE/PENDING
    // still block with a 409.
    if (existing.status === "DECLINED") {
      staleDeclinedId = existing.id;
    } else {
      return fail(409, "Already requested", "already-requested");
    }
  }

  const isAutoApprove = canAutoApproveInstance(session.user.permissions, instance, grants, mediaType);

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

  const baseData = { tmdbId, mediaType, arrInstance: instanceSlug, qualityProfileId: chosenQualityProfileId ?? null, title: verified.title, posterPath: verified.posterPath, releaseYear: verified.releaseYear, note: sanitizedNote ?? null, requestedBy: session.user.id } as const;

  let createdRequest: MediaRequest | null = null;
  let createdBranch: "auto-approve" | "pending" | "mirror-approved" | null = null;

  try {
    // Serializable + P2034 retry: concurrent creates at the quota boundary conflict
    // on the count+create and Postgres aborts one; without the retry that's a 500
    // instead of the correct 429/409. (bulk/route.ts wraps its tx the same way.)
    await runWithSerializableRetry(() => prisma.$transaction(async (tx) => {

      // Re-check quota inside the transaction to prevent races on concurrent requests
      if (enforceQuota && resolvedQuota) {
        const count = await tx.mediaRequest.count({
          where: { requestedBy: session.user.id, mediaType, createdAt: { gte: resolvedQuota.since }, status: { notIn: ["DECLINED"] } },
        });
        if (count >= resolvedQuota.limit) {
          throw new Error("QUOTA_EXCEEDED");
        }
      }

      if (alreadyAvailable) {
        return;
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
      if (staleDeclinedId) {
        await tx.mediaRequest.deleteMany({ where: { id: staleDeclinedId, status: "DECLINED", permanentlyDeclined: false } });
      }

      if (isAutoApprove) {
        // create (NOT upsert update:{}): a concurrent duplicate must hit the unique
        // constraint and surface as P2002 -> 409 below, exactly like the pending and
        // mirror-approved branches. The no-op upsert update let two concurrent
        // auto-approvals BOTH "succeed" and both fire ARR side effects + a 201/SSE
        // for the same row (guardrail 23).
        createdRequest = await tx.mediaRequest.create({
          // pendingNotifyAt arms the orchestrator's 90s "download pending / awaiting
          // release" backstop (sync/route.ts overdue scan only looks at rows with it set).
          // Web auto-approve previously had no backstop — unlike admin PATCH approve
          // (requests/[id]/route.ts) — so a stuck request never got a follow-up notification.
          // approvedAt: auto-approve is an approval (MediaRequest.approvedAt).
          data: { ...baseData, status: "APPROVED", approvedAt: new Date(), pendingNotifyAt: new Date(Date.now() + 90_000) },
        });
        createdBranch = "auto-approve";
        return;
      }

      // If another request for this exact title (+ same instance) is already APPROVED
      // or AVAILABLE, the content is already greenlit / being fulfilled — there is
      // nothing for an admin to review. Mirror that status so this requester is
      // tracked and still receives the "now available" notification (the sync
      // notifies every APPROVED row's requester), while skipping the admin
      // "new request" alert.
      //
      // No approvedAt: the copy made no decision of its own. The watch grade
      // counts it through the approval of the request it copied (per title).
      const greenlit = await tx.mediaRequest.findFirst({
        where: { tmdbId, mediaType, arrInstance: instanceSlug, status: { in: ["APPROVED", "AVAILABLE"] } },
        select: { status: true },
      });
      if (greenlit) {
        // An AVAILABLE peer is copied only when the title is available to THIS requester:
        // the peer may have been marked off a restricted server this requester holds no
        // grant for (guardrail 35). No visible library copy exists (that returned above),
        // so the instance's *arr-available cache is the remaining evidence — the same
        // ungated signal the sync's arr marking pass uses. Otherwise mirror APPROVED and
        // let the grant-gated sync marking pass promote (and notify) it.
        const mirrorStatus = greenlit.status === "AVAILABLE" && !arrHasInstance ? "APPROVED" : greenlit.status;
        createdRequest = await tx.mediaRequest.create({
          data: {
            ...baseData,
            status: mirrorStatus,
            // Mirror an already-AVAILABLE title's availability timestamp so this
            // row matches the original's shape (the sync's "now available" pass
            // and availability sorts read availableAt).
            ...(mirrorStatus === "AVAILABLE" ? { availableAt: new Date() } : {}),
          },
        });
        createdBranch = "mirror-approved";
        return;
      }

      createdRequest = await tx.mediaRequest.create({ data: baseData });
      createdBranch = "pending";
    }, { isolationLevel: "Serializable" }));
  } catch (err) {
    if (err instanceof Error && err.message === "QUOTA_EXCEEDED") {
      return fail(429, `You have reached your request quota of ${resolvedQuota?.limit ?? 0} per ${resolvedQuota?.windowLabel ?? "period"}`, "quota");
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return fail(409, "Already requested", "already-requested");
    }
    throw err;
  }

  if (alreadyAvailable && !createdRequest) {
    return { ok: true, kind: "already-available", title: verified.title };
  }

  if (!createdRequest || !createdBranch) {
    throw new Error("Unexpected: request was not created");
  }

  const request = createdRequest as MediaRequest;

  // Admin fan-out for a row that ends up PENDING. Shared by the normal pending branch
  // below and the auto-approve rollback — a failed ARR push leaves a PENDING request that
  // otherwise reached admins through no out-of-band channel at all (the earlier
  // request:new SSE only lands for admins with the web app already open).
  //
  // Suppress duplicate admin alerts for a title that's still pending review: only
  // the EARLIEST pending request for (tmdbId, mediaType, arrInstance) fires the admin
  // notifications. Total ordering by (createdAt, id) makes this race-safe — among
  // concurrent duplicate requests exactly one (the earliest) has no earlier peer
  // and alerts; the rest find this row and skip.
  const meta = verified;
  const announcePendingToAdmins = async () => {
    const earlierPending = await prisma.mediaRequest.findFirst({
      where: {
        tmdbId,
        mediaType,
        arrInstance: instanceSlug,
        status: "PENDING",
        id: { not: request.id },
        OR: [
          { createdAt: { lt: request.createdAt } },
          { createdAt: request.createdAt, id: { lt: request.id } },
        ],
      },
      select: { id: true },
    });

    if (!earlierPending) {
      const requestedBy = session.user.name ?? session.user.email ?? session.user.id;
      after(async () => {
        await Promise.allSettled([
          notifyAdminsNewRequest({ title: meta.title, mediaType, requestedBy, note: sanitizedNote ?? null, posterPath: meta.posterPath, tmdbId, releaseYear: meta.releaseYear, excludeUserId: session.user.id }),
          notifyAdminsNewRequestPush({ title: meta.title, mediaType, requestedBy, requestId: request.id, excludeUserId: session.user.id }),
          notifyAdminsNewRequestDiscord({ requestId: request.id, title: meta.title, mediaType, requestedBy, note: sanitizedNote ?? null, posterPath: meta.posterPath }),
        ]);
      });
    }
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
    try {
      if (mediaType === "MOVIE") {
        await addMovieToRadarr(tmdbId, instanceSlug, chosenQualityProfileId, session.user.id);
      } else {
        pushedTvdbId = await addSeriesToSonarr(tmdbId, instanceSlug, chosenQualityProfileId, session.user.id);
      }
    } catch (err) {
      console.error(`[arr] Auto-approve push failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
      // CAS on status: only roll back if still APPROVED. A concurrent webhook/sync could
      // have flipped this freshly-created row to AVAILABLE; a blind update would clobber
      // that back to PENDING. Clear the pendingNotifyAt too — the ARR push failed, so
      // there's no download to pend.
      await prisma.mediaRequest.updateMany({ where: { id: request.id, status: "APPROVED" }, data: { status: "PENDING", pendingNotifyAt: null } });
      // The client already saw request:new with status APPROVED; emit a corrective
      // update so it reflects the rolled-back PENDING state, and return the PENDING
      // shape rather than the stale APPROVED row (mirrors the PATCH rollback path).
      emitSSE({ type: "request:updated", requestId: request.id, status: "PENDING", userId: session.user.id });
      // The row now sits in the admin queue exactly like a normal pending request, so it
      // must be announced like one — and it can't rely on the pendingNotifyAt backstop
      // (cleared just above), leaving this the only alert admins get.
      await announcePendingToAdmins();
      return { ok: true, kind: "created", branch: "auto-approve", pushFailed: true, request: { ...request, status: "PENDING" } };
    }

    // Bookkeeping write kept OUT of the try above: Sonarr has already accepted the series
    // by this point, so a P2025 (row deleted mid-push) or transient DB error must not trip
    // the APPROVED->PENDING rollback and leave Sonarr grabbing content the DB says is
    // pending. updateMany no-ops on a concurrently deleted row instead of throwing.
    if (pushedTvdbId !== null) {
      await prisma.mediaRequest.updateMany({ where: { id: request.id }, data: { tvdbId: pushedTvdbId } });
    }

    // Run the pendingNotifyAt check PROMPTLY at ~90s instead of leaving it to the
    // orchestrator's next sweep. Scheduled only here, on the push-succeeded path:
    // unlike /api/requests/[id] the rollback above returns early having already
    // cleared pendingNotifyAt, so a job queued for it would have nothing to do.
    scheduleDownloadCheck({
      requestId: request.id,
      tmdbId,
      mediaType,
      arrInstance: instanceSlug,
      requestedBy: session.user.id,
      title: request.title,
    }, { name: "requests:auto-approve-90s-download-check" });

    return { ok: true, kind: "created", branch: createdBranch, pushFailed: false, request };
  }

  if (createdBranch === "mirror-approved") {
    // Content is already greenlit by an earlier request — no arr push (already
    // done) and no admin "new request" alert (nothing to review). The requester
    // is still tracked, so the sync's "now available" pass notifies them just
    // like the original requester.
    emitSSE({ type: "request:new", requestId: request.id, userId: session.user.id });
    return { ok: true, kind: "created", branch: createdBranch, pushFailed: false, request };
  }

  emitSSE({ type: "request:new", requestId: request.id, userId: session.user.id });

  await announcePendingToAdmins();
  return { ok: true, kind: "created", branch: createdBranch, pushFailed: false, request };
}
