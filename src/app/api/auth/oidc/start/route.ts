import { NextResponse, type NextRequest } from "next/server";
import {
  buildOidcAuthorization,
  isOidcConfigured,
  NATIVE_OIDC_CALLBACK_SCHEME,
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_PATH,
  signOidcStateCookie,
} from "@/lib/oidc";
import { checkRateLimit, getClientIpKey } from "@/lib/rate-limit";
import { safeInternalPath } from "@/lib/safe-url";
import { hasNativeClientHeader, NATIVE_CLIENT_HEADER } from "@/lib/mobile-auth";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Subpath deployments: prefix in-app targets exactly like ../callback/route.ts
// does — `new URL("/login", "https://host/request")` drops the base path.
const basePath = process.env.BASE_PATH ?? "";

// This route is reached by a TOP-LEVEL navigation (login-form sets
// window.location.href), so a JSON error body renders raw in the browser tab
// with no way back. A web caller's failures therefore redirect to
// /login?error=<code> exactly like the callback's do (login-form maps the code
// to a message); a NATIVE caller keeps the JSON status it can read. Fails
// closed to JSON when AUTH_URL is unset rather than deriving the base from an
// attacker-influenceable request Host — same rule as the callback.
function loginErrorRedirect(req: NextRequest, code: string): NextResponse {
  const base = process.env.AUTH_URL;
  if (!base) {
    const t = translatorForRequest(req);
    return NextResponse.json({ error: t("apiAuth.common.authUrlMissing") }, { status: 500 });
  }
  const url = new URL(`${basePath}/login`, base);
  url.searchParams.set("error", code);
  return NextResponse.redirect(url.toString());
}

function getRedirectUri(base: string): string {
  return `${base.replace(/\/$/, "")}/api/auth/oidc/callback`;
}

function isSecureCookieContext(): boolean {
  const url = process.env.AUTH_URL ?? "";
  if (url.startsWith("https://")) return true;
  if (url.startsWith("http://")) return false;
  return process.env.NODE_ENV === "production";
}

export async function GET(req: NextRequest) {
  const t = translatorForRequest(req);
  // Native clients cannot use the redirect+cookie handshake: this call is made
  // by the app's own HTTP client, while the IdP redirect lands in a separate
  // web-auth view with its own cookie jar. They get the authorize URL and the
  // signed flow state as JSON and drive the rest themselves, exactly like
  // /api/auth/plex/start hands back its flowState. Resolved first because it
  // also decides the SHAPE of every failure below (JSON vs /login redirect).
  const isNative = hasNativeClientHeader(req.headers.get(NATIVE_CLIENT_HEADER));

  if (!checkRateLimit(`oidc-start:${getClientIpKey(req.headers)}`, 20, 5 * 60 * 1000)) {
    return isNative
      ? NextResponse.json({ error: t("apiAuth.common.tooManyRequestsTryLaterDot") }, { status: 429 })
      : loginErrorRedirect(req, "rate_limited");
  }

  if (!isOidcConfigured()) {
    return isNative
      ? NextResponse.json({ error: t("apiAuth.oidc.notConfigured") }, { status: 503 })
      : loginErrorRedirect(req, "oidc_not_configured");
  }

  const authUrl = process.env.AUTH_URL;
  if (!authUrl) {
    return NextResponse.json({ error: t("apiAuth.common.authUrlMissing") }, { status: 500 });
  }

  const redirectUri = getRedirectUri(authUrl);
  // Validate callbackUrl so an attacker can't smuggle an open redirect through
  // the OIDC state cookie. safeInternalPath (shared with the callback route and
  // the login form) returns undefined for missing or unsafe input, and the
  // callback then falls back to "/".
  const returnTo = safeInternalPath(req.nextUrl.searchParams.get("callbackUrl"));
  let auth;
  try {
    auth = await buildOidcAuthorization(redirectUri, returnTo, { native: isNative });
  } catch (err) {
    console.error("[oidc/start] discovery or URL build failed:", err);
    return isNative
      ? NextResponse.json({ error: t("apiAuth.oidc.unavailable") }, { status: 503 })
      : loginErrorRedirect(req, "oidc_unavailable");
  }

  const cookieValue = await signOidcStateCookie(auth.state);

  if (isNative) {
    // No Set-Cookie: the cookie would be dead weight here (wrong jar) and the
    // flow state is already in the body. The app submits it back to
    // /api/auth/sign-in/oidc together with the code it catches.
    return NextResponse.json({
      authorizeUrl: auth.url.toString(),
      flowState: cookieValue,
      callbackScheme: NATIVE_OIDC_CALLBACK_SCHEME,
    });
  }

  const res = NextResponse.redirect(auth.url.toString());
  const secure = isSecureCookieContext();
  const attrs = [
    `${OIDC_STATE_COOKIE}=${cookieValue}`,
    // Must include BASE_PATH — a cookie scoped to "/api/auth/oidc" is never sent
    // back to `${BASE_PATH}/api/auth/oidc/callback`, so the callback reads no state
    // and every OIDC sign-in fails. Kept in lockstep with clearStateCookieHeader()
    // in ../callback/route.ts. No-op when BASE_PATH is unset.
    `Path=${OIDC_STATE_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=300",
  ];
  if (secure) attrs.push("Secure");
  res.headers.append("Set-Cookie", attrs.join("; "));
  return res;
}
