import { NextResponse, after } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { addMovieToRadarr, addSeriesToSonarr, listQualityProfiles } from "@/lib/arr";
import { Prisma, type MediaRequest } from "@/generated/prisma";
import { runWithSerializableRetry } from "@/lib/serializable-retry";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { emitSSE } from "@/lib/sse-emitter";
import { notifyAdminsNewRequest } from "@/lib/email";
import { notifyAdminsNewRequestPush } from "@/lib/push";
import { notifyAdminsNewRequestDiscord } from "@/lib/discord-notify";
import { maintenanceGuard } from "@/lib/maintenance";
import { sanitizeForLog } from "@/lib/sanitize";
import { canRequestInstance, canAutoApproveInstance, parseInstanceGrants, hasPermission, Permission } from "@/lib/permissions";
import { getArrInstances, getSyncableArrInstances, isInstanceConfigured } from "@/lib/arr-instance-registry";
import { routeMediaToSlug, type RoutableMedia } from "@/lib/arr-instances";
import { resolveUserQuota, parseQuotaLimit, type ResolvedQuota } from "@/lib/quota";
import { resolveMediaMeta } from "@/lib/request-meta";
import { isBlacklisted } from "@/lib/blacklist";
import { exceedsCap } from "@/lib/content-rating";
import { getMovieDetails, getTVDetails } from "@/lib/tmdb";
import { sanitizeOptional } from "@/lib/sanitize";
import { verifyRequestToken } from "@/lib/request-token";

const PAGE_SIZE = 20;
const VALID_STATUSES = ["PENDING", "APPROVED", "AVAILABLE", "DECLINED"] as const;
const VALID_SORTS = ["newest", "oldest"] as const;

export const GET = withAuth(async (req, _ctx, session) => {
  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const skip = (page - 1) * PAGE_SIZE;

  const statusParam = sp.get("status");
  const status =
    statusParam && (VALID_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as (typeof VALID_STATUSES)[number])
      : null;
  const sortParam = sp.get("sort");
  const sort =
    sortParam && (VALID_SORTS as readonly string[]).includes(sortParam)
      ? (sortParam as (typeof VALID_SORTS)[number])
      : "newest";
  const q = (sp.get("q") ?? "").trim();

  // MANAGE_REQUESTS sees every request (admins included via the ADMIN superbit);
  // everyone else sees only their own.
  const canManage = hasPermission(session.user.permissions, Permission.MANAGE_REQUESTS);
  const isAdmin = canManage;

  // `scope` is the base visibility (all vs own). The filter-chip counts ignore
  // the selected `status` but honor the search `q`, mirroring the web /requests page.
  const scope: Prisma.MediaRequestWhereInput = canManage ? {} : { requestedBy: session.user.id };
  const qWhere: Prisma.MediaRequestWhereInput = q
    ? { title: { contains: q, mode: "insensitive" } }
    : {};
  const where: Prisma.MediaRequestWhereInput = { ...scope, ...qWhere, ...(status ? { status } : {}) };
  const orderBy: Prisma.MediaRequestOrderByWithRelationInput = {
    createdAt: sort === "oldest" ? "asc" : "desc",
  };

  const [requests, total, statusCountsRaw] = await Promise.all([
    isAdmin
      ? prisma.mediaRequest.findMany({
          where,
          include: { user: { select: { name: true, email: true } } },
          orderBy,
          skip,
          take: PAGE_SIZE,
        })
      : prisma.mediaRequest.findMany({
          where,
          select: {
            id: true, tmdbId: true, mediaType: true, title: true, posterPath: true,
            releaseYear: true, status: true, createdAt: true, updatedAt: true,
            note: true, availableAt: true, tvdbId: true, permanentlyDeclined: true,
            user: { select: { name: true } },
          },
          orderBy,
          skip,
          take: PAGE_SIZE,
        }),
    prisma.mediaRequest.count({ where }),
    prisma.mediaRequest.groupBy({
      by: ["status"],
      where: { ...scope, ...qWhere },
      _count: { status: true },
    }),
  ]);

  const statusCounts = Object.fromEntries(statusCountsRaw.map((r) => [r.status, r._count.status]));

  return NextResponse.json({ requests, total, page, pageSize: PAGE_SIZE, statusCounts });
});

export const POST = withAuth(async (req, _ctx, session) => {
  const maint = await maintenanceGuard();
  if (maint) return maint;

  const [settingsRows, userRecord] = await Promise.all([
    prisma.setting.findMany({
      where: { key: { in: ["rateLimitRequests", "discordRequireLinkedAccountSite", "quotaLimit", "quotaPeriod", "request4kAll"] } },
    }),
    prisma.user.findUnique({
      where: { id: session.user.id },
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
  const settings = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));

  const limit = parseRateLimit(settings.rateLimitRequests, 20);
  if (!checkRateLimit(`requests:${session.user.id}`, limit, 60 * 1000)) {
    return tooManyRequests(60, "Too many requests — try again later");
  }

  if (settings.discordRequireLinkedAccountSite === "true" && !userRecord?.discordId) {
    return NextResponse.json({ error: "You must link your Discord account before making requests" }, { status: 403 });
  }

  // Capability + per-media-type quota are evaluated below, once mediaType is
  // known (see canRequest / resolveUserQuota after body validation).

  const parsed = await readJsonCapped<{
    tmdbId?: number;
    mediaType?: string;
    note?: string;
    _token?: string;
    is4k?: boolean;
    arrInstance?: string;
    qualityProfileId?: number;
  }>(req, 65536);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { tmdbId, mediaType, note, _token } = body;

  if (!tmdbId || !mediaType) {
    return NextResponse.json({ error: "tmdbId and mediaType are required" }, { status: 400 });
  }

  if (!_token || !verifyRequestToken(_token, tmdbId, mediaType, session.user.id)) {
    return NextResponse.json({ error: "Invalid or expired request token" }, { status: 403 });
  }

  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }

  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType must be MOVIE or TV" }, { status: 400 });
  }

  // Resolve which Radarr/Sonarr instance this request targets. Precedence:
  //   explicit `arrInstance` slug (validated) > legacy `is4k:true` (→ "4k") >
  //   auto-route by TMDB metadata (anime/genre/language rules) > default instance ("").
  const service = mediaType === "MOVIE" ? "radarr" : "sonarr";
  const instances = await getArrInstances(service);
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
    // one CONFIGURED non-default instance carries an autoRoute rule; otherwise default.
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
          originCountries: [],
        };
      } catch {
        // TMDB details unavailable ⇒ fall back to the default instance.
      }
      // Route only over configured instances so we never auto-select an unconfigured target.
      const configured = await getSyncableArrInstances(service);
      instanceSlug = routeMediaToSlug(configured, routable);
    }
  }

  // Whether the client explicitly targeted an instance (arrInstance or the legacy
  // is4k flag) vs. the server auto-routing it. Matters for the quality-profile
  // override below: an explicit target means the client knew which instance's
  // profile list it picked from; an auto-route means it didn't.
  const instanceExplicit = rawInstance !== undefined || body.is4k === true;

  const instance = instances.find((i) => i.slug === instanceSlug);
  if (!instance) {
    return NextResponse.json({ error: "That instance isn't available for requests" }, { status: 400 });
  }
  // A non-default instance must have a configured connection (url + apiKey). The default
  // instance ("") is always allowed — a request with no arr configured simply stays pending.
  if (instanceSlug !== "" && !(await isInstanceConfigured(service, instanceSlug))) {
    return NextResponse.json(
      { error: `Requests to "${instance.name}" aren't available — that instance isn't configured` },
      { status: 400 },
    );
  }

  // Capability gate — the permission bitmask is authoritative (admins pass via the ADMIN
  // superbit). The default instance is open to any base requester; "4k" gates on the
  // REQUEST_4K* bits / request4kAll toggle; named instances gate on serverAll or a
  // per-user instance grant.
  const grants = parseInstanceGrants(userRecord?.instanceGrants);
  if (!canRequestInstance(session.user.permissions, instance, grants, mediaType, settings.request4kAll === "true")) {
    return NextResponse.json({ error: "You don't have permission to request this" }, { status: 403 });
  }

  // Advanced request option: an explicit quality profile is honored only for
  // REQUEST_ADVANCED holders (ADMIN passes via the superbit) and is validated
  // against the target instance's profiles, so a client can't smuggle an arbitrary
  // id into the ARR add. Absent ⇒ the instance's configured default is used.
  let chosenQualityProfileId: number | undefined;
  if (body.qualityProfileId !== undefined) {
    if (!Number.isInteger(body.qualityProfileId) || body.qualityProfileId <= 0) {
      return NextResponse.json({ error: "qualityProfileId must be a positive integer" }, { status: 400 });
    }
    if (!hasPermission(session.user.permissions, Permission.REQUEST_ADVANCED)) {
      return NextResponse.json({ error: "You don't have permission to choose a quality profile" }, { status: 403 });
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
        return NextResponse.json({ error: `Could not connect to ${service}` }, { status: 502 });
      }
      if (!profileList || !profileList.profiles.some((p) => p.id === body.qualityProfileId)) {
        return NextResponse.json({ error: "Invalid quality profile for this request" }, { status: 400 });
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
        return NextResponse.json(
          { error: `You have reached your request quota of ${resolvedQuota.limit} per ${resolvedQuota.windowLabel}` },
          { status: 429 },
        );
      }
    }
  }

  if (note !== undefined && (typeof note !== "string" || note.length > 500)) {
    return NextResponse.json({ error: "note must be a string under 500 characters" }, { status: 400 });
  }
  const sanitizedNote = sanitizeOptional(note);

  let verified: Awaited<ReturnType<typeof resolveMediaMeta>> = null;
  try {
    verified = await resolveMediaMeta(tmdbId, mediaType);
  } catch {
    return NextResponse.json({ error: "Could not verify media with TMDB" }, { status: 422 });
  }
  if (!verified) {
    return NextResponse.json({ error: "Could not verify media with TMDB" }, { status: 422 });
  }

  // Blacklist gate — an admin-blocked title can never be requested. This is the
  // authoritative block (discovery hiding is best-effort UX) and must run before
  // any request row is created.
  if (await isBlacklisted(tmdbId, mediaType)) {
    return NextResponse.json({ error: "This title has been blocked by an administrator" }, { status: 403 });
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
      return NextResponse.json({ error: "This title's rating exceeds your account's limit" }, { status: 403 });
    }
  }

  const existing = await prisma.mediaRequest.findFirst({
    where: { tmdbId, mediaType, requestedBy: session.user.id, arrInstance: instanceSlug },
  });

  if (existing) {
    if (existing.permanentlyDeclined) {
      return NextResponse.json({ error: "This request has been permanently denied" }, { status: 403 });
    }
    // An ordinary (non-permanent) decline is not terminal — let the user
    // re-request: delete the stale DECLINED row and fall through to a fresh
    // create. APPROVED/AVAILABLE/PENDING still block with a 409.
    if (existing.status === "DECLINED") {
      // deleteMany (not delete) — on a concurrent double re-request the second
      // delete would throw P2025 (500); deleteMany no-ops, and the create below
      // then surfaces a clean 409 via its P2002 catch instead.
      //
      // CAS on status + permanentlyDeclined: if an admin re-approved or made the decline
      // permanent between the read and here, the predicate no-ops the delete — the create
      // below then 409s on the surviving row rather than orphaning an APPROVED row's ARR
      // grab or evading a fresh permanent ban.
      await prisma.mediaRequest.deleteMany({ where: { id: existing.id, status: "DECLINED", permanentlyDeclined: false } });
    } else {
      return NextResponse.json({ error: "Already requested" }, { status: 409 });
    }
  }

  const isAutoApprove = canAutoApproveInstance(session.user.permissions, instance, grants, mediaType);

  // Default-instance request: a Plex/Jellyfin library hit OR the default *arr-available
  // cache counts as already-here. An instance with skipLibraryCheck (4K/opt-in) ignores
  // the shared library — a copy at another quality must not block requesting this one —
  // and only that instance's available cache counts.
  const skipLibraryCheck = instance.skipLibraryCheck;
  const [plexItem, jellyfinItem, arrAvailable] = await Promise.all([
    skipLibraryCheck
      ? Promise.resolve(null)
      : prisma.plexLibraryItem.findUnique({ where: { tmdbId_mediaType: { tmdbId, mediaType } } }),
    skipLibraryCheck
      ? Promise.resolve(null)
      : prisma.jellyfinLibraryItem.findUnique({ where: { tmdbId_mediaType: { tmdbId, mediaType } } }),
    isAutoApprove
      ? mediaType === "MOVIE"
        ? prisma.radarrAvailableItem.findUnique({ where: { tmdbId_arrInstance: { tmdbId, arrInstance: instanceSlug } } }).then(r => r !== null)
        : prisma.sonarrAvailableItem.findUnique({ where: { tmdbId_arrInstance: { tmdbId, arrInstance: instanceSlug } } }).then(r => r !== null)
      : Promise.resolve(false),
  ]);
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
          data: { ...baseData, status: "APPROVED", pendingNotifyAt: new Date(Date.now() + 90_000) },
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
      const greenlit = await tx.mediaRequest.findFirst({
        where: { tmdbId, mediaType, arrInstance: instanceSlug, status: { in: ["APPROVED", "AVAILABLE"] } },
        select: { status: true },
      });
      if (greenlit) {
        createdRequest = await tx.mediaRequest.create({
          data: {
            ...baseData,
            status: greenlit.status,
            // Mirror an already-AVAILABLE title's availability timestamp so this
            // row matches the original's shape (the sync's "now available" pass
            // and availability sorts read availableAt).
            ...(greenlit.status === "AVAILABLE" ? { availableAt: new Date() } : {}),
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
      return NextResponse.json(
        { error: `You have reached your request quota of ${resolvedQuota?.limit ?? 0} per ${resolvedQuota?.windowLabel ?? "period"}` },
        { status: 429 }
      );
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "Already requested" }, { status: 409 });
    }
    throw err;
  }

  if (alreadyAvailable && !createdRequest) {
    return NextResponse.json({ alreadyAvailable: true, tmdbId, mediaType, title: verified.title }, { status: 200 });
  }

  if (!createdRequest || !createdBranch) {
    throw new Error("Unexpected: request was not created");
  }

  const request = createdRequest as MediaRequest;

  // A request and a deletion vote for the same title are contradictory. The vote route
  // already blocks voting when you've requested; mirror it here by clearing the caller's
  // own delete-vote on request, so a vote-then-request can't leave both rows persisting.
  void prisma.deletionVote.deleteMany({ where: { userId: session.user.id, tmdbId, mediaType } });

  if (createdBranch === "auto-approve") {
    emitSSE({ type: "request:new", requestId: request.id, userId: session.user.id });

    try {
      if (mediaType === "MOVIE") {
        await addMovieToRadarr(tmdbId, instanceSlug, chosenQualityProfileId, session.user.id);
      } else {
        const tvdbId = await addSeriesToSonarr(tmdbId, instanceSlug, chosenQualityProfileId, session.user.id);
        await prisma.mediaRequest.update({ where: { id: request.id }, data: { tvdbId } });
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
      return NextResponse.json({ ...request, status: "PENDING" }, { status: 201 });
    }

    return NextResponse.json(request, { status: 201 });
  }

  if (createdBranch === "mirror-approved") {
    // Content is already greenlit by an earlier request — no arr push (already
    // done) and no admin "new request" alert (nothing to review). The requester
    // is still tracked, so the sync's "now available" pass notifies them just
    // like the original requester.
    emitSSE({ type: "request:new", requestId: request.id, userId: session.user.id });
    return NextResponse.json(request, { status: 201 });
  }

  emitSSE({ type: "request:new", requestId: request.id, userId: session.user.id });

  // Suppress duplicate admin alerts for a title that's still pending review: only
  // the EARLIEST pending request for (tmdbId, mediaType, arrInstance) fires the admin
  // notifications. Total ordering by (createdAt, id) makes this race-safe — among
  // concurrent duplicate requests exactly one (the earliest) has no earlier peer
  // and alerts; the rest find this row and skip.
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
        notifyAdminsNewRequest({ title: verified.title, mediaType, requestedBy, note: sanitizedNote ?? null, posterPath: verified.posterPath, tmdbId, releaseYear: verified.releaseYear, excludeUserId: session.user.id }),
        notifyAdminsNewRequestPush({ title: verified.title, mediaType, requestedBy, tmdbId, excludeUserId: session.user.id }),
        notifyAdminsNewRequestDiscord({ requestId: request.id, title: verified.title, mediaType, requestedBy, note: sanitizedNote ?? null, posterPath: verified.posterPath }),
      ]);
    });
  }
  return NextResponse.json(request, { status: 201 });
});
