import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withPermission } from "@/lib/api-auth";
import { revokeSessionById, revokeAllUserSessions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { Permission, hasPermission } from "@/lib/permissions";
import { isIndefiniteDeadline } from "@/lib/session-lifetime";
import { translatorForRequest } from "@/lib/i18n/server-locale";

type RouteParams = { params: Promise<{ id: string }> };

// MANAGE_USERS, like every other account-lifecycle action on the Users page
// (purge / reactivate / mfa): the page admits delegates and shows the Sessions
// menu item to them, so an ADMIN-only gate here just made that one control dead.
// An ADMIN target additionally needs the ADMIN bit — a delegated user manager
// must not be able to read an admin's device list or sign an admin out.
function targetRequiresAdmin(targetRole: string, callerPerms: bigint): boolean {
  return targetRole === "ADMIN" && !hasPermission(callerPerms, Permission.ADMIN);
}

export const GET = withPermission(Permission.MANAGE_USERS)(async (
  req,
  { params }: RouteParams,
  session
) => {
  const t = translatorForRequest(req);
  const { id } = await params;

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
  if (!target) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
  if (targetRequiresAdmin(target.role, session.user.permissions)) {
    return NextResponse.json({ error: t("apiAdmin.users.onlyAdminModify") }, { status: 403 });
  }

  const sessions = await prisma.authSession.findMany({
    where: { userId: id },
    orderBy: { lastSeenAt: "desc" },
    select: {
      id:          true,
      sessionId:   true,
      deviceType:  true,
      deviceLabel: true,
      ipAddress:   true,
      createdAt:   true,
      lastSeenAt:  true,
      expiresAt:   true,
    },
  });

  // `indefinite` is ADDITIVE (safe for the pinned iOS decoders — guardrail 6c):
  // it lets clients label a never-expiring native session without hardcoding
  // the sentinel date the raw expiresAt serializes to.
  return NextResponse.json(
    sessions.map((s) => ({ ...s, indefinite: isIndefiniteDeadline(s.expiresAt) }))
  );
});

export const DELETE = withPermission(Permission.MANAGE_USERS)(async (
  req,
  { params }: RouteParams,
  session
) => {
  const t = translatorForRequest(req);
  const { id } = await params;

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, name: true, email: true },
  });
  if (!target) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
  if (targetRequiresAdmin(target.role, session.user.permissions)) {
    return NextResponse.json({ error: t("apiAdmin.users.onlyAdminModify") }, { status: 403 });
  }

  const parsed = await readJsonCapped<{ sessionId?: string; all?: boolean }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  // Strict `=== true`: a stray truthy value (e.g. the string "false") must not
  // sign the user out of every device.
  if (body.all === true) {
    await revokeAllUserSessions(id);

    void logAudit({
      userId:    session.user.id,
      userName:  session.user.name ?? session.user.email ?? "unknown",
      action:    "SESSION_REVOKE",
      target:    `user:${id}`,
      details:   {
        targetUser:  target.name ?? target.email,
        targetEmail: target.email,
        revokedAll:  true,
        adminAction: true,
      },
      ...auditContext(req, session),
    });

    return NextResponse.json({ ok: true, revoked: "all" });
  }

  if (body.sessionId && typeof body.sessionId === "string") {
    const record = await prisma.authSession.findUnique({
      where: { sessionId: body.sessionId },
      select: { userId: true, deviceLabel: true },
    });
    if (!record || record.userId !== id) {
      return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
    }

    await revokeSessionById(body.sessionId);

    void logAudit({
      userId:    session.user.id,
      userName:  session.user.name ?? session.user.email ?? "unknown",
      action:    "SESSION_REVOKE",
      target:    `session:${body.sessionId}`,
      details:   {
        targetUser:   target.name ?? target.email,
        targetEmail:  target.email,
        deviceLabel:  record.deviceLabel,
        adminAction:  true,
      },
      ...auditContext(req, session),
    });

    return NextResponse.json({ ok: true, revoked: body.sessionId });
  }

  return NextResponse.json({ error: t("apiAdmin.users.provideSessionId") }, { status: 400 });
});
