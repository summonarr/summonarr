import { NextRequest, NextResponse, after } from "next/server";
import { requireAuth } from "@/lib/api-auth";
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
import { verifyTmdbMedia } from "@/lib/tmdb";

async function resolveMediaMeta(
  tmdbId: number,
  mediaType: "MOVIE" | "TV",
): Promise<{ title: string; posterPath: string | null; releaseYear: string } | null> {
  // Prefer the pre-warmed TmdbMediaCore table, fall back to TmdbCache, then live TMDB API
  const core = await prisma.tmdbMediaCore.findUnique({
    where: { tmdbId_mediaType: { tmdbId, mediaType } },
    select: { title: true, posterPath: true, releaseYear: true },
  }).catch(() => null);
  if (core?.title) {
    return { title: core.title, posterPath: core.posterPath ?? null, releaseYear: core.releaseYear ?? "" };
  }

  const cacheKey = `${mediaType === "MOVIE" ? "movie" : "tv"}:${tmdbId}:details`;
  const cacheRow = await prisma.tmdbCache.findUnique({
    where: { key: cacheKey },
    select: { data: true, expiresAt: true },
  }).catch(() => null);
  if (cacheRow && new Date() < cacheRow.expiresAt) {
    try {
      const parsed = JSON.parse(cacheRow.data) as { title?: string; posterPath?: string | null; releaseYear?: string };
      if (parsed.title) {
        return { title: parsed.title, posterPath: parsed.posterPath ?? null, releaseYear: parsed.releaseYear ?? "" };
      }
    } catch { }
  }

  return verifyTmdbMedia(tmdbId, mediaType === "MOVIE" ? "movie" : "tv");
}
import { sanitizeOptional } from "@/lib/sanitize";
import { verifyRequestToken } from "@/lib/request-token";

const PAGE_SIZE = 20;

export async function GET(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const page = Math.max(1, parseInt(req.nextUrl.searchParams.get("page") ?? "1", 10) || 1);
  const skip = (page - 1) * PAGE_SIZE;

  const where =
    session.user.role === "ADMIN"
      ? {}
      : { requestedBy: session.user.id };

  const isAdmin = session.user.role === "ADMIN";

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
}

export async function POST(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const maint = await maintenanceGuard(session.user.role);
  if (maint) return maint;

  const [settingsRows, userRecord] = await Promise.all([
    prisma.setting.findMany({
      where: { key: { in: ["rateLimitRequests", "discordRequireLinkedAccountSite", "quotaLimit", "quotaPeriod"] } },
    }),
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { discordId: true, quotaExempt: true, autoApprove: true },
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

  const quotaLimit = parseInt(settings.quotaLimit ?? "0", 10);
  const quotaApplies = quotaLimit > 0 && session.user.role !== "ADMIN" && !userRecord?.quotaExempt;
  let quotaPeriod: string | undefined;
  let quotaSince: Date | undefined;
  if (quotaApplies) {
    const period = settings.quotaPeriod ?? "week";
    quotaPeriod = period;
    const now = new Date();
    if (period === "day") {
      quotaSince = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (period === "month") {
      quotaSince = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      // ISO week: Monday=0, so adjust JS Sunday (0) to position 6
      const day = now.getDay() === 0 ? 6 : now.getDay() - 1;
      quotaSince = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
    }

    const preCount = await prisma.mediaRequest.count({
      where: { requestedBy: session.user.id, createdAt: { gte: quotaSince }, status: { notIn: ["DECLINED"] } },
    });
    if (preCount >= quotaLimit) {
      return NextResponse.json(
        { error: `You have reached your request quota of ${quotaLimit} per ${period}` },
        { status: 429 }
      );
    }
  }

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

  const isAutoApprove = session.user.role === "ADMIN" || !!userRecord?.autoApprove;

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
      if (quotaApplies && quotaSince && quotaPeriod) {
        const count = await tx.mediaRequest.count({
          where: { requestedBy: session.user.id, createdAt: { gte: quotaSince }, status: { notIn: ["DECLINED"] } },
        });
        if (count >= quotaLimit) {
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
        { error: `You have reached your request quota of ${quotaLimit} per ${quotaPeriod}` },
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
}
