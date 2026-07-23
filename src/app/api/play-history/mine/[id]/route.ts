import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { getMyWatchHistoryEntry } from "@/lib/my-watch-history";

export const dynamic = "force-dynamic";

// GET — the play-by-play breakdown of ONE consolidated entry from the caller's
// own watch history. `id` is any play id in the entry (the list hands out the
// representative row's id). Scope is enforced inside getMyWatchHistoryEntry:
// a row belonging to another user's media-server identity 404s exactly like a
// missing one, so foreign ids leak nothing. Shares the /mine rate bucket.
export const GET = withAuth(async (
  _req,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
  if (!checkRateLimit(`play-history-mine:${session.user.id}`, 120, 60_000)) {
    return tooManyRequests(60);
  }
  const { id } = await params;
  if (!id || typeof id !== "string" || id.length > 64) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }
  const detail = await getMyWatchHistoryEntry(session.user.id, id);
  if (!detail) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(detail);
});
