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

export async function triggerFullSync(): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return; // no auth token available — silently skip (matches prior behaviour)

  const port = process.env.PORT ?? "3000";
  // On a sub-path deployment Next serves the route at `${BASE_PATH}/api/sync`;
  // a bare `/api/sync` would 404 and the SSE-driven full sync would never run.
  const basePath = process.env.BASE_PATH ?? "";
  const url = `http://127.0.0.1:${port}${basePath}/api/sync`;
  // Assumes the single long-lived process model (Docker container on PORT), so
  // the loopback hits the correct process; multi-instance affects only the local one.

  // Cap the wait so a slow or stuck orchestrator run does not hold the
  // debounced Plex timeline handler indefinitely.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    // Await so errors are visible; the body is ignored on success (the handler
    // does the work, or returns 200 { skipped: true } when the lock is held).
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
    }
  } catch (err) {
    // Do not throw — the caller (Plex timeline path) already treats this as
    // best-effort and only logs at warn level. Keep the same contract.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[internal-trigger] full sync trigger failed: ${msg}`);
  } finally {
    clearTimeout(timeout);
  }
}
