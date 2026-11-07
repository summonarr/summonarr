import { NextResponse } from "next/server";
import { readOptionalJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { logAudit, auditContext } from "@/lib/audit";
import { refreshCatalog, fetchTrashTree, describeSchemaError, type RefreshResult, type TrashTree } from "@/lib/trash";
import { withAdvisoryLock, TRASH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { checkRateLimit } from "@/lib/rate-limit";
import { isFeatureEnabled } from "@/lib/features";
import type { TrashService } from "@/generated/prisma";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { lockBusyResponse } from "@/lib/lock-http";
import { prisma } from "@/lib/prisma";

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // Kill-switch parity with the nightly cron: refresh fans out to the configured
  // Radarr/Sonarr instances, so a disabled TRaSH integration must block it too.
  if (!(await isFeatureEnabled("trashGuidesEnabled"))) {
    return NextResponse.json({ error: t("apiAdmin.trash.disabled") }, { status: 403 });
  }
  // Per-admin rate limit. A refresh fans out to GitHub (catalog pull) AND to
  // Radarr/Sonarr; a tight loop risks GitHub 429s (breaking the fetch for everyone)
  // and piles mutations on the Arr servers. 10 per 5-minute window caps a
  // compromised session while covering legitimate manual refreshes.
  if (!checkRateLimit(`admin-trash-refresh:${session.user.id}`, 10, 5 * 60 * 1000)) {
    return NextResponse.json({ error: t("apiAdmin.trash.tooManyRefreshes") }, { status: 429 });
  }
  // The body is optional: no body means "refresh both" (the UI sends none). But a
  // body that IS present must be valid JSON, so a typo can't quietly become "refresh both".
  // It is read whether or not Content-Length was sent: a chunked body has none.
  const parsed = await readOptionalJsonCapped<{ service?: unknown }>(req, 8192, {});
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;
  if (body.service !== undefined && body.service !== "radarr" && body.service !== "sonarr") {
    return NextResponse.json(
      { error: t("apiAdmin.common.serviceRadarrOrSonarrQuoted") },
      { status: 400 },
    );
  }

  const services: TrashService[] =
    body.service === "radarr" ? ["RADARR"]
      : body.service === "sonarr" ? ["SONARR"]
        : ["RADARR", "SONARR"];

  return withAdvisoryLock(
    TRASH_SYNC_LOCK_ID,
    async (signal: AbortSignal) => {
      const startTime = Date.now();
      const results: RefreshResult[] = [];
      const errors: string[] = [];
      let schemaDiagnostic: string | null = null;
      // Fetch the GitHub file listing ONCE and share it across services — it is
      // the same for RADARR and SONARR, so fetching it per service would double
      // the download and the GitHub rate-limit cost. Mirrors runTrashSync. If
      // the fetch fails, every requested service gets the same error line.
      let sharedTree: TrashTree | null = null;
      try {
        sharedTree = await fetchTrashTree();
      } catch (err) {
        const schemaHint = describeSchemaError(err);
        if (schemaHint) schemaDiagnostic = schemaHint;
        const msg = err instanceof Error ? err.message : String(err);
        for (const service of services) errors.push(`${service}: ${msg}`);
      }
      if (sharedTree !== null) {
        for (const service of services) {
          // The lock's work timeout aborts the refresh at its next batch boundary
          // (guardrail 41); the partial result is still reported and audited.
          if (signal.aborted) break;
          try {
            const r = await refreshCatalog(service, sharedTree, { signal });
            results.push(r);
            // Per-file failures (a download, a parse, a validator reject) are part
            // of this refresh's outcome, as in runTrashSync: without them `ok` and
            // the audit row read a partly failed refresh as clean.
            errors.push(...r.errors.map((e) => `${service}: ${e}`));
          } catch (err) {
            const schemaHint = describeSchemaError(err);
            if (schemaHint) {
              schemaDiagnostic = schemaHint;
              errors.push(`${service}: ${err instanceof Error ? err.message : String(err)}`);
            } else {
              // The tree is already fetched, so this is our own store failing: its
              // text can name the database host or a query, which stays in the log.
              console.error(`[trash] ${service} catalog refresh failed:`, err);
              errors.push(`${service}: ${t("apiAdmin.trash.internalError")}`);
            }
          }
        }
      }

      // Same stamp as runTrashSync: at least one service refreshed and the lock
      // did not cut the pass short. It drives the cron's once-an-hour cadence
      // gate and the "last refreshed" line on the settings card.
      const aborted = signal.aborted || results.some((r) => r.aborted);
      if (results.length > 0 && !aborted) {
        const value = new Date().toISOString();
        await prisma.setting.upsert({
          where: { key: "trashLastRefreshAt" },
          update: { value },
          create: { key: "trashLastRefreshAt", value },
        }).catch((err) => {
          console.warn("[trash] failed to stamp last-refresh-at:", err instanceof Error ? err.message : err);
        });
      }

      const durationMs = Date.now() - startTime;
      await logAudit({
        userId: session.user.id,
        userName: session.user.name ?? session.user.email,
        ...auditContext(req, session),
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
    () => lockBusyResponse(t("apiAdmin.trash.alreadyRunning")),
  );
});
