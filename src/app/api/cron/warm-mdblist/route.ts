import { prewarmMdblistCache } from "@/lib/mdblist-prewarm";
import { WARM_MDBLIST_LOCK_ID } from "@/lib/advisory-lock";
import { defineCronRoute } from "@/lib/cron-route";
import { prisma } from "@/lib/prisma";

export const POST = defineCronRoute({
  target: "mdblist",
  lockId: WARM_MDBLIST_LOCK_ID,
  cacheWarm: true,
  // Not configured: no run happened, so it is answered as a skip and kept out
  // of the run history, decided before the lock.
  skipReason: async () => {
    const apiKey = await prisma.setting.findUnique({ where: { key: "mdblistApiKey" } });
    return apiKey?.value.trim() ? null : "no MDBList API key configured";
  },
  async run({ signal }) {
    const result = await prewarmMdblistCache({ signal });
    return {
      body: { ...result },
      problems: result.failed,
      error: `${result.failed} of ${result.total} MDBList items failed to warm`,
    };
  },
});
