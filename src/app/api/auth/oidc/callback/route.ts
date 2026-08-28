import { NextResponse, type NextRequest } from "next/server";
import { AccountDeactivatedError, findOrCreateOidcUser, PROVIDER_REBIND_REQUIRED, PROVIDER_SETUP_REQUIRED, signInAndMintSession, buildDeviceMeta, normalizeEmail } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  exchangeOidcCode,
  isNativeOidcState,
  isOidcConfigured,
  NATIVE_OIDC_CALLBACK_URL,
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_PATH,
  verifyOidcStateCookie,
} from "@/lib/oidc";
import { serializeSessionCookie } from "@/lib/session-cookie";
import { checkRateLimit, getClientIpKey } from "@/lib/rate-limit";
import { safeInternalPath } from "@/lib/safe-url";

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
  return `${OIDC_STATE_COOKIE}=; Path=${OIDC_STATE_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`;
}

// Subpath deployments (BASE_PATH=/request): a root-absolute path resolved against
// AUTH_URL — `new URL("/login", "https://host/request")` — yields
// "https://host/login" and DROPS the base path, so every OIDC redirect lands on a
// 404 outside the app. Prefix in-app targets exactly like proxy.ts's
// buildLoginRedirect does. No-op when BASE_PATH is unset (the default).
const basePath = process.env.BASE_PATH ?? "";

function loginErrorRedirect(_req: NextRequest, code: string): NextResponse {
  // AUTH_URL is guaranteed set by the early guard in GET; fail closed otherwise
  // rather than deriving the base from an attacker-influenceable request Host.
  const base = process.env.AUTH_URL;
  if (!base) {
    return NextResponse.json({ error: "Server misconfigured: AUTH_URL is not set" }, { status: 500 });
  }
  const url = new URL(`${basePath}/login`, base);
  url.searchParams.set("error", code);
  const res = NextResponse.redirect(url.toString());
  res.headers.append("Set-Cookie", clearStateCookieHeader());
  return res;
}

// Hand a native flow straight back to the app on its custom scheme, carrying
// whatever the IdP returned. Deliberately does NOT exchange the code or mint a
// session: the PKCE codeVerifier for a native flow lives only in the signed
// flowState the app holds, so this server request could not complete the
// exchange even if it wanted to. The app finishes at /api/auth/sign-in/oidc.
//
// Safe to put the code in this URL for the same reason: without the app's
// flowState it cannot be redeemed. Nothing session-bearing is ever set here.
function nativeCallbackRedirect(params: Record<string, string>): NextResponse {
  const url = new URL(NATIVE_OIDC_CALLBACK_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url.toString());
}

export async function GET(req: NextRequest) {
  const authUrl = process.env.AUTH_URL;
  if (!authUrl) {
    return NextResponse.json({ error: "Server misconfigured: AUTH_URL is not set" }, { status: 500 });
  }

  // Detected before the refusals below: a native flow's browser sheet cannot
  // render the web login page usefully — an error must bounce to the app's
  // custom scheme (nativeCallbackRedirect) or the sheet strands with nothing
  // for the app to surface.
  const returnedState = req.nextUrl.searchParams.get("state");
  const isNativeFlow = isNativeOidcState(returnedState);

  // Throttle the callback like /start — each hit triggers an outbound IdP token
  // exchange and a DB user lookup/create even before the state cookie is checked.
  if (!checkRateLimit(`oidc-callback:${getClientIpKey(req.headers)}`, 20, 5 * 60 * 1000)) {
    return isNativeFlow
      ? nativeCallbackRedirect({ error: "rate_limited" })
      : loginErrorRedirect(req, "rate_limited");
  }

  if (!isOidcConfigured()) {
    return isNativeFlow
      ? nativeCallbackRedirect({ error: "oidc_not_configured" })
      : loginErrorRedirect(req, "oidc_not_configured");
  }

  // Native branch first: this request arrives in the app's web-auth view, which
  // never carries the flow cookie, so every cookie-based check below would
  // (correctly) fail. The state marker is the only signal available here.
  if (isNativeFlow) {
    const idpError = req.nextUrl.searchParams.get("error");
    if (idpError) return nativeCallbackRedirect({ error: idpError.slice(0, 64) });
    const code = req.nextUrl.searchParams.get("code");
    if (!code) return nativeCallbackRedirect({ error: "oidc_no_code" });
    return nativeCallbackRedirect({ code, state: returnedState });
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
    // A disabled account is an expected refusal, not a fault — the OIDC identity
    // still resolves to a real row (account removal disables rather than scrubs,
    // see account-lifecycle.ts), so it reaches the mint chokepoint and is turned
    // away there. Distinct code, and no error log.
    if (err instanceof AccountDeactivatedError) {
      return loginErrorRedirect(req, "account_disabled");
    }
    // Don't let a transient DB failure during mint throw out of the handler and
    // strand the OIDC state cookie — redirect to login with an error like the
    // other failure paths in this route.
    console.error("[oidc/callback] OIDC session mint failed:", err instanceof Error ? err.message : err);
    return loginErrorRedirect(req, "oidc_session_error");
  }

  // AUTH_URL is guaranteed non-empty by the early guard at the top of GET.
  const base = authUrl;
  // returnTo was already validated at /start and signed into the state cookie,
  // so re-validating here is belt-and-suspenders — defends against a future
  // regression in /start. Must use the SAME validator: this redirect also
  // carries the freshly-minted session cookie, so an off-origin target here is
  // a post-authentication open redirect (phishing hand-off), and the previous
  // `startsWith("/") && !startsWith("//")` test let `/\t/evil.com` through.
  const safeReturn = safeInternalPath(flowState.returnTo) ?? "/";
  // safeInternalPath always returns a root-absolute path, so the BASE_PATH prefix
  // is a plain concatenation (see the note on `basePath` above).
  const res = NextResponse.redirect(new URL(`${basePath}${safeReturn}`, base).toString());
  res.headers.append(
    "Set-Cookie",
    serializeSessionCookie(result.token, { maxAgeSeconds: result.expiresInSeconds }),
  );
  res.headers.append("Set-Cookie", clearStateCookieHeader());
  return res;
}
