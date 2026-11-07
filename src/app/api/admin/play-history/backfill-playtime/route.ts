import { NextResponse } from "next/server";
import { readJsonCappedOr } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { getWatchedThreshold, clearActivityCache } from "@/lib/play-history";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// One-shot backfill for PlayHistory rows written before ActiveSession.playtimeMs landed.
// Pre-fix `playDuration` stored the playhead position at session end (so a scrub-to-credits
// looked like a full watch); post-fix it stores accumulated wall-clock "playing" seconds.
//
// Clamp: a session can't play longer than (stoppedAt - startedAt). LEAST(playDuration, wallClock)
// collapses scrub-to-end inflation; `watched` and `pausedDuration` recompute from the clamped value.
//
// Default = dry run (counts + a five-row sample); `?execute=true` applies. Idempotent — the WHERE
// clause excludes rows that don't need clamping, so re-runs are a no-op.

// The session's wall-clock span, the ceiling a play can't exceed.
const WALL_CLOCK = `EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int`;
// The clamped playDuration — what the UPDATE writes and what the dry run previews.
const CLAMPED_PLAY = `LEAST("playDuration", ${WALL_CLOCK})`;
// The clamped play as a percentage of the runtime (callers guard duration > 0).
const CLAMPED_PCT = `(${CLAMPED_PLAY}::float / duration::float * 100)`;
// The rows that need clamping. ONE definition for the dry-run count, its sample
// and the UPDATE: the confirm gate compares the operator's echoed count with the
// live count, which only means something while both read the same rows (they
// drifted once — see the watched CASE below).
const CANDIDATE_WHERE = `"playDuration" > ${WALL_CLOCK}
       AND "stoppedAt" > "startedAt"`;

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
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

  const counts = await prisma.$queryRawUnsafe<{
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
           AND ${CLAMPED_PCT} < $1
       )::bigint AS watched_flips
     FROM "PlayHistory"
     WHERE ${CANDIDATE_WHERE}`,
    threshold,
  );

  const totalRows = Number(counts[0]?.total_rows ?? 0);
  const affectedRows = Number(counts[0]?.candidate_rows ?? 0);
  const watchedFlippedToFalse = Number(counts[0]?.watched_flips ?? 0);

  if (!execute) {
    // The preview sample is read on the dry run only; the execute path needs
    // just the live count for its confirmation gate.
    const sample = await prisma.$queryRawUnsafe<{
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
         ${CLAMPED_PLAY} AS play_duration_new,
         watched AS watched_old,
         (
           CASE
             WHEN duration > 0
             THEN ${CLAMPED_PCT} >= $1
             ELSE watched
           END
         ) AS watched_new
       FROM "PlayHistory"
       WHERE ${CANDIDATE_WHERE}
       ORDER BY "startedAt" DESC
       LIMIT 5`,
      threshold,
    );
    const sampleSerialized = sample.map((c) => ({
      id: c.id,
      title: c.title,
      duration: Number(c.duration),
      playDurationOld: Number(c.play_duration_old),
      playDurationNew: Number(c.play_duration_new),
      watchedOld: c.watched_old,
      watchedNew: c.watched_new,
    }));
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
        error: t("apiAdmin.backfillPlaytime.confirmationRequired"),
        // Protocol text, not prose — the exact body the operator must echo.
        hint: `POST {"confirmAffectedRows": ${affectedRows}} to confirm.`,
        affectedRows,
      },
      { status: 409 },
    );
  }

  // Static SQL fragments only (the constants above); the threshold stays bound.
  const updated = await prisma.$executeRawUnsafe(
    `UPDATE "PlayHistory" SET
       "playDuration" = ${CLAMPED_PLAY},
       "pausedDuration" = GREATEST(
         0,
         ${WALL_CLOCK}
           - ${CLAMPED_PLAY}
       ),
       "watched" = CASE
         WHEN duration > 0
         THEN ${CLAMPED_PCT} >= $1
         -- A row with no known runtime cannot be re-judged, so its flag is left as
         -- is: the dry-run's watched_flips FILTER requires duration > 0, and an
         -- ELSE false here flipped rows that count never saw, so the reported
         -- watchedFlippedToFalse under-stated what the write did.
         ELSE "watched"
       END
     WHERE ${CANDIDATE_WHERE}`,
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
