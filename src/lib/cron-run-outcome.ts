// How a cron/sync route's answer reads to the admin "Run" button and to the run
// ledger. Zero-import so the "use client" cron table can share it with the
// server-side recorder (cron-history.ts re-exports the header from here).

// Marks an answer where no run happened: a busy lock, an unconfigured job. The
// run ledger records nothing for it (withCronRunRecording), so the cron table
// must not count it as a run either.
export const CRON_SKIPPED_HEADER = "X-Cron-Skipped";

export type ManualRunOutcome = "ok" | "error" | "skipped";

/**
 * The verdict on one manual run from its HTTP answer.
 *
 * - Any non-2xx is an error, even with a `skipped` field (a 502
 *   `{ skipped: true, reason: "arr-unavailable" }` is a failure).
 * - A skip is the X-Cron-Skipped header or a literal `skipped: true`, never a
 *   truthy `skipped`: /api/sync/ratings answers `skipped` as a COUNT, and its
 *   best run says `skipped: 0`.
 * - Otherwise an `error` field means a run that finished with failures; `ok`
 *   is not read, because most of these routes don't send it.
 */
export function manualRunOutcome(
  status: number,
  headers: { get(name: string): string | null },
  body: unknown,
): ManualRunOutcome {
  if (status < 200 || status > 299) return "error";
  const fields = body && typeof body === "object" ? (body as { skipped?: unknown; error?: unknown }) : {};
  if (headers.get(CRON_SKIPPED_HEADER) !== null || fields.skipped === true) return "skipped";
  return fields.error ? "error" : "ok";
}
