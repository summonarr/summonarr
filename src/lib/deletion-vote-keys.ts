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

/** Prefix of the pending-delivery markers (see deletionVotePendingKey). */
export const DELETION_VOTE_PENDING_PREFIX = "deletionVotePending:";

/**
 * Written BEFORE the claim and removed once the alert was handed to the
 * senders, so a crash between the claim and the send leaves a marker a later
 * vote's sweep can finish. The claim marker's own value ("1") is unchanged.
 * Value: JSON `{ at, title, posterPath }`.
 */
export function deletionVotePendingKey(tmdbId: number, mediaType: string): string {
  return `${DELETION_VOTE_PENDING_PREFIX}${tmdbId}:${mediaType}`;
}

/** The title a pending key names, or null when it is malformed. */
export function parseDeletionVotePendingKey(key: string): { tmdbId: number; mediaType: "MOVIE" | "TV" } | null {
  if (!key.startsWith(DELETION_VOTE_PENDING_PREFIX)) return null;
  const [id, type, extra] = key.slice(DELETION_VOTE_PENDING_PREFIX.length).split(":");
  if (extra !== undefined || (type !== "MOVIE" && type !== "TV") || !/^\d{1,10}$/.test(id ?? "")) return null;
  return { tmdbId: Number(id), mediaType: type };
}

/** The stored threshold: a positive whole number, else 0 (off). */
export function parseDeletionVoteThreshold(raw: string | null | undefined): number {
  const n = parseInt(raw ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
