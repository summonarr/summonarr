import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Coerce EVERY BigInt column on a row to a number, whatever they happen to be.
//
// This route returns the whole ActiveSession row (`...s`), and JSON.stringify
// throws a TypeError on a BigInt — so one uncoerced BigInt column turns the
// entire endpoint into a 500. The previous hand-maintained list named the three
// columns that existed when it was written (progressMs/playtimeMs/durationMs)
// and silently went stale the moment `startProgressMs` was added: every request
// with at least one live session 500'd, and because the iOS app is this route's
// ONLY consumer (the web now-playing list is rendered by the admin/activity
// server component and refreshed over the `activity:sessions` SSE payload,
// neither of which serializes through here) nothing on the web surfaced it.
// Deriving the set from the row means the next BigInt column can't repeat that.
function withoutBigInts<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === "bigint" ? Number(value) : value;
  }
  // Every bigint became a number and nothing else moved; the wire shape is
  // identical to the field-by-field version this replaced.
  return out as T;
}

export const GET = withPermission(Permission.ADMIN)(async (_req, _ctx, _session) => {
  const sessions = await prisma.activeSession.findMany({
    orderBy: { startedAt: "desc" },
  });

  return NextResponse.json(sessions.map(withoutBigInts));
});
