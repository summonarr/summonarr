import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { emitNotificationEvent } from "@/lib/notify-agents";
import { notifyAdminsDeletionVoteThreshold } from "@/lib/email";
import { notifyAdminsDeletionVoteThresholdPush } from "@/lib/push";
import { isTmdbIdInRange, parseTmdbIdParam } from "@/lib/tmdb-id";
import { processSingleton } from "@/lib/process-singleton";
import {
  DELETION_VOTE_PENDING_PREFIX,
  DELETION_VOTE_THRESHOLD_KEY,
  deletionVoteMarkerKey,
  deletionVotePendingKey,
  parseDeletionVotePendingKey,
  parseDeletionVoteThreshold,
} from "@/lib/deletion-vote-keys";

/** The threshold Setting, read on `db` (a transaction's client inside one). 0 = off. */
export async function readDeletionVoteThreshold(db: Pick<typeof prisma, "setting"> = prisma): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: DELETION_VOTE_THRESHOLD_KEY } });
  return parseDeletionVoteThreshold(row?.value);
}

/**
 * The title a /api/votes/[tmdbId] call names: the canonical path id within
 * INT4 and the `mediaType` query parameter. The un-vote (DELETE) and the admin
 * dismiss (PATCH) parse it the same way.
 */
export function parseVoteTitleParams(
  rawId: string,
  searchParams: URLSearchParams,
): { ok: true; tmdbId: number; mediaType: "MOVIE" | "TV" } | { ok: false; error: "tmdbId" | "mediaType" } {
  const tmdbId = parseTmdbIdParam(rawId);
  if (tmdbId === null || !isTmdbIdInRange(tmdbId)) return { ok: false, error: "tmdbId" };
  const mediaType = searchParams.get("mediaType");
  if (mediaType !== "MOVIE" && mediaType !== "TV") return { ok: false, error: "mediaType" };
  return { ok: true, tmdbId, mediaType };
}

/**
 * Fire the "deletion threshold reached" admin alert exactly once per title,
 * after a vote on it COMMITTED. The marker row is an idempotent one-shot gate:
 * createMany(skipDuplicates) reports count === 1 for the single caller that
 * wins the insert and 0 for everyone after.
 *
 * Runs OUTSIDE any transaction, after the vote insert (guardrail 23): a bare
 * create() whose duplicate-key error is caught-and-ignored inside a
 * single-level interactive tx leaves Postgres in the aborted state, so the
 * trailing COMMIT becomes a ROLLBACK and silently discards the vote too. Running
 * it afterwards is also self-healing: if the process dies before the claim, the
 * next vote re-evaluates the threshold and fires the alert.
 */
export async function alertIfVoteThresholdReached(media: {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  posterPath: string | null;
}): Promise<void> {
  const { tmdbId, mediaType } = media;
  const threshold = await readDeletionVoteThreshold();
  if (threshold <= 0) return;
  const voteCount = await prisma.deletionVote.count({ where: { tmdbId, mediaType } });
  if (voteCount < threshold) return;
  const claimKey = deletionVoteMarkerKey(tmdbId, mediaType);
  // Later votes on an already-alerted title stop here, without writing a marker.
  if (await prisma.setting.findUnique({ where: { key: claimKey } })) return;
  // Intent first: a crash after the claim but before the send leaves this
  // marker for the sweep to finish. Overwrites a stale one from an earlier cycle.
  const pendingKey = deletionVotePendingKey(tmdbId, mediaType);
  const pendingValue = JSON.stringify({ at: new Date().toISOString(), title: media.title, posterPath: media.posterPath });
  await prisma.setting.upsert({
    where: { key: pendingKey },
    create: { key: pendingKey, value: pendingValue },
    update: { value: pendingValue },
  });
  const claim = await prisma.setting.createMany({
    data: [{ key: claimKey, value: "1" }],
    skipDuplicates: true,
  });
  // A loser leaves the pending marker to the winner (its send removes it).
  if (claim.count !== 1) return;
  // Re-count after winning the claim: an admin "dismiss" deletes all votes AND
  // this claim key in one tx, so a dismiss racing between the count above and
  // the claim insert would re-create the key and fire a false threshold alert
  // for a title whose votes were just wiped. Only notify if still over.
  const recount = await prisma.deletionVote.count({ where: { tmdbId, mediaType } });
  if (recount < threshold) {
    // The race wiped the votes, so give the claim back. Left in place, the key
    // would block the alert when the title genuinely reaches the threshold
    // again. Best-effort: the vote is already saved.
    await prisma.setting
      .deleteMany({ where: { key: { in: [claimKey, pendingKey] } } })
      .catch((err) => console.warn("[votes] releasing threshold claim failed:", err));
    return;
  }
  const data = { title: media.title, mediaType, voteCount: recount, posterPath: media.posterPath, tmdbId };
  after(async () => {
    await deliverThresholdAlert(data);
    // Best-effort: a marker left behind only costs one repeat from the sweep.
    await prisma.setting
      .deleteMany({ where: { key: pendingKey } })
      .catch((err) => console.warn("[votes] clearing pending threshold alert failed:", err));
  });
}

type ThresholdAlertData = { title: string; mediaType: "MOVIE" | "TV"; voteCount: number; posterPath: string | null; tmdbId: number };

async function deliverThresholdAlert(data: ThresholdAlertData): Promise<void> {
  emitNotificationEvent({
    event: "vote.threshold",
    media: { type: data.mediaType, tmdbId: data.tmdbId, title: data.title, posterPath: data.posterPath },
    votes: data.voteCount,
  });
  await Promise.allSettled([
    notifyAdminsDeletionVoteThreshold(data),
    notifyAdminsDeletionVoteThresholdPush(data),
  ]);
}

/** A pending marker is finished only once it is this old: a fresh one belongs to the vote that wrote it. */
export const VOTE_ALERT_RETRY_MIN_AGE_MS = 10 * 60_000;
/** Past this the alert is old news and the marker is dropped unsent. */
export const VOTE_ALERT_RETRY_TTL_MS = 24 * 60 * 60_000;
/** The sweep runs at most this often per process. */
export const VOTE_ALERT_SWEEP_INTERVAL_MS = 5 * 60_000;
const MAX_VOTE_ALERTS_PER_SWEEP = 20;

const voteAlertSweep = processSingleton("deletion-vote-threshold:sweep", () => ({ lastAt: Number.NEGATIVE_INFINITY }));

/**
 * Finish alerts a crash interrupted (a pending marker older than a few
 * minutes). Each marker is taken by deleting it (count 0 = another caller took
 * it), the title is re-judged (still over the threshold, claim re-won or still
 * held), and the alert is delivered once more. At-least-once across a crash;
 * a marker whose removal failed after a delivered alert repeats it once.
 */
export async function sweepPendingVoteAlerts(opts: { now?: Date; force?: boolean } = {}): Promise<{ delivered: number; dropped: number }> {
  const nowMs = (opts.now ?? new Date()).getTime();
  const out = { delivered: 0, dropped: 0 };
  if (!opts.force && nowMs - voteAlertSweep.lastAt < VOTE_ALERT_SWEEP_INTERVAL_MS) return out;
  voteAlertSweep.lastAt = nowMs;
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: DELETION_VOTE_PENDING_PREFIX } },
    select: { key: true, value: true },
    take: MAX_VOTE_ALERTS_PER_SWEEP,
  });
  for (const row of rows) {
    const title = parseDeletionVotePendingKey(row.key);
    let stored: { at?: unknown; title?: unknown; posterPath?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(row.value ?? "");
      if (parsed && typeof parsed === "object") stored = parsed as typeof stored;
    } catch { /* unreadable: dropped below */ }
    const at = typeof stored.at === "string" ? Date.parse(stored.at) : NaN;
    const age = Number.isFinite(at) ? nowMs - at : Number.POSITIVE_INFINITY;
    if (title && age < VOTE_ALERT_RETRY_MIN_AGE_MS) continue;
    const taken = await prisma.setting.deleteMany({ where: { key: { in: [row.key] } } });
    if (taken.count === 0) continue;
    if (!title || typeof stored.title !== "string" || age > VOTE_ALERT_RETRY_TTL_MS) {
      out.dropped++;
      continue;
    }
    const { tmdbId, mediaType } = title;
    const threshold = await readDeletionVoteThreshold();
    const voteCount = threshold > 0 ? await prisma.deletionVote.count({ where: { tmdbId, mediaType } }) : 0;
    if (threshold <= 0 || voteCount < threshold) {
      out.dropped++;
      continue;
    }
    const claimKey = deletionVoteMarkerKey(tmdbId, mediaType);
    if (!(await prisma.setting.findUnique({ where: { key: claimKey } }))) {
      const claim = await prisma.setting.createMany({ data: [{ key: claimKey, value: "1" }], skipDuplicates: true });
      if (claim.count !== 1) continue;
    }
    await deliverThresholdAlert({
      title: stored.title,
      mediaType,
      voteCount,
      posterPath: typeof stored.posterPath === "string" ? stored.posterPath : null,
      tmdbId,
    });
    out.delivered++;
  }
  return out;
}

/** Test seam: let the next sweep run at once. */
export function _resetVoteAlertSweepForTests(): void {
  voteAlertSweep.lastAt = Number.NEGATIVE_INFINITY;
}
