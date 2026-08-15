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
  // Whitelist BEFORE these reach getPlayHistoryStats: the cache key is built from
  // the raw strings, so an unrecognised value minted its own key while the SQL
  // filter ignored it — every distinct junk value ran the full ~33-query uncached
  // fan-out under a slot nothing would ever reuse, and evicted real entries from
  // the 500-key cache on its way out. Same two-branch check the sibling list and
  // export routes already use.
  const rawSource = params.get("source");
  const source = rawSource === "plex" || rawSource === "jellyfin" ? rawSource : undefined;
  const rawMediaType = params.get("mediaType");
  const mediaType = rawMediaType === "MOVIE" || rawMediaType === "TV" ? rawMediaType : undefined;

  const stats = await getPlayHistoryStats({ days, source, mediaType });
  return NextResponse.json(stats);
});
