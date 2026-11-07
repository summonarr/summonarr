import { authActive } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { hasPermission, Permission } from "@/lib/permissions";
import { AuditLogView } from "@/components/admin/audit-log-table";
import { requireFeature } from "@/lib/features";
import { getTranslator } from "@/lib/i18n/server";
import { PageHeader } from "@/components/ui/design";
import { buildAuditLogWhere } from "@/lib/audit-log-filter";
import { AUDIT_VIEW_COOKIE, parseAuditViewMode } from "@/lib/audit-log-view";
import { REDACTED_USER_NAME } from "@/lib/audit";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireFeature("feature.admin.auditLog");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  // As a URLSearchParams, the filter reads exactly as the list and export
  // routes read theirs: a repeated key (an ARRAY here at runtime, whatever the
  // prop type says) is its first value.
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  }
  // The filter the list and export routes build too (audit-log-filter.ts). An
  // unparseable date is a 400 there, so it can't be shown here either: drop it
  // from the URL, so the bar, the first page, "Load more" and the export all
  // agree on the filter actually applied (a second bad date takes one more hop).
  const filter = buildAuditLogWhere(query);
  if (filter.error) {
    query.delete(filter.param);
    const rest = query.toString();
    redirect(rest ? `/admin/audit-log?${rest}` : "/admin/audit-log");
  }
  const { where, filters } = filter;

  const logs = await prisma.auditLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
  });

  const hasMore = logs.length > PAGE_SIZE;
  if (hasMore) logs.pop();
  const nextCursor = logs.length > 0 ? logs[logs.length - 1].id : null;

  const rows = logs.map((l) => ({
    id: l.id,
    createdAt: l.createdAt.toISOString(),
    userName: l.userName,
    action: l.action,
    target: l.target,
    details: l.details,
    ipAddress: l.ipAddress,
    userAgent: l.userAgent,
    provider: l.provider,
  }));

  const t = await getTranslator();
  // The saved Table/Timeline choice is a cookie so the FIRST paint is already in
  // that view: read from localStorage after mount, timeline users saw the table
  // flash first. Null = no cookie yet (the view falls back to a one-time read
  // of the old localStorage value).
  const initialViewMode = parseAuditViewMode((await cookies()).get(AUDIT_VIEW_COOKIE)?.value);

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("adminManage.audit.title")}
        subtitle={t("adminManage.audit.subtitle")}
      />

      <AuditLogView
        initialLogs={rows}
        initialNextCursor={nextCursor}
        initialHasMore={hasMore}
        filters={{
          action: filters.action ?? "",
          group: filters.group ?? "",
          dateFrom: filters.dateFrom ?? "",
          dateTo: filters.dateTo ?? "",
          user: filters.user ?? "",
          target: filters.target ?? "",
          hideCron: filters.hideCron,
        }}
        initialViewMode={initialViewMode}
        redactedUserName={REDACTED_USER_NAME}
      />
    </div>
  );
}
