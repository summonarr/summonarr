import { timedFetch } from "@/lib/client/fetch-json";
import { withBasePath } from "@/lib/base-path";
import { abortableSleep } from "@/lib/abortable-sleep";
import { retryAfterDeltaSeconds } from "@/lib/client/rate-limit";
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
  // The issue dialog: the WRONG_MATCH issue this fix answers, closed by the
  // server's job when the remap succeeds (title mode only), and the corrected
  // title its resolution note names.
  issueId?: string;
  issueTitle?: string;
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
// `issueResolved` (a fix sent with `issueId`): whether the server's job closed
// that issue; absent when it can't say — a joined job closes it separately.
export type FixMatchOutcome = { ok: true; warning?: string; joined?: boolean; issueResolved?: boolean };

// What the UI gets on every poll while the job runs: the server's phase plus
// wall-clock elapsed since the job started, so "Applying…" can become
// "Jellyfin accepted the match — waiting for its refresh (3:20)".
export type FixMatchProgressView = {
  phase: "queued" | "searching" | "applying" | "confirming";
  remoteApplied: boolean;
  attempt: number;
  attempts: number;
  readFailures: number;
  // Jobs ahead of this one while it waits for a slot (phase "queued" only).
  queueAhead?: number;
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
  // Too many consecutive status-read failures (network, non-2xx, or an answer
  // that is not the status route's JSON).
  | "pollLost"
  // The job was still running at MAX_WAIT_MS.
  | "timedOut";

export class FixMatchClientError extends Error {
  code: FixMatchErrorCode;
  status: number | undefined;
  /** A refused start's Retry-After, in seconds, when the route sent one. */
  retryAfter: number | undefined;
  constructor(code: FixMatchErrorCode, opts: { status?: number; message?: string; retryAfter?: number } = {}) {
    super(opts.message ?? code);
    this.name = "FixMatchClientError";
    this.code = code;
    this.status = opts.status;
    this.retryAfter = opts.retryAfter;
  }
}

// The route allows 10 starts a minute per admin and sends no Retry-After, so a
// rate-limited start waits this long before it is tried again.
const RATE_LIMIT_WAIT_MS = 15_000;
const RATE_LIMIT_MAX_WAIT_MS = 60_000;

/**
 * How long a bulk run waits before retrying a title whose START was
 * rate-limited (429), or null when the failure is not one. A 429 means the
 * remap never began, so trying it again cannot run one twice.
 */
export function fixMatchRetryAfterMs(err: unknown): number | null {
  if (!(err instanceof FixMatchClientError) || err.status !== 429) return null;
  const sent = err.retryAfter;
  if (sent === undefined || !Number.isFinite(sent) || sent <= 0) return RATE_LIMIT_WAIT_MS;
  return Math.min(sent * 1000, RATE_LIMIT_MAX_WAIT_MS);
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

type JobStatus = "queued" | "running" | "done" | "failed";
const JOB_STATUSES: ReadonlySet<string> = new Set<JobStatus>(["queued", "running", "done", "failed"]);
const PHASES: ReadonlySet<string> = new Set<FixMatchProgressView["phase"]>(["queued", "searching", "applying", "confirming"]);

type StartBody = { ok: boolean; jobId?: string; warning?: string; error?: string; joined: boolean };
type StatusBody = {
  status: JobStatus;
  queueAhead?: number;
  progress?: Omit<FixMatchProgressView, "elapsedMs">;
  result: FixMatchOutcome;
  error?: string;
};

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

// The start POST's answer, field by field: anything of the wrong type reads as absent.
function startBodyOf(raw: unknown): StartBody {
  const r = record(raw) ?? {};
  return { ok: r.ok === true, jobId: str(r.jobId) || undefined, warning: str(r.warning), error: str(r.error), joined: r.joined === true };
}

// A finished job's result, built from the fields the UI reads — never the
// server's object spread through.
function outcomeOf(raw: unknown): FixMatchOutcome {
  const r = record(raw) ?? {};
  const warning = str(r.warning);
  const issueResolved = bool(r.issueResolved);
  return {
    ok: true,
    ...(warning ? { warning } : {}),
    ...(r.joined === true ? { joined: true } : {}),
    ...(issueResolved !== undefined ? { issueResolved } : {}),
  };
}

function progressOf(raw: unknown): StatusBody["progress"] {
  const r = record(raw);
  if (!r) return undefined;
  const phase = str(r.phase);
  return {
    phase: phase && PHASES.has(phase) ? (phase as FixMatchProgressView["phase"]) : "applying",
    remoteApplied: r.remoteApplied === true,
    attempt: num(r.attempt) ?? 0,
    attempts: num(r.attempts) ?? 0,
    readFailures: num(r.readFailures) ?? 0,
    ...(num(r.copy) !== undefined ? { copy: num(r.copy) } : {}),
    ...(num(r.copies) !== undefined ? { copies: num(r.copies) } : {}),
  };
}

// The status route's answer, or null when the body is not it (an auth proxy's
// page, a stray JSON).
function statusBodyOf(raw: unknown): StatusBody | null {
  const r = record(raw);
  const status = str(r?.status);
  if (!r || !status || !JOB_STATUSES.has(status)) return null;
  return {
    status: status as JobStatus,
    queueAhead: num(r.queueAhead),
    progress: progressOf(r.progress),
    result: outcomeOf(r.result),
    error: str(r.error),
  };
}

/** Fired on `window` when a job has been accepted, so the job tray refreshes at once. */
export const FIX_MATCH_STARTED_EVENT = "fix-match:started";

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

const abortError = () => new DOMException("Fix-match polling aborted", "AbortError");
const isAbortError = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

// POST the remap as a background job. Throws a FixMatchClientError on refusal.
async function startFixMatch(body: FixMatchRequest, signal: AbortSignal | undefined): Promise<StartBody> {
  let res: Response;
  try {
    res = await timedFetch(withBasePath("/api/admin/fix-match"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, async: true }),
      signal,
    });
  } catch (err) {
    // timedFetch's own timeout rejects with an AbortError too. Only the
    // caller's abort may leave as one: callers read it as "unmounted" and show
    // nothing, which left a mounted button busy for good.
    if (isAbortError(err) && !signal?.aborted) throw new FixMatchClientError("http", { status: 0 });
    throw err;
  }
  const started = startBodyOf(await res.json().catch(() => null));
  if (!res.ok || !started.ok) {
    const retryAfter = res.status === 429 ? retryAfterDeltaSeconds(res.headers.get("Retry-After")) ?? undefined : undefined;
    throw started.error
      ? new FixMatchClientError("failed", { status: res.status, message: started.error, retryAfter })
      : new FixMatchClientError("http", { status: res.status, retryAfter });
  }
  return started;
}

// One status read: the job's status, or the HTTP status of a read that never
// reached it (0 = the fetch failed or timed out). Throws jobLost on a 404 and
// rethrows the caller's abort.
async function readJobStatus(statusUrl: string, signal: AbortSignal | undefined): Promise<StatusBody | { failed: number }> {
  let pollRes: Response;
  try {
    pollRes = await timedFetch(statusUrl, { signal });
  } catch (err) {
    // The caller's abort only: a poll that hit timedFetch's own timeout is a
    // failed poll like any other, counted toward the limit.
    if (isAbortError(err) && signal?.aborted) throw err;
    return { failed: 0 };
  }
  if (pollRes.status === 404) throw new FixMatchClientError("jobLost", { status: 404 });
  // A 200 that is not the status route's JSON — an auth proxy's login page
  // after a redirect — never reached the job: a failed poll, not "running".
  if (!pollRes.ok || pollRes.redirected) return { failed: pollRes.status };
  return statusBodyOf(await pollRes.json().catch(() => null)) ?? { failed: pollRes.status };
}

function progressView(job: StatusBody, startedLocally: number): FixMatchProgressView {
  // startedLocally, never the job's startedAt: that is the SERVER clock, and
  // mixing clocks renders a wrong elapsed timer under any skew.
  const elapsedMs = Date.now() - startedLocally;
  if (job.status === "queued") {
    return { phase: "queued", remoteApplied: false, attempt: 0, attempts: 0, readFailures: 0, queueAhead: job.queueAhead ?? 0, elapsedMs };
  }
  const p = job.progress;
  return {
    phase: p?.phase ?? "applying",
    remoteApplied: p?.remoteApplied ?? false,
    attempt: p?.attempt ?? 0,
    attempts: p?.attempts ?? 0,
    readFailures: p?.readFailures ?? 0,
    ...(p?.copies ? { copy: p.copy, copies: p.copies } : {}),
    elapsedMs,
  };
}

export async function runFixMatch(
  body: FixMatchRequest,
  opts: { onProgress?: (progress: FixMatchProgressView) => void; signal?: AbortSignal } = {},
): Promise<FixMatchOutcome> {
  const startedLocally = Date.now();
  const started = await startFixMatch(body, opts.signal);
  // A server that predates the job mode ignores `async` and answers the plain
  // synchronous result — honour it.
  if (!started.jobId) return started.warning ? { ok: true, warning: started.warning } : { ok: true };

  // Only a caller that PICKED a candidate can have had its pick ignored.
  const joined = Boolean(started.joined && body.canonicalGuid);
  // A joined job's result speaks for the issue of whoever started it.
  const ownIssueFlag = !started.joined;
  // Tell the job tray there is something new to show without waiting for its poll.
  if (typeof window !== "undefined") window.dispatchEvent(new Event(FIX_MATCH_STARTED_EVENT));

  const statusUrl = withBasePath(`/api/admin/fix-match/status?id=${encodeURIComponent(started.jobId)}`);
  const deadline = Date.now() + MAX_WAIT_MS;
  let consecutiveFailures = 0;
  let lastSignature = "";
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    await abortableSleep(POLL_INTERVAL_MS, opts.signal);
    // The caller navigated away (component unmount): stop the 3s poll loop —
    // the server-side job keeps running by design. AbortError shape so callers
    // can distinguish it from a real failure.
    if (opts.signal?.aborted) throw abortError();
    const job = await readJobStatus(statusUrl, opts.signal);
    if ("failed" in job) {
      if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new FixMatchClientError("pollLost", job.failed ? { status: job.failed } : {});
      }
      continue;
    }
    consecutiveFailures = 0;
    if (job.status === "done") {
      const { issueResolved, ...result } = job.result;
      return {
        ...result,
        ...(joined ? { joined: true } : {}),
        ...(ownIssueFlag && issueResolved !== undefined ? { issueResolved } : {}),
      };
    }
    if (job.status === "failed") throw new FixMatchClientError("failed", { message: job.error ?? "" });
    // Waiting for a slot is not a stall, however long the jobs ahead take.
    if (job.status === "queued") {
      lastChangeAt = Date.now();
    } else {
      const signature = progressSignature(job.progress);
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastChangeAt = Date.now();
      } else if (hasStalled(Date.now(), lastChangeAt, job.progress !== undefined)) {
        throw new FixMatchClientError("timedOut");
      }
    }
    opts.onProgress?.(progressView(job, startedLocally));
  }
  throw new FixMatchClientError("timedOut");
}
