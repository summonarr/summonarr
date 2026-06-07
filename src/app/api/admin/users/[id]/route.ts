import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { invalidateUserSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { logAudit, logAuditOrFail, auditContext } from "@/lib/audit";
import { Permission, parseAndValidatePermissions, defaultPermissionsForRole } from "@/lib/permissions";

export const PATCH = withAdmin(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
  const { id } = await params;

  if (id === session.user.id) {
    return NextResponse.json({ error: "Cannot change your own role" }, { status: 400 });
  }

  type NotifKey = "notifyOnApproved" | "notifyOnAvailable" | "notifyOnDeclined" | "emailOnApproved" | "emailOnAvailable" | "emailOnDeclined" | "pushOnApproved" | "pushOnAvailable" | "pushOnDeclined" | "notifyOnIssue";
  const notifKeys: NotifKey[] = ["notifyOnApproved", "notifyOnAvailable", "notifyOnDeclined", "emailOnApproved", "emailOnAvailable", "emailOnDeclined", "pushOnApproved", "pushOnAvailable", "pushOnDeclined", "notifyOnIssue"];

  let body: {
    role?: string;
    permissions?: string;
    movieQuotaLimit?: number | null;
    movieQuotaDays?: number | null;
    tvQuotaLimit?: number | null;
    tvQuotaDays?: number | null;
    mediaServer?: string | null;
  } & Partial<Record<NotifKey, boolean>>;
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

  if (body.permissions !== undefined) {
    const parsed = parseAndValidatePermissions(body.permissions);
    if (parsed === null) {
      return NextResponse.json({ error: "permissions must be a decimal bitmask within the known permission set" }, { status: 400 });
    }
    const targetUser = await prisma.user.findUnique({ where: { id }, select: { permissions: true, role: true, name: true, email: true } });
    if (!targetUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Never let the editor strip the ADMIN bit from a role=ADMIN user — demote the
    // role first (which routes through the last-admin CAS below). Keeps the
    // "never lock out the last admin" invariant on a single code path.
    if (targetUser.role === "ADMIN" && (parsed & Permission.ADMIN) === 0n) {
      return NextResponse.json({ error: "Demote this admin's role before removing the ADMIN permission." }, { status: 400 });
    }

    try {
      await prisma.user.update({ where: { id }, data: { permissions: parsed } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      throw err;
    }
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "USER_PERMISSIONS_CHANGE", target: `user:${id}`, details: { targetUser: targetUser.name ?? targetUser.email, before: targetUser.permissions.toString(), after: parsed.toString() }, ...auditContext(req, session) });
    invalidateUserSession(id);
    return NextResponse.json({ id, permissions: parsed.toString() });
  }

  const quotaFields = ["movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays"] as const;
  const quotaField = quotaFields.find((k) => k in body);
  if (quotaField !== undefined) {
    const val = body[quotaField];
    if (val !== null && val !== undefined && (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 100_000)) {
      return NextResponse.json({ error: `${quotaField} must be a non-negative integer or null` }, { status: 400 });
    }
    const nextVal = val ?? null;
    const prevQuota = await prisma.user.findUnique({
      where: { id },
      select: { movieQuotaLimit: true, movieQuotaDays: true, tvQuotaLimit: true, tvQuotaDays: true },
    });
    if (!prevQuota) return NextResponse.json({ error: "Not found" }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { [quotaField]: nextVal } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      throw err;
    }
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "SETTINGS_CHANGE", target: `user:${id}`, details: { field: quotaField, before: prevQuota[quotaField] ?? null, after: nextVal }, ...auditContext(req, session) });
    invalidateUserSession(id);
    return NextResponse.json({ id, [quotaField]: nextVal });
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

  // If we reached here, none of the typed-field branches (mediaServer/permissions/
  // quota*/notif*) matched. That means the caller either sent {} or only
  // unrecognized keys. Surface that explicitly rather than falling through to the
  // role validator (which would return a misleading "role must be …").
  if (body.role === undefined) {
    return NextResponse.json({ error: "No recognized fields in PATCH body" }, { status: 400 });
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
        UPDATE "User" SET role = ${newRole}, permissions = ${defaultPermissionsForRole(newRole)}, "updatedAt" = ${now}
        WHERE id = ${id}
        AND role = 'ADMIN'
        AND (SELECT COUNT(*) FROM "User" WHERE role = 'ADMIN') > 1
      `;
    });
    if (rowsAffected === 0) {
      return NextResponse.json({ error: "Cannot demote the last admin" }, { status: 400 });
    }
  } else {
    // Setting a role re-seeds the permission bitmask from the preset (role is a
    // preset selector); fine-tune afterward via the `permissions` field.
    await prisma.user.update({
      where: { id },
      data: {
        role: body.role as "ADMIN" | "ISSUE_ADMIN" | "USER",
        permissions: defaultPermissionsForRole(body.role),
      },
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
});

export const DELETE = withAdmin(async (
  _req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
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
});
