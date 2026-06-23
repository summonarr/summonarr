import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { logAudit } from "@/lib/audit";
import { applySpecs } from "@/lib/trash";
import type { ArrVariant } from "@/lib/arr";
import { withAdvisoryLock, TRASH_SYNC_LOCK_ID } from "@/lib/advisory-lock";

function busyResponse() {
  return NextResponse.json(
    { ok: false, error: "Trash sync already running", retryAfter: 30 },
    { status: 409, headers: { "Retry-After": "30" } },
  );
}

export const POST = withAdmin(async (req, _ctx, session) => {
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
