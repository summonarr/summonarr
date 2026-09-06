import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { getActivityCalendar } from "@/lib/play-history";

export const dynamic = "force-dynamic";

// Native-client mirror of the 365-day activity heatmap (the web renders it in
// src/components/admin/activity-calendar.tsx). Returns one row per UTC day with
// a watched-session count; the lib fn already buckets by UTC day and labels
// each `day` as YYYY-MM-DD. Optional source/mediaType filters match the heatmap.
export const GET = withPermission(Permission.ADMIN)(async (request, _ctx, _session) => {
  const params = request.nextUrl.searchParams;
  // Whitelist BEFORE these reach getActivityCalendar — same reason as the
  // sibling /api/play-history/stats route: the cache key is built from the raw
  // strings while the SQL filter ignores unknown values, so every distinct junk
  // value ran the full uncached 365-day scan under a key nothing would reuse
  // and evicted real entries from the shared 500-key activity cache.
  const rawSource = params.get("source");
  const source = rawSource === "plex" || rawSource === "jellyfin" ? rawSource : undefined;
  const rawMediaType = params.get("mediaType");
  const mediaType = rawMediaType === "MOVIE" || rawMediaType === "TV" ? rawMediaType : undefined;

  const calendar = await getActivityCalendar(source, mediaType);
  return NextResponse.json(calendar);
});
