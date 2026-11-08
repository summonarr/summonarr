// The deletion-vote threshold's Setting keys, shared by the vote routes (the
// one-shot alert's claim and its re-arm), the admin dismiss and the
// now-available wipe (notify-available.ts). Zero imports.

/** The admin's threshold Setting: votes on one title that alert the admins. */
export const DELETION_VOTE_THRESHOLD_KEY = "deletionVoteThreshold";

/**
 * The one-shot marker of a title whose threshold alert already fired. Created
 * with createMany(skipDuplicates) by the vote that crosses the threshold; any
 * path that drops the tally below it deletes the marker so a re-crossing alerts
 * again.
 */
export function deletionVoteMarkerKey(tmdbId: number, mediaType: string): string {
  return `deletionVoteNotified:${tmdbId}:${mediaType}`;
}

/** The stored threshold: a positive whole number, else 0 (off). */
export function parseDeletionVoteThreshold(raw: string | null | undefined): number {
  const n = parseInt(raw ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
