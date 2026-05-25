import { SignJWT, jwtVerify, type JWTPayload } from "jose";

// Claim shape mirrors what next-auth's JWT callback in auth.config.ts builds
// today. Kept structurally compatible so a future cut-over can read either
// token shape during the rollout window without re-mapping fields.
//
// `expiresAt` is the per-device session deadline tracked alongside the
// AuthSession DB row — distinct from the JWT `exp` claim, which jose enforces
// on every verify. The two are intentionally separate so a sliding refresh
// can update `exp` without losing the original device-bound deadline.
export interface SessionClaims extends JWTPayload {
  id: string;
  role: string;
  email?: string | null;
  name?: string | null;
  provider?: string;
  mediaServer?: string | null;
  sessionId?: string;
  uaFingerprint?: string;
  isMobile?: boolean;
  deviceLabel?: string;
  expiresAt?: number;
}

const ENCODER = new TextEncoder();

function getSecret(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "[session-jwt] NEXTAUTH_SECRET (or AUTH_SECRET) must be set",
    );
  }
  return ENCODER.encode(secret);
}

export async function signSessionJwt(
  claims: Omit<SessionClaims, "iat" | "exp">,
  options: { expiresInSeconds: number },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + options.expiresInSeconds)
    .sign(getSecret());
}

export async function verifySessionJwt(
  token: string,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      // Pin the alg list so a token with `alg: "none"` (or anything we didn't
      // sign with) is rejected outright — the classic JWT-library footgun.
      algorithms: ["HS256"],
    });
    if (typeof payload.id !== "string" || typeof payload.role !== "string") {
      return null;
    }
    return payload as SessionClaims;
  } catch {
    return null;
  }
}
