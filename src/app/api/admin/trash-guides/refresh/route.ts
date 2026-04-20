import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { refreshCatalog, describeSchemaError, type RefreshResult } from "@/lib/trash";
import type { TrashService } from "@/generated/prisma";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { service?: string } = {};
  try {
    body = await req.json();
  } catch {

  }

  const services: TrashService[] =
    body.service === "radarr" ? ["RADARR"]
      : body.service === "sonarr" ? ["SONARR"]
        : ["RADARR", "SONARR"];

  const startTime = Date.now();
  const results: RefreshResult[] = [];
  const errors: string[] = [];
  let schemaDiagnostic: string | null = null;
  for (const service of services) {
    try {
      results.push(await refreshCatalog(service));
    } catch (err) {
      const schemaHint = describeSchemaError(err);
      if (schemaHint) schemaDiagnostic = schemaHint;
      errors.push(`${service}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const durationMs = Date.now() - startTime;
  await logAudit({
    userId: session.user.id,
    userName: session.user.name ?? "admin",
    action: "SETTINGS_CHANGE",
    target: "trash:refresh",
    details: { results, errors, durationMs, trigger: "admin" },
  });

  return NextResponse.json({
    ok: errors.length === 0,
    results,
    errors,
    durationMs,
    ...(schemaDiagnostic ? { schemaDiagnostic } : {}),
  });
}
