import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { revokeSessionById, revokeAllUserSessions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAuditOrFail } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(
  _req: NextRequest,
  { params }: RouteParams
) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

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
}

export async function DELETE(
  req: NextRequest,
  { params }: RouteParams
) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  const { id } = await params;

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true },
  });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { sessionId?: string; all?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.all) {
    await revokeAllUserSessions(id);

    await logAuditOrFail({
      userId:    session.user.id,
      userName:  session.user.name ?? session.user.email ?? "unknown",
      action:    "SESSION_REVOKE",
      target:    `user:${id}`,
      ipAddress: getClientIp(req.headers),
      userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
      details:   {
        targetUser:  target.name ?? target.email,
        targetEmail: target.email,
        revokedAll:  true,
        adminAction: true,
      },
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

    await logAuditOrFail({
      userId:    session.user.id,
      userName:  session.user.name ?? session.user.email ?? "unknown",
      action:    "SESSION_REVOKE",
      target:    `session:${body.sessionId}`,
      ipAddress: getClientIp(req.headers),
      userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
      details:   {
        targetUser:   target.name ?? target.email,
        targetEmail:  target.email,
        deviceLabel:  record.deviceLabel,
        adminAction:  true,
      },
    });

    return NextResponse.json({ ok: true, revoked: body.sessionId });
  }

  return NextResponse.json({ error: "Provide sessionId or all: true" }, { status: 400 });
}
