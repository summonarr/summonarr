import { SignJWT, jwtVerify, type JWTPayload } from "jose";

// Claim shape mirrors the token shape next-auth's jwt callback (the now-removed
// auth.config.ts) would build. Kept structurally compatible when the project
// migrated off next-auth so no field had to be re-mapped.
//
// `expiresAt` is the per-device session deadline tracked alongside the
// AuthSession DB row — distinct from the JWT `exp` claim, which jose enforces
// on every verify. The two are intentionally separate so a sliding refresh
// can update `exp` without losing the original device-bound deadline.
export interface SessionClaims extends JWTPayload {
  id: string;
  role: string;
  // Authoritative capability bitmask, decimal-encoded (BigInt isn't JSON-
  // serializable). Optional so older tokens still verify; absent ⇒ callers fall
  // back to the role preset via effectivePermissions(). See src/lib/permissions.ts.
  permissions?: string;
  email?: string | null;
  name?: string | null;
  provider?: string;
  mediaServer?: string | null;
  sessionId?: string;
  uaFingerprint?: string;
  isMobile?: boolean;
  deviceLabel?: string;
  expiresAt?: number;
  // Machine sessions only: the IP allowlist that was in effect when the token
  // was minted, snapshotted into the claims so the Node-runtime auth guards can
  // re-check the caller's IP on every use (the mint-time check alone would let a
  // leaked token be replayed from any address). Absent / empty ⇒ no allowlist was
  // configured ⇒ no per-request IP restriction.
  machineAllowedIps?: string[];
}

const ENCODER = new TextEncoder();

function getSecret(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      "[session-jwt] NEXTAUTH_SECRET must be set",
    );
  }
  return ENCODER.encode(secret);
}

export async function signSessionJwt(
  claims: Omit<SessionClaims, "iat" | "exp">,
  options: { expiresInSeconds: number; iat?: number },
): Promise<string> {
  // iat override exists for the role-rotation path in verifyAndRefreshSession:
  // it bumps sessionsRevokedAt to oldIat+1 to invalidate the old token, then
  // mints a new one — the new one MUST carry iat STRICTLY GREATER than the
  // cutoff (the cutoff check rejects `iat <= cutoff`) or it'll fail its own
  // cutoff check on the next request. Wall-clock seconds-resolution arithmetic
  // means a rotation within ~1s of the presented token's iat needs the override
  // to land at cutoff+1 (= oldIat+2) instead of now.
  const now = typeof options.iat === "number" ? options.iat : Math.floor(Date.now() / 1000);
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
