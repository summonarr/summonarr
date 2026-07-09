import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { sanitizeOptional } from "@/lib/sanitize";

const PAGE_SIZE = 60;
const SELECT = { tmdbId: true, mediaType: true, title: true, posterPath: true, createdAt: true } as const;

// GET — the caller's own "not interested" list (newest first).
export const GET = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`hidden-list:${session.user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const sp = req.nextUrl.searchParams;
  const page = Math.min(Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1), 10_000);

  const where: Prisma.HiddenItemWhereInput = { userId: session.user.id };
  const [items, total] = await Promise.all([
    prisma.hiddenItem.findMany({
      where,
      select: SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.hiddenItem.count({ where }),
  ]);

  return NextResponse.json({ items, total, page, pageSize: PAGE_SIZE });
});

// POST — hide { tmdbId, mediaType }. title/posterPath are optional (the card/detail
// already has them); we do NOT verify against TMDB so a "not interested" tap is
// instant and never fails on an upstream outage.
export const POST = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`hidden:${session.user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  const parsed = await readJsonCapped<{ tmdbId?: number; mediaType?: string; title?: string; posterPath?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const { tmdbId, mediaType } = parsed;

  if (!tmdbId || !mediaType) {
    return NextResponse.json({ error: "tmdbId and mediaType are required" }, { status: 400 });
  }
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType must be MOVIE or TV" }, { status: 400 });
  }

  const title = (sanitizeOptional(parsed.title) ?? "").slice(0, 500);
  const posterPath =
    typeof parsed.posterPath === "string" && parsed.posterPath.length > 0 && parsed.posterPath.length <= 500
      ? parsed.posterPath
      : null;

  try {
    const item = await prisma.hiddenItem.create({
      data: { tmdbId, mediaType, title, posterPath, userId: session.user.id },
      select: SELECT,
    });
    return NextResponse.json(item, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "Already hidden" }, { status: 409 });
    }
    throw err;
  }
});

// DELETE — un-hide ?tmdbId=&mediaType=. deleteMany so a missing row is an
// idempotent no-op success (toggle-off).
export const DELETE = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`hidden-del:${session.user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const sp = req.nextUrl.searchParams;
  const tmdbId = Number(sp.get("tmdbId"));
  const mediaType = sp.get("mediaType");
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType must be MOVIE or TV" }, { status: 400 });
  }

  await prisma.hiddenItem.deleteMany({ where: { userId: session.user.id, tmdbId, mediaType } });
  return NextResponse.json({ ok: true });
});
