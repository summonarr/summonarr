import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { revokeSessionById, revokeAllUserSessions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = withAdmin(async (
  _req,
  { params }: RouteParams,
  _session
) => {
  const { id } = await params;

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

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

  return NextResponse.json(sessions);
});

export const DELETE = withAdmin(async (
  req,
  { params }: RouteParams,
  session
) => {
  const { id } = await params;

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true },
  });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = await readJsonCapped<{ sessionId?: string; all?: boolean }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (body.all) {
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
      return NextResponse.json({ error: "Not found" }, { status: 404 });
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

  return NextResponse.json({ error: "Provide sessionId or all: true" }, { status: 400 });
});
