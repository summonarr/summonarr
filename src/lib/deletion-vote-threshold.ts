import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { emitNotificationEvent } from "@/lib/notify-agents";
import { notifyAdminsDeletionVoteThreshold } from "@/lib/email";
import { notifyAdminsDeletionVoteThresholdPush } from "@/lib/push";
import { isTmdbIdInRange, parseTmdbIdParam } from "@/lib/tmdb-id";
import { DELETION_VOTE_THRESHOLD_KEY, deletionVoteMarkerKey, parseDeletionVoteThreshold } from "@/lib/deletion-vote-keys";

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
  const claim = await prisma.setting.createMany({
    data: [{ key: claimKey, value: "1" }],
    skipDuplicates: true,
  });
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
      .deleteMany({ where: { key: claimKey } })
      .catch((err) => console.warn("[votes] releasing threshold claim failed:", err));
    return;
  }
  const data = { title: media.title, mediaType, voteCount: recount, posterPath: media.posterPath, tmdbId };
  after(async () => {
    emitNotificationEvent({
      event: "vote.threshold",
      media: { type: mediaType, tmdbId, title: media.title, posterPath: media.posterPath },
      votes: recount,
    });
    await Promise.allSettled([
      notifyAdminsDeletionVoteThreshold(data),
      notifyAdminsDeletionVoteThresholdPush(data),
    ]);
  });
}
