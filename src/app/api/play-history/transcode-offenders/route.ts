import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { getTranscodeOffenders } from "@/lib/play-history";

export const dynamic = "force-dynamic";

// Native-client mirror of the transcode-pressure leaderboard on the activity
// overview (src/components/admin/transcode-pressure.tsx). Returns the top users
// and titles forcing server-side transcodes in the window. Params mirror the
// stats route: clamped `days`, optional `source`/`mediaType`.
export const GET = withPermission(Permission.ADMIN)(async (request, _ctx, _session) => {
  const params = request.nextUrl.searchParams;
  // Clamp identically to /api/play-history/stats so an unbounded/negative
  // window can't scan or invert the whole table.
  const days = Math.min(Math.max(parseInt(params.get("days") ?? "30", 10) || 30, 1), 3650);
  // Whitelist BEFORE these reach getTranscodeOffenders: the cache key is built
  // from the raw strings while the SQL filter honours only these values, so an
  // unrecognised one ran both uncached aggregate scans under a key nothing would
  // ever reuse — and evicted real entries from the shared 500-key activity cache
  // on its way out. Same two-branch check as /api/play-history/stats.
  const rawSource = params.get("source");
  const source = rawSource === "plex" || rawSource === "jellyfin" ? rawSource : undefined;
  const rawMediaType = params.get("mediaType");
  const mediaType = rawMediaType === "MOVIE" || rawMediaType === "TV" ? rawMediaType : undefined;

  const offenders = await getTranscodeOffenders({ days, source, mediaType });
  return NextResponse.json(offenders);
});
