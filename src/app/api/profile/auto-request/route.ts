import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { isFeatureEnabled } from "@/lib/features";
import { canAutoRequest } from "@/lib/permissions";
import { WATCHLIST_AUTO_REQUEST_FEATURE_KEY } from "@/lib/auto-request";
import { getPlexWatchlistConnection } from "@/lib/plex-watchlist";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// The caller's watchlist auto-request state (src/lib/auto-request.ts):
//   enabled        — the feature flag is on;
//   permitted      — they hold an AUTO_REQUEST* bit for movies and/or TV;
//   plexWatchlist  — their own "Auto-request from my Plex watchlist" toggle;
//   plexConnected  — a Plex token of THEIR OWN is stored (captured at Plex
//                    sign-in while the feature is on). Unchanged meaning.
// Additive (the iOS app decodes this body — never remove or rename a field):
//   plexServerSource  — the admin lets the cron read Plex friends' watchlists
//                       through the server owner's token;
//   plexServerOptedIn — the caller's consent counts for that path (the toggle is
//                       on AND they turned it on themselves, or the admin
//                       auto-enrolls); false the moment they switch it off;
//   plexServerStatus  — the last server-path run's verdict for them:
//                       "ok" | "private" | "error" | null (not read);
//   plexConnectedVia  — "token" | "server" | null: how the cron reads their list.
// The web profile renders this server-side; native clients need the REST form.
export const GET = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const [enabled, user, plexAccount] = await Promise.all([
    isFeatureEnabled(WATCHLIST_AUTO_REQUEST_FEATURE_KEY),
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { plexWatchlistAutoRequest: true, plexWatchlistOptInAt: true },
    }),
    prisma.account.findFirst({ where: { userId: session.user.id, provider: "plex" }, select: { id: true } }),
  ]);
  if (!user) return NextResponse.json({ error: t("apiAuth.common.notFound") }, { status: 404 });
  const connection = await getPlexWatchlistConnection(
    { id: session.user.id, plexWatchlistOptInAt: user.plexWatchlistOptInAt, plexWatchlistAutoRequest: user.plexWatchlistAutoRequest },
    plexAccount !== null,
  );
  return NextResponse.json({
    enabled,
    permitted: {
      movie: canAutoRequest(session.user.permissions, "MOVIE"),
      tv: canAutoRequest(session.user.permissions, "TV"),
    },
    plexWatchlist: user.plexWatchlistAutoRequest,
    plexConnected: plexAccount !== null,
    plexServerSource: connection.serverSource,
    plexServerOptedIn: connection.serverOptedIn,
    plexServerStatus: connection.serverStatus,
    plexConnectedVia: connection.connectedVia,
  });
});

// Flip the caller's own Plex-watchlist toggle. Deliberately ungated on the flag
// and the permission: it is a preference, and it should survive an admin
// turning the feature off and on again. Turning it ON is the explicit consent
// the server-token path requires (plexWatchlistOptInAt, guardrail 34b); turning
// it off clears that consent.
export const PATCH = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<{ plexWatchlist?: unknown }>(req, 4096);
  if (parsed instanceof NextResponse) return parsed;
  if (typeof parsed.plexWatchlist !== "boolean") {
    return NextResponse.json({ error: t("apiAuth.profile.plexWatchlistBoolean") }, { status: 400 });
  }
  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      plexWatchlistAutoRequest: parsed.plexWatchlist,
      plexWatchlistOptInAt: parsed.plexWatchlist ? new Date() : null,
    },
  });
  // Opting out drops the stored plex.tv token: it exists only to read the
  // watchlist, and a full-account credential shouldn't outlive its purpose.
  // Opting back in needs one Plex sign-in to store a fresh one.
  if (!parsed.plexWatchlist) {
    await prisma.account.deleteMany({ where: { userId: session.user.id, provider: "plex" } });
  }
  return NextResponse.json({ plexWatchlist: parsed.plexWatchlist });
});
