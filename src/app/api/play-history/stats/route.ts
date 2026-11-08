import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { getPlayHistoryStats } from "@/lib/play-history";
import { parseActivityDays, parseActivitySourceMediaType } from "@/lib/activity-days";

export const dynamic = "force-dynamic";

export const GET = withPermission(Permission.ADMIN)(async (request, _ctx, _session) => {
  const params = request.nextUrl.searchParams;
  // Clamp to match the stats page route (src/app/(app)/admin/activity/stats):
  // an unbounded/negative day window would scan or invert the whole table.
  const days = parseActivityDays(params.get("days"));
  // Whitelisted BEFORE these reach getPlayHistoryStats, whose cache key is built
  // from them (see parseActivitySourceMediaType): every distinct junk value used
  // to run the full uncached fan-out under a key nothing would ever reuse.
  const { source, mediaType } = parseActivitySourceMediaType(params);

  const stats = await getPlayHistoryStats({ days, source, mediaType });
  return NextResponse.json(stats);
});
