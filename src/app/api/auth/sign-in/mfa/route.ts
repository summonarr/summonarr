import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { AccountDeactivatedError, buildDeviceMeta, signInAndMintSession } from "@/lib/auth";
import { buildSignInResponse, disabledAccountResponse } from "@/lib/sign-in-response";
import { readJsonCapped } from "@/lib/body-size";
import { checkRateLimit, getClientIp, ipBucketKey, refundHit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { hasNativeClientHeader, NATIVE_CLIENT_HEADER } from "@/lib/mobile-auth";
import { consumeToken, isTokenUsable, recordTokenFailure, verifyMfaSigninToken } from "@/lib/mfa/mfa-token";
import { passwordVersion, verifySecondFactor, type SecondFactorInput } from "@/lib/mfa/mfa-store";
import { webAuthnConfigFromEnv, type AuthenticationResponseJSON } from "@/lib/mfa/webauthn";

// POST /api/auth/sign-in/mfa — the second half of a local-credentials sign-in
// for an account with two-factor enabled (guardrail 6d).
//
// Body: { mfaToken, method: "totp" | "recovery", code }
//    or { mfaToken, method: "webauthn", credential: <PublicKeyCredential JSON> }
//
// Only after the second factor verifies does this call signInAndMintSession +
// buildSignInResponse — EXACTLY as the password route does for an account
// without 2FA — so the cookie / native bearer semantics (guardrail 6b), the
// session lifetime (6c, rememberMe carried in the challenge token) and the
// disabled-account refusal (33) are the shared ones, not a parallel copy.
//
// Throttles: per IP (every attempt), per account (reserved, refunded on
// success — the credentials-route pattern), and per challenge token (burns after
// MAX_TOKEN_FAILURES wrong answers, consumed on success).

// An assertion is a few KB of base64url at most.
const MAX_MFA_BODY_BYTES = 32 * 1024;
const IP_LIMIT = 30;
const IP_WINDOW_MS = 5 * 60 * 1000;
const USER_LIMIT = 10;
const USER_WINDOW_MS = 15 * 60 * 1000;

const EXPIRED_MESSAGE = "Your sign-in has expired. Please sign in again.";
const INVALID_MESSAGE = "Invalid verification code.";

function expired(): NextResponse {
  return NextResponse.json({ error: EXPIRED_MESSAGE, mfaExpired: true }, { status: 401 });
}

function parseInput(body: Record<string, unknown>): SecondFactorInput | null {
  const method = body.method;
  if (method === "totp" || method === "recovery") {
    if (typeof body.code !== "string" || body.code.length === 0 || body.code.length > 64) return null;
    return { method, code: body.code };
  }
  if (method === "webauthn") {
    if (!body.credential || typeof body.credential !== "object" || Array.isArray(body.credential)) return null;
    return { method, credential: body.credential as AuthenticationResponseJSON };
  }
  return null;
}

function sameString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function POST(req: NextRequest) {
  const parsed = await readJsonCapped<Record<string, unknown>>(req, MAX_MFA_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const ip = getClientIp(req.headers);
  const ua = req.headers.get("user-agent")?.slice(0, 512) ?? null;
  const fail = (reason: string, userId?: string, details: Record<string, unknown> = {}) =>
    void logAudit({
      userId: userId ?? "anonymous",
      userName: "anonymous",
      action: "AUTH_LOGIN_FAILED",
      target: "auth:login",
      ipAddress: ip,
      userAgent: ua,
      provider: "credentials",
      details: { reason, ...details },
    });

  if (!checkRateLimit(`mfa-ip:${ipBucketKey(ip)}`, IP_LIMIT, IP_WINDOW_MS)) {
    fail("mfa_rate_limited");
    return NextResponse.json({ error: "Too many attempts — please wait a few minutes." }, { status: 429 });
  }

  const claims = await verifyMfaSigninToken(body.mfaToken);
  if (!claims || !isTokenUsable(claims.jti, claims.exp)) return expired();

  // The native-client header selects the session lifetime and whether the JWT
  // goes in the body (guardrails 6b/6c); it was fixed at the password step.
  if (hasNativeClientHeader(req.headers.get(NATIVE_CLIENT_HEADER)) !== claims.native) {
    return NextResponse.json({ error: "Sign-in client changed. Please sign in again.", mfaExpired: true }, { status: 400 });
  }

  const input = parseInput(body);
  if (!input) return NextResponse.json({ error: "A verification method and code are required." }, { status: 400 });

  const userKey = `mfa-user:${claims.userId}`;
  if (!checkRateLimit(userKey, USER_LIMIT, USER_WINDOW_MS)) {
    fail("mfa_rate_limited", claims.userId);
    return NextResponse.json({ error: "Too many attempts — please wait 15 minutes." }, { status: 429 });
  }

  // Local login switched off after the password step ⇒ no completion either.
  const disableRow = await prisma.setting.findUnique({ where: { key: "disableLocalLogin" } });
  if (disableRow?.value === "true") return expired();

  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    select: { id: true, email: true, name: true, role: true, passwordHash: true },
  });
  // A password change (or a purge, which nulls the hash) since the password
  // step kills the challenge.
  if (!user?.passwordHash || !sameString(passwordVersion(user.passwordHash), claims.pwv)) return expired();

  const verdict = await verifySecondFactor(user.id, input, {
    webauthnChallenge: claims.webauthnChallenge,
    webauthnConfig: webAuthnConfigFromEnv(),
  });
  if (!verdict.ok) {
    // The reserved account hit is KEPT (a real failed second factor), and the
    // token edges toward burning.
    const failures = recordTokenFailure(claims.jti, claims.exp);
    fail("mfa_invalid", user.id, { method: input.method, check: verdict.reason, failures });
    return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
  }

  // One challenge, one session — a concurrent second success loses here.
  if (!consumeToken(claims.jti, claims.exp)) return expired();
  refundHit(userKey);

  const device = buildDeviceMeta(req.headers);
  let result;
  try {
    result = await signInAndMintSession({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        rememberMe: claims.rememberMe,
        ...device,
      },
      providerId: "credentials",
      secondFactor: input.method,
    });
  } catch (err) {
    if (err instanceof AccountDeactivatedError) return disabledAccountResponse();
    throw err;
  }
  return buildSignInResponse(req, result);
}
