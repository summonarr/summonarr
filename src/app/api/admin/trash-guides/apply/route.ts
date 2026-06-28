import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { logAudit } from "@/lib/audit";
import { applySpecs } from "@/lib/trash";
import type { ArrVariant } from "@/lib/arr";
import { withAdvisoryLock, TRASH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { checkRateLimit } from "@/lib/rate-limit";

function busyResponse() {
  return NextResponse.json(
    { ok: false, error: "Trash sync already running", retryAfter: 30 },
    { status: 409, headers: { "Retry-After": "30" } },
  );
}

export const POST = withAdmin(async (req, _ctx, session) => {
  // Per-admin rate limit. Applying specs issues a burst of write requests to the
  // configured Radarr/Sonarr instances (creating/updating custom formats and
  // quality profiles), so an unbounded loop here would hammer those Arr servers
  // with mutations and could leave their config thrashing. Bounding it to 10
  // applies per 5-minute window per admin stops a compromised admin session from
  // flooding the Arr instances while leaving ample headroom for an operator
  // iterating on their profile setup.
  if (!checkRateLimit(`admin-trash-apply:${session.user.id}`, 10, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many apply requests — try again shortly." }, { status: 429 });
  }
  const parsed = await readJsonCapped<{ specIds?: unknown; variant?: unknown }>(req, 32768);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (!Array.isArray(body.specIds) || body.specIds.some((v) => typeof v !== "string")) {
    return NextResponse.json({ error: "specIds must be string[]" }, { status: 400 });
  }
  const ids = body.specIds as string[];
  // Anything other than the literal "4k" routes to the HD instance — fail-safe default.
  const variant: ArrVariant = body.variant === "4k" ? "4k" : "hd";
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, results: [] });
  }
  if (ids.length > 500) {
    return NextResponse.json({ error: "Too many specs — apply in batches of 500" }, { status: 400 });
  }

  return withAdvisoryLock(
    TRASH_SYNC_LOCK_ID,
    async () => {
      const startTime = Date.now();
      const results = await applySpecs(ids, variant);
      const durationMs = Date.now() - startTime;

      const failures = results.filter((r) => !r.ok);
      const recreated = results.filter((r) => r.recreated).length;
      await logAudit({
        userId: session.user.id,
        userName: session.user.name ?? "admin",
        action: "SETTINGS_CHANGE",
        target: "trash:apply",
        details: {
          variant,
          count: results.length,
          failures: failures.length,
          ...(recreated > 0 ? { recreated } : {}),
          durationMs,
          specIds: ids,
        },
      });

      return NextResponse.json({
        ok: failures.length === 0,
        results,
        durationMs,
      });
    },
    busyResponse,
  );
});
