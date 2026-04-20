import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAuditOrFail, auditContext } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN" || isTokenExpired(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const record = await prisma.playHistory.findUnique({
    where: { id },
    include: {
      mediaServerUser: {
        select: { id: true, username: true, source: true, thumbUrl: true },
      },
    },
  });
  if (!record) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(record);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN" || isTokenExpired(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const record = await prisma.playHistory.findUnique({
    where: { id },
    select: { id: true, mediaServerUserId: true, title: true },
  });
  if (!record) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.playHistory.delete({ where: { id } });

  await logAuditOrFail({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: `play-history:${id}`,
    details: { title: record.title, mediaServerUserId: record.mediaServerUserId },
    ...auditContext(request, session),
  });

  return new NextResponse(null, { status: 204 });
}
