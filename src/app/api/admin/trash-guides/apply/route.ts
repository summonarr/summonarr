import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { applySpecs } from "@/lib/trash";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { specIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.specIds) || body.specIds.some((v) => typeof v !== "string")) {
    return NextResponse.json({ error: "specIds must be string[]" }, { status: 400 });
  }
  const ids = body.specIds as string[];
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, results: [] });
  }
  if (ids.length > 500) {
    return NextResponse.json({ error: "Too many specs — apply in batches of 500" }, { status: 400 });
  }

  const startTime = Date.now();
  const results = await applySpecs(ids);
  const durationMs = Date.now() - startTime;

  const failures = results.filter((r) => !r.ok);
  await logAudit({
    userId: session.user.id,
    userName: session.user.name ?? "admin",
    action: "SETTINGS_CHANGE",
    target: "trash:apply",
    details: {
      count: results.length,
      failures: failures.length,
      durationMs,
      specIds: ids,
    },
  });

  return NextResponse.json({
    ok: failures.length === 0,
    results,
    durationMs,
  });
}
