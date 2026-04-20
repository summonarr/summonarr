import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import type { AuditAction, Prisma } from "@/generated/prisma";

const VALID_ACTIONS: AuditAction[] = [
  "REQUEST_APPROVE", "REQUEST_DECLINE", "REQUEST_DELETE",
  "USER_ROLE_CHANGE", "USER_DELETE", "SETTINGS_CHANGE",
  "LIBRARY_SYNC", "ISSUE_STATUS_CHANGE", "MAINTENANCE_TOGGLE",
  "BACKUP_EXPORT", "BACKUP_IMPORT",
  "AUTH_LOGIN", "AUTH_LOGIN_FAILED", "AUTH_LOGOUT",
  "SESSION_REVOKE", "CACHE_WARM", "RATINGS_CACHE_CLEAR", "ISSUE_DELETE",
];

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "50", 10) || 50));
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const action = url.searchParams.get("action") as AuditAction | null;
  const dateFrom = url.searchParams.get("dateFrom");
  const dateTo = url.searchParams.get("dateTo");
  const user = url.searchParams.get("user");
  const target = url.searchParams.get("target");

  const where: Prisma.AuditLogWhereInput = {};

  if (action && VALID_ACTIONS.includes(action)) {
    where.action = action;
  }

  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(dateFrom);
    if (dateTo) {
      // Advance by one day to make the date range inclusive of the requested end date
      const end = new Date(dateTo);
      end.setDate(end.getDate() + 1);
      where.createdAt.lt = end;
    }
  }

  if (user) {
    where.userName = { contains: user, mode: "insensitive" };
  }

  if (target) {
    where.target = { contains: target, mode: "insensitive" };
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
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Only null out fields that still hold PII; rows without IP/UA are already clean
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const result = await prisma.auditLog.updateMany({
    where: {
      createdAt: { lt: cutoff },
      OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }],
    },
    data: { ipAddress: null, userAgent: null },
  });

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: "audit-log:pii-scrub",
    details: { type: "audit-pii-scrub", scrubbed: result.count, cutoff: cutoff.toISOString() },
    ...auditContext(req, session),
  });

  return NextResponse.json({ scrubbed: result.count, cutoff: cutoff.toISOString() });
}
