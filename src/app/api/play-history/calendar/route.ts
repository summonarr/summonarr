import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getActivityCalendar } from "@/lib/play-history";

export const dynamic = "force-dynamic";

// Native-client mirror of the 365-day activity heatmap (the web renders it in
// src/components/admin/activity-calendar.tsx). Returns one row per UTC day with
// a watched-session count; the lib fn already buckets by UTC day and labels
// each `day` as YYYY-MM-DD. Optional source/mediaType filters match the heatmap.
export const GET = withAdmin(async (request, _ctx, _session) => {
  const params = request.nextUrl.searchParams;
  const source = params.get("source") ?? undefined;
  const mediaType = params.get("mediaType") ?? undefined;

  const calendar = await getActivityCalendar(source, mediaType);
  return NextResponse.json(calendar);
});
