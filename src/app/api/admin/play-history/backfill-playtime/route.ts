import { NextResponse } from "next/server";
import { readJsonCappedOr } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { getWatchedThreshold, clearActivityCache } from "@/lib/play-history";

// One-shot backfill for PlayHistory rows written before ActiveSession.playtimeMs landed.
// Pre-fix `playDuration` stored the playhead position at session end (so a scrub-to-credits
// looked like a full watch); post-fix it stores accumulated wall-clock "playing" seconds.
//
// Clamp: a session can't play longer than (stoppedAt - startedAt). LEAST(playDuration, wallClock)
// collapses scrub-to-end inflation; `watched` and `pausedDuration` recompute from the clamped value.
//
// Default = dry run (counts + a five-row sample); `?execute=true` applies. Idempotent — the WHERE
// clause excludes rows that don't need clamping, so re-runs are a no-op.

export const POST = withAdmin(async (req, _ctx, session) => {
  const execute = req.nextUrl.searchParams.get("execute") === "true";
  const threshold = await getWatchedThreshold();

  // Parse confirmation body for the execute path. The admin must echo the
  // candidate-row count from a prior dry-run; this both proves they saw the
  // dry-run output (reducing accidental destructive double-clicks) and
  // defends against a CSRF-style request that doesn't know the live count.
  // The dry-run path ignores the body.
  let confirmAffected: number | null = null;
  if (execute) {
    const body = await readJsonCappedOr<{ confirmAffectedRows?: number }>(req, 8192, {});
    if (body instanceof NextResponse) return body;
    if (typeof body?.confirmAffectedRows === "number") {
      confirmAffected = body.confirmAffectedRows;
    }
  }

  const [counts, sample] = await Promise.all([
    prisma.$queryRawUnsafe<{
      total_rows: bigint;
      candidate_rows: bigint;
      watched_flips: bigint;
    }[]>(
      `SELECT
         (SELECT COUNT(*)::bigint FROM "PlayHistory") AS total_rows,
         COUNT(*)::bigint AS candidate_rows,
         COUNT(*) FILTER (
           WHERE watched = true
             AND duration > 0
             AND (LEAST("playDuration", EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int)::float / duration::float * 100) < $1
         )::bigint AS watched_flips
       FROM "PlayHistory"
       WHERE "playDuration" > EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int
         AND "stoppedAt" > "startedAt"`,
      threshold,
    ),
    prisma.$queryRawUnsafe<{
      id: string;
      title: string;
      duration: number;
      play_duration_old: number;
      play_duration_new: number;
      watched_old: boolean;
      watched_new: boolean;
    }[]>(
      `SELECT
         id,
         title,
         duration,
         "playDuration" AS play_duration_old,
         LEAST("playDuration", EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int) AS play_duration_new,
         watched AS watched_old,
         (
           CASE
             WHEN duration > 0
             THEN (LEAST("playDuration", EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int)::float / duration::float * 100) >= $1
             ELSE false
           END
         ) AS watched_new
       FROM "PlayHistory"
       WHERE "playDuration" > EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int
         AND "stoppedAt" > "startedAt"
       ORDER BY "startedAt" DESC
       LIMIT 5`,
      threshold,
    ),
  ]);

  const totalRows = Number(counts[0]?.total_rows ?? 0);
  const affectedRows = Number(counts[0]?.candidate_rows ?? 0);
  const watchedFlippedToFalse = Number(counts[0]?.watched_flips ?? 0);

  const sampleSerialized = sample.map((c) => ({
    id: c.id,
    title: c.title,
    duration: Number(c.duration),
    playDurationOld: Number(c.play_duration_old),
    playDurationNew: Number(c.play_duration_new),
    watchedOld: c.watched_old,
    watchedNew: c.watched_new,
  }));

  if (!execute) {
    return NextResponse.json({
      dryRun: true,
      threshold,
      totalRows,
      affectedRows,
      watchedFlippedToFalse,
      sample: sampleSerialized,
      hint: `Re-POST with ?execute=true and body {"confirmAffectedRows": ${affectedRows}} to apply.`,
    });
  }

  // Confirmation gate. Match exactly against the live candidate count so an
  // execute call made before the operator saw the dry-run output (or after
  // the data shifted underneath it) fails closed.
  if (confirmAffected === null || confirmAffected !== affectedRows) {
    return NextResponse.json(
      {
        error: "Confirmation required",
        hint: `POST {"confirmAffectedRows": ${affectedRows}} to confirm.`,
        affectedRows,
      },
      { status: 409 },
    );
  }

  const updated = await prisma.$executeRawUnsafe(
    `UPDATE "PlayHistory" SET
       "playDuration" = LEAST("playDuration", EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int),
       "pausedDuration" = GREATEST(
         0,
         EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int
           - LEAST("playDuration", EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int)
       ),
       "watched" = CASE
         WHEN duration > 0
         THEN (LEAST("playDuration", EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int)::float / duration::float * 100) >= $1
         ELSE false
       END
     WHERE "playDuration" > EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int
       AND "stoppedAt" > "startedAt"`,
    threshold,
  );

  // Backfill already executed; a failed audit write must not 500 it (GR26).
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "PLAY_HISTORY_BACKFILL",
    target: "PlayHistory",
    details: { updated, threshold, watchedFlippedToFalse },
    ...auditContext(req, session),
  });

  // Activity stats are cached up to 30 minutes — drop them so the new numbers show immediately.
  clearActivityCache();

  return NextResponse.json({
    dryRun: false,
    threshold,
    updated,
    watchedFlippedToFalse,
  });
});
