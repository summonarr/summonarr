import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getHeatmapCellDetail, type HeatmapCellQuery } from "@/lib/play-history";

// Drill-down behind the click popover on the activity heatmaps. Returns the
// per-cell aggregate (plays, transcode mix, watch time, quality/network) for a
// clicked calendar day (mode=day) or day-of-week × hour bucket (mode=hour).
// Counts filter watched=true server-side so the popover total matches the cell.
//
// Query: mode=day&day=YYYY-MM-DD | mode=hour&dow=0-6&hour=0-23
//        [&userId=…] [&source=plex|jellyfin] [&mediaType=MOVIE|TV] [&days=N]
export const GET = withAdmin(async (req) => {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode");

  if (mode !== "day" && mode !== "hour") {
    return NextResponse.json({ error: "mode must be 'day' or 'hour'" }, { status: 400 });
  }

  const query: HeatmapCellQuery = { mode };

  if (mode === "day") {
    const day = searchParams.get("day") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return NextResponse.json({ error: "day must be YYYY-MM-DD" }, { status: 400 });
    }
    query.day = day;
  } else {
    // Reject absent/empty params before coercion — Number(null) and Number("")
    // are both 0, which would silently resolve to the Sunday-00:00 cell instead
    // of a 400 (the day branch already 400s on a missing day).
    const dowRaw = searchParams.get("dow");
    const hourRaw = searchParams.get("hour");
    const dow = dowRaw == null || dowRaw === "" ? NaN : Number(dowRaw);
    const hour = hourRaw == null || hourRaw === "" ? NaN : Number(hourRaw);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      return NextResponse.json({ error: "dow must be 0-6" }, { status: 400 });
    }
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      return NextResponse.json({ error: "hour must be 0-23" }, { status: 400 });
    }
    query.dow = dow;
    query.hour = hour;
    const daysParam = searchParams.get("days");
    if (daysParam != null) {
      const days = Number(daysParam);
      if (Number.isInteger(days) && days > 0 && days <= 3650) query.days = days;
    }
  }

  const userId = searchParams.get("userId");
  if (userId) query.userId = userId;

  const source = searchParams.get("source");
  if (source === "plex" || source === "jellyfin") query.source = source;

  const mediaType = searchParams.get("mediaType");
  if (mediaType === "MOVIE" || mediaType === "TV") query.mediaType = mediaType;

  const detail = await getHeatmapCellDetail(query);
  return NextResponse.json(detail);
});
