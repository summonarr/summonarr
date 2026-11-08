// The Initial DB Fill's outcome rules (master-db-fill-button.tsx), pure so the
// unit suite can run them: what each step's answer means for the line the
// button shows, and its colour.
//
// - A step with no answer yet (a library server, the warm) may still be
//   running on the server: "pending", never a failure (guardrail 37a).
// - A failure never hides what the earlier step did: the warm's error rides
//   after the per-server library results, so the admin can tell whether the
//   library sync itself went through.
import type { Translator } from "@/lib/i18n/translate";
import { isNoAnswer, jobAnswerError, type LibrarySyncOutcome } from "@/lib/client/library-sync";
import { check, v } from "@/lib/validate";

export type FillEndPhase = "done" | "pending" | "error";
export interface FillEnd {
  phase: FillEndPhase;
  summary: string;
}

/** Phase 1, read: each configured server's line, and whether the warm should run at all. */
export interface FillLibraryStep {
  texts: string[];
  /** Every server failed: there is no library to warm from. */
  allFailed: boolean;
  /** Some server failed: the run goes on, but can't end green. */
  degraded: boolean;
  /** Some server hasn't answered yet: the run goes on, but can't end green. */
  pending: boolean;
}

export function fillLibraryStep(outcomes: readonly { outcome: LibrarySyncOutcome; text: string }[]): FillLibraryStep {
  return {
    texts: outcomes.map((o) => o.text),
    allFailed: outcomes.every((o) => o.outcome.kind === "failed"),
    degraded: outcomes.some((o) => o.outcome.kind === "failed"),
    pending: outcomes.some((o) => o.outcome.kind === "noAnswer"),
  };
}

/** Phase 1 stopped the run: every configured server failed. */
export function fillLibraryFailedEnd(step: FillLibraryStep, t: Translator): FillEnd {
  return { phase: "error", summary: t("adminManage.library.fill.libraryFailedWith", { detail: step.texts.join(" · ") }) };
}

// The warm's counts; a field it left out (or sent as something else) counts 0.
const WarmCounts = v.object({
  fetched: v.optional(v.unknown()),
  backfilled: v.optional(v.unknown()),
  skipped: v.optional(v.unknown()),
  failed: v.optional(v.unknown()),
});
const countOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The warm threw before it answered (its start request got no response). */
export function fillWarmThrewEnd(step: FillLibraryStep, t: Translator): FillEnd {
  return { phase: "error", summary: [...step.texts, t("adminManage.library.fill.warmFailed")].join(" · ") };
}

/** Phase 2's answer, read against phase 1. */
export function fillWarmEnd(
  step: FillLibraryStep,
  warm: { status: number; data: unknown },
  t: Translator,
  locale: string,
): FillEnd {
  // Name every configured server, even one that scanned 0 items, so a failed
  // server can never silently drop out of the summary.
  const parts = [...step.texts];
  if (isNoAnswer(warm)) {
    // No answer is not a failure: the warm may still be running.
    parts.push(t("adminManage.library.fill.warmNoAnswer"));
    return { phase: step.degraded ? "error" : "pending", summary: parts.join(" · ") };
  }
  const warmError = jobAnswerError(warm);
  if (warm.status < 200 || warm.status >= 300 || warmError) {
    parts.push(warmError ?? t("adminManage.library.fill.warmFailedStatus", { status: warm.status }));
    return { phase: "error", summary: parts.join(" · ") };
  }
  const read = check(WarmCounts, warm.data);
  const counts = read.ok ? read.value : {};
  const fetched = countOf(counts.fetched);
  const backfilled = countOf(counts.backfilled);
  const skipped = countOf(counts.skipped);
  const failed = countOf(counts.failed);
  const tmdbParts: string[] = [];
  if (fetched > 0) tmdbParts.push(t("adminManage.library.fill.fetched", { value: fetched.toLocaleString(locale) }));
  if (backfilled > 0) tmdbParts.push(t("adminManage.library.fill.backfilled", { value: backfilled.toLocaleString(locale) }));
  if (skipped > 0) tmdbParts.push(t("adminManage.library.fill.cached", { value: skipped.toLocaleString(locale) }));
  if (failed > 0) tmdbParts.push(t("adminManage.library.fill.failed", { value: failed.toLocaleString(locale) }));
  parts.push(`TMDB: ${tmdbParts.join(", ") || t("adminManage.library.btn.items", { count: 0, formatted: "0" })}`);
  // A summary that names a failed server or failed TMDB items must not render
  // green — the two together read as "this worked" over the top of "this did
  // not". A server with no answer yet isn't green either.
  return {
    phase: step.degraded || failed > 0 ? "error" : step.pending ? "pending" : "done",
    summary: parts.join(" · "),
  };
}

/**
 * How long a finished run's line stays before the button goes back to idle,
 * or null to keep it: a failure stays until the next run, so an admin who
 * stepped away during a long fill still sees what went wrong.
 */
export function fillResetDelayMs(phase: FillEndPhase): number | null {
  return phase === "error" ? null : 20_000;
}
