import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { AuditLogView } from "@/components/admin/audit-log-table";
import { requireFeature } from "@/lib/features";
import type { AuditAction, Prisma } from "@/generated/prisma";
import { PageHeader } from "@/components/ui/design";
import { AUDIT_ACTIONS, ACTION_GROUP, type AuditGroup } from "@/lib/audit-actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

// Derived from the shared audit-actions module so the schema enum is the single
// source of truth. Previously this page had its own hand-maintained list (16 of
// 27 values) — a filter for any missing enum value silently returned the full
// unfiltered set (audit-log H34 / S8-Pass3-F1).
const VALID_ACTIONS: AuditAction[] = AUDIT_ACTIONS;

const GROUP_ACTIONS: Record<AuditGroup, AuditAction[]> = {
  auth: [],
  admin: [],
  system: [],
};
for (const action of AUDIT_ACTIONS) {
  GROUP_ACTIONS[ACTION_GROUP[action]].push(action);
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; group?: string; dateFrom?: string; dateTo?: string; user?: string; target?: string; hideCron?: string }>;
}) {
  await requireFeature("feature.admin.auditLog");
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const { action: actionParam, group: groupParam, dateFrom, dateTo, user, target, hideCron: hideCronParam } = await searchParams;
  const action = VALID_ACTIONS.includes(actionParam as AuditAction)
    ? (actionParam as AuditAction)
    : undefined;
  const group: AuditGroup | undefined =
    groupParam === "auth" || groupParam === "admin" || groupParam === "system"
      ? groupParam
      : undefined;
  const hideCron = hideCronParam === "1";

  const where: Prisma.AuditLogWhereInput = {};
  // Action is more specific than group — action wins if both are present
  if (action) where.action = action;
  else if (group) where.action = { in: GROUP_ACTIONS[group] };
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
        currentGroup={group ?? ""}
        currentDateFrom={dateFrom ?? ""}
        currentDateTo={dateTo ?? ""}
        currentUser={user ?? ""}
        currentTarget={target ?? ""}
        currentHideCron={hideCron}
      />
    </div>
  );
}
