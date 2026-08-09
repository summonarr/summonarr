// Trusted same-process triggers that must go through the public cron/sync
// surface so that isCronAuthorized, withCronRunRecording, the orchestrator
// advisory lock (SYNC_ORCHESTRATOR_LOCK_ID = 2000), and audit recording all
// behave exactly as an external CRON_SECRET caller would.
//
// This is the *sole* permitted direct `fetch` for server-side outbound HTTP
// (see Claude.md guardrail 5a). All other external HTTP must use safeFetch*.
//
// Target is always hardcoded 127.0.0.1 + CRON_SECRET; SSRF policy does not
// apply. The call is intentionally to the public route so the full path
// (proxy → isCronAuthorized → withAdvisoryLock → runSyncOrchestrator) is used.

/** How long the trigger waits before giving up on the response. */
export const TRIGGER_WAIT_MS = 30_000;

/**
 * Abort reason used when our own wait expires.
 *
 * The distinction it carries is load-bearing: the sync route never observes
 * `request.signal` (the only AbortSignal it receives is withAdvisoryLock's, and
 * runSyncOrchestrator explicitly discards it), and nothing awaits this promise
 * — the Plex timeline handler calls it as `void triggerLibrarySync()`. So an
 * expired wait cancels nothing; the orchestrator runs to completion and
 * withCronRunRecording still records the run. A genuine transport error
 * (ECONNREFUSED — the server is not listening) is a real problem and must keep
 * reading as a failure.
 *
 * If anything ever wires `request.signal` into the orchestrator, this
 * reasoning changes and the message below has to change with it.
 */
class TriggerWaitExpired extends Error {
  constructor() {
    super(`internal sync trigger stopped waiting after ${TRIGGER_WAIT_MS}ms`);
    this.name = "TriggerWaitExpired";
  }
}

/**
 * Outcome discriminator for the caller's retry decision:
 * - "ran": the orchestrator processed this trigger (including the
 *   stopped-waiting case — the run continues server-side).
 * - "skipped": the orchestrator's advisory lock was held by another run; the
 *   trigger did nothing and the caller may re-arm its debounce.
 * - "failed": transport/HTTP/config failure (already warned). Callers must NOT
 *   blindly retry — a broken loopback would retry forever.
 */
export type TriggerFullSyncResult = "ran" | "skipped" | "failed";

export async function triggerFullSync(): Promise<TriggerFullSyncResult> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return "failed"; // no auth token available — silently skip (matches prior behaviour)

  const port = process.env.PORT ?? "3000";
  // On a sub-path deployment Next serves the route at `${BASE_PATH}/api/sync`;
  // a bare `/api/sync` would 404 and the SSE-driven full sync would never run.
  const basePath = process.env.BASE_PATH ?? "";
  const url = `http://127.0.0.1:${port}${basePath}/api/sync`;
  // Assumes the single long-lived process model (Docker container on PORT), so
  // the loopback hits the correct process; multi-instance affects only the local one.

  // Cap the wait so a slow or stuck orchestrator run does not hold the
  // debounced Plex timeline handler indefinitely.
  //
  // Giving abort() an explicit reason is what lets the catch below tell "we
  // stopped waiting" apart from "the request genuinely failed". A bare
  // abort() yields a generic `AbortError: This operation was aborted`, which
  // read as a failed sync in the logs and sent operators chasing a
  // non-problem.
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new TriggerWaitExpired()),
    TRIGGER_WAIT_MS,
  );

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      // Best-effort trigger: surface the HTTP error for operators but do not
      // throw or block the timeline handler.
      const body = await res.text().catch(() => '');
      console.warn(
        `[internal-trigger] full sync trigger got non-2xx ${res.status} from /api/sync: ${body.slice(0, 200)}`
      );
      return "failed";
    }
    // A 200 has two meanings: the orchestrator ran, or it returned
    // { skipped: true } because another run holds the advisory lock. The
    // caller needs the distinction — a dropped timeline trigger used to make
    // a library change wait up to SYNC_INTERVAL. An unparseable success body
    // reads as "ran" (never re-arm on ambiguity).
    const body = (await res.json().catch(() => null)) as { skipped?: boolean } | null;
    return body?.skipped === true ? "skipped" : "ran";
  } catch (err) {
    // Do not throw — the caller (Plex timeline path) already treats this as
    // best-effort and only logs at warn level. Keep the same contract.
    if (controller.signal.reason instanceof TriggerWaitExpired) {
      // Our own deadline, not a failure. The sync is still running; say so,
      // and do not use the word "failed" for something that did not fail.
      console.warn(
        `[internal-trigger] sync still running after ${TRIGGER_WAIT_MS}ms; stopped waiting ` +
          `(the run continues — see the sync:full entry under Admin → Settings → System)`,
      );
      return "ran";
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[internal-trigger] full sync trigger failed: ${msg}`);
    return "failed";
  } finally {
    clearTimeout(timeout);
  }
}
