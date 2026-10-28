// The issue "Fix file" window's rules (pure, zero-import): which fix fits what
// is on disk, and which release-search rejections mean only "a file is already
// on disk". The window itself is issue-actions.tsx.
//
// Why one window: Refetch, Replace and Replace file were three buttons for one
// job, and for the usual report — a broken file that already meets the quality
// cutoff — two of them did nothing. A search only takes an UPGRADE of a file
// on disk, so Refetch answered "Search triggered" and nothing came; a picked
// release imports only when it is at least as good as the file on disk, and
// the arr marks nearly every release "rejected" against it, so the list read
// empty. The window reads the files first and leads with the fix that works.

/**
 * What the window leads with.
 * - `nothing`: nothing the issue covers is on disk — a search fetches it.
 * - `upgrade`: every file is below the profile's cutoff — a search can replace it.
 * - `broken`: at least one file meets the cutoff — a search never replaces it,
 *   so delete it and get a new copy.
 * - `unknown`: the files weren't read (an issue admin, who can't list them, or
 *   a failed read) — offer the search and the release list, and say why.
 */
export type FixAdvice = "nothing" | "upgrade" | "broken" | "unknown";

export function fixAdvice(files: readonly { qualityCutoffNotMet: boolean }[] | null): FixAdvice {
  if (files === null) return "unknown";
  if (files.length === 0) return "nothing";
  return files.every((f) => f.qualityCutoffNotMet) ? "upgrade" : "broken";
}

/**
 * The files the delete starts with ticked: the only one when there is exactly
 * one (a movie, an episode), none otherwise — a season's worth of files is the
 * admin's choice, never a default, because the delete can't be undone.
 */
export function defaultFileSelection(files: readonly { id: number }[]): number[] {
  return files.length === 1 ? [files[0].id] : [];
}

// Radarr and Sonarr word every "a file is already on disk" rejection this way
// (DecisionEngine/Specifications/UpgradeDiskSpecification.cs, read 2026-10-28):
// "Existing file meets cutoff", "Existing file on disk is of equal or higher
// preference / revision", "… meets quality cutoff", "… Custom Format …",
// "… does not allow upgrades", and Sonarr v5's season-pack upgrade threshold.
// Matched on the English text the arr sends (it is never translated). A
// wording this misses only falls back to the plain "rejected" list.
const DISK_REJECTION = /^(?:Existing file\b|Season pack does not meet the upgrade criteria)/;

/**
 * True when every reason the arr turned the release down is the file already
 * on disk. Such a release still downloads when grabbed, and imports when it is
 * at least as good as that file — exactly what an issue about a broken file
 * may want — so the list shows it instead of hiding it with the rejected ones.
 */
export function rejectedOnlyForFileOnDisk(r: { rejected: boolean; rejections: readonly string[] }): boolean {
  return r.rejected && r.rejections.length > 0 && r.rejections.every((x) => DISK_REJECTION.test(x));
}

/** The release the list starts on: the first the arr would take, else the first turned down only for the file on disk. */
export function defaultRelease<T extends { guid: string; rejected: boolean; rejections: readonly string[] }>(
  releases: readonly T[],
): string | null {
  const first = releases.find((r) => !r.rejected) ?? releases.find(rejectedOnlyForFileOnDisk);
  return first?.guid ?? null;
}
