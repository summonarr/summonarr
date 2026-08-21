import { withBasePath } from "@/lib/base-path";

// Client half of the background fix-match (guardrail 37a): start the job, then
// poll its status until it settles. Resolves with the same shape the
// synchronous POST returns; rejects with an Error carrying the client-safe
// message. Transient poll failures (a proxy blip, a sleeping tab) are retried —
// only a 404 (the server restarted and lost the in-memory job) or the overall
// deadline gives up, and both say what to do next instead of implying the
// remap failed.

export type FixMatchRequest = {
  server: "plex" | "jellyfin";
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  correctTmdbId: number;
  canonicalGuid?: string;
  serverInstance?: string;
};

export type FixMatchOutcome = { ok: true; warning?: string };

type StartBody = { ok?: boolean; jobId?: string; warning?: string; error?: string };
type StatusBody = { status?: "running" | "done" | "failed"; result?: FixMatchOutcome; error?: string };

const POLL_INTERVAL_MS = 3_000;
const MAX_WAIT_MS = 20 * 60_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 10;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runFixMatch(body: FixMatchRequest): Promise<FixMatchOutcome> {
  const res = await fetch(withBasePath("/api/admin/fix-match"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, async: true }),
  });
  let started: StartBody = {};
  try { started = await res.json() as StartBody; } catch { }
  if (!res.ok || !started.ok) throw new Error(started.error ?? `HTTP ${res.status}`);
  // A server that predates the job mode ignores `async` and answers the plain
  // synchronous result — honour it.
  if (!started.jobId) return started.warning ? { ok: true, warning: started.warning } : { ok: true };

  const statusUrl = withBasePath(`/api/admin/fix-match/status?id=${encodeURIComponent(started.jobId)}`);
  const deadline = Date.now() + MAX_WAIT_MS;
  let consecutiveFailures = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let pollRes: Response;
    try {
      pollRes = await fetch(statusUrl);
    } catch {
      if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error("Lost contact while the fix-match was running — run a library re-sync to see whether it landed.");
      }
      continue;
    }
    if (pollRes.status === 404) {
      throw new Error("The server lost track of this fix-match (restarted?) — run a library re-sync to see whether it landed.");
    }
    if (!pollRes.ok) {
      if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error(`Status check kept failing (HTTP ${pollRes.status}) — run a library re-sync to see whether the match landed.`);
      }
      continue;
    }
    consecutiveFailures = 0;
    const job = await pollRes.json().catch(() => ({})) as StatusBody;
    if (job.status === "done") return job.result ?? { ok: true };
    if (job.status === "failed") throw new Error(job.error ?? "Fix-match operation failed");
  }
  throw new Error("The fix-match is still running after 20 minutes — check the item on the media server or run a library re-sync.");
}
