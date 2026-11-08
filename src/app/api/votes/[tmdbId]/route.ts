import { NextResponse } from "next/server";
import { withAuth, withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { logAudit, auditContext } from "@/lib/audit";
import { maintenanceGuard } from "@/lib/maintenance";
import { isFeatureEnabled } from "@/lib/features";
import { deletionVoteMarkerKey } from "@/lib/deletion-vote-keys";
import { parseVoteTitleParams, readDeletionVoteThreshold } from "@/lib/deletion-vote-threshold";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";

export const DELETE = withAuth(async (
  req,
  { params }: { params: Promise<{ tmdbId: string }> },
  session
) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled("feature.page.votes"))) {
    return NextResponse.json({ error: t("apiUser.votes.disabled") }, { status: 403 });
  }

  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  // Per-user bound like every sibling mutation (votes POST, hidden/watchlist
  // DELETE): un-vote is a three-statement transaction with no other cap.
  if (!checkRateLimit(`votes-del:${session.user.id}`, 60, 60_000)) {
    return tooManyRequests(60, t("apiUser.common.tooManyRequestsLater"));
  }

  const title = parseVoteTitleParams((await params).tmdbId, req.nextUrl.searchParams);
  if (!title.ok) return badTitleParams(title.error, t);
  const { tmdbId, mediaType } = title;

  // Re-arm the one-shot threshold alert if removing this vote drops the tally
  // below the threshold. The notify path (votes POST) only alerts when it is the
  // first to create the `deletionVoteNotified:` Setting key, so a stale key left
  // behind here would silently block the alert the next time the title crosses
  // the threshold. The admin dismiss (PATCH below) clears the key the same way.
  const deleted = await prisma.$transaction(async (tx) => {
    const removed = await tx.deletionVote.deleteMany({
      where: { tmdbId, mediaType, userId: session.user.id },
    });
    if (removed.count > 0) {
      const threshold = await readDeletionVoteThreshold(tx);
      if (threshold > 0) {
        const remaining = await tx.deletionVote.count({ where: { tmdbId, mediaType } });
        if (remaining < threshold) {
          await tx.setting.deleteMany({ where: { key: deletionVoteMarkerKey(tmdbId, mediaType) } });
        }
      }
    }
    return removed;
  });

  if (deleted.count === 0) {
    return NextResponse.json({ error: t("apiUser.votes.notFound") }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
});

export const PATCH = withAdmin(async (
  req,
  { params }: { params: Promise<{ tmdbId: string }> },
  session
) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  if (!checkRateLimit(`votes-dismiss:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: t("apiUser.votes.dismissRateLimited") }, { status: 429 });
  }

  const title = parseVoteTitleParams((await params).tmdbId, req.nextUrl.searchParams);
  if (!title.ok) return badTitleParams(title.error, t);
  const { tmdbId, mediaType } = title;

  // Wrap delete + Setting cleanup in a single transaction so a "notified" flag never
  // outlives the votes it referenced. The Setting key may not exist (notification
  // never fired), so the delete uses deleteMany — which is null-safe by design.
  const settingKey = deletionVoteMarkerKey(tmdbId, mediaType);
  const [deleted] = await prisma.$transaction([
    prisma.deletionVote.deleteMany({ where: { tmdbId, mediaType } }),
    prisma.setting.deleteMany({ where: { key: settingKey } }),
  ]);

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "VOTE_DISMISS_ALL",
    target: `tmdb:${tmdbId}:${mediaType}`,
    details: { dismissedCount: deleted.count, mediaType, tmdbId },
    ...auditContext(req, session),
  });

  return NextResponse.json({ ok: true, dismissed: deleted.count });
});

// The 400 for a /api/votes/[tmdbId] call naming no valid title.
function badTitleParams(error: "tmdbId" | "mediaType", t: Translator): NextResponse {
  return NextResponse.json(
    { error: t(error === "tmdbId" ? "apiUser.votes.invalidTmdbId" : "apiUser.votes.mediaTypeQueryInvalid") },
    { status: 400 },
  );
}
