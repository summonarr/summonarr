import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { auditActor, logAudit } from "@/lib/audit";
import { sanitizeOptional } from "@/lib/sanitize";
import { invalidateBlacklistCache } from "@/lib/blacklist";
import { parseTitleKeyBody, parseTitleKeyQuery } from "@/lib/title-key-input";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin-managed request blacklist. A blacklisted (tmdbId, mediaType) pair is
// hidden from discovery (attachAllAvailability's default filter) and rejected at
// the request chokepoint (POST /api/requests + /api/requests/bulk). ADMIN-only.
//   GET    → list (newest first)
//   POST   → add/update  { tmdbId, mediaType, title?, reason? } → 201 { item, created }
//   DELETE → remove      ?tmdbId=&mediaType=  (query params — DELETE bodies are
//            stripped by some proxies)

export const GET = withAdmin(async () => {
  const items = await prisma.blacklistItem.findMany({
    orderBy: { createdAt: "desc" },
    take: 1000,
  });
  return NextResponse.json({ items });
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<{ tmdbId?: unknown; mediaType?: unknown; title?: unknown; reason?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const input = parseTitleKeyBody(parsed, t);
  if (input instanceof NextResponse) return input;
  const { tmdbId, mediaType, title, reason } = input;

  // Whether this POST adds a title or rewrites one already blocked: the manager's
  // count goes up only for a new row (it loads at most 1000 rows, so it can't tell
  // on its own). Read before the upsert; two racing POSTs for one new title can
  // both say `created` — only the count is off then, never the row.
  const existing = await prisma.blacklistItem.findUnique({
    where: { tmdbId_mediaType: { tmdbId, mediaType } },
    select: { tmdbId: true },
  });
  const item = await prisma.blacklistItem.upsert({
    where: { tmdbId_mediaType: { tmdbId, mediaType } },
    create: { tmdbId, mediaType, title: sanitizeOptional(title) ?? null, reason: sanitizeOptional(reason) ?? null, addedBy: session.user.id },
    // Only the fields the request carried: re-adding a blocked title without a
    // reason must not erase the one stored (an explicit "" still clears it).
    update: {
      ...(title !== undefined && { title: sanitizeOptional(title) ?? null }),
      ...(reason !== undefined && { reason: sanitizeOptional(reason) ?? null }),
      addedBy: session.user.id,
    },
  });
  invalidateBlacklistCache();
  // Post-commit, non-transactional mutation ⇒ swallowing logAudit (guardrail 26).
  void logAudit({
    ...auditActor(req, session),
    action: "BLACKLIST_CHANGE",
    target: `blacklist:${mediaType}:${tmdbId}`,
    details: { op: "add", title: item.title, reason: item.reason },
  });
  // Additive: `created` is false when the title was already blocked.
  return NextResponse.json({ item, created: existing === null }, { status: 201 });
});

export const DELETE = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const key = parseTitleKeyQuery(req.nextUrl.searchParams, t);
  if (key instanceof NextResponse) return key;
  const { tmdbId, mediaType } = key;
  const deleted = await prisma.blacklistItem.deleteMany({ where: { tmdbId, mediaType } });
  invalidateBlacklistCache();
  if (deleted.count > 0) {
    void logAudit({
      ...auditActor(req, session),
      action: "BLACKLIST_CHANGE",
      target: `blacklist:${mediaType}:${tmdbId}`,
      details: { op: "remove" },
    });
  }
  return NextResponse.json({ ok: true, removed: deleted.count });
});
