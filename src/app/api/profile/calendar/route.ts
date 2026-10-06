import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { logAudit, auditContext } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { isFeatureEnabled } from "@/lib/features";
import { hasPermission, Permission } from "@/lib/permissions";
import { generateCalendarToken, hashCalendarToken } from "@/lib/calendar-token";
import { calendarFeedPath, calendarSiteUrl, CALENDAR_FEATURE_KEY } from "@/lib/calendar-feed";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { tooManyRequests } from "@/lib/http";
import type { Translator } from "@/lib/i18n/translate";

// Manage the caller's personal iCal feed token. The token is shown ONCE — in the
// POST response that mints it — because only its hash is stored (see
// calendar-token.ts for why). GET therefore reports whether a feed exists, never
// its URL. POST always replaces: minting a new hash revokes the old URL at once.
export const dynamic = "force-dynamic";

const GENERATE_LIMIT = 10;
const GENERATE_WINDOW_MS = 60 * 60 * 1000;

function disabled(t: Translator): NextResponse {
  return NextResponse.json({ error: t("apiAuth.profile.calendarDisabled") }, { status: 404 });
}

export const GET = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled(CALENDAR_FEATURE_KEY))) return disabled(t);
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
  const t = translatorForRequest(req);
  // Mints a bearer credential — blocked during maintenance like push/subscribe.
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  if (!(await isFeatureEnabled(CALENDAR_FEATURE_KEY))) return disabled(t);
  if (!checkRateLimit(`calendar-token:${session.user.id}`, GENERATE_LIMIT, GENERATE_WINDOW_MS)) {
    // Retry-After mirrors the limiter's window (http.ts contract).
    return tooManyRequests(GENERATE_WINDOW_MS / 1000, t("apiAuth.common.tooManyRequestsTryLater"));
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
  if (count !== 1) return NextResponse.json({ error: t("apiAuth.profile.accountUnavailable") }, { status: 404 });

  // A bearer credential was minted (and any prior one revoked) — audit after the
  // commit, swallowing (guardrail 26). The token itself is never recorded.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? "unknown",
    action: "SETTINGS_CHANGE",
    target: `user:${session.user.id}`,
    details: { kind: "calendar-token-minted" },
    ...auditContext(req, session),
  });

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

// Deliberately NOT gated on the feature flag: revoking a feed URL is always
// safe, and the hash survives the feature being switched off (the feed route
// only goes dark) — so a user whose URL leaked must be able to revoke it while
// the feature is off, or the leaked link serves again the moment it is re-enabled.
// GET and POST keep the gate.
export const DELETE = withAuth(async (req, _ctx, session) => {
  // A revoke is the one write that must stay open during maintenance too (like
  // push unsubscribe): it only ever removes a credential.
  await prisma.user.updateMany({
    where: { id: session.user.id },
    data: { calendarTokenHash: null, calendarTokenCreatedAt: null },
  });
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? "unknown",
    action: "SETTINGS_CHANGE",
    target: `user:${session.user.id}`,
    details: { kind: "calendar-token-revoked" },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
