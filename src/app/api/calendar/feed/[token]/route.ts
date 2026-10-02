import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIpKey } from "@/lib/rate-limit";
import { isFeatureEnabled } from "@/lib/features";
import { effectivePermissions, hasPermission, Permission } from "@/lib/permissions";
import { tokenFromFeedSegment, hashCalendarToken, isWellFormedCalendarToken } from "@/lib/calendar-token";
import { buildCalendarFeed, CALENDAR_FEATURE_KEY, resolveCalendarToken, type CalendarScope } from "@/lib/calendar-feed";

// PUBLIC (listed in isPublicPath in proxy.ts + ROUTE_EXCEPTIONS in
// audit-routes.mts): a calendar app subscribing to this URL sends no cookie and
// no header, so the secret token in the path IS the credential. Only its
// SHA-256 hash is stored and the compare is timing-safe (calendar-token.ts).
//
// Every failure is the same bare 404 — unknown token, revoked token, a disabled
// or purged owner, `?scope=all` without MANAGE_REQUESTS, the feature switched
// off — so the endpoint never tells a prober which of those it hit.
//
// Cache-read only: no upstream call per poll (calendar-feed.ts).
export const dynamic = "force-dynamic";

// Per client address: generous for a household of calendar apps behind one
// NAT, tight enough that the token space can't be walked.
const IP_LIMIT = 60;
const IP_WINDOW_MS = 10 * 60 * 1000;
// Per token: Apple Calendar can poll every 5 minutes; nothing legitimate needs
// more than this, and it caps what one leaked URL can cost the server.
const TOKEN_LIMIT = 20;
const TOKEN_WINDOW_MS = 10 * 60 * 1000;

function notFound(): NextResponse {
  return new NextResponse("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function tooMany(windowMs: number): NextResponse {
  return new NextResponse("Too many requests", {
    status: 429,
    headers: { "Retry-After": String(windowMs / 1000), "Cache-Control": "no-store" },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  // Rate-limit BEFORE any DB work, so garbage tokens cost nothing but a map hit.
  if (!checkRateLimit(`calendar-feed:ip:${getClientIpKey(req.headers)}`, IP_LIMIT, IP_WINDOW_MS)) {
    return tooMany(IP_WINDOW_MS);
  }
  const token = tokenFromFeedSegment((await params).token);
  if (!isWellFormedCalendarToken(token)) return notFound();
  if (!checkRateLimit(`calendar-feed:token:${hashCalendarToken(token)}`, TOKEN_LIMIT, TOKEN_WINDOW_MS)) {
    return tooMany(TOKEN_WINDOW_MS);
  }
  if (!(await isFeatureEnabled(CALENDAR_FEATURE_KEY))) return notFound();

  const owner = await resolveCalendarToken(token);
  if (!owner) return notFound();

  const scopeParam = req.nextUrl.searchParams.get("scope");
  let scope: CalendarScope = { kind: "user", userId: owner.id };
  if (scopeParam === "all") {
    // Re-checked on EVERY poll against the live row: a demoted admin's
    // all-requests subscription stops working at once.
    const perms = effectivePermissions(owner.role, owner.permissions);
    if (!hasPermission(perms, Permission.MANAGE_REQUESTS)) return notFound();
    scope = { kind: "all" };
  } else if (scopeParam !== null) {
    return notFound();
  }

  // Written in the feed owner's language (their stored User.locale).
  const body = await buildCalendarFeed(scope, undefined, owner.locale);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="${scope.kind === "all" ? "summonarr-requests" : "summonarr"}.ics"`,
      // Private: the URL is a credential; no shared cache may keep the body.
      "Cache-Control": "private, max-age=900",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}
