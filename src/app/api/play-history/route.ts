import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN" || isTokenExpired(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;

  const distinctMode = params.get("distinct");
  if (distinctMode === "platforms") {
    const rows = await prisma.$queryRawUnsafe<{ platform: string }[]>(
      `SELECT DISTINCT "platform" FROM "PlayHistory" WHERE "platform" IS NOT NULL ORDER BY "platform"`,
    );
    return NextResponse.json(rows.map((r) => r.platform));
  }
  if (distinctMode === "users") {
    const rows = await prisma.mediaServerUser.findMany({
      select: { id: true, username: true, source: true },
      orderBy: { username: "asc" },
    });
    return NextResponse.json(rows);
  }

  const page = Math.min(Math.max(1, parseInt(params.get("page") ?? "1", 10) || 1), 10_000);
  const limit = Math.min(100, Math.max(1, parseInt(params.get("limit") ?? "20", 10) || 20));
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  const source = params.get("source");
  if (source === "plex" || source === "jellyfin") where.source = source;

  const tmdbIdRaw = params.get("tmdbId");
  if (tmdbIdRaw) {
    const tmdbId = parseInt(tmdbIdRaw, 10);
    if (!isNaN(tmdbId)) where.tmdbId = tmdbId;
  }

  const mediaType = params.get("mediaType");
  if (mediaType === "MOVIE" || mediaType === "TV") where.mediaType = mediaType;

  const watched = params.get("watched");
  if (watched === "true") where.watched = true;
  else if (watched === "false") where.watched = false;

  const userId = params.get("userId");
  if (userId) where.mediaServerUserId = userId;

  const playMethod = params.get("playMethod");
  if (playMethod && ["DirectPlay", "DirectStream", "Transcode"].includes(playMethod)) {
    where.playMethod = playMethod;
  }

  const platform = params.get("platform");
  if (platform) where.platform = platform;

  const startDate = params.get("startDate");
  const endDate = params.get("endDate");
  if (startDate || endDate) {
    where.startedAt = {
      ...(startDate ? { gte: new Date(startDate) } : {}),
      ...(endDate ? { lte: new Date(endDate) } : {}),
    };
  }

  const search = params.get("search")?.trim();
  if (search) {
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { mediaServerUser: { username: { contains: search, mode: "insensitive" } } },
    ];
  }

  const SORTABLE_FIELDS = new Set(["startedAt", "title", "playDuration", "duration", "source", "platform"]);
  const sortBy = params.get("sortBy");
  const sortDir = params.get("sortDir") === "asc" ? "asc" : "desc";
  const orderBy: Record<string, string> = SORTABLE_FIELDS.has(sortBy ?? "")
    ? { [sortBy!]: sortDir }
    : { startedAt: "desc" };

  const [items, total] = await Promise.all([
    prisma.playHistory.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      include: {
        mediaServerUser: {
          select: { username: true, source: true, thumbUrl: true, user: { select: { name: true } } },
        },
      },
    }),
    prisma.playHistory.count({ where }),
  ]);

  return NextResponse.json({
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
}
