import { NextResponse, type NextRequest } from "next/server";
import {
  AccountDeactivatedError,
  buildDeviceMeta,
  findOrCreateOidcUser,
  normalizeEmail,
  PROVIDER_REBIND_REQUIRED,
  PROVIDER_SETUP_REQUIRED,
  signInAndMintSession,
} from "@/lib/auth";
import { buildSignInResponse, disabledAccountResponse } from "@/lib/sign-in-response";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import {
  exchangeNativeOidcCode,
  isNativeOidcState,
  isOidcConfigured,
  verifyOidcStateCookie,
} from "@/lib/oidc";
import { checkRateLimit, getClientIpKey } from "@/lib/rate-limit";

// Native completion of the OIDC flow — the counterpart to the JSON branch of
// /api/auth/oidc/start. The browser flow never reaches here: it finishes inside
// /api/auth/oidc/callback, which mints the session cookie directly.
//
// The app arrives with the (code, state) it caught on the custom-scheme
// redirect plus the flowState token it was handed at /start, and this route
// does what the callback does for the web — exchange, resolve the user, mint.
//
// Why the code alone is not enough to sign in: the PKCE codeVerifier and the
// expected nonce live INSIDE the signed flowState, which never leaves the app.
// A code lifted out of the redirect URL cannot be redeemed without it, which is
// what makes bouncing the code through a custom scheme safe.
//
// Body carries code/state/flowState/rememberMe — 16 KB cap protects this
// unauthenticated surface against memory-exhaustion DoS, same as the sibling
// provider routes.
const MAX_SIGNIN_BODY_BYTES = 16 * 1024;

export async function POST(req: NextRequest) {
  // Each hit triggers an outbound IdP token exchange plus a DB user
  // lookup/create, so throttle on the same budget as /start and /callback.
  if (!checkRateLimit(`oidc-signin:${getClientIpKey(req.headers)}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later." }, { status: 429 });
  }

  if (!isOidcConfigured()) {
    return NextResponse.json({ error: "OIDC sign-in is not configured" }, { status: 503 });
  }

  const parsed = await readJsonCapped<Record<string, unknown>>(req, MAX_SIGNIN_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (typeof body.code !== "string" || !body.code) {
    return NextResponse.json({ error: "code required" }, { status: 400 });
  }
  if (typeof body.state !== "string" || !body.state) {
    return NextResponse.json({ error: "state required" }, { status: 400 });
  }
  if (typeof body.flowState !== "string" || !body.flowState) {
    return NextResponse.json({ error: "OIDC sign-in flow expired" }, { status: 400 });
  }

  const flowState = await verifyOidcStateCookie(body.flowState);
  if (!flowState) {
    return NextResponse.json({ error: "OIDC sign-in flow expired" }, { status: 400 });
  }
  // Bind the submitted state to the signed one. exchangeNativeOidcCode also
  // passes it as expectedState, so this is belt-and-suspenders — but it fails
  // here with a clear 400 instead of surfacing as an opaque exchange error.
  if (flowState.state !== body.state) {
    return NextResponse.json({ error: "OIDC sign-in flow mismatch" }, { status: 400 });
  }
  // Refuse a flow state minted for the WEB handshake. Without this a stolen web
  // flow cookie could be replayed through the native path to trade a code for a
  // bearer token; the native marker is stamped at /start only for callers that
  // identified as native.
  if (!isNativeOidcState(flowState.state)) {
    return NextResponse.json({ error: "OIDC sign-in flow mismatch" }, { status: 400 });
  }

  let claims;
  try {
    claims = await exchangeNativeOidcCode(body.code, body.state, flowState);
  } catch (err) {
    console.error(
      "[auth/sign-in/oidc] code exchange failed:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "OIDC sign-in failed" }, { status: 401 });
  }

  let dbUser;
  try {
    dbUser = await findOrCreateOidcUser(claims);
  } catch (err) {
    console.error(
      "[auth/sign-in/oidc] user lookup failed:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "OIDC sign-in failed" }, { status: 401 });
  }

  // Same refusals the web callback renders as ?error= codes on /login. Kept as
  // distinct messages so the app can tell the user what to do rather than
  // showing a generic failure.
  if (dbUser === PROVIDER_REBIND_REQUIRED) {
    return NextResponse.json(
      { error: "This account is already linked to a different sign-in method." },
      { status: 409 },
    );
  }
  if (dbUser === PROVIDER_SETUP_REQUIRED) {
    return NextResponse.json(
      { error: "This server hasn't finished its first-run setup yet." },
      { status: 409 },
    );
  }

  // Keep notificationEmail in lock-step with the provider's email claim on every
  // sign-in, exactly as the web callback does.
  if (claims.email) {
    const oidcEmail = normalizeEmail(claims.email);
    await prisma.user
      .update({ where: { id: dbUser.id }, data: { notificationEmail: oidcEmail } })
      .catch((err) =>
        console.error(
          "[auth/sign-in/oidc] notificationEmail sync failed:",
          err instanceof Error ? err.message : err,
        ),
      );
  }

  const device = buildDeviceMeta(req.headers);
  let result;
  try {
    result = await signInAndMintSession({
      user: { ...dbUser, ...device },
      providerId: "oidc",
    });
  } catch (err) {
    if (err instanceof AccountDeactivatedError) return disabledAccountResponse();
    throw err;
  }

  // No flow-state cookie to clear — the native flow never set one. Replay is
  // bounded by the IdP: an authorization code is single-use, so a resubmitted
  // (code, flowState) pair fails at the exchange above.
  return buildSignInResponse(req, result);
}
