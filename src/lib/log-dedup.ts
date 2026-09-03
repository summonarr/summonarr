// Repeat-suppression for warnings that restate an UNCHANGED condition on every
// pass of a periodic job.
//
// Why this exists:
// - The library sync re-derives the same collision sets on every run, so
//   `[jellyfin] 90 TMDB id(s) matched more than one Movie` and the
//   conflated-ratingKey list were emitted verbatim once per orchestrator run —
//   byte-identical, indefinitely. At the intended hourly cadence that is ~24
//   lines a day and harmless.
// - When something upstream drove the orchestrator to run roughly once a
//   minute, those same lines became ~1,400 a day. They did not report the
//   anomaly; they *were* the flood that hid it. A warning that restates a
//   steady state at the rate of its own polling can never show a rate change,
//   because its volume is a property of the caller, not of the condition.
// - So the fix is not "log less detail", it is "log the condition once, and
//   again the moment it differs". Rate lives in the cron run history
//   (recordCronRun), which is the surface actually built to answer "how often".
//
// Semantics:
// - Keyed on a caller-supplied SIGNATURE. A genuine change — 90 duplicates
//   becoming 91, or a different set of dropped ratingKeys — logs immediately.
// - Per-process and in-memory only. A restart always re-logs, so the current
//   state is never invisible to an operator who just started reading.
// - Suppression is silent by design: emitting "(repeated N times)" would
//   reintroduce a per-pass line, which is the thing being removed.
//
// Precedent: PlexEventStreamManager.persistReachability already holds a
// `lastReachable` value and no-ops on an unchanged one for exactly this reason.

/**
 * Upper bound on tracked keys. The real key space is small and bounded by admin
 * config — (media type x registered instance) — but de-registering and
 * re-registering instances could grow it slowly over a long uptime. Clearing
 * wholesale on overflow costs at most one extra line per live key and needs no
 * LRU bookkeeping; it can never leak.
 */
const MAX_TRACKED_KEYS = 256;

const lastSignature = new Map<string, string>();

/**
 * Emit `message` via console.warn only when `signature` differs from the last
 * one logged under `key` in this process.
 *
 * `key` identifies the CONDITION (e.g. `jellyfin-dupes:Movie:default`);
 * `signature` identifies its current VALUE. Keep the signature derived from
 * everything the message states, or a changed message will be suppressed.
 */
export function warnOnChange(key: string, signature: string, message: string): void {
  if (lastSignature.get(key) === signature) return;
  if (lastSignature.size >= MAX_TRACKED_KEYS && !lastSignature.has(key)) {
    lastSignature.clear();
  }
  lastSignature.set(key, signature);
  console.warn(message);
}

/** Test seam: drop all suppression state so cases cannot leak into each other. */
export function resetLogDedup(): void {
  lastSignature.clear();
}
