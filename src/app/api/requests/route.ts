import { NextResponse, after } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { addMovieToRadarr, addSeriesToSonarr } from "@/lib/arr";
import { Prisma, type MediaRequest } from "@/generated/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { emitSSE } from "@/lib/sse-emitter";
import { notifyAdminsNewRequest } from "@/lib/email";
import { notifyAdminsNewRequestPush } from "@/lib/push";
import { notifyAdminsNewRequestDiscord } from "@/lib/discord-notify";
import { maintenanceGuard } from "@/lib/maintenance";
import { sanitizeForLog } from "@/lib/sanitize";
import { canRequest, canAutoApprove, hasPermission, Permission } from "@/lib/permissions";
import { resolveUserQuota, type ResolvedQuota } from "@/lib/quota";
import { resolveMediaMeta } from "@/lib/request-meta";
import { sanitizeOptional } from "@/lib/sanitize";
import { verifyRequestToken } from "@/lib/request-token";

const PAGE_SIZE = 20;

export const GET = withAuth(async (req, _ctx, session) => {
  const page = Math.max(1, parseInt(req.nextUrl.searchParams.get("page") ?? "1", 10) || 1);
  const skip = (page - 1) * PAGE_SIZE;

  // MANAGE_REQUESTS sees every request (admins included via the ADMIN superbit);
  // everyone else sees only their own.
  const canManage = hasPermission(session.user.permissions, Permission.MANAGE_REQUESTS);
  const where = canManage ? {} : { requestedBy: session.user.id };

  const isAdmin = canManage;

  const [requests, total] = await Promise.all([
    isAdmin
      ? prisma.mediaRequest.findMany({
          where,
          include: { user: { select: { name: true, email: true } } },
          orderBy: { createdAt: "desc" },
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
          orderBy: { createdAt: "desc" },
          skip,
          take: PAGE_SIZE,
        }),
    prisma.mediaRequest.count({ where }),
  ]);

  return NextResponse.json({ requests, total, page, pageSize: PAGE_SIZE });
});

export const POST = withAuth(async (req, _ctx, session) => {
  const maint = await maintenanceGuard();
  if (maint) return maint;

  const [settingsRows, userRecord] = await Promise.all([
    prisma.setting.findMany({
      where: { key: { in: ["rateLimitRequests", "discordRequireLinkedAccountSite", "quotaLimit", "quotaPeriod"] } },
    }),
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        discordId: true,
        movieQuotaLimit: true,
        movieQuotaDays: true,
        tvQuotaLimit: true,
        tvQuotaDays: true,
      },
    }),
  ]);
  const settings = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));

  const limit = parseRateLimit(settings.rateLimitRequests, 20);
  if (!checkRateLimit(`requests:${session.user.id}`, limit, 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  if (settings.discordRequireLinkedAccountSite === "true" && !userRecord?.discordId) {
    return NextResponse.json({ error: "You must link your Discord account before making requests" }, { status: 403 });
  }

  // Capability + per-media-type quota are evaluated below, once mediaType is
  // known (see canRequest / resolveUserQuota after body validation).

  let body: {
    tmdbId?: number;
    mediaType?: string;
    note?: string;
    _token?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

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

  // Capability gate — the permission bitmask is authoritative (admins pass via
  // the ADMIN superbit baked into session.user.permissions).
  if (!canRequest(session.user.permissions, mediaType, false)) {
    return NextResponse.json({ error: "You don't have permission to request this" }, { status: 403 });
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
      parseInt(settings.quotaLimit ?? "0", 10),
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

  const existing = await prisma.mediaRequest.findFirst({
    where: { tmdbId, mediaType, requestedBy: session.user.id },
  });

  if (existing) {
    if (existing.permanentlyDeclined) {
      return NextResponse.json({ error: "This request has been permanently denied" }, { status: 403 });
    }
    return NextResponse.json({ error: "Already requested" }, { status: 409 });
  }

  const isAutoApprove = canAutoApprove(session.user.permissions, mediaType, false);

  const [plexItem, arrAvailable] = await Promise.all([
    prisma.plexLibraryItem.findUnique({
      where: { tmdbId_mediaType: { tmdbId, mediaType } },
    }),
    isAutoApprove
      ? mediaType === "MOVIE"
        ? prisma.radarrAvailableItem.findUnique({ where: { tmdbId } }).then(r => r !== null)
        : prisma.sonarrAvailableItem.findUnique({ where: { tmdbId } }).then(r => r !== null)
      : Promise.resolve(false),
  ]);
  const alreadyAvailable = !!plexItem || arrAvailable;

  const baseData = { tmdbId, mediaType, title: verified.title, posterPath: verified.posterPath, releaseYear: verified.releaseYear, note: sanitizedNote ?? null, requestedBy: session.user.id } as const;

  let createdRequest: MediaRequest | null = null;
  let createdBranch: "auto-approve" | "pending" | null = null;

  try {
    await prisma.$transaction(async (tx) => {

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
        createdRequest = await tx.mediaRequest.upsert({
          where: { tmdbId_mediaType_requestedBy: { tmdbId, mediaType, requestedBy: session.user.id } },
          create: { ...baseData, status: "APPROVED" },
          update: {},
        });
        createdBranch = "auto-approve";
        return;
      }

      createdRequest = await tx.mediaRequest.create({ data: baseData });
      createdBranch = "pending";
    }, { isolationLevel: "Serializable" });
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

  if (createdBranch === "auto-approve") {
    emitSSE({ type: "request:new", requestId: request.id, userId: session.user.id });

    try {
      if (mediaType === "MOVIE") {
        await addMovieToRadarr(tmdbId);
      } else {
        const tvdbId = await addSeriesToSonarr(tmdbId);
        await prisma.mediaRequest.update({ where: { id: request.id }, data: { tvdbId } });
      }
    } catch (err) {
      console.error(`[arr] Auto-approve push failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
      await prisma.mediaRequest.update({ where: { id: request.id }, data: { status: "PENDING" } });
    }

    return NextResponse.json(request, { status: 201 });
  }

  emitSSE({ type: "request:new", requestId: request.id, userId: session.user.id });
  const requestedBy = session.user.name ?? session.user.email ?? session.user.id;
  after(async () => {
    await Promise.allSettled([
      notifyAdminsNewRequest({ title: verified.title, mediaType, requestedBy, note: sanitizedNote ?? null, posterPath: verified.posterPath, tmdbId, releaseYear: verified.releaseYear }),
      notifyAdminsNewRequestPush({ title: verified.title, mediaType, requestedBy }),
      notifyAdminsNewRequestDiscord({ requestId: request.id, title: verified.title, mediaType, requestedBy, note: sanitizedNote ?? null, posterPath: verified.posterPath }),
    ]);
  });
  return NextResponse.json(request, { status: 201 });
});
