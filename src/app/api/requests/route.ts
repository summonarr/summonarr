import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { parsePageParam } from "@/lib/pagination";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { maintenanceGuard } from "@/lib/maintenance";
import { sanitizeContainsSearch } from "@/lib/sanitize";
import { hasPermission, Permission } from "@/lib/permissions";
import { verifyRequestToken } from "@/lib/request-token";
import { createMediaRequest, loadRequestContext } from "@/lib/request-create";

const PAGE_SIZE = 20;
const VALID_STATUSES = ["PENDING", "APPROVED", "AVAILABLE", "DECLINED"] as const;
const VALID_SORTS = ["newest", "oldest"] as const;

export const GET = withAuth(async (req, _ctx, session) => {
  const sp = req.nextUrl.searchParams;
  const page = parsePageParam(sp);
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
  // Prisma `contains` → ILIKE with no ESCAPE clause; strip wildcard
  // metacharacters and bound the length (search-box DoS, matches /api/votes).
  const q = sanitizeContainsSearch((sp.get("q") ?? "").trim());

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
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  const requestCtx = await loadRequestContext(session.user.id);
  const { settings, userRecord } = requestCtx;

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

  // typeof-guard BEFORE verifyRequestToken: readJsonCapped<T>'s generic is a
  // compile-time cast only, so a truthy non-string (`123`, `{}`) slipped past the
  // old `!_token` check and threw ERR_INVALID_ARG_TYPE out of Buffer.from(a, "hex")
  // as a 500 instead of this 403. Empty string is non-verifying and still 403s.
  if (typeof _token !== "string" || !verifyRequestToken(_token, tmdbId, mediaType, session.user.id)) {
    return NextResponse.json({ error: "Invalid or expired request token" }, { status: 403 });
  }

  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }

  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType must be MOVIE or TV" }, { status: 400 });
  }

  // Everything from instance resolution to the admin fan-out lives in the shared
  // request chokepoint (src/lib/request-create.ts) — the watchlist auto-request
  // files through the same function. This route only maps its result onto the
  // HTTP responses it has always given.
  const result = await createMediaRequest(session, requestCtx, {
    tmdbId,
    mediaType,
    note,
    is4k: body.is4k,
    arrInstance: body.arrInstance,
    qualityProfileId: body.qualityProfileId,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  if (result.kind === "already-available") {
    return NextResponse.json({ alreadyAvailable: true, tmdbId, mediaType, title: result.title }, { status: 200 });
  }
  return NextResponse.json(result.request, { status: 201 });
});
