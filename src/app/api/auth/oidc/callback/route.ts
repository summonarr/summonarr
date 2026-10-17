import { NextResponse, type NextRequest } from "next/server";
import { AccountDeactivatedError, signInAndMintSession, buildDeviceMeta } from "@/lib/auth";
import {
  buildOidcExchangeUrl,
  clearOidcStateCookie,
  exchangeOidcCode,
  isNativeOidcState,
  isOidcConfigured,
  NATIVE_OIDC_CALLBACK_URL,
  readOidcStateCookie,
  verifyOidcStateCookie,
} from "@/lib/oidc";
import { loadOidcAllowlist, oidcExchangeOptionsFor, oidcWebErrorCode, resolveOidcSignIn } from "@/lib/oidc-signin";
import { serializeSessionCookie } from "@/lib/session-cookie";
import { checkRateLimit, getClientIpKey } from "@/lib/rate-limit";
import { safeInternalPath } from "@/lib/safe-url";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Subpath deployments (BASE_PATH=/request): a root-absolute path resolved against
// AUTH_URL — `new URL("/login", "https://host/request")` — yields
// "https://host/login" and DROPS the base path, so every OIDC redirect lands on a
// 404 outside the app. Prefix in-app targets exactly like proxy.ts's
// buildLoginRedirect does. No-op when BASE_PATH is unset (the default).
const basePath = process.env.BASE_PATH ?? "";

function loginErrorRedirect(req: NextRequest, code: string): NextResponse {
  // AUTH_URL is guaranteed set by the early guard in GET; fail closed otherwise
  // rather than deriving the base from an attacker-influenceable request Host.
  const base = process.env.AUTH_URL;
  if (!base) {
    const t = translatorForRequest(req);
    return NextResponse.json({ error: t("apiAuth.common.authUrlMissing") }, { status: 500 });
  }
  const url = new URL(`${basePath}/login`, base);
  url.searchParams.set("error", code);
  const res = NextResponse.redirect(url.toString());
  res.headers.append("Set-Cookie", clearOidcStateCookie());
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
  const t = translatorForRequest(req);
  const authUrl = process.env.AUTH_URL;
  if (!authUrl) {
    return NextResponse.json({ error: t("apiAuth.common.authUrlMissing") }, { status: 500 });
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

  // The IdP's own refusal arrives as `error=` with no code. A user clicking
  // Deny/Cancel at the IdP is an expected outcome, not a fault: it gets its own
  // code (login-form words it) and is NOT logged — the exchange below would
  // otherwise throw on the error response and record a server error for a
  // refusal (guardrail 7; contrast the silent AccountDeactivatedError branch).
  // Read before the cookie so an expired state can't mask what the IdP said.
  const idpError = req.nextUrl.searchParams.get("error");
  if (idpError) {
    return loginErrorRedirect(req, idpError === "access_denied" ? "oidc_access_denied" : "oidc_idp_error");
  }

  // Read ONLY under this deployment's name — the `__Host-` one on HTTPS, which
  // a sibling subdomain can't plant (oidcStateCookie in oidc.ts).
  const stateCookie = readOidcStateCookie(req.headers.get("cookie"));
  if (!stateCookie) {
    return loginErrorRedirect(req, "oidc_no_state");
  }
  const flowState = await verifyOidcStateCookie(stateCookie);
  if (!flowState) {
    return loginErrorRedirect(req, "oidc_state_invalid");
  }

  // The allowlist is read first: it decides whether the exchange also has to
  // fetch a groups claim.
  let policy;
  try {
    policy = await loadOidcAllowlist();
  } catch (err) {
    console.error("[oidc/callback] allowlist read failed:", err instanceof Error ? err.message : err);
    return loginErrorRedirect(req, "oidc_user_rejected");
  }

  let claims;
  try {
    // Rebuild the exchange URL from the SIGNED redirectUri, not req.url — see
    // buildOidcExchangeUrl for why the request's own origin cannot be trusted
    // to match the redirect_uri sent at /start.
    claims = await exchangeOidcCode(
      buildOidcExchangeUrl(flowState, req.nextUrl.searchParams),
      flowState,
      oidcExchangeOptionsFor(policy),
    );
  } catch (err) {
    console.error("[oidc/callback] code exchange failed:", err instanceof Error ? err.message : err);
    return loginErrorRedirect(req, "oidc_exchange_failed");
  }

  // Allowlist, identity lookup and notification address — shared with the
  // native route so the two can't disagree (oidc-signin.ts). Every refusal is
  // audited there.
  let outcome;
  try {
    outcome = await resolveOidcSignIn(claims, policy, req.headers);
  } catch (err) {
    console.error("[oidc/callback] user lookup failed:", err instanceof Error ? err.message : err);
    return loginErrorRedirect(req, "oidc_user_rejected");
  }
  if (!outcome.ok) {
    return loginErrorRedirect(req, oidcWebErrorCode(outcome.reason));
  }
  const dbUser = outcome.user;

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
  // so re-validating here is a second safety net in case /start ever regresses.
  // Use the SAME validator: this redirect also carries the new session cookie,
  // so an off-site target here would be an open redirect right after sign-in
  // (a phishing hand-off).
  const safeReturn = safeInternalPath(flowState.returnTo) ?? "/";
  // safeInternalPath always returns a root-absolute path, so the BASE_PATH prefix
  // is a plain concatenation (see the note on `basePath` above).
  const res = NextResponse.redirect(new URL(`${basePath}${safeReturn}`, base).toString());
  res.headers.append(
    "Set-Cookie",
    serializeSessionCookie(result.token, { maxAgeSeconds: result.expiresInSeconds }),
  );
  res.headers.append("Set-Cookie", clearOidcStateCookie());
  return res;
}
