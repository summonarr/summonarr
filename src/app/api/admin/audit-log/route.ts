import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext, getAuditPiiRetentionDays, REDACTED_USER_NAME } from "@/lib/audit";
import { scrubTargetPiiFromAudit } from "@/lib/audit-scrub";
import { checkRateLimit } from "@/lib/rate-limit";
import { buildAuditLogWhere } from "@/lib/audit-log-filter";
import { translatorForRequest } from "@/lib/i18n/server-locale";

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
  // Beyond the retention cutoff, scrub all remaining PII:
  //   - ipAddress / userAgent: nulled on every row
  //   - userName: redacted on every row (still keyed by userId for joinability)
  //   - details: nulled on auth events (free-form payload may contain identifiers);
  //     preserved otherwise (a USER_DELETE record stays intact for audit purposes),
  //     except the target-user name/email keys of admin actions (audit-scrub.ts),
  //     which go — the row keeps the account id, not who it was.
  // Window comes from the shared reader (auditPiiRetentionDays Setting, default
  // 90d) so this manual scrub and the scrub-audit-pii cron enforce one promise.
  const retentionDays = await getAuditPiiRetentionDays();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const piiResult = await prisma.auditLog.updateMany({
    where: {
      createdAt: { lt: cutoff },
      OR: [
        { ipAddress: { not: null } },
        { userAgent: { not: null } },
        { userName: { not: REDACTED_USER_NAME } },
      ],
    },
    data: { ipAddress: null, userAgent: null, userName: REDACTED_USER_NAME },
  });

  const detailsResult = await prisma.auditLog.updateMany({
    where: {
      createdAt: { lt: cutoff },
      action: { in: ["AUTH_LOGIN_FAILED", "AUTH_LOGIN", "AUTH_LOGOUT"] },
      details: { not: null },
    },
    data: { details: null },
  });

  const adminDetailsScrubbed = await scrubTargetPiiFromAudit(prisma, { createdAt: { lt: cutoff } });

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: "audit-log:pii-scrub",
    details: {
      type: "audit-pii-scrub",
      scrubbed: piiResult.count,
      detailsScrubbed: detailsResult.count,
      adminDetailsScrubbed,
      cutoff: cutoff.toISOString(),
    },
    ...auditContext(req, session),
  });

  return NextResponse.json({
    scrubbed: piiResult.count,
    detailsScrubbed: detailsResult.count,
    adminDetailsScrubbed,
    cutoff: cutoff.toISOString(),
    retentionDays,
  });
});
