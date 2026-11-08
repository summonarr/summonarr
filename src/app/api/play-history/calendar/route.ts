import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { getActivityCalendar } from "@/lib/play-history";
import { parseActivitySourceMediaType } from "@/lib/activity-days";

export const dynamic = "force-dynamic";

// Native-client mirror of the 365-day activity heatmap (the web renders it in
// src/components/admin/activity-calendar.tsx). Returns one row per day with a
// watched-session count; the lib fn buckets by the statistics time zone's day
// (the statsTimeZone setting, else the server's zone) and labels each `day` as
// YYYY-MM-DD. Optional source/mediaType filters match the heatmap.
export const GET = withPermission(Permission.ADMIN)(async (request, _ctx, _session) => {
  // Whitelisted BEFORE these reach getActivityCalendar, whose cache key is built
  // from them (see parseActivitySourceMediaType): every distinct junk value used
  // to run the full uncached 365-day scan under a key nothing would reuse.
  const { source, mediaType } = parseActivitySourceMediaType(request.nextUrl.searchParams);

  const calendar = await getActivityCalendar(source, mediaType);
  return NextResponse.json(calendar);
});
