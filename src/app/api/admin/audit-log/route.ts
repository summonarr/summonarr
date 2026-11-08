import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { auditActor, logAudit, getAuditPiiRetentionDays } from "@/lib/audit";
import { AuditPiiScrubError, scrubAuditPii, type AuditPiiScrubCounts } from "@/lib/audit-pii-scrub";
import { tooManyRequests } from "@/lib/http";
import { checkRateLimit } from "@/lib/rate-limit";
import { buildAuditLogWhere } from "@/lib/audit-log-filter";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// The manual PII scrub (audit-pii-scrub.ts, the cron's own pass) per admin per
// window: it is idempotent and batched, so this only bounds a looping client
// re-walking a large trail.
const SCRUB_LIMIT = 5;
const SCRUB_WINDOW_MS = 10 * 60 * 1000;

export const GET = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`admin-audit-list:${session.user.id}`, 60, 60 * 1000)) {
    return NextResponse.json({ error: t("apiAdmin.common.tooManyRequests") }, { status: 429 });
  }
  const url = req.nextUrl;
  const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "50", 10) || 50));
  const cursor = url.searchParams.get("cursor") ?? undefined;

  // The filter the page and the export build too (audit-log-filter.ts). An
  // invalid date is a 400 here and on the export, and the page drops it
  // before rendering, so "Load more" never pages an unfiltered list.
  const filter = buildAuditLogWhere(url.searchParams);
  if (filter.error) {
    const msg = filter.error === "invalidDateFrom"
      ? t("apiAdmin.auditLog.invalidDateFrom")
      : t("apiAdmin.auditLog.invalidDateTo");
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  const { where } = filter;

  const logs = await prisma.auditLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: pageSize + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = logs.length > pageSize;
  if (hasMore) logs.pop();
  const nextCursor = logs.length > 0 ? logs[logs.length - 1].id : null;

  return NextResponse.json({ logs, nextCursor, hasMore });
});

export const DELETE = withAdmin(async (req, _ctx, session) => {
  // Beyond the retention cutoff, scrub all remaining PII (scrubAuditPii):
  //   - ipAddress / userAgent: nulled on every row
  //   - userName: redacted on every row (still keyed by userId for joinability)
  //   - details: nulled on auth events (free-form payload may contain identifiers);
  //     preserved otherwise (a USER_DELETE record stays intact for audit purposes),
  //     except the target-user name/email keys of admin actions (audit-scrub.ts),
  //     which go — the row keeps the account id, not who it was.
  // Window comes from the shared reader (auditPiiRetentionDays Setting, default
  // 90d) so this manual scrub and the scrub-audit-pii cron enforce one promise.
  const t = translatorForRequest(req);
  if (!checkRateLimit(`admin-audit-scrub:${session.user.id}`, SCRUB_LIMIT, SCRUB_WINDOW_MS)) {
    return tooManyRequests(SCRUB_WINDOW_MS / 1000, t("apiAdmin.common.tooManyRequestsLater"));
  }
  const retentionDays = await getAuditPiiRetentionDays();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // Audited however it ends: a scrub that stopped part-way still rewrote rows,
  // and the trail says which steps finished before the error (guardrail 26:
  // the swallowing writer, after the writes).
  let result: AuditPiiScrubCounts | null = null;
  let failure: unknown = null;
  try {
    result = await scrubAuditPii(cutoff);
  } catch (err) {
    failure = err;
  }
  const counts: Partial<AuditPiiScrubCounts> = result ?? (failure instanceof AuditPiiScrubError ? failure.done : {});
  void logAudit({
    ...auditActor(req, session),
    action: "SETTINGS_CHANGE",
    target: "audit-log:pii-scrub",
    details: {
      type: "audit-pii-scrub",
      scrubbed: counts.scrubbed ?? null,
      detailsScrubbed: counts.authDetailsCleared ?? null,
      adminDetailsScrubbed: counts.adminDetailsScrubbed ?? null,
      cutoff: cutoff.toISOString(),
      ...(result === null ? { failed: true, error: (failure instanceof Error ? failure.message : String(failure)).slice(0, 500) } : {}),
    },
  });
  if (result === null) throw failure;

  return NextResponse.json({
    scrubbed: result.scrubbed,
    detailsScrubbed: result.authDetailsCleared,
    adminDetailsScrubbed: result.adminDetailsScrubbed,
    cutoff: cutoff.toISOString(),
    retentionDays,
  });
});
