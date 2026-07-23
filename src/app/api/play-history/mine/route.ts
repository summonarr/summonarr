import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { getMyWatchHistory } from "@/lib/my-watch-history";

export const dynamic = "force-dynamic";

// GET — the caller's OWN watch history. Unlike the rest of /api/play-history
// (ADMIN-only), this is open to any authenticated user because the scope is
// fixed server-side: getMyWatchHistory filters by the MediaServerUser rows
// linked to the SESSION user, and no query param can widen that — there is
// deliberately no userId parameter. Params: `cursor` (keyset, from the
// previous response), `mediaType` (MOVIE|TV), `search` (title/episode).
export const GET = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`play-history-mine:${session.user.id}`, 120, 60_000)) {
    return tooManyRequests(60);
  }
  const sp = req.nextUrl.searchParams;
  const page = await getMyWatchHistory(session.user.id, {
    cursor: sp.get("cursor"),
    mediaType: sp.get("mediaType"),
    search: sp.get("search"),
  });
  return NextResponse.json(page);
});
