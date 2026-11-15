import { NextResponse } from "next/server";
import { readJsonCappedOr } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { getWatchedThreshold, clearActivityCache } from "@/lib/play-history";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { isPrismaErrorCode, txFailureKind } from "@/lib/prisma-errors";

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
  const t = translatorForRequest(req);
  const execute = req.nextUrl.searchParams.get("execute") === "true";
  const threshold = await getWatchedThreshold();

  // The dry run: the counts plus a five-row preview sample. It ignores the body.
  if (!execute) {
    const { counts, sample } = await readDryRun(threshold);
    return NextResponse.json({
      dryRun: true,
      threshold,
      totalRows: counts.totalRows,
      affectedRows: counts.affectedRows,
      watchedFlippedToFalse: counts.watchedFlippedToFalse,
      sample,
      hint: `Re-POST with ?execute=true and body {"confirmAffectedRows": ${counts.affectedRows}} to apply.`,
    });
  }

  // The admin must echo the candidate-row count from a prior dry run; this both
  // proves they saw the dry-run output (reducing accidental destructive
  // double-clicks) and defends against a CSRF-style request that doesn't know
  // the live count.
  const body = await readJsonCappedOr<{ confirmAffectedRows?: number }>(req, 8192, {});
  if (body instanceof NextResponse) return body;
  const confirmAffected = typeof body?.confirmAffectedRows === "number" ? body.confirmAffectedRows : null;

  const outcome = await executeBackfill(threshold, confirmAffected);
  if (outcome.kind === "unconfirmed") {
    return NextResponse.json(
      {
        error: t("apiAdmin.backfillPlaytime.confirmationRequired"),
        // Protocol text, not prose — the exact body the operator must echo.
        hint: `POST {"confirmAffectedRows": ${outcome.affectedRows}} to confirm.`,
        affectedRows: outcome.affectedRows,
      },
      { status: 409 },
    );
  }

  const { updated, watchedFlippedToFalse } = outcome;
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

// The session's wall-clock span, the ceiling a play can't exceed.
const WALL_CLOCK = `EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int`;
// The clamped playDuration — what the UPDATE writes and what the dry run previews.
const CLAMPED_PLAY = `LEAST("playDuration", ${WALL_CLOCK})`;
// The clamped play as a percentage of the runtime. Callers guard duration > 0
// with a CASE: AND operands have no guaranteed evaluation order in Postgres, so
// an AND guard would not stop a float division by zero.
const CLAMPED_PCT = `(${CLAMPED_PLAY}::float / duration::float * 100)`;
// The rows that need clamping. ONE definition for the dry-run count, its sample
// and the UPDATE: the confirm gate compares the operator's echoed count with the
// live count, which only means something while both read the same rows (they
// drifted once — see the watched CASE below).
const CANDIDATE_WHERE = `"playDuration" > ${WALL_CLOCK}
       AND "stoppedAt" > "startedAt"`;

const COUNT_SQL = `SELECT
       (SELECT COUNT(*)::bigint FROM "PlayHistory") AS total_rows,
       COUNT(*)::bigint AS candidate_rows,
       COUNT(*) FILTER (
         WHERE watched = true
           AND CASE WHEN duration > 0 THEN ${CLAMPED_PCT} < $1 ELSE false END
       )::bigint AS watched_flips
     FROM "PlayHistory"
     WHERE ${CANDIDATE_WHERE}`;

const SAMPLE_SQL = `SELECT
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
       LIMIT 5`;

// Static SQL fragments only (the constants above); the threshold stays bound.
const UPDATE_SQL = `UPDATE "PlayHistory" SET
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
     WHERE ${CANDIDATE_WHERE}`;

// The execute path's count and UPDATE run in one REPEATABLE READ transaction,
// so the confirmed count and the rows written are the same snapshot. The
// statement was unbounded before it moved into a transaction; Prisma's timeout
// only rolls a finished statement back, so this bounds a runaway, not the work.
const EXECUTE_TX_TIMEOUT_MS = 5 * 60 * 1000;

type RawRunner = Pick<typeof prisma, "$queryRawUnsafe">;

interface CandidateCounts {
  totalRows: number;
  affectedRows: number;
  watchedFlippedToFalse: number;
}

async function readCounts(db: RawRunner, threshold: number): Promise<CandidateCounts> {
  const counts = await db.$queryRawUnsafe<{
    total_rows: bigint;
    candidate_rows: bigint;
    watched_flips: bigint;
  }[]>(COUNT_SQL, threshold);
  return {
    totalRows: Number(counts[0]?.total_rows ?? 0),
    affectedRows: Number(counts[0]?.candidate_rows ?? 0),
    watchedFlippedToFalse: Number(counts[0]?.watched_flips ?? 0),
  };
}

// What the dry run reports: the counts and a five-row preview sample.
async function readDryRun(threshold: number) {
  const counts = await readCounts(prisma, threshold);
  const rows = await prisma.$queryRawUnsafe<{
    id: string;
    title: string;
    duration: number;
    play_duration_old: number;
    play_duration_new: number;
    watched_old: boolean;
    watched_new: boolean;
  }[]>(SAMPLE_SQL, threshold);
  const sample = rows.map((c) => ({
    id: c.id,
    title: c.title,
    duration: Number(c.duration),
    playDurationOld: Number(c.play_duration_old),
    playDurationNew: Number(c.play_duration_new),
    watchedOld: c.watched_old,
    watchedNew: c.watched_new,
  }));
  return { counts, sample };
}

type ExecuteOutcome =
  | { kind: "applied"; updated: number; watchedFlippedToFalse: number }
  | { kind: "unconfirmed"; affectedRows: number };

// Thrown inside the transaction to roll the UPDATE back when it wrote a
// different number of rows than the operator confirmed.
class CountMismatchError extends Error {
  readonly affectedRows: number;
  constructor(affectedRows: number) {
    super("backfill count changed");
    this.name = "CountMismatchError";
    this.affectedRows = affectedRows;
  }
}

// The confirmation gate and the write, atomically. The count is re-read inside
// the transaction and must match the operator's echo exactly, so an execute
// call made before they saw the dry run (or after the data shifted) fails
// closed. Under REPEATABLE READ the UPDATE sees the gate's snapshot: rows
// inserted since are invisible to it, and a candidate another transaction
// changed meanwhile aborts it with a serialization failure (also a 409).
async function executeBackfill(threshold: number, confirmAffected: number | null): Promise<ExecuteOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      const counts = await readCounts(tx, threshold);
      if (confirmAffected === null || confirmAffected !== counts.affectedRows) {
        return { kind: "unconfirmed" as const, affectedRows: counts.affectedRows };
      }
      const updated = await tx.$executeRawUnsafe(UPDATE_SQL, threshold);
      if (updated !== counts.affectedRows) throw new CountMismatchError(updated);
      return { kind: "applied" as const, updated, watchedFlippedToFalse: counts.watchedFlippedToFalse };
    }, { isolationLevel: "RepeatableRead", timeout: EXECUTE_TX_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof CountMismatchError) return { kind: "unconfirmed", affectedRows: err.affectedRows };
    if (txFailureKind(err) === "serialization" || isPrismaErrorCode(err, "P2034")) {
      // Rolled back; tell the operator the count they must confirm now.
      return { kind: "unconfirmed", affectedRows: (await readCounts(prisma, threshold)).affectedRows };
    }
    throw err;
  }
}
