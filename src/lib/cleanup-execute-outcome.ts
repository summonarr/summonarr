// What a non-OK answer to the Library cleanup EXECUTE says about what happened —
// pure, zero imports, so the unit runner loads it (the hook that reads it,
// src/components/admin/cleanup-delete.tsx, is .tsx and can't).
//
// The execute is one synchronous request: a fresh listing of every instance,
// then up to 500 titles' upstream DELETEs. Behind a reverse proxy that closes a
// request after ~60–100 s (the guardrail-37a lesson) the browser gets the
// PROXY's 502/504 while the route keeps deleting. Read as "the delete failed",
// that left "Delete N now" offered over titles already gone, and a second click
// started a second execute over the same titles beside the first.
//
// So only the ROUTE's own refusal is definite: every JSON `{ error }` it answers
// (400 a bad body, 401/403 from withAdmin, 404 the feature off, 409 handled by
// the caller) is returned BEFORE the first upstream delete, so nothing was
// removed and the plan can stand. Anything else — a gateway status, a body that
// isn't the route's JSON (a proxy's HTML page, the framework's 500 page after a
// throw mid-run) — is OUTCOME UNKNOWN: some titles may already be gone.

// Statuses a proxy or gateway answers with, whatever the body says.
export const CLEANUP_GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export type CleanupExecuteFailure =
  | { kind: "refused"; error: string }
  | { kind: "unknown" };

export function cleanupExecuteFailure(status: number, body: unknown): CleanupExecuteFailure {
  if (CLEANUP_GATEWAY_STATUSES.has(status)) return { kind: "unknown" };
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (typeof error === "string" && error.length > 0) return { kind: "refused", error };
  return { kind: "unknown" };
}
