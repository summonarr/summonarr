import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { AuditLogView } from "@/components/admin/audit-log-table";
import { requireFeature } from "@/lib/features";
import type { AuditAction, Prisma } from "@/generated/prisma";
import { PageHeader } from "@/components/ui/design";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const VALID_ACTIONS: AuditAction[] = [
  "REQUEST_APPROVE", "REQUEST_DECLINE", "REQUEST_DELETE",
  "USER_ROLE_CHANGE", "USER_DELETE", "SETTINGS_CHANGE",
  "LIBRARY_SYNC", "ISSUE_STATUS_CHANGE", "MAINTENANCE_TOGGLE",
  "BACKUP_EXPORT", "BACKUP_IMPORT",
  "AUTH_LOGIN", "AUTH_LOGIN_FAILED", "AUTH_LOGOUT",
];

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; dateFrom?: string; dateTo?: string; user?: string; target?: string; hideCron?: string }>;
}) {
  await requireFeature("feature.admin.auditLog");
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const { action: actionParam, dateFrom, dateTo, user, target, hideCron: hideCronParam } = await searchParams;
  const action = VALID_ACTIONS.includes(actionParam as AuditAction)
    ? (actionParam as AuditAction)
    : undefined;
  const hideCron = hideCronParam === "1";

  const where: Prisma.AuditLogWhereInput = {};
  if (action) where.action = action;
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(dateFrom);
    if (dateTo) {
      const end = new Date(dateTo);
      end.setDate(end.getDate() + 1);
      where.createdAt.lt = end;
    }
  }
  if (user) where.userName = { contains: user, mode: "insensitive" };
  if (target) where.target = { contains: target, mode: "insensitive" };
  if (hideCron) where.userId = { not: "system" };

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

  return (
    <div className="ds-page-enter">
      <PageHeader
        title="Audit Log"
        subtitle="Track admin actions and system changes"
      />

      <AuditLogView
        initialLogs={rows}
        initialNextCursor={nextCursor}
        initialHasMore={hasMore}
        currentAction={action ?? ""}
        currentDateFrom={dateFrom ?? ""}
        currentDateTo={dateTo ?? ""}
        currentUser={user ?? ""}
        currentTarget={target ?? ""}
        currentHideCron={hideCron}
      />
    </div>
  );
}
