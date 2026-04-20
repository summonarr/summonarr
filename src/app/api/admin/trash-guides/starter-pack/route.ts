import { NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { applySpecs, describeSchemaError } from "@/lib/trash";
import { resolveStarterPack, STARTER_PACK } from "@/lib/trash-recommendations";

export async function GET() {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
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
}

export async function POST() {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const items = await resolveStarterPack();
    const specIds = items.filter((i) => i.spec).map((i) => i.spec!.id);
    const missing = items.filter((i) => !i.spec).map((i) => i.item.label);

    const startTime = Date.now();
    const results = specIds.length > 0 ? await applySpecs(specIds) : [];
    const durationMs = Date.now() - startTime;

    await logAudit({
      userId: session.user.id,
      userName: session.user.name ?? "admin",
      action: "SETTINGS_CHANGE",
      target: "trash:starter-pack",
      details: {
        applied: results.length,
        failures: results.filter((r) => !r.ok).length,
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
}
