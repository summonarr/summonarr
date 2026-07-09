import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { logAudit, auditContext } from "@/lib/audit";
import { sanitizeOptional } from "@/lib/sanitize";
import { invalidateBlacklistCache } from "@/lib/blacklist";

// Admin-managed request blacklist. A blacklisted (tmdbId, mediaType) pair is
// hidden from discovery (attachAllAvailability's default filter) and rejected at
// the request chokepoint (POST /api/requests + /api/requests/bulk). ADMIN-only.
//   GET    → list (newest first)
//   POST   → add/update  { tmdbId, mediaType, title?, reason? }
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
  const parsed = await readJsonCapped<{
    tmdbId?: number;
    mediaType?: string;
    title?: string;
    reason?: string;
  }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const { tmdbId, mediaType, title, reason } = parsed;

  if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType must be MOVIE or TV" }, { status: 400 });
  }
  if (title !== undefined && (typeof title !== "string" || title.length > 500)) {
    return NextResponse.json({ error: "title must be a string under 500 characters" }, { status: 400 });
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
    return NextResponse.json({ error: "reason must be a string under 500 characters" }, { status: 400 });
  }

  const item = await prisma.blacklistItem.upsert({
    where: { tmdbId_mediaType: { tmdbId, mediaType } },
    create: { tmdbId, mediaType, title: sanitizeOptional(title) ?? null, reason: sanitizeOptional(reason) ?? null, addedBy: session.user.id },
    update: { title: sanitizeOptional(title) ?? null, reason: sanitizeOptional(reason) ?? null, addedBy: session.user.id },
  });
  invalidateBlacklistCache();
  // Post-commit, non-transactional mutation ⇒ swallowing logAudit (guardrail 26).
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "BLACKLIST_CHANGE",
    target: `blacklist:${mediaType}:${tmdbId}`,
    details: { op: "add", title: item.title, reason: item.reason },
    ...auditContext(req, session),
  });
  return NextResponse.json({ item }, { status: 201 });
});

export const DELETE = withAdmin(async (req, _ctx, session) => {
  const sp = req.nextUrl.searchParams;
  const tmdbId = Number(sp.get("tmdbId"));
  const mediaType = sp.get("mediaType");
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || (mediaType !== "MOVIE" && mediaType !== "TV")) {
    return NextResponse.json({ error: "tmdbId and mediaType are required" }, { status: 400 });
  }
  const deleted = await prisma.blacklistItem.deleteMany({ where: { tmdbId, mediaType } });
  invalidateBlacklistCache();
  if (deleted.count > 0) {
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email,
      action: "BLACKLIST_CHANGE",
      target: `blacklist:${mediaType}:${tmdbId}`,
      details: { op: "remove" },
      ...auditContext(req, session),
    });
  }
  return NextResponse.json({ ok: true, removed: deleted.count });
});
