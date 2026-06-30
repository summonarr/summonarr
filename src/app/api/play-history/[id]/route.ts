import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const GET = withPermission(Permission.ADMIN)(async (
  _request,
  { params }: { params: Promise<{ id: string }> },
  _session,
) => {
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
});

export const DELETE = withPermission(Permission.ADMIN)(async (
  request,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
  const { id } = await params;
  if (!checkRateLimit(`admin-play-history-delete:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: "Too many attempts — please wait a minute." }, { status: 429 });
  }
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const record = await prisma.playHistory.findUnique({
    where: { id },
    select: {
      id: true,
      mediaServerUserId: true,
      title: true,
      source: true,
      tmdbId: true,
      startedAt: true,
      stoppedAt: true,
    },
  });
  if (!record) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.playHistory.delete({ where: { id } });

  // Row already deleted; a failed audit write must not 500 a successful delete.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "PLAY_HISTORY_DELETE",
    target: `play-history:${id}`,
    details: {
      title: record.title,
      mediaServerUserId: record.mediaServerUserId,
      source: record.source,
      tmdbId: record.tmdbId,
      startedAt: record.startedAt.toISOString(),
      stoppedAt: record.stoppedAt.toISOString(),
    },
    ...auditContext(request, session),
  });

  return new NextResponse(null, { status: 204 });
});
