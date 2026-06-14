import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getTranscodeOffenders } from "@/lib/play-history";

export const dynamic = "force-dynamic";

// Native-client mirror of the transcode-pressure leaderboard on the activity
// overview (src/components/admin/transcode-pressure.tsx). Returns the top users
// and titles forcing server-side transcodes in the window. Params mirror the
// stats route: clamped `days`, optional `source`/`mediaType`.
export const GET = withAdmin(async (request, _ctx, _session) => {
  const params = request.nextUrl.searchParams;
  // Clamp identically to /api/play-history/stats so an unbounded/negative
  // window can't scan or invert the whole table.
  const days = Math.min(Math.max(parseInt(params.get("days") ?? "30", 10) || 30, 1), 3650);
  const source = params.get("source") ?? undefined;
  const mediaType = params.get("mediaType") ?? undefined;

  const offenders = await getTranscodeOffenders({ days, source, mediaType });
  return NextResponse.json(offenders);
});
