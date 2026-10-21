import { SignJWT, jwtVerify, decodeProtectedHeader, type JWTPayload } from "jose";
import { legacyRawSessionKeys, signingKey, verificationKeyForKid } from "@/lib/signing-keys";
import { MAX_CONFIGURABLE_SESSION_SECONDS } from "@/lib/session-lifetime";

// How a session token reaches the server: the HttpOnly cookie a browser sends,
// or `Authorization: Bearer` from a native app (guardrail 6b). A token is bound
// to ONE of them at mint and refused on the other (guardrail 6h).
export type SessionTransport = "cookie" | "bearer";

// The claims (fields) carried inside the session JWT.
//
// `expiresAt` is the per-device session deadline tracked alongside the
// AuthSession DB row — distinct from the JWT `exp` claim, which jose enforces
// on every verify. The two are intentionally separate so a re-sign (every
// DB-checked verify mints a fresh token carrying dbCheckedAt) can set `exp`
// without losing the original device-bound deadline; since guardrail 6c the
// re-sign puts `exp` AT the deadline, and a native session's deadline is the
// never-reached sentinel from session-lifetime.ts.
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
  // Coarse browser:os:device summary taken at sign-in. Informational only since
  // guardrail 6h: it is NEVER compared against the request's User-Agent (the
  // client chooses that header, so the comparison stopped nothing).
  uaFingerprint?: string;
  isMobile?: boolean;
  deviceLabel?: string;
  expiresAt?: number;
  // The transport this session was minted for (guardrail 6h): "bearer" for a
  // sign-in that presented X-Summonarr-Client (the never-expiring native
  // session), "cookie" for everything else. Every reader refuses the token on
  // the other transport. Absent on tokens minted before the claim existed; see
  // boundTransport for how those are read.
  transport?: SessionTransport;
  // Set only by the DB-checked re-sign in session-refresh.ts (the fast-path
  // marker). Never present at mint.
  dbCheckedAt?: number;
  // Machine sessions only: the IP allowlist that was in effect when the token
  // was minted, snapshotted into the claims so the Node-runtime auth guards can
  // re-check the caller's IP on every use (the mint-time check alone would let a
  // leaked token be replayed from any address). Absent / empty ⇒ no allowlist was
  // configured ⇒ no per-request IP restriction.
  machineAllowedIps?: string[];
}

// The protected header + audience every session JWT carries since the subkey
// change. A token with a kid MUST verify under the session subkey with both; a
// token without one is a legacy raw-key mint (verifySessionToken below).
export const SESSION_JWT_TYP = "summonarr-session+jwt";
export const SESSION_JWT_AUDIENCE = "summonarr:session";

export async function signSessionJwt(
  claims: Omit<SessionClaims, "iat" | "exp">,
  options: { expiresInSeconds: number; iat?: number },
): Promise<string> {
  // iat override: no production path passes it any more (the privilege-change
  // rotation used to, back when it stamped a per-user cutoff). Tests use it to
  // mint tokens with a chosen issue time.
  const now = typeof options.iat === "number" ? options.iat : Math.floor(Date.now() / 1000);
  const { kid, key } = signingKey("session");
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256", typ: SESSION_JWT_TYP, kid })
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + options.expiresInSeconds)
    .sign(key);
}

export interface VerifiedSessionToken {
  claims: SessionClaims;
  // True only when the token was signed with the CURRENT session subkey. A token
  // signed with NEXTAUTH_SECRET_PREVIOUS's subkey or the legacy raw secret
  // verifies, but session-refresh.ts sends it down the slow path so it is
  // re-signed with the current key straight away.
  signedWithCurrentKey: boolean;
}

// Signature + exp + shape, and nothing about transport or the database. The
// readers go through verifySessionJwt(token, transport) or
// verifyAndRefreshSession, which add the transport check.
//
// Two ways in:
//   - kid present: the session subkey that kid names (current or previous
//     secret), HS256 only, with the session typ and audience. Any mismatch ⇒ null.
//   - no kid: a LEGACY token, HMAC'd with the raw NEXTAUTH_SECRET (or the raw
//     previous secret) before the subkeys existed. Accepted only in its legacy
//     shape — typ "JWT" or absent, no audience, no transport claim — so the raw
//     key can never vouch for a token in the new format. This path exists for
//     native tokens: the app is never handed a replacement (guardrail 6b), so an
//     iOS device signed in before the change presents its raw-key token until
//     it signs out. A browser's raw-key cookie is re-signed with the subkey on
//     its first request, and it could not outlive its ≤90-day deadline anyway.
export async function verifySessionToken(token: string): Promise<VerifiedSessionToken | null> {
  try {
    const header = decodeProtectedHeader(token);
    let payload: JWTPayload;
    let signedWithCurrentKey: boolean;
    if (header.kid !== undefined) {
      if (typeof header.kid !== "string") return null;
      const match = verificationKeyForKid("session", header.kid);
      if (!match) return null;
      const verified = await jwtVerify(token, match.key, {
        // Pin the alg list so a token with `alg: "none"` (or anything we didn't
        // sign with) is rejected outright — the classic JWT-library footgun.
        algorithms: ["HS256"],
        audience: SESSION_JWT_AUDIENCE,
        typ: SESSION_JWT_TYP,
      });
      if (verified.protectedHeader.typ !== SESSION_JWT_TYP) return null;
      payload = verified.payload;
      signedWithCurrentKey = match.current;
    } else {
      if (header.typ !== undefined && header.typ !== "JWT") return null;
      const legacy = await verifyLegacyRawKey(token);
      if (!legacy) return null;
      if (legacy.aud !== undefined || legacy.transport !== undefined) return null;
      payload = legacy;
      signedWithCurrentKey = false;
    }
    if (typeof payload.id !== "string" || typeof payload.role !== "string") {
      return null;
    }
    return { claims: payload as SessionClaims, signedWithCurrentKey };
  } catch {
    return null;
  }
}

async function verifyLegacyRawKey(token: string): Promise<JWTPayload | null> {
  for (const key of legacyRawSessionKeys()) {
    try {
      const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
      return payload;
    } catch {
      // try the next key
    }
  }
  return null;
}

// Verified claims, or null. Pass the transport the token ARRIVED on and a token
// bound to the other one is refused too (guardrail 6h) — every session reader
// does; omitting it is for tests and for decoding a token this process just
// minted.
export async function verifySessionJwt(
  token: string,
  presentedOn?: SessionTransport,
): Promise<SessionClaims | null> {
  const verified = await verifySessionToken(token);
  if (!verified) return null;
  if (presentedOn && !isTransportAllowed(verified.claims, presentedOn)) return null;
  return verified.claims;
}

// ── transport binding (guardrail 6h) ─────────────────────────────────────────

// The transport a token is bound to. The claim when present; for a token minted
// before the claim existed, what its shape proves:
//   - dbCheckedAt ⇒ "cookie". Only the DB-checked re-sign stamps it, and a
//     re-signed token reaches a client only as Set-Cookie (a bearer client is
//     never handed one; the proxy's forwarded-header rewrite is server-internal).
//   - a deadline more than MAX_CONFIGURABLE_SESSION_SECONDS past iat ⇒ "bearer".
//     A browser deadline is at most that far past sign-in, and a re-sign only
//     moves iat closer to it, so a longer horizon is the never-expiring native
//     sentinel or the 1-year native TTL from before guardrail 6c.
//   - otherwise null: either transport. That is a token no request has re-signed
//     yet (a browser mint seconds old, a 15-minute machine session) or a pre-6c
//     native sign-in that got a browser-length TTL. All of them were minted
//     before the claim existed, so the ambiguity dies with their ≤90-day
//     deadlines; the first re-sign of each stamps the transport it arrived on.
export function boundTransport(claims: SessionClaims): SessionTransport | null {
  if (claims.transport === "cookie" || claims.transport === "bearer") return claims.transport;
  if (typeof claims.dbCheckedAt === "number") return "cookie";
  if (
    typeof claims.expiresAt === "number" &&
    typeof claims.iat === "number" &&
    claims.expiresAt - claims.iat > MAX_CONFIGURABLE_SESSION_SECONDS
  ) {
    return "bearer";
  }
  return null;
}

// False when the token is bound to the OTHER transport (or carries a transport
// claim that is neither value).
export function isTransportAllowed(claims: SessionClaims, presentedOn: SessionTransport): boolean {
  if (
    claims.transport !== undefined &&
    claims.transport !== "cookie" &&
    claims.transport !== "bearer"
  ) {
    return false;
  }
  const bound = boundTransport(claims);
  return bound === null || bound === presentedOn;
}
