import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCappedOr } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";

const PAGE_SIZE = 30;
const SELECT = { id: true, type: true, title: true, body: true, tmdbId: true, mediaType: true, posterPath: true, readAt: true, createdAt: true } as const;

// GET — the caller's in-app notifications (newest first), paginated, + unread and
// total counts. The bell reads page 1; the /notifications page walks all pages.
export const GET = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`notifications:${session.user.id}`, 120, 60_000)) {
    return tooManyRequests(60);
  }
  const page = Math.min(Math.max(1, parseInt(req.nextUrl.searchParams.get("page") ?? "1", 10) || 1), 10_000);
  const [items, unreadCount, total] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: session.user.id },
      select: SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.notification.count({ where: { userId: session.user.id, readAt: null } }),
    prisma.notification.count({ where: { userId: session.user.id } }),
  ]);
  return NextResponse.json({ items, unreadCount, total, page, pageSize: PAGE_SIZE });
});

// POST — mark notifications read. Body { ids?: string[] } marks those; an empty
// body marks ALL of the caller's unread. Returns the new unread count.
export const POST = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`notifications-read:${session.user.id}`, 60, 60_000)) {
    return tooManyRequests(60);
  }
  const parsed = await readJsonCappedOr<{ ids?: unknown }>(req, 16384, {});
  if (parsed instanceof NextResponse) return parsed;
  const ids = Array.isArray(parsed.ids)
    ? parsed.ids.filter((x): x is string => typeof x === "string").slice(0, 500)
    : null;

  await prisma.notification.updateMany({
    where: { userId: session.user.id, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
    data: { readAt: new Date() },
  });
  const unreadCount = await prisma.notification.count({ where: { userId: session.user.id, readAt: null } });
  return NextResponse.json({ ok: true, unreadCount });
});

// DELETE — remove notifications. Body { ids?: string[] } deletes those; an empty
// body clears ALL of the caller's notifications. Returns the new unread count.
export const DELETE = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`notifications-del:${session.user.id}`, 60, 60_000)) {
    return tooManyRequests(60);
  }
  const parsed = await readJsonCappedOr<{ ids?: unknown }>(req, 16384, {});
  if (parsed instanceof NextResponse) return parsed;
  const ids = Array.isArray(parsed.ids)
    ? parsed.ids.filter((x): x is string => typeof x === "string").slice(0, 500)
    : null;

  await prisma.notification.deleteMany({
    where: { userId: session.user.id, ...(ids ? { id: { in: ids } } : {}) },
  });
  const unreadCount = await prisma.notification.count({ where: { userId: session.user.id, readAt: null } });
  return NextResponse.json({ ok: true, unreadCount });
});
