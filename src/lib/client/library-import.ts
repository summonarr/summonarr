// Client half of the Plex and Jellyfin settings forms' full import/sync button:
// one full sync of the DEFAULT server, started as a background job and polled
// until it answers (POST { full, async: true }, then GET ?job= — the
// guardrail-37a pattern, the same route and runner the admin Resync uses).
//
// A synchronous request waited out the whole walk; on a large library a reverse
// proxy cut it after ~60–100s and the form said "failed" while the sync ran on.
//
// "No answer" (status 0, or a gateway's 5xx with no error of the route's) is
// never a failure: the sync may still be running on the server.
import { check, v } from "../validate";
import { isNoAnswer, jobAnswerError } from "./library-sync";
import { runReplaceFileJob } from "./replace-file-job";

export type LibraryImportOutcome =
  /** The sync finished: how many requests it marked available, and what it scanned. */
  | { kind: "done"; marked: number; scanned: { movies: number; tv: number } }
  /** 200 { skipped }: a sync of this server was already running. */
  | { kind: "busy" }
  /** Nothing answered: it may still be running. */
  | { kind: "noAnswer" }
  /** The route's own refusal ("" when it gave no reason, or answered a shape it never sends). */
  | { kind: "error"; error: string };

const SyncAnswer = v.object({
  marked: v.number(),
  scanned: v.object({ movies: v.number(), tv: v.number() }),
});

/** A sync's job answer (status 0 = none came) as an outcome. Pure. */
export function libraryImportOutcome(answer: { status: number; data: unknown }): LibraryImportOutcome {
  if (isNoAnswer(answer)) return { kind: "noAnswer" };
  const error = jobAnswerError(answer);
  if (answer.status < 200 || answer.status > 299 || error !== null) return { kind: "error", error: error ?? "" };
  const data = answer.data;
  if (typeof data === "object" && data !== null && (data as { skipped?: unknown }).skipped === true) return { kind: "busy" };
  const parsed = check(SyncAnswer, data);
  return parsed.ok ? { kind: "done", ...parsed.value } : { kind: "error", error: "" };
}

const POLL_MS = 3_000;
// 400 × 3 s = 20 minutes, past a full walk of a large library (library-sync.ts).
const MAX_POLLS = 400;

/**
 * Run one full sync of the default server of `service` and wait for its
 * outcome. `url` is the route with the base path applied. Resolves null once
 * `signal` aborts (the form unmounted, or a newer run took over).
 */
export async function runLibraryImport(
  url: string,
  signal: AbortSignal,
  opts: { fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<LibraryImportOutcome | null> {
  const base = opts.fetchFn ?? fetch;
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => base(input, { ...init, signal })) as typeof fetch;
  let answer;
  try {
    answer = await runReplaceFileJob(fetchFn, url, { full: true }, {
      intervalMs: POLL_MS,
      maxPolls: MAX_POLLS,
      isAlive: () => !signal.aborted,
      sleep: opts.sleep,
    });
  } catch {
    // The start request itself got no answer (or was aborted).
    if (signal.aborted) return null;
    return { kind: "noAnswer" };
  }
  if (answer === null || signal.aborted) return null;
  return libraryImportOutcome(answer);
}
