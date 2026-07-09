import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCappedOr } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";

const PAGE_SIZE = 30;
const SELECT = { id: true, type: true, title: true, body: true, tmdbId: true, mediaType: true, posterPath: true, readAt: true, createdAt: true } as const;

// GET — the caller's in-app notifications (newest first), + unread and total
// counts. Cursor-based (not offset): the list is live and client-mutated, so a
// `?page=N` skip would duplicate or skip rows as items arrive or are removed
// between pages. The cursor is `<createdAt-iso>|<id>` over the stable
// (createdAt desc, id desc) ordering; the response returns `nextCursor` (null
// when exhausted). The bell reads the first page (no cursor); the /notifications
// page walks pages by passing the last item's cursor.
export const GET = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`notifications:${session.user.id}`, 120, 60_000)) {
    return tooManyRequests(60);
  }
  // Parse an opaque `<createdAt-iso>|<id>` cursor into a keyset predicate. An
  // absent/malformed cursor fails soft to the first page.
  const cursorRaw = req.nextUrl.searchParams.get("cursor");
  let cursorWhere: object = {};
  if (cursorRaw) {
    const sep = cursorRaw.indexOf("|");
    if (sep > 0) {
      const at = new Date(cursorRaw.slice(0, sep));
      const id = cursorRaw.slice(sep + 1);
      if (id && !Number.isNaN(at.getTime())) {
        cursorWhere = {
          OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }],
        };
      }
    }
  }
  const [items, unreadCount, total] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: session.user.id, ...cursorWhere },
      select: SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE,
    }),
    prisma.notification.count({ where: { userId: session.user.id, readAt: null } }),
    prisma.notification.count({ where: { userId: session.user.id } }),
  ]);
  const last = items.length === PAGE_SIZE ? items[items.length - 1] : null;
  const nextCursor = last ? `${last.createdAt.toISOString()}|${last.id}` : null;
  return NextResponse.json({ items, unreadCount, total, nextCursor, pageSize: PAGE_SIZE });
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

// DELETE — remove notifications. Selection is via QUERY PARAMS (not the body):
//   ?ids=a,b,c  deletes those; ?all=1 clears ALL of the caller's notifications.
// DELETE bodies are stripped by some proxies/CDNs, which would silently turn a
// single-item delete into a full-inbox wipe — so clear-all must be an explicit
// `all=1` signal. A request with neither is a no-op 400, never a wipe. Matches
// the watchlist/hidden/blacklist DELETE convention. Returns the new unread count.
export const DELETE = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`notifications-del:${session.user.id}`, 60, 60_000)) {
    return tooManyRequests(60);
  }
  const sp = req.nextUrl.searchParams;
  const all = sp.get("all") === "1";
  const idsParam = sp.get("ids");
  const ids = idsParam
    ? idsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500)
    : [];
  if (!all && ids.length === 0) {
    return NextResponse.json({ error: "specify ?ids= or ?all=1" }, { status: 400 });
  }

  await prisma.notification.deleteMany({
    where: { userId: session.user.id, ...(all ? {} : { id: { in: ids } }) },
  });
  const unreadCount = await prisma.notification.count({ where: { userId: session.user.id, readAt: null } });
  return NextResponse.json({ ok: true, unreadCount });
});
