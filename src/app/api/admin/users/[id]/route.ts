import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired, invalidateUserSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { logAudit, logAuditOrFail, auditContext } from "@/lib/audit";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  if (id === session.user.id) {
    return NextResponse.json({ error: "Cannot change your own role" }, { status: 400 });
  }

  type NotifKey = "notifyOnApproved" | "notifyOnAvailable" | "notifyOnDeclined" | "emailOnApproved" | "emailOnAvailable" | "emailOnDeclined" | "pushOnApproved" | "pushOnAvailable" | "pushOnDeclined";
  const notifKeys: NotifKey[] = ["notifyOnApproved", "notifyOnAvailable", "notifyOnDeclined", "emailOnApproved", "emailOnAvailable", "emailOnDeclined", "pushOnApproved", "pushOnAvailable", "pushOnDeclined"];

  let body: { role?: string; autoApprove?: boolean; quotaExempt?: boolean; mediaServer?: string | null } & Partial<Record<NotifKey, boolean>>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if ("mediaServer" in body) {
    const ms = body.mediaServer;
    if (ms !== null && ms !== "plex" && ms !== "jellyfin") {
      return NextResponse.json({ error: "mediaServer must be 'plex', 'jellyfin', or null" }, { status: 400 });
    }
    const prevMediaServer = await prisma.user.findUnique({ where: { id }, select: { mediaServer: true } });
    if (!prevMediaServer) return NextResponse.json({ error: "Not found" }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { mediaServer: ms } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      throw err;
    }
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "SETTINGS_CHANGE", target: `user:${id}`, details: { field: "mediaServer", before: prevMediaServer.mediaServer, after: ms }, ...auditContext(req, session) });
    invalidateUserSession(id);
    return NextResponse.json({ id, mediaServer: ms });
  }

  if (body.autoApprove !== undefined) {
    if (typeof body.autoApprove !== "boolean") {
      return NextResponse.json({ error: "autoApprove must be a boolean" }, { status: 400 });
    }
    const prevAutoApprove = await prisma.user.findUnique({ where: { id }, select: { autoApprove: true } });
    if (!prevAutoApprove) return NextResponse.json({ error: "Not found" }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { autoApprove: body.autoApprove } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      throw err;
    }
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "SETTINGS_CHANGE", target: `user:${id}`, details: { field: "autoApprove", before: prevAutoApprove.autoApprove, after: body.autoApprove }, ...auditContext(req, session) });
    return NextResponse.json({ id, autoApprove: body.autoApprove });
  }

  if (body.quotaExempt !== undefined) {
    if (typeof body.quotaExempt !== "boolean") {
      return NextResponse.json({ error: "quotaExempt must be a boolean" }, { status: 400 });
    }
    const prevQuotaExempt = await prisma.user.findUnique({ where: { id }, select: { quotaExempt: true } });
    if (!prevQuotaExempt) return NextResponse.json({ error: "Not found" }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { quotaExempt: body.quotaExempt } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      throw err;
    }
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "SETTINGS_CHANGE", target: `user:${id}`, details: { field: "quotaExempt", before: prevQuotaExempt.quotaExempt, after: body.quotaExempt }, ...auditContext(req, session) });
    return NextResponse.json({ id, quotaExempt: body.quotaExempt });
  }

  const notifKey = notifKeys.find(k => body[k] !== undefined);
  if (notifKey !== undefined) {
    if (typeof body[notifKey] !== "boolean") {
      return NextResponse.json({ error: `${notifKey} must be a boolean` }, { status: 400 });
    }
    const prevNotif = await prisma.user.findUnique({ where: { id }, select: { [notifKey]: true } });
    if (!prevNotif) return NextResponse.json({ error: "Not found" }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { [notifKey]: body[notifKey] } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      throw err;
    }
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "SETTINGS_CHANGE", target: `user:${id}`, details: { field: notifKey, before: prevNotif[notifKey], after: body[notifKey] }, ...auditContext(req, session) });
    return NextResponse.json({ id, [notifKey]: body[notifKey] });
  }

  if (body.role !== "ADMIN" && body.role !== "USER" && body.role !== "ISSUE_ADMIN") {
    return NextResponse.json({ error: "role must be ADMIN, ISSUE_ADMIN, or USER" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, name: true, email: true } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if ((body.role === "USER" || body.role === "ISSUE_ADMIN") && target.role === "ADMIN") {
    // Advisory lock 42 + atomic row count ensures we never demote the last admin, even under concurrent requests
    const now = new Date().toISOString();
    const newRole = body.role;
    const rowsAffected = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(42)");
      return tx.$executeRaw`
        UPDATE "User" SET role = ${newRole}, "updatedAt" = ${now}
        WHERE id = ${id}
        AND role = 'ADMIN'
        AND (SELECT COUNT(*) FROM "User" WHERE role = 'ADMIN') > 1
      `;
    });
    if (rowsAffected === 0) {
      return NextResponse.json({ error: "Cannot demote the last admin" }, { status: 400 });
    }
  } else {
    await prisma.user.update({
      where: { id },
      data: { role: body.role as "ADMIN" | "ISSUE_ADMIN" | "USER" },
    });
  }

  invalidateUserSession(id);

  try {
    await logAuditOrFail({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "USER_ROLE_CHANGE", target: `user:${id}`, details: { targetUser: target.name ?? target.email, targetEmail: target.email, before: { role: target.role }, after: { role: body.role } }, ...auditContext(req, session) });
  } catch (err) {
    console.error("[audit] Critical audit log failed:", err);
    return NextResponse.json({ error: "Audit logging failed" }, { status: 500 });
  }
  return NextResponse.json({ id, role: body.role });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  if (id === session.user.id) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { role: true, name: true, email: true } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [requestCount, issueCount, voteCount] = await Promise.all([
    prisma.mediaRequest.count({ where: { requestedBy: id } }),
    prisma.issue.count({ where: { reportedBy: id } }),
    prisma.deletionVote.count({ where: { userId: id } }),
  ]);

  if (target.role === "ADMIN") {
    // Advisory lock 42 + atomic row count ensures we never delete the last admin under concurrent requests
    const rowsAffected = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(42)");
      return tx.$executeRaw`
        DELETE FROM "User"
        WHERE id = ${id}
        AND role = 'ADMIN'
        AND (SELECT COUNT(*) FROM "User" WHERE role = 'ADMIN') > 1
      `;
    });
    if (rowsAffected === 0) {
      return NextResponse.json({ error: "Cannot delete the last admin" }, { status: 400 });
    }
  } else {
    await prisma.user.delete({ where: { id } });
  }

  invalidateUserSession(id);

  try {
    await logAuditOrFail({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "USER_DELETE", target: `user:${id}`, details: { targetUser: target.name ?? target.email, targetEmail: target.email, before: { role: target.role }, cascadeDeleted: { mediaRequests: requestCount, issues: issueCount, deletionVotes: voteCount } }, ...auditContext(_req, session) });
  } catch (err) {
    console.error("[audit] Critical audit log failed:", err);
    return NextResponse.json({ error: "Audit logging failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
