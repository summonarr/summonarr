import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { isFeatureEnabled } from "@/lib/features";
import { canAutoRequest } from "@/lib/permissions";
import { WATCHLIST_AUTO_REQUEST_FEATURE_KEY } from "@/lib/auto-request";

// The caller's watchlist auto-request state (src/lib/auto-request.ts):
//   enabled        — the feature flag is on;
//   permitted      — they hold an AUTO_REQUEST* bit for movies and/or TV;
//   plexWatchlist  — their own "Auto-request from my Plex watchlist" toggle;
//   plexConnected  — a Plex token is stored (captured at Plex sign-in while the
//                    feature is on), i.e. the cron can actually read their list.
// The web profile renders this server-side; native clients need the REST form.
export const GET = withAuth(async (_req, _ctx, session) => {
  const [enabled, user, plexAccount] = await Promise.all([
    isFeatureEnabled(WATCHLIST_AUTO_REQUEST_FEATURE_KEY),
    prisma.user.findUnique({ where: { id: session.user.id }, select: { plexWatchlistAutoRequest: true } }),
    prisma.account.findFirst({ where: { userId: session.user.id, provider: "plex" }, select: { id: true } }),
  ]);
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    enabled,
    permitted: {
      movie: canAutoRequest(session.user.permissions, "MOVIE"),
      tv: canAutoRequest(session.user.permissions, "TV"),
    },
    plexWatchlist: user.plexWatchlistAutoRequest,
    plexConnected: plexAccount !== null,
  });
});

// Flip the caller's own Plex-watchlist toggle. Deliberately ungated on the flag
// and the permission: it is a preference, and it should survive an admin
// turning the feature off and on again.
export const PATCH = withAuth(async (req, _ctx, session) => {
  const parsed = await readJsonCapped<{ plexWatchlist?: unknown }>(req, 4096);
  if (parsed instanceof NextResponse) return parsed;
  if (typeof parsed.plexWatchlist !== "boolean") {
    return NextResponse.json({ error: "plexWatchlist must be a boolean" }, { status: 400 });
  }
  await prisma.user.update({
    where: { id: session.user.id },
    data: { plexWatchlistAutoRequest: parsed.plexWatchlist },
  });
  // Opting out drops the stored plex.tv token: it exists only to read the
  // watchlist, and a full-account credential shouldn't outlive its purpose.
  // Opting back in needs one Plex sign-in to store a fresh one.
  if (!parsed.plexWatchlist) {
    await prisma.account.deleteMany({ where: { userId: session.user.id, provider: "plex" } });
  }
  return NextResponse.json({ plexWatchlist: parsed.plexWatchlist });
});
