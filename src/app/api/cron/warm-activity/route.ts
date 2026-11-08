import { clearActivityCache, warmActivityCache } from "@/lib/play-history";
import { WARM_ACTIVITY_LOCK_ID } from "@/lib/advisory-lock";
import { defineCronRoute } from "@/lib/cron-route";

// Every run lands in the cron history (Admin -> Settings -> System) for both
// admin and cron triggers — a throw, a lock connection that fails or a lock
// timeout as a failed run — and a busy-lock skip does not. This warm has no
// partial-failure count: it either finishes (ok) or throws.
export const POST = defineCronRoute({
  target: "activity",
  lockId: WARM_ACTIVITY_LOCK_ID,
  cacheWarm: true,
  async run() {
    clearActivityCache();
    const { warmed } = await warmActivityCache();
    return { body: { warmed } };
  },
});
