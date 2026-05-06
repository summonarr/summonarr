import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { logAudit } from "@/lib/audit";
import { refreshCatalog, describeSchemaError, type RefreshResult } from "@/lib/trash";
import { withAdvisoryLock, TRASH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import type { TrashService } from "@/generated/prisma";

function busyResponse() {
  return NextResponse.json(
    { ok: false, error: "Trash sync already running", retryAfter: 30 },
    { status: 409, headers: { "Retry-After": "30" } },
  );
}

export async function POST(req: NextRequest) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  // Body is optional. Accept missing/empty body silently (UI's "Refresh both" sends none); reject
  // malformed JSON loudly (typos otherwise silently fall through to "refresh both").
  const contentLength = req.headers.get("content-length");
  let body: { service?: unknown } = {};
  if (contentLength && contentLength !== "0") {
    try {
      body = (await req.json()) as { service?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
  }
  if (body.service !== undefined && body.service !== "radarr" && body.service !== "sonarr") {
    return NextResponse.json(
      { error: "service must be 'radarr' or 'sonarr'" },
      { status: 400 },
    );
  }

  const services: TrashService[] =
    body.service === "radarr" ? ["RADARR"]
      : body.service === "sonarr" ? ["SONARR"]
        : ["RADARR", "SONARR"];

  return withAdvisoryLock(
    TRASH_SYNC_LOCK_ID,
    async () => {
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
    },
    busyResponse,
  );
}
