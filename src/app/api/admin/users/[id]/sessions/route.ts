import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withPermission, type SummonarrSession } from "@/lib/api-auth";
import { revokeSessionById, revokeAllUserSessions } from "@/lib/auth";
import { clearSessionFootholdsInTx } from "@/lib/session-footholds";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { Permission, hasPermission } from "@/lib/permissions";
import { assertTargetNotAdminInTx, isAdminTarget, TargetBecameAdminError } from "@/lib/account-lifecycle";
import { isIndefiniteDeadline } from "@/lib/session-lifetime";
import { translatorForRequest } from "@/lib/i18n/server-locale";

type RouteParams = { params: Promise<{ id: string }> };

// MANAGE_USERS, like every other account-lifecycle action on the Users page
// (purge / reactivate / mfa): the page admits delegates and shows the Sessions
// menu item to them, so an ADMIN-only gate here just made that one control dead.
// An ADMIN target (by role or by the ADMIN bit — isAdminTarget, the rule the
// in-transaction re-checks apply) additionally needs the ADMIN bit: a delegated
// user manager must not be able to read an admin's device list or sign an
// admin out.
async function readTarget(id: string) {
  return prisma.user.findUnique({ where: { id }, select: { id: true, role: true, permissions: true, name: true } });
}

const callerIsAdmin = (session: SummonarrSession) => hasPermission(session.user.permissions, Permission.ADMIN);

export const GET = withPermission(Permission.MANAGE_USERS)(async (
  req,
  { params }: RouteParams,
  session
) => {
  const t = translatorForRequest(req);
  const { id } = await params;

  const target = await readTarget(id);
  if (!target) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
  if (isAdminTarget(target) && !callerIsAdmin(session)) {
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

  const target = await readTarget(id);
  if (!target) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
  if (isAdminTarget(target) && !callerIsAdmin(session)) {
    return NextResponse.json({ error: t("apiAdmin.users.onlyAdminModify") }, { status: 403 });
  }

  const parsed = await readJsonCapped<{ sessionId?: string; all?: boolean }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  // Strict `=== true`: a stray truthy value (e.g. the string "false") must not
  // sign the user out of every device.
  let revoked: { all: true } | { sessionId: string; deviceLabel: string | null };
  if (body.all === true) {
    revoked = { all: true };
  } else if (body.sessionId && typeof body.sessionId === "string") {
    const record = await prisma.authSession.findUnique({
      where: { sessionId: body.sessionId },
      select: { userId: true, deviceLabel: true },
    });
    if (!record || record.userId !== id) {
      return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
    }
    revoked = { sessionId: body.sessionId, deviceLabel: record.deviceLabel };
  } else {
    return NextResponse.json({ error: t("apiAdmin.users.provideSessionId") }, { status: 400 });
  }

  try {
    if ("all" in revoked) await revokeEverySession(id, callerIsAdmin(session));
    else await revokeSessionById(revoked.sessionId, (tx) => assertTargetNotAdminInTx(tx, id, callerIsAdmin(session)));
  } catch (err) {
    if (err instanceof TargetBecameAdminError) {
      return NextResponse.json({ error: t("apiAdmin.users.onlyAdminModify") }, { status: 403 });
    }
    throw err;
  }

  // Committed — a failed audit write must not 500 it (guardrail 26). Under the
  // ACCOUNT's target, by id (+ display name when it has one), never by email
  // (audit-scrub.ts); a single session goes in details — a `session:<sid>`
  // target named the person only inside its details, which the purge's
  // `user:<id>` scrub never reached.
  void logAudit({
    userId:    session.user.id,
    userName:  session.user.name ?? session.user.email ?? "unknown",
    action:    "SESSION_REVOKE",
    target:    `user:${id}`,
    details:   {
      targetUserId: id,
      ...(target.name ? { targetUser: target.name } : {}),
      ...("all" in revoked
        ? { revokedAll: true }
        : { sessionId: revoked.sessionId, deviceLabel: revoked.deviceLabel }),
      adminAction:  true,
    },
    ...auditContext(req, session),
  });

  return NextResponse.json({ ok: true, revoked: "all" in revoked ? "all" : revoked.sessionId });
});

// Sign the account out everywhere, with the same compromise-response set as
// POST /api/sessions/revoke-all (guardrail 6g), in revokeAllUserSessions' own
// transaction. Not folded into revokeAllUserSessions — Jellyfin offboarding uses
// that helper without wanting to drop push / pending Discord / the calendar URL.
async function revokeEverySession(id: string, callerIsAdminBit: boolean): Promise<void> {
  await revokeAllUserSessions(id, async (tx) => {
    await assertTargetNotAdminInTx(tx, id, callerIsAdminBit);
    await clearSessionFootholdsInTx(tx, id);
    await tx.user.update({
      where: { id },
      data: { calendarTokenHash: null, calendarTokenCreatedAt: null },
    });
  });
}
