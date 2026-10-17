import { hkdfSync, createHmac, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify, decodeProtectedHeader, type JWTPayload } from "jose";

// One signing key per PURPOSE, each an HKDF subkey of NEXTAUTH_SECRET, plus
// verify-only rotation through NEXTAUTH_SECRET_PREVIOUS (guardrail 6h).
//
// Why per purpose: the raw secret used to sign the session JWT, the Plex and
// QuickConnect flow cookies, the OIDC flow state, the request tokens and the
// PlexTokenCache HMAC. Every one of those is HS256/HMAC-SHA256 under the same
// key, so a value minted for one purpose was a valid MAC for every other one
// and only the payload shape kept them apart. A subkey per purpose makes each
// token fail the other purposes on the signature alone, and the typ/aud claims
// make that explicit. mfa-token.ts, mfa-store.ts and the Plex connect cookie
// already derived their own subkeys; this module is the same idea for the rest.
//
// Why kid: NEXTAUTH_SECRET_PREVIOUS lets an operator rotate the secret without
// a global sign-out. Every JWT carries a `kid` naming the secret that signed it
// (an HKDF-derived id, never the secret or a plain hash of it), so the verifier
// picks the matching key instead of trying both. The previous secret only ever
// VERIFIES; nothing is signed with it.
//
// The previous secret keeps everything it signed valid while it is set. That is
// the point for a planned rotation and exactly wrong after a leak: to cut off a
// leaked secret, change NEXTAUTH_SECRET and do NOT set the previous one.

export type SigningPurpose =
  | "session"
  | "plex-flow"
  | "qc-flow"
  | "oidc-flow"
  | "request-token"
  | "plex-token-cache"
  // hashAuditEmail (auth.ts): the audit-log email hash, which also keys the
  // per-account sign-in limiter. An HMAC key, never a JWT signer.
  | "audit-email";

export interface SigningKey {
  kid: string;
  key: Uint8Array;
  // True for NEXTAUTH_SECRET, false for NEXTAUTH_SECRET_PREVIOUS.
  current: boolean;
}

// Fixed salt; the purpose is the HKDF info, so each subkey is domain-separated.
const SALT = "summonarr-signing-key";

function currentSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("[signing-keys] NEXTAUTH_SECRET must be set");
  return secret;
}

// Blank, unset, or the same as the current secret ⇒ no previous key.
function previousSecret(current: string): string | null {
  const prev = process.env.NEXTAUTH_SECRET_PREVIOUS;
  if (!prev || prev.trim().length === 0 || prev === current) return null;
  return prev;
}

// Derivation is cheap but runs on every request (the proxy verifies a session
// per request), so keep the results. Keyed by the secret itself: tests swap
// NEXTAUTH_SECRET at runtime, and a stale entry for an old value is harmless.
const derived = new Map<string, Uint8Array>();
const kids = new Map<string, string>();
const CACHE_LIMIT = 64;

function subkey(secret: string, purpose: SigningPurpose): Uint8Array {
  const cacheKey = `${purpose}\u0000${secret}`;
  const hit = derived.get(cacheKey);
  if (hit) return hit;
  const key = new Uint8Array(hkdfSync("sha256", secret, SALT, `summonarr:${purpose}:v1`, 32));
  if (derived.size >= CACHE_LIMIT) derived.clear();
  derived.set(cacheKey, key);
  return key;
}

// Names the SECRET (not the purpose), so one kid covers every token that secret
// signed. 9 HKDF bytes → 12 base64url chars; reveals nothing about the secret.
export function keyIdFor(secret: string): string {
  const hit = kids.get(secret);
  if (hit) return hit;
  const kid = Buffer.from(hkdfSync("sha256", secret, SALT, "summonarr:kid:v1", 9)).toString("base64url");
  if (kids.size >= CACHE_LIMIT) kids.clear();
  kids.set(secret, kid);
  return kid;
}

// The key every new token of this purpose is signed with.
export function signingKey(purpose: SigningPurpose): SigningKey {
  const secret = currentSecret();
  return { kid: keyIdFor(secret), key: subkey(secret, purpose), current: true };
}

// Every key a token of this purpose may verify under, current first.
export function verificationKeys(purpose: SigningPurpose): SigningKey[] {
  const secret = currentSecret();
  const keys: SigningKey[] = [{ kid: keyIdFor(secret), key: subkey(secret, purpose), current: true }];
  const prev = previousSecret(secret);
  if (prev) keys.push({ kid: keyIdFor(prev), key: subkey(prev, purpose), current: false });
  return keys;
}

export function verificationKeyForKid(purpose: SigningPurpose, kid: string): SigningKey | null {
  return verificationKeys(purpose).find((k) => k.kid === kid) ?? null;
}

// The RAW secrets (current, then previous), for the one legacy path that still
// needs them: session JWTs minted before the subkeys existed. A native token is
// never re-issued (guardrail 6b), so an iOS device signed in before this change
// presents a raw-key token for as long as its session lives. See
// verifySessionToken in session-jwt.ts for how that path is gated.
export function legacyRawSessionKeys(): Uint8Array[] {
  const secret = currentSecret();
  const encoder = new TextEncoder();
  const keys = [encoder.encode(secret)];
  const prev = previousSecret(secret);
  if (prev) keys.push(encoder.encode(prev));
  return keys;
}

// ── purpose-bound JWTs (the short-lived flow tokens) ─────────────────────────

export interface PurposeJwtOptions {
  typ: string;
  audience: string;
}

export async function signPurposeJwt(
  purpose: SigningPurpose,
  payload: JWTPayload,
  opts: PurposeJwtOptions & { ttlSeconds: number },
): Promise<string> {
  const { kid, key } = signingKey(purpose);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256", typ: opts.typ, kid })
    .setAudience(opts.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + opts.ttlSeconds)
    .sign(key);
}

// Verifies the signature under the key the kid names, the HS256 pin, exp, the
// typ header and the audience. No kid, an unknown kid, or any mismatch ⇒ null.
// There is no raw-key fallback here: these tokens live minutes, so the ones in
// flight when the derivation changed simply fail once.
export async function verifyPurposeJwt(
  purpose: SigningPurpose,
  token: string,
  opts: PurposeJwtOptions,
): Promise<JWTPayload | null> {
  try {
    const header = decodeProtectedHeader(token);
    if (typeof header.kid !== "string") return null;
    const match = verificationKeyForKid(purpose, header.kid);
    if (!match) return null;
    const { payload, protectedHeader } = await jwtVerify(token, match.key, {
      algorithms: ["HS256"],
      audience: opts.audience,
      typ: opts.typ,
    });
    if (protectedHeader.typ !== opts.typ) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── purpose-bound HMACs ──────────────────────────────────────────────────────

export function purposeHmacHex(key: SigningKey, message: string): string {
  return createHmac("sha256", key.key).update(message).digest("hex");
}

// True when `mac` is the HMAC of `message` under ANY verification key of the
// purpose. Constant-time per comparison.
export function verifyPurposeHmacHex(purpose: SigningPurpose, message: string, mac: string): boolean {
  // Keys first: a missing NEXTAUTH_SECRET throws here rather than reading as a
  // plain "no match".
  const keys = verificationKeys(purpose);
  // Buffer.from(…, "hex") stops at the first non-hex character, so a valid MAC
  // with junk appended would otherwise compare equal.
  if (!/^[0-9a-f]{64}$/i.test(mac)) return false;
  const presented = Buffer.from(mac, "hex");
  let ok = false;
  for (const key of keys) {
    const expected = Buffer.from(purposeHmacHex(key, message), "hex");
    if (presented.length === expected.length && timingSafeEqual(presented, expected)) ok = true;
  }
  return ok;
}
