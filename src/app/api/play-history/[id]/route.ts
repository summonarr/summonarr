import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
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
      referenceId: true,
    },
  });
  if (!record) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // `?chain=true` deletes the whole resume chain — one viewing that was paused
  // and resumed, stored as N rows. The admin history table groups those into a
  // single row and offers a single delete, so deleting only the row's own id
  // removed one segment while the UI dropped the group and promised permanent
  // removal. The chain then came back on the next fetch, one segment lighter
  // and reporting a lower watched percentage — a delete that silently corrupted
  // what it claimed to remove.
  //
  // The chain key is COALESCE(referenceId, id), matching the grouping in
  // /api/play-history: a continuation carries the root's id in referenceId, and
  // the ROOT ITSELF HAS referenceId = null (it is not self-linked). So the
  // predicate has to match the root by id and the continuations by referenceId
  // — keying on referenceId alone would leave the root behind, which is the
  // oldest segment and the one that anchors the group.
  const chain = request.nextUrl.searchParams.get("chain") === "true";
  const chainId = record.referenceId ?? record.id;

  const deleted = chain
    ? await prisma.playHistory.deleteMany({
        where: { OR: [{ id: chainId }, { referenceId: chainId }] },
      })
    // The findUnique above is a TOCTOU: a concurrent (or double-submitted) delete
    // removes the row first and Prisma answers this one with P2025, which nothing
    // here catches — so a removal that SUCCEEDED was reported as a 500, while the
    // chain branch's deleteMany no-ops and 204s in the identical race. Swallow
    // only P2025; the 404 pre-check still covers an id that never existed.
    : await prisma.playHistory
        .delete({ where: { id } })
        .then(() => ({ count: 1 }))
        .catch((err: unknown) => {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") return { count: 0 };
          throw err;
        });

  // Rows already deleted; a failed audit write must not 500 a successful delete.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "PLAY_HISTORY_DELETE",
    target: `play-history:${chain ? chainId : id}`,
    details: {
      title: record.title,
      mediaServerUserId: record.mediaServerUserId,
      source: record.source,
      tmdbId: record.tmdbId,
      startedAt: record.startedAt.toISOString(),
      stoppedAt: record.stoppedAt.toISOString(),
      // Without these the audit log cannot tell a whole-viewing delete from a
      // single-segment one, and play history has no recovery path short of a
      // backup restore (guardrail 19 — the live poller is its only writer).
      ...(chain ? { chain: true, chainId, segmentsDeleted: deleted.count } : {}),
    },
    ...auditContext(request, session),
  });

  return new NextResponse(null, { status: 204 });
});
