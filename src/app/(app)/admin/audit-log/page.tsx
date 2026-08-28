import { authActive } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { AuditLogView } from "@/components/admin/audit-log-table";
import { requireFeature } from "@/lib/features";
import type { AuditAction, Prisma } from "@/generated/prisma";
import { PageHeader } from "@/components/ui/design";
import { AUDIT_ACTIONS, ACTION_GROUP, type AuditGroup } from "@/lib/audit-actions";
import { sanitizeContainsSearch } from "@/lib/sanitize";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

// Derived from the shared audit-actions module so the schema enum is the single
// source of truth. A hand-maintained list previously missed values, so a filter
// for any missing enum value silently returned the full unfiltered set.
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
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

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
    // An Invalid Date reaches Prisma's DateTime filter and throws, taking the
    // whole page render down — mirrors the isNaN guard in /api/admin/audit-log.
    if (dateFrom) {
      const start = new Date(dateFrom);
      if (!isNaN(start.getTime())) where.createdAt.gte = start;
    }
    if (dateTo) {
      const end = new Date(dateTo);
      if (!isNaN(end.getTime())) {
        end.setDate(end.getDate() + 1);
        where.createdAt.lt = end;
      }
    }
  }
  // Prisma `contains` → ILIKE with no ESCAPE clause; strip wildcard
  // metacharacters and bound the length (search-box DoS, matches /api/votes).
  if (user) where.userName = { contains: sanitizeContainsSearch(user), mode: "insensitive" };
  if (target) where.target = { contains: sanitizeContainsSearch(target), mode: "insensitive" };
  // "Hide cron" means hide the SYSTEM principal, not hide every row without a
  // user. `{ not: "system" }` compiles to `"userId" <> 'system'`, and in SQL
  // NULL <> 'system' is NULL, not TRUE — so Postgres drops every NULL-userId row
  // too. Three writers produce those, and the one that matters is
  // /api/auth/machine-session, which mints an ADMIN-impersonating JWT from
  // CRON_SECRET and is deliberately attributed to the machine rather than to the
  // assumed admin. That row is the only record the mint happened, and ticking a
  // filter labelled "Showing only real users" silently removed it — including
  // from the CSV/JSON export.
  if (hideCron) where.AND = [{ OR: [{ userId: null }, { userId: { not: "system" } }] }];

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
