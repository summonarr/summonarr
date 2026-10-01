import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { isFeatureEnabled } from "@/lib/features";
import { hasPermission, Permission } from "@/lib/permissions";
import { generateCalendarToken, hashCalendarToken } from "@/lib/calendar-token";
import { calendarFeedPath, calendarSiteUrl, CALENDAR_FEATURE_KEY } from "@/lib/calendar-feed";

// Manage the caller's personal iCal feed token. The token is shown ONCE — in the
// POST response that mints it — because only its hash is stored (see
// calendar-token.ts for why). GET therefore reports whether a feed exists, never
// its URL. POST always replaces: minting a new hash revokes the old URL at once.
export const dynamic = "force-dynamic";

const GENERATE_LIMIT = 10;
const GENERATE_WINDOW_MS = 60 * 60 * 1000;

function disabled(): NextResponse {
  return NextResponse.json({ error: "Calendar feeds are disabled" }, { status: 404 });
}

export const GET = withAuth(async (_req, _ctx, session) => {
  if (!(await isFeatureEnabled(CALENDAR_FEATURE_KEY))) return disabled();
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { calendarTokenHash: true, calendarTokenCreatedAt: true },
  });
  return NextResponse.json({
    enabled: !!user?.calendarTokenHash,
    createdAt: user?.calendarTokenHash ? (user.calendarTokenCreatedAt?.toISOString() ?? null) : null,
    canSubscribeAll: hasPermission(session.user.permissions, Permission.MANAGE_REQUESTS),
  });
});

export const POST = withAuth(async (req, _ctx, session) => {
  if (!(await isFeatureEnabled(CALENDAR_FEATURE_KEY))) return disabled();
  if (!checkRateLimit(`calendar-token:${session.user.id}`, GENERATE_LIMIT, GENERATE_WINDOW_MS)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }
  const token = generateCalendarToken();
  const createdAt = new Date();
  // updateMany scoped to a live, never-purged row: a disabled account must not
  // be able to mint a feed (its next poll would 404 anyway, but the write is
  // refused here rather than relied on downstream).
  const { count } = await prisma.user.updateMany({
    where: { id: session.user.id, deactivatedAt: null, purgedAt: null },
    data: { calendarTokenHash: hashCalendarToken(token), calendarTokenCreatedAt: createdAt },
  });
  if (count !== 1) return NextResponse.json({ error: "Account unavailable" }, { status: 404 });

  const site = calendarSiteUrl(req.nextUrl.origin);
  const url = `${site ?? ""}${calendarFeedPath(token)}`;
  const canSubscribeAll = hasPermission(session.user.permissions, Permission.MANAGE_REQUESTS);
  return NextResponse.json(
    {
      token,
      url,
      webcalUrl: url.replace(/^https?:\/\//i, "webcal://"),
      allUrl: canSubscribeAll ? `${url}?scope=all` : null,
      createdAt: createdAt.toISOString(),
    },
    // The body carries a credential: never cache it anywhere.
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
});

export const DELETE = withAuth(async (_req, _ctx, session) => {
  if (!(await isFeatureEnabled(CALENDAR_FEATURE_KEY))) return disabled();
  await prisma.user.updateMany({
    where: { id: session.user.id },
    data: { calendarTokenHash: null, calendarTokenCreatedAt: null },
  });
  return NextResponse.json({ ok: true });
});
