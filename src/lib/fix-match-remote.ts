import { safeFetchAdminConfigured } from "@/lib/safe-fetch";
import { translatorFor } from "@/lib/i18n/server-locale";
import type { TranslateVars } from "@/lib/i18n/translate";
import type { FixMatchReport } from "@/lib/fix-match-jobs";

// Plumbing the Plex and Jellyfin remap helpers share (fix-match-plex.ts,
// fix-match-jellyfin.ts): progress reporting, the best-effort refresh, a JSON
// read that never throws, and the diagnostic error a failed remap explains
// itself with.

/** The progress a remote helper reports (fix-match-jobs.ts adds `updatedAt`). */
export type RemoteProgress = Parameters<FixMatchReport>[0];

/**
 * A progress record a remote helper mutates as it works, and `push` to hand a
 * copy to the job (a no-op on a run nobody polls). Starts at "searching".
 */
export function remoteProgress(report: FixMatchReport | undefined): { progress: RemoteProgress; push: () => void } {
  const progress: RemoteProgress = { phase: "searching", remoteApplied: false, attempt: 0, attempts: 0, readFailures: 0 };
  return { progress, push: () => report?.({ ...progress }) };
}

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The body as JSON, or null when it isn't JSON — an unreadable answer is a failed read, never a throw. */
export async function readJsonOrNull(res: Response): Promise<unknown> {
  return res.json().catch(() => null);
}

/** A string an upstream sent, or "" for anything else. */
export function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

// A refresh queued after the match was APPLIED: best-effort, because the
// confirmation poll that follows is the sole success arbiter, so a transient
// refresh failure must not report the whole fix-match as failed.
export async function refreshBestEffort(url: string, init: { method: string; headers: Record<string, string> }, tag: string): Promise<void> {
  await safeFetchAdminConfigured(url, { ...init, timeoutMs: 30_000 })
    .catch((e: unknown) => { console.warn("[fix-match]", tag, "refresh call failed (non-fatal):", e); return null; });
}

/**
 * The catalog keys a failed remote remap explains itself with. Each says what
 * state the item was left in and what the admin can do next.
 */
export type FixMatchDiagnosticKey =
  | "apiAdmin.fixMatch.plexNotConfirmed"
  | "apiAdmin.fixMatch.jellyfinNoCandidate"
  | "apiAdmin.fixMatch.jellyfinStillProcessing"
  | "apiAdmin.fixMatch.jellyfinUnreadable"
  | "apiAdmin.fixMatch.jellyfinLocked"
  | "apiAdmin.fixMatch.jellyfinStillPrevious"
  | "apiAdmin.fixMatch.jellyfinStillPreviousNfo"
  | "apiAdmin.fixMatch.jellyfinStillPreviousNfoSaver"
  | "apiAdmin.fixMatch.jellyfinNotConfirmed";

/**
 * A remote remap that failed in a way the admin can act on ("the item is
 * locked — unlock it", "still processing — don't retry yet"). The route answers
 * the caller with `t(key, vars)` in their language; `vars` hold only ids,
 * counts and a library name, never a URL, path or token, so the answer stays
 * client-safe (guardrail 37a). The message — for the server log — is the
 * English text plus whatever upstream `detail` explains it.
 */
export class FixMatchDiagnosticError extends Error {
  readonly key: FixMatchDiagnosticKey;
  readonly vars: TranslateVars;
  constructor(key: FixMatchDiagnosticKey, vars: TranslateVars, detail?: string) {
    const english = translatorFor("en")(key, vars);
    super(detail ? `${english} (${detail})` : english);
    this.name = "FixMatchDiagnosticError";
    this.key = key;
    this.vars = vars;
  }
}
