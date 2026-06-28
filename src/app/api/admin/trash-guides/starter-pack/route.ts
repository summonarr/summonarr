import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { logAudit } from "@/lib/audit";
import { applySpecs, describeSchemaError } from "@/lib/trash";
import { resolveStarterPack, STARTER_PACK } from "@/lib/trash-recommendations";
import { withAdvisoryLock, TRASH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { isFeatureEnabled } from "@/lib/features";

function busyResponse() {
  return NextResponse.json(
    { ok: false, error: "Trash sync already running", retryAfter: 30 },
    { status: 409, headers: { "Retry-After": "30" } },
  );
}

export const GET = withAdmin(async (_req, _ctx, _session) => {
  try {
    const items = await resolveStarterPack();
    return NextResponse.json({ items });
  } catch (err) {
    const schemaDiagnostic = describeSchemaError(err);
    if (schemaDiagnostic) {
      // TrashSpec table doesn't exist yet (schema not migrated); return empty list with hint instead of 500
      const emptyItems = STARTER_PACK.map((item) => ({ item, spec: null, application: null }));
      return NextResponse.json({ items: emptyItems, schemaDiagnostic });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ items: [], error: message }, { status: 500 });
  }
});

export const POST = withAdmin(async (_req, _ctx, session) => {
  // Kill-switch parity: applies curated specs to Radarr/Sonarr, so a disabled TRaSH
  // integration must block it. (GET is a read-only preview and stays open.)
  if (!(await isFeatureEnabled("trashGuidesEnabled"))) {
    return NextResponse.json({ error: "TRaSH Guides integration is disabled" }, { status: 403 });
  }
  return withAdvisoryLock(
    TRASH_SYNC_LOCK_ID,
    async () => {
      try {
        const items = await resolveStarterPack();
        // Only the curated STARTER_PACK entries (recommended:true). resolveStarterPack
        // also returns every non-curated profile/naming/size spec (for the GET
        // picker); filtering on `i.spec` alone would push the ENTIRE TRaSH catalog
        // to Radarr/Sonarr and overwrite the operator's existing custom profiles.
        const curated = items.filter((i) => i.item.recommended);
        const specIds = curated.filter((i) => i.spec).map((i) => i.spec!.id);
        const missing = curated.filter((i) => !i.spec).map((i) => i.item.label);

        const startTime = Date.now();
        const results = specIds.length > 0 ? await applySpecs(specIds) : [];
        const durationMs = Date.now() - startTime;

        const recreated = results.filter((r) => r.recreated).length;
        await logAudit({
          userId: session.user.id,
          userName: session.user.name ?? "admin",
          action: "SETTINGS_CHANGE",
          target: "trash:starter-pack",
          details: {
            applied: results.length,
            failures: results.filter((r) => !r.ok).length,
            ...(recreated > 0 ? { recreated } : {}),
            missing,
            durationMs,
          },
        });

        return NextResponse.json({
          ok: results.every((r) => r.ok) && missing.length === 0,
          results,
          missing,
          durationMs,
        });
      } catch (err) {
        const schemaDiagnostic = describeSchemaError(err);
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
          { ok: false, error: message, ...(schemaDiagnostic ? { schemaDiagnostic } : {}) },
          { status: schemaDiagnostic ? 409 : 500 },
        );
      }
    },
    busyResponse,
  );
});
