import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { logAudit } from "@/lib/audit";
import { refreshCatalog, describeSchemaError, type RefreshResult } from "@/lib/trash";
import { withAdvisoryLock, TRASH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { checkRateLimit } from "@/lib/rate-limit";
import type { TrashService } from "@/generated/prisma";

function busyResponse() {
  return NextResponse.json(
    { ok: false, error: "Trash sync already running", retryAfter: 30 },
    { status: 409, headers: { "Retry-After": "30" } },
  );
}

export const POST = withAdmin(async (req, _ctx, session) => {
  // Per-admin rate limit. A refresh fans out to GitHub (pulling the TRaSH-Guides
  // catalog) AND to the configured Radarr/Sonarr instances, so calling it in a
  // tight loop would hammer GitHub's raw-content endpoints (risking 429s that
  // break the catalog fetch for everyone) and pile mutation requests onto the Arr
  // servers. Bounding it to 10 refreshes per 5-minute window per admin caps a
  // compromised admin session while still covering an operator's legitimate
  // manual refreshes.
  if (!checkRateLimit(`admin-trash-refresh:${session.user.id}`, 10, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many refreshes — try again shortly." }, { status: 429 });
  }
  // Body is optional. Accept missing/empty body silently (UI's "Refresh both" sends none); reject
  // malformed JSON loudly (typos otherwise silently fall through to "refresh both").
  const contentLength = req.headers.get("content-length");
  let body: { service?: unknown } = {};
  if (contentLength && contentLength !== "0") {
    const parsed = await readJsonCapped<{ service?: unknown }>(req, 8192);
    if (parsed instanceof NextResponse) return parsed;
    body = parsed;
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
});
