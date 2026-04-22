import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { revokeSessionById } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";

export async function GET() {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const sessions = await prisma.authSession.findMany({
    where: { userId: session.user.id },
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

  const currentSessionId = session.sessionId;

  return NextResponse.json(
    sessions.map((s) => ({
      ...s,
      isCurrent: s.sessionId === currentSessionId,
    }))
  );
}

export async function DELETE(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  let body: { sessionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { sessionId } = body;
  if (!sessionId || typeof sessionId !== "string") {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const record = await prisma.authSession.findUnique({
    where: { sessionId },
    select: { userId: true, deviceLabel: true },
  });

  if (!record || record.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await revokeSessionById(sessionId);

  void logAudit({
    userId:    session.user.id,
    userName:  session.user.name ?? session.user.email ?? "unknown",
    action:    "SESSION_REVOKE",
    target:    `session:${sessionId}`,
    ipAddress: getClientIp(req.headers),
    userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
    details:   { deviceLabel: record.deviceLabel, revokedByOwner: true },
  });

  return NextResponse.json({ ok: true });
}
