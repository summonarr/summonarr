import { prewarmOmdbCache } from "@/lib/omdb-prewarm";
import { WARM_OMDB_LOCK_ID } from "@/lib/advisory-lock";
import { defineCronRoute } from "@/lib/cron-route";
import { prisma } from "@/lib/prisma";

export const POST = defineCronRoute({
  target: "omdb",
  lockId: WARM_OMDB_LOCK_ID,
  cacheWarm: true,
  // Not configured: no run happened, so it is answered as a skip and kept out
  // of the run history, decided before the lock.
  skipReason: async () => {
    const apiKey = await prisma.setting.findUnique({ where: { key: "omdbApiKey" } });
    return apiKey?.value.trim() ? null : "no OMDB API key configured";
  },
  async run({ signal }) {
    const result = await prewarmOmdbCache({ signal });
    return {
      body: { ...result },
      problems: result.failed,
      error: `${result.failed} of ${result.total} OMDB items failed to warm`,
    };
  },
});
