import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import type { AuditAction, Prisma } from "@/generated/prisma";
import { AUDIT_ACTIONS, ACTION_GROUP, type AuditGroup } from "@/lib/audit-actions";

const VALID_ACTIONS: AuditAction[] = AUDIT_ACTIONS;

// Coarse group filter — derived from the shared ACTION_GROUP so the schema enum
// is the single source of truth. Adding a new enum value with a group assignment
// in audit-actions.ts automatically populates the right bucket here.
const GROUP_ACTIONS: Record<AuditGroup, AuditAction[]> = {
  auth: [],
  admin: [],
  system: [],
};
for (const action of AUDIT_ACTIONS) {
  GROUP_ACTIONS[ACTION_GROUP[action]].push(action);
}

export const GET = withAdmin(async (req, _ctx, session) => {
  if (!checkRateLimit(`admin-audit-list:${session.user.id}`, 60, 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const url = req.nextUrl;
  const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "50", 10) || 50));
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const action = url.searchParams.get("action") as AuditAction | null;
  const groupParam = url.searchParams.get("group");
  const group: "auth" | "admin" | "system" | null =
    groupParam === "auth" || groupParam === "admin" || groupParam === "system"
      ? groupParam
      : null;
  const dateFrom = url.searchParams.get("dateFrom");
  const dateTo = url.searchParams.get("dateTo");
  const user = url.searchParams.get("user");
  const target = url.searchParams.get("target");
  const hideCron = url.searchParams.get("hideCron") === "1";

  const where: Prisma.AuditLogWhereInput = {};

  // Action is more specific than group — action wins if both are present
  if (action && VALID_ACTIONS.includes(action)) {
    where.action = action;
  } else if (group) {
    where.action = { in: GROUP_ACTIONS[group] };
  }

  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) {
      const d = new Date(dateFrom);
      if (!isNaN(d.getTime())) where.createdAt.gte = d;
    }
    if (dateTo) {
      const end = new Date(dateTo);
      if (!isNaN(end.getTime())) {
        // Advance by one day to make the date range inclusive of the requested end date
        end.setDate(end.getDate() + 1);
        where.createdAt.lt = end;
      }
    }
  }

  if (user) {
    where.userName = { contains: user, mode: "insensitive" };
  }

  if (target) {
    where.target = { contains: target, mode: "insensitive" };
  }

  if (hideCron) {
    where.userId = { not: "system" };
  }

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
  //     preserved on USER_DELETE so the deletion record stays intact for audit purposes.
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const piiResult = await prisma.auditLog.updateMany({
    where: {
      createdAt: { lt: cutoff },
      OR: [
        { ipAddress: { not: null } },
        { userAgent: { not: null } },
        { userName: { not: "[redacted]" } },
      ],
    },
    data: { ipAddress: null, userAgent: null, userName: "[redacted]" },
  });

  const detailsResult = await prisma.auditLog.updateMany({
    where: {
      createdAt: { lt: cutoff },
      action: { in: ["AUTH_LOGIN_FAILED", "AUTH_LOGIN", "AUTH_LOGOUT"] },
      details: { not: null },
    },
    data: { details: null },
  });

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: "audit-log:pii-scrub",
    details: {
      type: "audit-pii-scrub",
      scrubbed: piiResult.count,
      detailsScrubbed: detailsResult.count,
      cutoff: cutoff.toISOString(),
    },
    ...auditContext(req, session),
  });

  return NextResponse.json({
    scrubbed: piiResult.count,
    detailsScrubbed: detailsResult.count,
    cutoff: cutoff.toISOString(),
  });
});
