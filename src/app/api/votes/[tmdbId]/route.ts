import { NextResponse } from "next/server";
import { withAuth, withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit, auditContext } from "@/lib/audit";
import { maintenanceGuard } from "@/lib/maintenance";
import { isFeatureEnabled } from "@/lib/features";

export const DELETE = withAuth(async (
  req,
  { params }: { params: Promise<{ tmdbId: string }> },
  session
) => {
  if (!(await isFeatureEnabled("feature.page.votes"))) {
    return NextResponse.json({ error: "Deletion voting is disabled" }, { status: 403 });
  }

  const maint = await maintenanceGuard();
  if (maint) return maint;

  const { tmdbId: rawId } = await params;
  const tmdbId = parseInt(rawId, 10);
  if (isNaN(tmdbId)) return NextResponse.json({ error: "Invalid tmdbId" }, { status: 400 });

  const mediaType = req.nextUrl.searchParams.get("mediaType");
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType query param must be MOVIE or TV" }, { status: 400 });
  }

  // Re-arm the one-shot threshold-notify gate if removing this vote drops the tally
  // below the threshold. The notify path (votes POST) creates the
  // `deletionVoteNotified:` Setting key and swallows the duplicate-key error, so a
  // stale key left behind here would silently suppress a future genuine re-crossing.
  // Mirrors the admin dismiss (PATCH below), which clears the key in the same tx.
  const deleted = await prisma.$transaction(async (tx) => {
    const removed = await tx.deletionVote.deleteMany({
      where: { tmdbId, mediaType, userId: session.user.id },
    });
    if (removed.count > 0) {
      const thresholdRow = await tx.setting.findUnique({ where: { key: "deletionVoteThreshold" } });
      const threshold = parseInt(thresholdRow?.value ?? "0", 10);
      if (threshold > 0) {
        const remaining = await tx.deletionVote.count({ where: { tmdbId, mediaType } });
        if (remaining < threshold) {
          await tx.setting.deleteMany({ where: { key: `deletionVoteNotified:${tmdbId}:${mediaType}` } });
        }
      }
    }
    return removed;
  });

  if (deleted.count === 0) {
    return NextResponse.json({ error: "Vote not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
});

export const PATCH = withAdmin(async (
  req,
  { params }: { params: Promise<{ tmdbId: string }> },
  session
) => {
  const maint = await maintenanceGuard();
  if (maint) return maint;

  if (!checkRateLimit(`votes-dismiss:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "Too many dismiss operations — try again later" }, { status: 429 });
  }

  const { tmdbId: rawId } = await params;
  const tmdbId = parseInt(rawId, 10);
  if (isNaN(tmdbId)) return NextResponse.json({ error: "Invalid tmdbId" }, { status: 400 });

  const mediaType = req.nextUrl.searchParams.get("mediaType");
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType query param must be MOVIE or TV" }, { status: 400 });
  }

  // Wrap delete + Setting cleanup in a single transaction so a "notified" flag never
  // outlives the votes it referenced. The Setting key may not exist (notification
  // never fired), so the delete uses deleteMany — which is null-safe by design.
  const settingKey = `deletionVoteNotified:${tmdbId}:${mediaType}`;
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
