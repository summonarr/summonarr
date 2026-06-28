import { NextResponse, type NextRequest } from "next/server";
import { findOrCreateOidcUser, PROVIDER_REBIND_REQUIRED, PROVIDER_SETUP_REQUIRED, signInAndMintSession, buildDeviceMeta, normalizeEmail } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  exchangeOidcCode,
  isOidcConfigured,
  OIDC_STATE_COOKIE,
  verifyOidcStateCookie,
} from "@/lib/oidc";
import { serializeSessionCookie } from "@/lib/session-cookie";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

function readStateCookie(req: NextRequest): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const piece of header.split(/;\s*/)) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    if (piece.slice(0, eq) === OIDC_STATE_COOKIE) return piece.slice(eq + 1);
  }
  return null;
}

function clearStateCookieHeader(): string {
  return `${OIDC_STATE_COOKIE}=; Path=/api/auth/oidc; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function loginErrorRedirect(_req: NextRequest, code: string): NextResponse {
  // AUTH_URL is guaranteed set by the early guard in GET; fail closed otherwise
  // rather than deriving the base from an attacker-influenceable request Host.
  const base = process.env.AUTH_URL;
  if (!base) {
    return NextResponse.json({ error: "Server misconfigured: AUTH_URL is not set" }, { status: 500 });
  }
  const url = new URL("/login", base);
  url.searchParams.set("error", code);
  const res = NextResponse.redirect(url.toString());
  res.headers.append("Set-Cookie", clearStateCookieHeader());
  return res;
}

export async function GET(req: NextRequest) {
  const authUrl = process.env.AUTH_URL;
  if (!authUrl) {
    return NextResponse.json({ error: "Server misconfigured: AUTH_URL is not set" }, { status: 500 });
  }

  // Throttle the callback like /start — each hit triggers an outbound IdP token
  // exchange and a DB user lookup/create even before the state cookie is checked.
  if (!checkRateLimit(`oidc-callback:${getClientIp(req.headers)}`, 20, 5 * 60 * 1000)) {
    return loginErrorRedirect(req, "rate_limited");
  }

  if (!isOidcConfigured()) {
    return loginErrorRedirect(req, "oidc_not_configured");
  }

  const stateCookie = readStateCookie(req);
  if (!stateCookie) {
    return loginErrorRedirect(req, "oidc_no_state");
  }
  const flowState = await verifyOidcStateCookie(stateCookie);
  if (!flowState) {
    return loginErrorRedirect(req, "oidc_state_invalid");
  }

  let claims;
  try {
    claims = await exchangeOidcCode(new URL(req.url), flowState);
  } catch (err) {
    console.error("[oidc/callback] code exchange failed:", err instanceof Error ? err.message : err);
    return loginErrorRedirect(req, "oidc_exchange_failed");
  }

  let dbUser;
  try {
    dbUser = await findOrCreateOidcUser(claims);
  } catch (err) {
    console.error("[oidc/callback] user lookup failed:", err instanceof Error ? err.message : err);
    return loginErrorRedirect(req, "oidc_user_rejected");
  }

  if (dbUser === PROVIDER_REBIND_REQUIRED) {
    return loginErrorRedirect(req, "oidc_rebind_required");
  }
  if (dbUser === PROVIDER_SETUP_REQUIRED) {
    return loginErrorRedirect(req, "oidc_setup_required");
  }

  // Keep notificationEmail in lock-step with the OIDC provider's email claim
  // on every sign-in.
  if (claims.email) {
    const oidcEmail = normalizeEmail(claims.email);
    await prisma.user
      .update({ where: { id: dbUser.id }, data: { notificationEmail: oidcEmail } })
      .catch((err) => console.error("[oidc/callback] notificationEmail sync failed:", err instanceof Error ? err.message : err));
  }

  const device = buildDeviceMeta(req.headers);
  let result: Awaited<ReturnType<typeof signInAndMintSession>>;
  try {
    result = await signInAndMintSession({
      user: { ...dbUser, ...device },
      providerId: "oidc",
    });
  } catch (err) {
    // Don't let a transient DB failure during mint throw out of the handler and
    // strand the OIDC state cookie — redirect to login with an error like the
    // other failure paths in this route.
    console.error("[oidc/callback] OIDC session mint failed:", err instanceof Error ? err.message : err);
    return loginErrorRedirect(req, "oidc_session_error");
  }

  // AUTH_URL is guaranteed non-empty by the early guard at the top of GET.
  const base = authUrl;
  // returnTo was already validated at /start (must start with "/", not "//")
  // and signed into the state cookie, so re-validating here is belt-and-
  // suspenders — defends against a future regression in /start.
  const safeReturn =
    flowState.returnTo && flowState.returnTo.startsWith("/") && !flowState.returnTo.startsWith("//")
      ? flowState.returnTo
      : "/";
  const res = NextResponse.redirect(new URL(safeReturn, base).toString());
  res.headers.append(
    "Set-Cookie",
    serializeSessionCookie(result.token, { maxAgeSeconds: result.expiresInSeconds }),
  );
  res.headers.append("Set-Cookie", clearStateCookieHeader());
  return res;
}
