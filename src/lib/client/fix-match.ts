import { withBasePath } from "@/lib/base-path";
import type { Translator } from "@/lib/i18n/translate";

// Client half of the background fix-match (guardrail 37a): start the job, then
// poll its status until it settles. Resolves with the same shape the
// synchronous POST returns; rejects with a FixMatchClientError carrying a CODE,
// never English prose — the consumer maps the code to a translated string with
// `fixMatchErrorMessage` (the server's own `error` is already translated for
// the request's language and passes through untouched). Transient poll
// failures (a proxy blip, a sleeping tab) are retried — only a 404 (the server
// restarted and lost the in-memory job) or the overall deadline gives up, and
// both are distinct codes so the UI can say what to do next instead of
// implying the remap failed.

export type FixMatchRequest = {
  server: "plex" | "jellyfin";
  mediaType: "MOVIE" | "TV";
  correctTmdbId: number;
  canonicalGuid?: string;
  serverInstance?: string;
} & (
  | { tmdbId: number; itemKey?: undefined }
  // Item mode: one item the library match check flagged; the server reads its
  // current id from the stored report.
  | { itemKey: string; tmdbId?: undefined }
);

// `warning` is the server's (translated) partial-remap note. `joined` means an
// identical remap was already running server-side and this call attached to it
// — i.e. THIS caller's candidate pick (if different) was not used. It is a flag
// rather than text so the consumer can render it in its own language.
export type FixMatchOutcome = { ok: true; warning?: string; joined?: boolean };

// What the UI gets on every poll while the job runs: the server's phase plus
// wall-clock elapsed since the job started, so "Applying…" can become
// "Jellyfin accepted the match — waiting for its refresh (3:20)".
export type FixMatchProgressView = {
  phase: "searching" | "applying" | "confirming";
  remoteApplied: boolean;
  attempt: number;
  attempts: number;
  readFailures: number;
  // Which copy of a multi-copy title the server is on (1-based); absent for one item.
  copy?: number;
  copies?: number;
  elapsedMs: number;
};

export type FixMatchErrorCode =
  // The start POST or a status read answered non-2xx with no server message.
  | "http"
  // The server reported the job failed; `message` is its translated reason
  // (may be empty when it sent none).
  | "failed"
  // Status read 404'd: the server restarted and lost the in-memory job.
  | "jobLost"
  // Too many consecutive status-read failures (network or non-2xx).
  | "pollLost"
  // The job was still running at MAX_WAIT_MS.
  | "timedOut";

export class FixMatchClientError extends Error {
  code: FixMatchErrorCode;
  status: number | undefined;
  constructor(code: FixMatchErrorCode, opts: { status?: number; message?: string } = {}) {
    super(opts.message ?? code);
    this.name = "FixMatchClientError";
    this.code = code;
    this.status = opts.status;
  }
}

// Maps a runFixMatch rejection to a translated line. Shared by every consumer so
// the four client-only outcomes read identically everywhere; the server's own
// message passes through for `failed`.
export function fixMatchErrorMessage(err: unknown, t: Translator): string {
  if (err instanceof FixMatchClientError) {
    switch (err.code) {
      case "jobLost":  return t("adminQueue.fixMatch.outcome.jobLost");
      case "pollLost": return t("adminQueue.fixMatch.outcome.pollLost");
      case "timedOut": return t("adminQueue.fixMatch.outcome.timedOut");
      case "http":     return t("adminQueue.common.requestFailed", { status: err.status ?? 0 });
      case "failed":   return err.message || t("adminQueue.fixMatch.outcome.failed");
    }
  }
  return err instanceof Error && err.message ? err.message : t("adminQueue.fixMatch.unknownError");
}

// The warning line for a SUCCESSFUL outcome, or null when there is nothing to
// say: the server's partial-remap note and/or the translated "joined" notice.
export function fixMatchWarningMessage(outcome: FixMatchOutcome, t: Translator): string | null {
  const parts = [outcome.warning, outcome.joined ? t("adminQueue.fixMatch.outcome.joined") : undefined].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

type StartBody = { ok?: boolean; jobId?: string; warning?: string; error?: string; joined?: boolean };
type StatusBody = {
  status?: "running" | "done" | "failed";
  startedAt?: number;
  progress?: Omit<FixMatchProgressView, "elapsedMs">;
  result?: FixMatchOutcome;
  error?: string;
};

const POLL_INTERVAL_MS = 3_000;
// Absolute ceiling. A multi-copy Jellyfin series runs its copies one after
// another (up to ~10 min of confirmation each), so a fixed 20-minute window gave
// up on a job that was still making progress.
const MAX_WAIT_MS = 4 * 60 * 60_000;
// Give up when a RUNNING job stops reporting any change for this long: every
// confirmation attempt, phase and copy change counts as progress. A server that
// reports no progress at all (an older build) keeps the previous 20-minute window.
export const STALL_LIMIT_MS = 10 * 60_000;
export const NO_PROGRESS_LIMIT_MS = 20 * 60_000;

/** A comparable fingerprint of what the job reports — anything that changes means "still alive". */
export function progressSignature(p: StatusBody["progress"] | undefined): string {
  return p ? [p.phase, p.remoteApplied ? 1 : 0, p.attempt, p.attempts, p.readFailures, p.copy ?? 0, p.copies ?? 0].join("|") : "";
}

/** True when a running job has shown no change for longer than its limit. */
export function hasStalled(now: number, lastChangeAt: number, reportsProgress: boolean): boolean {
  return now - lastChangeAt >= (reportsProgress ? STALL_LIMIT_MS : NO_PROGRESS_LIMIT_MS);
}
const MAX_CONSECUTIVE_POLL_FAILURES = 10;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runFixMatch(
  body: FixMatchRequest,
  opts: { onProgress?: (progress: FixMatchProgressView) => void; signal?: AbortSignal } = {},
): Promise<FixMatchOutcome> {
  const startedLocally = Date.now();
  const res = await fetch(withBasePath("/api/admin/fix-match"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, async: true }),
    signal: opts.signal,
  });
  let started: StartBody = {};
  try { started = await res.json() as StartBody; } catch { }
  if (!res.ok || !started.ok) {
    throw started.error
      ? new FixMatchClientError("failed", { status: res.status, message: started.error })
      : new FixMatchClientError("http", { status: res.status });
  }
  // A server that predates the job mode ignores `async` and answers the plain
  // synchronous result — honour it.
  if (!started.jobId) return started.warning ? { ok: true, warning: started.warning } : { ok: true };

  // Only a caller that PICKED a candidate can have had its pick ignored.
  const joined = Boolean(started.joined && body.canonicalGuid);

  const statusUrl = withBasePath(`/api/admin/fix-match/status?id=${encodeURIComponent(started.jobId)}`);
  const deadline = Date.now() + MAX_WAIT_MS;
  let consecutiveFailures = 0;
  let lastSignature = "";
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    // The caller navigated away (component unmount): stop the 3s poll loop —
    // the server-side job keeps running by design. AbortError shape so callers
    // can distinguish it from a real failure.
    if (opts.signal?.aborted) throw new DOMException("Fix-match polling aborted", "AbortError");
    let pollRes: Response;
    try {
      pollRes = await fetch(statusUrl, { signal: opts.signal });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new FixMatchClientError("pollLost");
      }
      continue;
    }
    if (pollRes.status === 404) {
      throw new FixMatchClientError("jobLost", { status: 404 });
    }
    if (!pollRes.ok) {
      if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new FixMatchClientError("pollLost", { status: pollRes.status });
      }
      continue;
    }
    consecutiveFailures = 0;
    const job = await pollRes.json().catch(() => ({})) as StatusBody;
    if (job.status === "done") {
      const result = job.result ?? { ok: true };
      return joined ? { ...result, joined: true } : result;
    }
    if (job.status === "failed") throw new FixMatchClientError("failed", { message: job.error ?? "" });
    const signature = progressSignature(job.progress);
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastChangeAt = Date.now();
    } else if (hasStalled(Date.now(), lastChangeAt, job.progress !== undefined)) {
      throw new FixMatchClientError("timedOut");
    }
    opts.onProgress?.({
      phase: job.progress?.phase ?? "applying",
      remoteApplied: job.progress?.remoteApplied ?? false,
      attempt: job.progress?.attempt ?? 0,
      attempts: job.progress?.attempts ?? 0,
      readFailures: job.progress?.readFailures ?? 0,
      ...(job.progress?.copies ? { copy: job.progress.copy, copies: job.progress.copies } : {}),
      // startedLocally, never job.startedAt: the latter is the SERVER clock,
      // and mixing clocks renders a wrong elapsed timer under any skew.
      elapsedMs: Date.now() - startedLocally,
    });
  }
  throw new FixMatchClientError("timedOut");
}
