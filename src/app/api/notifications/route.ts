import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCappedOr } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";

const LIMIT = 30;

// GET — the caller's recent in-app notifications (newest first) + unread count.
export const GET = withAuth(async (_req, _ctx, session) => {
  if (!checkRateLimit(`notifications:${session.user.id}`, 120, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: session.user.id },
      select: { id: true, type: true, title: true, body: true, tmdbId: true, mediaType: true, posterPath: true, readAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
    }),
    prisma.notification.count({ where: { userId: session.user.id, readAt: null } }),
  ]);
  return NextResponse.json({ items, unreadCount });
});

// POST — mark notifications read. Body { ids?: string[] } marks those; an empty
// body marks ALL of the caller's unread. Returns the new unread count.
export const POST = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`notifications-read:${session.user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
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
