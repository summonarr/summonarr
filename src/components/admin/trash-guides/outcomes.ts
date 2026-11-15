import type { FetchJsonResult } from "@/lib/client/fetch-json";
import { check } from "@/lib/validate";
import { foldedApplyError, TRASH_DISABLED_SKIP_REASON } from "@/lib/trash-sync-text";
import { APPLY_RESULT, type ApplyResult } from "./types";

// How the TRaSH cards read a Refresh Catalog, Apply or Sync Now answer. Pure,
// so the verdicts are unit-tested (tests/trash-run-outcomes.test.mts) — the
// routes answer a partial failure with a 2xx, and reading only the status
// showed a degraded run as a success.

// The trash-sync route's skip reason when the feature is off server-side (the
// advisory lock's contention skip is cronSkippedResponse()'s default). The
// route and this reader share the one constant.
export { TRASH_DISABLED_SKIP_REASON };

/**
 * A fetchJson answer as the readers below take it: the status and the parsed
 * body of anything the route (or something in front of it) answered. null when
 * no answer came — the request failed or timed out, or a proxy's own 5xx page —
 * and undefined when the card dropped the request (it unmounted).
 */
export function answerOf(res: FetchJsonResult<unknown>): { status: number; body: unknown } | null | undefined {
  if (res.ok) return { status: res.status, body: res.data };
  if (res.kind === "aborted") return undefined;
  if (res.kind === "http" || res.kind === "invalid") return { status: res.status, body: res.body };
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

// Every per-spec result that has the whole shape the apply log renders (its
// name, its trashId, a string error) — a malformed entry is left out, never
// shown as a blank name or "apply undefined".
function applyResults(v: unknown): ApplyResult[] {
  const out: ApplyResult[] = [];
  for (const r of records(v)) {
    const checked = check(APPLY_RESULT, r);
    if (checked.ok) out.push(checked.value);
  }
  return out;
}

// One line per failed or cut-short service refresh, prefixed the way
// runTrashSync folds them (`SERVICE: message`).
function refreshResultLines(results: unknown, stoppedEarly: string): string[] {
  const out: string[] = [];
  for (const r of records(results)) {
    const prefix = typeof r.service === "string" ? `${r.service}: ` : "";
    for (const e of strings(r.errors)) out.push(prefix + e);
    if (r.aborted === true) out.push(prefix + stoppedEarly);
  }
  return out;
}

export type RefreshOutcome =
  | { kind: "skipped" }
  | { kind: "done"; failures: string[]; schemaDiagnostic?: string };

// POST /api/admin/trash-guides/refresh. 409 = the trash lock is held and
// nothing ran. Otherwise the run failed when the route says so OR when a
// service's own result carries errors or was cut short: the route's `ok` only
// counts thrown errors, so a refresh with per-file failures still answers ok.
export function refreshOutcome(status: number, body: unknown, stoppedEarly: string): RefreshOutcome {
  if (status === 409) return { kind: "skipped" };
  const b = isRecord(body) ? body : null;
  const failures = new Set<string>([...strings(b?.errors), ...refreshResultLines(b?.results, stoppedEarly)]);
  const httpOk = status >= 200 && status < 300;
  if (failures.size === 0 && (!httpOk || b?.ok !== true)) {
    failures.add(typeof b?.error === "string" ? b.error : `HTTP ${status}`);
  }
  const schemaDiagnostic = typeof b?.schemaDiagnostic === "string" ? b.schemaDiagnostic : undefined;
  return { kind: "done", failures: [...failures], ...(schemaDiagnostic ? { schemaDiagnostic } : {}) };
}

export type SyncOutcome =
  | { kind: "skipped"; reason: "running" | "disabled" }
  | {
      kind: "done";
      failed: boolean;
      // Run-level failures for the banner. A spec's own apply failure is shown
      // by name in the apply log instead, so its folded `apply <trashId>: …`
      // copy is left out here.
      errors: string[];
      applied: ApplyResult[];
      // Services the run refreshed; when there are any, runTrashSync has
      // usually moved the last-refresh stamp.
      refreshed: number;
    };

// POST /api/cron/trash-sync. It answers 200 for a degraded run (ok:false,
// errors[], applied[].ok=false) and marks it with X-Cron-Degraded, so the body
// decides; a skip is 200 { skipped, reason }.
export function syncOutcome(status: number, body: unknown, stoppedEarly: string): SyncOutcome {
  const httpOk = status >= 200 && status < 300;
  const b = isRecord(body) ? body : null;
  if (httpOk && b?.skipped === true) {
    return { kind: "skipped", reason: b.reason === TRASH_DISABLED_SKIP_REASON ? "disabled" : "running" };
  }
  const applied = applyResults(b?.applied);
  const folded = new Set(applied.flatMap((r) => (!r.ok && r.error ? [foldedApplyError(r.trashId, r.error)] : [])));
  const errors = [...new Set([
    ...strings(b?.errors).filter((e) => !folded.has(e)),
    // runTrashSync already folds each service's refresh errors into errors[];
    // only a cut-short pass adds a line of its own.
    ...records(b?.refreshed)
      .filter((r) => r.aborted === true)
      .map((r) => (typeof r.service === "string" ? `${r.service}: ` : "") + stoppedEarly),
  ])];
  const anyApplyFailed = applied.some((r) => !r.ok);
  const failed = !httpOk || b === null || b.ok === false || errors.length > 0 || anyApplyFailed;
  if (failed && errors.length === 0 && !anyApplyFailed) {
    errors.push(typeof b?.error === "string" ? b.error : `HTTP ${status}`);
  }
  return { kind: "done", failed, errors, applied, refreshed: records(b?.refreshed).length };
}

export type ApplyOutcome =
  | { kind: "skipped" }
  | {
      kind: "done";
      failed: boolean;
      /** The run's per-spec results, failures shown by name in the apply log. */
      results: ApplyResult[];
      /** A refusal with no per-spec results (403 off, 429, 400): the route's reason, else `fallback`. */
      errors: string[];
      /**
       * Sent ids a completed run returned no result for: a spec a catalog
       * refresh deleted meanwhile, or one a stopped run never reached. They
       * were NOT applied, so the run failed.
       */
      unanswered: string[];
    };

// POST /api/admin/trash-guides/apply. 409 = the trash lock is held and nothing
// ran: a skip, as for the other two routes. A refusal (TRaSH off, the rate
// limit, a bad body) answers a bare { error } with no per-spec results, so its
// reason goes to the banner; a run's own failures are in `results`.
export function applyOutcome(status: number, body: unknown, fallback: string, sent: readonly string[] = []): ApplyOutcome {
  if (status === 409) return { kind: "skipped" };
  const b = isRecord(body) ? body : null;
  const results = applyResults(b?.results);
  const httpOk = status >= 200 && status < 300;
  // Only a run that ran can leave an id unanswered; a refusal answered none.
  const answered = new Set(results.map((r) => r.specId));
  const unanswered = httpOk && b !== null && Array.isArray(b.results) ? sent.filter((id) => !answered.has(id)) : [];
  const failed = !httpOk || b?.ok !== true || results.some((r) => !r.ok) || unanswered.length > 0;
  const errors = failed && results.length === 0 && unanswered.length === 0
    ? [typeof b?.error === "string" && b.error ? b.error : fallback]
    : [];
  return { kind: "done", failed, results, errors, unanswered };
}
