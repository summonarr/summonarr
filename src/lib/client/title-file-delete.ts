// The title manager's file delete (DELETE /api/admin/arr/title/files), from
// the browser. It runs as a BACKGROUND job on the server — each delete may
// wait 120 s (a recycle bin on another disk is a copy), past a reverse proxy's
// hold, and the admin was shown "delete failed" while the arr finished it. So:
// start it, then poll `&job=` for the DELETE's own answer through the shared
// counted loop (job-poll.ts — never a clock, guardrail 16). A few failed polls
// in a row (a network blip, a proxy's own 502–504 with no JSON) are retried,
// and running out of either is "still running" — the delete keeps running
// there, and the tab stops holding its controls: the admin reloads the files
// to see what's left.
//
// No server imports, so the unit suite loads it (tests/arr-title-file-delete.test.mts).
import { apiErrorText } from "./api-error";
import { arrCall, jobUrl } from "./arr-call";
import { DELETE_START } from "./arr-answers";
import { pollJob } from "./job-poll";

export const DELETE_POLL_MS = 1_500;
/** ~3 minutes of polls, then "still running" — the Files tab's controls wait no longer than that. */
export const DELETE_MAX_POLLS = 120;
export const DELETE_FAILED_POLLS = 5;

export type DeleteAnswer =
  | { kind: "deleted"; deleted: number }
  | { kind: "failed"; error: string }
  /** No answer from the delete itself: it may still be running on the server — never shown as failed. */
  | { kind: "running" };

/**
 * Delete `fileIds` of the title `url` names (the files route with its title
 * query, base path included). The ids go in the body: "select all" on a
 * long-running series is more than a query string holds. Null when `signal`
 * ended the wait (the manager closed).
 */
export async function runTitleFileDelete(
  url: string,
  fileIds: readonly number[],
  fallback: string,
  opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DeleteAnswer | null> {
  const { signal } = opts;
  const start = await arrCall(url, { method: "DELETE", body: { fileIds, async: true }, schema: DELETE_START, signal, fallback });
  if (signal?.aborted) return null;
  if (!start.ok) return { kind: "failed", error: start.error };
  if (start.data.job === undefined) return { kind: "deleted", deleted: start.data.deleted ?? 0 };
  const answer = await pollJob(globalThis.fetch, jobUrl(url, start.data.job), {
    isAlive: () => !signal?.aborted,
    intervalMs: DELETE_POLL_MS,
    maxPolls: DELETE_MAX_POLLS,
    failLimit: DELETE_FAILED_POLLS,
    sleep: opts.sleep,
  });
  if (answer === null) return null;
  const data = answer.data;
  // No answer, or one with no JSON object (a page from something in between,
  // a job that broke): the delete may still be running — never shown as failed.
  if (answer.status === 0 || data === null || typeof data !== "object" || Array.isArray(data)) return { kind: "running" };
  if (answer.status >= 200 && answer.status < 300) {
    return { kind: "deleted", deleted: "deleted" in data && typeof data.deleted === "number" ? data.deleted : 0 };
  }
  return { kind: "failed", error: apiErrorText(data, fallback) };
}
