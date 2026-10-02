import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { logAudit, auditContext } from "@/lib/audit";
import { sanitizeOptional } from "@/lib/sanitize";
import { isFeatureEnabled } from "@/lib/features";
import { CLEANUP_FEATURE_KEY } from "@/lib/library-cleanup-data";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";

// Per-title "never a cleanup candidate" pins (ADMIN).
//   POST   → protect   { tmdbId, mediaType, title?, reason? }
//   DELETE → unprotect ?tmdbId=&mediaType=  (query params — DELETE bodies are
//            stripped by some proxies, same as the blacklist route)

async function disabled(t: Translator): Promise<NextResponse | null> {
  return (await isFeatureEnabled(CLEANUP_FEATURE_KEY))
    ? null
    : NextResponse.json({ error: t("apiAdmin.cleanup.disabled") }, { status: 404 });
}

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const off = await disabled(t);
  if (off) return off;
  const parsed = await readJsonCapped<{ tmdbId?: unknown; mediaType?: unknown; title?: unknown; reason?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const { tmdbId, mediaType, title, reason } = parsed;
  if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId <= 0) {
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
  const data = {
    title: sanitizeOptional(title as string | undefined) ?? null,
    reason: sanitizeOptional(reason as string | undefined) ?? null,
    addedBy: session.user.id,
  };
  const item = await prisma.cleanupProtection.upsert({
    where: { tmdbId_mediaType: { tmdbId, mediaType } },
    create: { tmdbId, mediaType, ...data },
    update: data,
  });
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "LIBRARY_CLEANUP_PROTECT",
    target: `cleanup:${mediaType}:${tmdbId}`,
    details: { op: "add", title: item.title, reason: item.reason },
    ...auditContext(req, session),
  });
  return NextResponse.json({ item }, { status: 201 });
});

export const DELETE = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const off = await disabled(t);
  if (off) return off;
  const sp = req.nextUrl.searchParams;
  const tmdbId = Number(sp.get("tmdbId"));
  const mediaType = sp.get("mediaType");
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || (mediaType !== "MOVIE" && mediaType !== "TV")) {
    return NextResponse.json({ error: t("apiAdmin.common.tmdbIdAndMediaTypeRequired") }, { status: 400 });
  }
  const removed = await prisma.cleanupProtection.deleteMany({ where: { tmdbId, mediaType } });
  if (removed.count > 0) {
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email,
      action: "LIBRARY_CLEANUP_PROTECT",
      target: `cleanup:${mediaType}:${tmdbId}`,
      details: { op: "remove" },
      ...auditContext(req, session),
    });
  }
  return NextResponse.json({ ok: true, removed: removed.count });
});
