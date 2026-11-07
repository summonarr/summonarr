import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { getTranscodeOffenders } from "@/lib/play-history";
import { parseActivityDays, parseActivitySourceMediaType } from "@/lib/activity-days";

export const dynamic = "force-dynamic";

// Native-client mirror of the transcode-pressure leaderboard on the activity
// overview (src/components/admin/transcode-pressure.tsx). Returns the top users
// and titles forcing server-side transcodes in the window. Params mirror the
// stats route: clamped `days`, optional `source`/`mediaType`.
export const GET = withPermission(Permission.ADMIN)(async (request, _ctx, _session) => {
  const params = request.nextUrl.searchParams;
  // Clamp identically to /api/play-history/stats so an unbounded/negative
  // window can't scan or invert the whole table.
  const days = parseActivityDays(params.get("days"));
  // Whitelisted BEFORE these reach getTranscodeOffenders, whose cache key is
  // built from them (see parseActivitySourceMediaType).
  const { source, mediaType } = parseActivitySourceMediaType(params);

  const offenders = await getTranscodeOffenders({ days, source, mediaType });
  return NextResponse.json(offenders);
});
