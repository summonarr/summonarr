import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { getPlayHistoryStats } from "@/lib/play-history";

export const dynamic = "force-dynamic";

export const GET = withPermission(Permission.ADMIN)(async (request, _ctx, _session) => {
  const params = request.nextUrl.searchParams;
  // Clamp to match the stats page route (src/app/(app)/admin/activity/stats):
  // an unbounded/negative day window would scan or invert the whole table.
  const days = Math.min(Math.max(parseInt(params.get("days") ?? "30", 10) || 30, 1), 3650);
  const source = params.get("source") ?? undefined;
  const mediaType = params.get("mediaType") ?? undefined;

  const stats = await getPlayHistoryStats({ days, source, mediaType });
  return NextResponse.json(stats);
});
