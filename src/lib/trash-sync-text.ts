// The words a TRaSH sync answer carries that the admin cards read back
// (src/components/admin/trash-guides/outcomes.ts). One copy for the writer and
// the reader: a rewording on either side alone would show a disabled feature as
// "already running", or list every apply failure twice.
//
// Zero imports: the cron route, runTrashSync and the client card all load it.

/** The trash-sync route's skip reason while TRaSH Guides is off server-side. */
export const TRASH_DISABLED_SKIP_REASON = "TRaSH Guides disabled";

/** How runTrashSync folds one spec's apply failure into the run's errors[]. */
export function foldedApplyError(trashId: string, error: string): string {
  return `apply ${trashId}: ${error}`;
}
