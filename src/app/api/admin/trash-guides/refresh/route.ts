import { NextResponse } from "next/server";
import { readOptionalJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { logAudit, auditContext } from "@/lib/audit";
import { refreshCatalog, fetchTrashTree, describeSchemaError, type RefreshResult, type TrashTree } from "@/lib/trash";
import { withAdvisoryLock, TRASH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { isFeatureEnabled } from "@/lib/features";
import type { TrashService } from "@/generated/prisma";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
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
    return tooManyRequests(5 * 60, t("apiAdmin.trash.tooManyRefreshes"));
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
        : [...ALL_SERVICES];

  return withAdvisoryLock(
    TRASH_SYNC_LOCK_ID,
    async (signal: AbortSignal) => {
      const startTime = Date.now();
      const { results, errors, schemaDiagnostic } = await refreshServices(services, signal, t);

      // The same stamp as runTrashSync: trashLastRefreshAt drives the cron's
      // once-an-hour cadence gate (which refreshes BOTH services) and the
      // settings card's "last refreshed" line. So it is written only when this
      // refresh covered both services and every one of them refreshed, and the
      // lock did not cut the pass short: a radarr-only refresh, or one where a
      // service threw, must not hold the cron's full refresh off for an hour.
      const aborted = signal.aborted || results.some((r) => r.aborted);
      if (services.length === ALL_SERVICES.length && results.length === services.length && !aborted) {
        await stampLastRefresh();
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

const ALL_SERVICES: readonly TrashService[] = ["RADARR", "SONARR"];

interface RefreshOutcome {
  results: RefreshResult[];
  errors: string[];
  schemaDiagnostic: string | null;
}

// Refreshes the requested services off ONE shared GitHub tree — the listing is
// the same for RADARR and SONARR, so fetching it per service would double the
// download and the GitHub rate-limit cost (mirrors runTrashSync). A failure is
// logged in full and reported per service: the tree fetch's own message (a
// GitHub answer, no internal detail) for every requested service, a schema
// problem with its hint, and any other store failure as the generic line.
async function refreshServices(services: readonly TrashService[], signal: AbortSignal, t: Translator): Promise<RefreshOutcome> {
  const out: RefreshOutcome = { results: [], errors: [], schemaDiagnostic: null };
  let tree: TrashTree;
  try {
    tree = await fetchTrashTree();
  } catch (err) {
    console.error("[trash] catalog tree fetch failed:", err);
    out.schemaDiagnostic = describeSchemaError(err);
    const msg = err instanceof Error ? err.message : String(err);
    for (const service of services) out.errors.push(`${service}: ${msg}`);
    return out;
  }
  for (const service of services) {
    // The lock's work timeout aborts the refresh at its next batch boundary
    // (guardrail 41); the partial result is still reported and audited.
    if (signal.aborted) break;
    try {
      const r = await refreshCatalog(service, tree, { signal });
      out.results.push(r);
      // Per-file failures (a download, a parse, a validator reject) are part of
      // this refresh's outcome, as in runTrashSync: without them `ok` and the
      // audit row read a partly failed refresh as clean.
      out.errors.push(...r.errors.map((e) => `${service}: ${e}`));
    } catch (err) {
      console.error(`[trash] ${service} catalog refresh failed:`, err);
      const schemaHint = describeSchemaError(err);
      if (schemaHint) {
        out.schemaDiagnostic = schemaHint;
        out.errors.push(`${service}: ${err instanceof Error ? err.message : String(err)}`);
      } else {
        // The tree is already fetched, so this is our own store failing: its
        // text can name the database host or a query, which stays in the log.
        out.errors.push(`${service}: ${t("apiAdmin.trash.internalError")}`);
      }
    }
  }
  return out;
}

async function stampLastRefresh(): Promise<void> {
  const value = new Date().toISOString();
  await prisma.setting.upsert({
    where: { key: "trashLastRefreshAt" },
    update: { value },
    create: { key: "trashLastRefreshAt", value },
  }).catch((err) => {
    console.warn("[trash] failed to stamp last-refresh-at:", err instanceof Error ? err.message : err);
  });
}
