import { DOWNLOAD_POLICIES_LOCK_ID } from "@/lib/advisory-lock";
import { defineCronRoute } from "@/lib/cron-route";
import { syncDownloadPolicies } from "@/lib/download-policy";

export const POST = defineCronRoute({
  target: "download-policies",
  lockId: DOWNLOAD_POLICIES_LOCK_ID,
  async run({ elapsedMs }) {
    const results = await syncDownloadPolicies();
    const durationMs = elapsedMs();
    const totals = results.reduce(
      (acc, r) => ({
        upserted: acc.upserted + r.upserted,
        enforced: acc.enforced + r.enforced,
        errors: acc.errors + r.errors,
      }),
      { upserted: 0, enforced: 0, errors: 0 },
    );
    // `error` (singular) is the field the admin Run-now badge surfaces —
    // `errors` (the count) alone rendered as a bare "HTTP 500" where every
    // sibling names the failure.
    return {
      body: { durationMs, ...totals, sources: results.map((r) => r.source) },
      problems: totals.errors,
      error: `${totals.errors} download-policy error(s)`,
    };
  },
});
