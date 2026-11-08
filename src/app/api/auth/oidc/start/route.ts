import { NextResponse, type NextRequest } from "next/server";
import {
  buildOidcAuthorization,
  isOidcConfigured,
  NATIVE_OIDC_CALLBACK_SCHEME,
  oidcLoginErrorRedirect,
  serializeOidcStateCookie,
  signOidcStateCookie,
} from "@/lib/oidc";
import { loadOidcAllowlist } from "@/lib/oidc-signin";
import { checkRateLimit, getClientIpKey } from "@/lib/rate-limit";
import { safeInternalPath } from "@/lib/safe-url";
import { hasNativeClientHeader, NATIVE_CLIENT_HEADER } from "@/lib/mobile-auth";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// This route is reached by a TOP-LEVEL navigation (login-form sets
// window.location.href), so a web caller's failures redirect to
// /login?error=<code> exactly like the callback's do; a NATIVE caller keeps
// the JSON status it can read. No flow cookie exists yet to clear.
function loginErrorRedirect(req: NextRequest, code: string): NextResponse {
  return oidcLoginErrorRedirect(req, code);
}

function getRedirectUri(base: string): string {
  return `${base.replace(/\/$/, "")}/api/auth/oidc/callback`;
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
  // The allowlist's opt-in "groups" scope. An unreadable stored value asks for
  // nothing extra (loadOidcAllowlist answers null; the callback refuses it). A
  // read that FAILS ends the flow here: the callback fails closed on the same
  // fault, and a flow started without the groups scope would refuse a
  // group-gated user for the wrong reason once the database is back.
  let policy;
  try {
    policy = await loadOidcAllowlist();
  } catch (err) {
    console.error("[oidc/start] allowlist read failed:", err instanceof Error ? err.message : err);
    return isNative
      ? NextResponse.json({ error: t("apiAuth.oidc.unavailable") }, { status: 503 })
      : loginErrorRedirect(req, "oidc_unavailable");
  }
  let auth;
  try {
    auth = await buildOidcAuthorization(redirectUri, returnTo, {
      native: isNative,
      requestGroupsScope: policy?.requestGroupsScope === true,
    });
  } catch (err) {
    console.error("[oidc/start] discovery or URL build failed:", err);
    return isNative
      ? NextResponse.json({ error: t("apiAuth.oidc.unavailable") }, { status: 503 })
      : loginErrorRedirect(req, "oidc_unavailable");
  }

  // The web form's "remember me" rides in the signed state to the callback.
  // Never for a native flow: its session never expires either way (6c).
  const rememberMe = !isNative && req.nextUrl.searchParams.get("rememberMe") === "1";
  const cookieValue = await signOidcStateCookie(rememberMe ? { ...auth.state, rememberMe: true } : auth.state);

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
  // `__Host-` + Path=/ + Secure on HTTPS, so a sibling subdomain can't plant a
  // flow cookie of its own (login CSRF); the BASE_PATH-scoped plain name on
  // http dev. Name and attributes come from oidcStateCookie (oidc.ts), the same
  // source the callback reads and clears with.
  res.headers.append("Set-Cookie", serializeOidcStateCookie(cookieValue));
  return res;
}
