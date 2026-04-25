import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAuditOrFail, auditContext } from "@/lib/audit";
import { getWatchedThreshold, clearActivityCache } from "@/lib/play-history";

// One-shot backfill for PlayHistory rows written before ActiveSession.playtimeMs landed.
//
// Pre-fix `playDuration` stored the playhead position at session end — so a user who scrubbed
// to the credits looked like they watched the whole runtime. Post-fix it stores accumulated
// wall-clock seconds in the "playing" state.
//
// Best-effort clamp: a session physically cannot have played longer than (stoppedAt - startedAt).
// LEAST(playDuration, wallClock) collapses scrub-to-end inflation while leaving correctly-
// tracked rows untouched. `watched` and `pausedDuration` are recomputed from the clamped value.
//
// Default = dry run (returns counts + a five-row sample). Pass `?execute=true` to apply.
// Idempotent — the WHERE clause excludes rows that don't need clamping, so re-runs are a no-op.

export async function POST(req: NextRequest) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  const execute = req.nextUrl.searchParams.get("execute") === "true";
  const threshold = await getWatchedThreshold();

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
      hint: "Re-POST with ?execute=true to apply.",
    });
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

  try {
    await logAuditOrFail({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email,
      action: "PLAY_HISTORY_BACKFILL",
      target: "PlayHistory",
      details: { updated, threshold, watchedFlippedToFalse },
      ...auditContext(req, session),
    });
  } catch (err) {
    console.error("[audit] Critical audit log failed:", err);
    return NextResponse.json({ error: "Audit logging failed" }, { status: 500 });
  }

  // Activity stats are cached up to 30 minutes — drop them so the new numbers show immediately.
  clearActivityCache();

  return NextResponse.json({
    dryRun: false,
    threshold,
    updated,
    watchedFlippedToFalse,
  });
}
