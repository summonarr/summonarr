import { prisma } from "@/lib/prisma";
import { processSingleton } from "@/lib/process-singleton";

// The database half of /api/health. The route is anonymous, and each probe is
// a `SELECT 1` on the small shared pool, so anyone could hold pool connections
// just by requesting it in a loop. The answer is therefore remembered for a
// moment, process-wide (guardrail 27a), and concurrent requests share ONE
// query.
//
// A healthy answer is reused for HEALTH_UP_TTL_MS; a failed one for less, so a
// database that comes back is seen at once and an outage is still re-checked
// several times a second at most. Both are far below the Docker HEALTHCHECK's
// interval, so the container probe always sees a fresh answer.
export const HEALTH_UP_TTL_MS = 2_000;
export const HEALTH_DOWN_TTL_MS = 500;

const state = processSingleton<{
  last: { up: boolean; at: number } | null;
  inflight: Promise<boolean> | null;
}>("health:db-probe", () => ({ last: null, inflight: null }));

// Whether Postgres answers. Never rejects. `now` is injectable for tests.
export function probeDatabase(now: () => number = Date.now): Promise<boolean> {
  const last = state.last;
  if (last && now() - last.at < (last.up ? HEALTH_UP_TTL_MS : HEALTH_DOWN_TTL_MS)) {
    return Promise.resolve(last.up);
  }
  if (state.inflight) return state.inflight;
  const probe = (async () => {
    let up = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      up = false;
      console.error("[health] DB readiness check failed:", err instanceof Error ? err.message : err);
    }
    state.last = { up, at: now() };
    return up;
  })().finally(() => {
    state.inflight = null;
  });
  state.inflight = probe;
  return probe;
}

/** Test seam: forget the remembered answer. */
export function __resetHealthProbeForTests(): void {
  state.last = null;
  state.inflight = null;
}
