import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { auditActor, logAudit } from "@/lib/audit";
import { sanitizeOptional } from "@/lib/sanitize";
import { cleanupDisabledResponse } from "@/lib/library-cleanup-gate";
import { isTmdbIdInRange } from "@/lib/tmdb-id";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { invalidateNeverWatchedReport } from "@/lib/never-watched-report";

// Per-title "never a cleanup candidate" pins (ADMIN).
//   POST   → protect   { tmdbId, mediaType, title?, reason? } → 201 { item }.
//            Re-protecting updates only the fields sent; `addedBy` stays the
//            admin who protected it first.
//   DELETE → unprotect ?tmdbId=&mediaType=  (query params — DELETE bodies are
//            stripped by some proxies, same as the blacklist route)

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const off = await cleanupDisabledResponse(t);
  if (off) return off;
  const parsed = await readJsonCapped<{ tmdbId?: unknown; mediaType?: unknown; title?: unknown; reason?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const { tmdbId, mediaType, title, reason } = parsed;
  if (typeof tmdbId !== "number" || !isTmdbIdInRange(tmdbId)) {
    return NextResponse.json({ error: t("apiAdmin.common.tmdbIdPositive") }, { status: 400 });
  }
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: t("apiAdmin.common.mediaTypeMovieOrTv") }, { status: 400 });
  }
  if (title !== undefined && (typeof title !== "string" || title.length > 500)) {
    return NextResponse.json({ error: t("apiAdmin.common.titleTooLong") }, { status: 400 });
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
    return NextResponse.json({ error: t("apiAdmin.common.reasonTooLong") }, { status: 400 });
  }
  // A title already protected keeps who protected it and anything this call
  // doesn't send: the never-watched page re-protects with the title alone, and
  // must not wipe a reason given elsewhere. Still 201 either way (the answer
  // the pages and the spec know).
  const sent = {
    ...(title !== undefined ? { title: sanitizeOptional(title) ?? null } : {}),
    ...(reason !== undefined ? { reason: sanitizeOptional(reason) ?? null } : {}),
  };
  const item = await prisma.cleanupProtection.upsert({
    where: { tmdbId_mediaType: { tmdbId, mediaType } },
    create: { tmdbId, mediaType, title: null, reason: null, ...sent, addedBy: session.user.id },
    update: sent,
  });
  invalidateNeverWatchedReport();
  void logAudit({
    ...auditActor(req, session),
    action: "LIBRARY_CLEANUP_PROTECT",
    target: `cleanup:${mediaType}:${tmdbId}`,
    details: { op: "add", title: item.title, reason: item.reason },
  });
  return NextResponse.json({ item }, { status: 201 });
});

export const DELETE = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const off = await cleanupDisabledResponse(t);
  if (off) return off;
  const sp = req.nextUrl.searchParams;
  const tmdbId = Number(sp.get("tmdbId"));
  const mediaType = sp.get("mediaType");
  if (!isTmdbIdInRange(tmdbId) || (mediaType !== "MOVIE" && mediaType !== "TV")) {
    return NextResponse.json({ error: t("apiAdmin.common.tmdbIdAndMediaTypeRequired") }, { status: 400 });
  }
  const removed = await prisma.cleanupProtection.deleteMany({ where: { tmdbId, mediaType } });
  if (removed.count > 0) {
    invalidateNeverWatchedReport();
    void logAudit({
      ...auditActor(req, session),
      action: "LIBRARY_CLEANUP_PROTECT",
      target: `cleanup:${mediaType}:${tmdbId}`,
      details: { op: "remove" },
    });
  }
  return NextResponse.json({ ok: true, removed: removed.count });
});
