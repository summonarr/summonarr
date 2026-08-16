import { NextResponse, type NextRequest } from "next/server";
import {
  buildOidcAuthorization,
  isOidcConfigured,
  NATIVE_OIDC_CALLBACK_SCHEME,
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_PATH,
  signOidcStateCookie,
} from "@/lib/oidc";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { safeInternalPath } from "@/lib/safe-url";
import { hasNativeClientHeader, NATIVE_CLIENT_HEADER } from "@/lib/mobile-auth";

function getRedirectUri(base: string): string {
  return `${base.replace(/\/$/, "")}/api/auth/oidc/callback`;
}

function isSecureCookieContext(): boolean {
  const url = process.env.AUTH_URL ?? "";
  if (url.startsWith("https://")) return true;
  if (url.startsWith("http://")) return false;
  return process.env.NODE_ENV === "production";
}

// Validates a callbackUrl query param so an attacker can't smuggle an open
// redirect through the OIDC state cookie. Shares safeInternalPath with the
// callback route and login-form.tsx — the old hand-rolled
// `startsWith("/") && !startsWith("//")` test was bypassable with an embedded
// TAB/LF/CR (see src/lib/safe-url.ts). Returns undefined for missing or invalid
// input — the callback then falls back to "/".

export async function GET(req: NextRequest) {
  if (!checkRateLimit(`oidc-start:${getClientIp(req.headers)}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later." }, { status: 429 });
  }

  if (!isOidcConfigured()) {
    return NextResponse.json({ error: "OIDC sign-in is not configured" }, { status: 503 });
  }

  const authUrl = process.env.AUTH_URL;
  if (!authUrl) {
    return NextResponse.json({ error: "Server misconfigured: AUTH_URL is not set" }, { status: 500 });
  }

  const redirectUri = getRedirectUri(authUrl);
  const returnTo = safeInternalPath(req.nextUrl.searchParams.get("callbackUrl"));
  // Native clients cannot use the redirect+cookie handshake: this call is made
  // by the app's own HTTP client, while the IdP redirect lands in a separate
  // web-auth view with its own cookie jar. They get the authorize URL and the
  // signed flow state as JSON and drive the rest themselves, exactly like
  // /api/auth/plex/start hands back its flowState.
  const isNative = hasNativeClientHeader(req.headers.get(NATIVE_CLIENT_HEADER));
  let auth;
  try {
    auth = await buildOidcAuthorization(redirectUri, returnTo, { native: isNative });
  } catch (err) {
    console.error("[oidc/start] discovery or URL build failed:", err);
    return NextResponse.json({ error: "OIDC sign-in is unavailable" }, { status: 503 });
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
