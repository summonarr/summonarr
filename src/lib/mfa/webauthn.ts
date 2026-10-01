// WebAuthn (Level 2) relying-party verification — registration and assertion —
// with node:crypto and the in-repo strict CBOR decoder. Pure: no DB, no network,
// no clock. Everything the ceremony needs (challenge, allowed origins, RP ID,
// the stored credential) is passed in, so each check is unit-testable with
// authenticator data built byte-for-byte in the test.
//
// Why hand-rolled rather than @simplewebauthn/server: this project keeps a
// ~10-dependency tree and hand-writes small libraries, and the subset a SECOND
// factor needs is small and fully specified — attestation "none" (so no
// attestation-statement formats, no certificate chains, no metadata service),
// three COSE algorithms, and the §7.1/§7.2 verification steps below. Each step
// carries its spec section so a reviewer can check it against the spec text.
//
// Attestation policy: we request attestation "none" and never rely on an
// attestation statement — the trust model is the password plus possession of a
// key the user registered while already signed in. Browsers replace the
// statement with fmt "none" under that conveyance; an authenticator/browser that
// still sends another fmt has its attStmt ignored (treated as "none", which is
// what the spec's conveyance preference permits the CLIENT to do anyway). The
// credential public key always comes from authenticator data, never attStmt.

import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { decodeCbor, decodeCborFirst, isCborMap, CborError, type CborValue } from "./cbor";

export class WebAuthnError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WebAuthnError";
    this.code = code;
  }
}

export interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  // Exact origins (scheme://host[:port]) a ceremony may come from.
  origins: string[];
}

// COSE algorithm identifiers we accept, in preference order.
export const COSE_ALG_ES256 = -7;
export const COSE_ALG_EDDSA = -8;
export const COSE_ALG_RS256 = -257;
export const SUPPORTED_COSE_ALGS = [COSE_ALG_ES256, COSE_ALG_EDDSA, COSE_ALG_RS256] as const;

export const ALLOWED_TRANSPORTS = ["usb", "nfc", "ble", "internal", "hybrid", "smart-card"] as const;

// Authenticator data flag bits (WebAuthn §6.1).
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

// ─── base64url ──────────────────────────────────────────────────────────────

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

// Strict: rejects padding, the standard-base64 "+/" alphabet, and any string
// that isn't the canonical encoding of the bytes it decodes to.
export function fromBase64Url(input: unknown, field = "value"): Buffer {
  if (typeof input !== "string" || !B64URL_RE.test(input) || input.length % 4 === 1) {
    throw new WebAuthnError("encoding", `${field} is not base64url`);
  }
  const buf = Buffer.from(input, "base64url");
  if (buf.toString("base64url") !== input) throw new WebAuthnError("encoding", `${field} is not canonical base64url`);
  return buf;
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function sha256(data: Uint8Array | string): Buffer {
  return createHash("sha256").update(data).digest();
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── configuration ──────────────────────────────────────────────────────────

// RP ID = AUTH_URL's hostname; origins = AUTH_URL's origin plus any
// AUTH_TRUSTED_ORIGIN whose host is the RP ID or a subdomain of it (WebAuthn
// §5.1.3: the RP ID must be a registrable suffix of the origin's host — an
// origin outside it could never produce a valid ceremony, so listing it would
// only widen the check for nothing). BASE_PATH never affects an origin.
// Returns null when AUTH_URL is missing/unparseable: passkeys are then
// unavailable rather than bound to a guessed host.
export function webAuthnConfigFromEnv(env: Record<string, string | undefined> = process.env): WebAuthnConfig | null {
  const raw = env.AUTH_URL?.trim();
  if (!raw) return null;
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  const rpId = base.hostname.toLowerCase();
  if (!rpId) return null;
  const origins = new Set<string>([base.origin]);
  for (const entry of (env.AUTH_TRUSTED_ORIGIN ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      const host = u.hostname.toLowerCase();
      if ((u.protocol === "https:" || u.protocol === "http:") && (host === rpId || host.endsWith(`.${rpId}`))) {
        origins.add(u.origin);
      }
    } catch {
      // ignored — instrumentation.ts already warns about an unparseable entry
    }
  }
  return { rpId, rpName: "Summonarr", origins: [...origins] };
}

// ─── authenticator data (§6.1) ──────────────────────────────────────────────

export interface ParsedAuthData {
  rpIdHash: Buffer;
  flags: { up: boolean; uv: boolean; be: boolean; bs: boolean; at: boolean; ed: boolean };
  signCount: number;
  attested?: { aaguid: Buffer; credentialId: Buffer; publicKey: Buffer };
}

export function parseAuthenticatorData(data: Uint8Array): ParsedAuthData {
  if (data.length < 37) throw new WebAuthnError("authdata", "authenticator data is too short");
  const buf = Buffer.from(data);
  const rpIdHash = buf.subarray(0, 32);
  const flagsByte = buf[32];
  const signCount = buf.readUInt32BE(33);
  const flags = {
    up: (flagsByte & FLAG_UP) !== 0,
    uv: (flagsByte & FLAG_UV) !== 0,
    be: (flagsByte & FLAG_BE) !== 0,
    bs: (flagsByte & FLAG_BS) !== 0,
    at: (flagsByte & FLAG_AT) !== 0,
    ed: (flagsByte & FLAG_ED) !== 0,
  };
  let pos = 37;
  let attested: ParsedAuthData["attested"];
  if (flags.at) {
    if (buf.length < pos + 18) throw new WebAuthnError("authdata", "attested credential data is truncated");
    const aaguid = buf.subarray(pos, pos + 16);
    pos += 16;
    const idLen = buf.readUInt16BE(pos);
    pos += 2;
    if (idLen === 0 || idLen > 1023) throw new WebAuthnError("authdata", "credential id length out of range");
    if (buf.length < pos + idLen) throw new WebAuthnError("authdata", "credential id is truncated");
    const credentialId = buf.subarray(pos, pos + idLen);
    pos += idLen;
    let keyLen: number;
    try {
      ({ length: keyLen } = decodeCborFirst(buf.subarray(pos)));
    } catch (err) {
      throw new WebAuthnError("authdata", `credential public key is not valid CBOR: ${err instanceof Error ? err.message : err}`);
    }
    const publicKey = buf.subarray(pos, pos + keyLen);
    pos += keyLen;
    attested = { aaguid, credentialId, publicKey };
  }
  if (flags.ed) {
    try {
      const { value, length } = decodeCborFirst(buf.subarray(pos));
      if (!isCborMap(value)) throw new CborError("extensions must be a map");
      pos += length;
    } catch (err) {
      throw new WebAuthnError("authdata", `extension data is not valid CBOR: ${err instanceof Error ? err.message : err}`);
    }
  }
  // Nothing may follow what the flags declared — trailing bytes mean the flags
  // and the payload disagree.
  if (pos !== buf.length) throw new WebAuthnError("authdata", "unexpected trailing bytes in authenticator data");
  // §6.1.3: a credential can't be backed up unless it is backup-eligible.
  if (flags.bs && !flags.be) throw new WebAuthnError("authdata", "backup state set without backup eligibility");
  return { rpIdHash: Buffer.from(rpIdHash), flags, signCount, attested };
}

// ─── COSE public keys (RFC 9053) ────────────────────────────────────────────

function coseBytes(map: Map<number | string, CborValue>, label: number, len?: number): Buffer {
  const v = map.get(label);
  if (!(v instanceof Uint8Array)) throw new WebAuthnError("cose", `COSE key parameter ${label} missing`);
  if (len !== undefined && v.length !== len) throw new WebAuthnError("cose", `COSE key parameter ${label} has the wrong length`);
  return Buffer.from(v);
}

export function coseToPublicKey(cose: Uint8Array): { key: KeyObject; alg: number } {
  let value: CborValue;
  try {
    value = decodeCbor(cose);
  } catch (err) {
    throw new WebAuthnError("cose", `COSE key is not valid CBOR: ${err instanceof Error ? err.message : err}`);
  }
  if (!isCborMap(value)) throw new WebAuthnError("cose", "COSE key is not a map");
  const kty = value.get(1);
  const alg = value.get(3);
  if (typeof alg !== "number" || !(SUPPORTED_COSE_ALGS as readonly number[]).includes(alg)) {
    throw new WebAuthnError("cose", "unsupported COSE algorithm");
  }
  try {
    if (alg === COSE_ALG_ES256) {
      if (kty !== 2 || value.get(-1) !== 1) throw new WebAuthnError("cose", "ES256 requires an EC2 P-256 key");
      const x = coseBytes(value, -2, 32);
      const y = coseBytes(value, -3, 32);
      // createPublicKey validates that (x, y) is on the curve.
      const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: x.toString("base64url"), y: y.toString("base64url") }, format: "jwk" });
      return { key, alg };
    }
    if (alg === COSE_ALG_EDDSA) {
      if (kty !== 1 || value.get(-1) !== 6) throw new WebAuthnError("cose", "EdDSA requires an OKP Ed25519 key");
      const x = coseBytes(value, -2, 32);
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: x.toString("base64url") }, format: "jwk" });
      return { key, alg };
    }
    // RS256
    if (kty !== 3) throw new WebAuthnError("cose", "RS256 requires an RSA key");
    const n = coseBytes(value, -1);
    const e = coseBytes(value, -2);
    const key = createPublicKey({ key: { kty: "RSA", n: n.toString("base64url"), e: e.toString("base64url") }, format: "jwk" });
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits < 2048) throw new WebAuthnError("cose", "RSA keys must be at least 2048 bits");
    return { key, alg };
  } catch (err) {
    if (err instanceof WebAuthnError) throw err;
    throw new WebAuthnError("cose", `COSE key is not a valid public key: ${err instanceof Error ? err.message : err}`);
  }
}

function verifySignature(alg: number, key: KeyObject, data: Buffer, signature: Buffer): boolean {
  try {
    if (alg === COSE_ALG_EDDSA) return cryptoVerify(null, data, key, signature);
    if (alg === COSE_ALG_ES256) return cryptoVerify("sha256", data, { key, dsaEncoding: "der" }, signature);
    return cryptoVerify("sha256", data, key, signature); // RS256: RSASSA-PKCS1-v1_5
  } catch {
    return false;
  }
}

// ─── client data (§7.1 steps 5–12, §7.2 steps 10–15) ────────────────────────

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

function verifyClientData(
  raw: Buffer,
  expectedType: "webauthn.create" | "webauthn.get",
  expectedChallenge: string,
  config: WebAuthnConfig,
): ClientData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new WebAuthnError("client-data", "clientDataJSON is not JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new WebAuthnError("client-data", "clientDataJSON is not an object");
  const cd = parsed as Record<string, unknown>;
  if (cd.type !== expectedType) throw new WebAuthnError("type", `clientData.type is not ${expectedType}`);
  if (typeof cd.challenge !== "string" || !bytesEqual(Buffer.from(cd.challenge, "utf8"), Buffer.from(expectedChallenge, "utf8"))) {
    throw new WebAuthnError("challenge", "challenge does not match");
  }
  if (typeof cd.origin !== "string" || !config.origins.includes(cd.origin)) {
    throw new WebAuthnError("origin", "origin is not allowed");
  }
  // A ceremony run inside a cross-origin iframe is never one of ours.
  if (cd.crossOrigin === true) throw new WebAuthnError("origin", "cross-origin ceremonies are not accepted");
  return cd as unknown as ClientData;
}

function checkRpIdHash(auth: ParsedAuthData, config: WebAuthnConfig): void {
  if (!bytesEqual(auth.rpIdHash, sha256(config.rpId))) throw new WebAuthnError("rp-id", "rpIdHash does not match the RP ID");
}

function checkUserFlags(auth: ParsedAuthData, requireUserVerification: boolean): void {
  if (!auth.flags.up) throw new WebAuthnError("user-presence", "user presence flag not set");
  if (requireUserVerification && !auth.flags.uv) throw new WebAuthnError("user-verification", "user verification required");
}

// ─── registration (§7.1) ────────────────────────────────────────────────────

export interface RegistrationResponseJSON {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string; transports?: unknown };
}

export interface VerifiedRegistration {
  credentialId: string; // base64url
  publicKey: string; // base64url COSE_Key
  alg: number;
  signCount: number;
  transports: string[];
  aaguid: string;
  backupEligible: boolean;
  backedUp: boolean;
  userVerified: boolean;
}

function formatAaguid(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function verifyRegistrationResponse(opts: {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
  config: WebAuthnConfig;
  requireUserVerification?: boolean;
}): VerifiedRegistration {
  const { response: r, config } = opts;
  if (!r || typeof r !== "object" || r.type !== "public-key" || !r.response || typeof r.response !== "object") {
    throw new WebAuthnError("shape", "not a public-key credential");
  }
  const rawId = fromBase64Url(r.rawId, "rawId");
  if (r.id !== r.rawId) throw new WebAuthnError("shape", "id and rawId disagree");
  const clientDataJSON = fromBase64Url(r.response.clientDataJSON, "clientDataJSON");
  const attestationObject = fromBase64Url(r.response.attestationObject, "attestationObject");

  verifyClientData(clientDataJSON, "webauthn.create", opts.expectedChallenge, config);

  let att: CborValue;
  try {
    att = decodeCbor(attestationObject);
  } catch (err) {
    throw new WebAuthnError("attestation", `attestationObject is not valid CBOR: ${err instanceof Error ? err.message : err}`);
  }
  if (!isCborMap(att)) throw new WebAuthnError("attestation", "attestationObject is not a map");
  const fmt = att.get("fmt");
  const attStmt = att.get("attStmt");
  const authDataRaw = att.get("authData");
  if (typeof fmt !== "string" || !isCborMap(attStmt ?? null) || !(authDataRaw instanceof Uint8Array)) {
    throw new WebAuthnError("attestation", "attestationObject is missing fmt/attStmt/authData");
  }
  // "none" must carry an empty statement. Any other fmt's statement is
  // ignored by policy (see the header) — never trusted, never parsed further.
  if (fmt === "none" && (attStmt as Map<unknown, unknown>).size !== 0) {
    throw new WebAuthnError("attestation", "fmt none must have an empty attStmt");
  }

  const auth = parseAuthenticatorData(authDataRaw);
  checkRpIdHash(auth, config);
  checkUserFlags(auth, opts.requireUserVerification ?? false);
  if (!auth.flags.at || !auth.attested) throw new WebAuthnError("authdata", "registration lacks attested credential data");
  // The credential the client says it created is the one the authenticator attested.
  if (!bytesEqual(auth.attested.credentialId, rawId)) throw new WebAuthnError("shape", "rawId does not match the attested credential id");

  const { alg } = coseToPublicKey(auth.attested.publicKey);

  const transports = Array.isArray(r.response.transports)
    ? [...new Set(r.response.transports.filter((t): t is string => typeof t === "string" && (ALLOWED_TRANSPORTS as readonly string[]).includes(t)))]
    : [];

  return {
    credentialId: toBase64Url(auth.attested.credentialId),
    publicKey: toBase64Url(auth.attested.publicKey),
    alg,
    signCount: auth.signCount,
    transports,
    aaguid: formatAaguid(auth.attested.aaguid),
    backupEligible: auth.flags.be,
    backedUp: auth.flags.bs,
    userVerified: auth.flags.uv,
  };
}

// ─── assertion (§7.2) ───────────────────────────────────────────────────────

export interface AuthenticationResponseJSON {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
}

export interface StoredCredential {
  credentialId: string; // base64url
  publicKey: string; // base64url COSE_Key
  signCount: number;
}

export interface VerifiedAssertion {
  newSignCount: number;
  userVerified: boolean;
  backedUp: boolean;
}

// The credential id an assertion claims, validated — the caller looks the
// stored credential up by it (scoped to the user) before calling
// verifyAuthenticationResponse.
export function assertionCredentialId(response: AuthenticationResponseJSON): string {
  if (!response || typeof response !== "object" || response.type !== "public-key") {
    throw new WebAuthnError("shape", "not a public-key credential");
  }
  const rawId = fromBase64Url(response.rawId, "rawId");
  if (response.id !== response.rawId) throw new WebAuthnError("shape", "id and rawId disagree");
  return toBase64Url(rawId);
}

export function verifyAuthenticationResponse(opts: {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  config: WebAuthnConfig;
  credential: StoredCredential;
  // The user handle we registered for this account; a returned userHandle that
  // differs means the authenticator thinks this is somebody else's credential.
  expectedUserHandle?: string;
  requireUserVerification?: boolean;
}): VerifiedAssertion {
  const { response: r, config, credential } = opts;
  const credentialId = assertionCredentialId(r);
  // §7.2 step 5/6: the credential must be the one we looked up for this user.
  if (credentialId !== credential.credentialId) throw new WebAuthnError("credential", "credential does not belong to this user");
  if (!r.response || typeof r.response !== "object") throw new WebAuthnError("shape", "missing assertion response");

  const clientDataJSON = fromBase64Url(r.response.clientDataJSON, "clientDataJSON");
  const authenticatorData = fromBase64Url(r.response.authenticatorData, "authenticatorData");
  const signature = fromBase64Url(r.response.signature, "signature");

  if (r.response.userHandle != null && r.response.userHandle !== "") {
    const handle = fromBase64Url(r.response.userHandle, "userHandle");
    if (!opts.expectedUserHandle || !bytesEqual(handle, fromBase64Url(opts.expectedUserHandle, "expectedUserHandle"))) {
      throw new WebAuthnError("credential", "userHandle does not match this account");
    }
  }

  verifyClientData(clientDataJSON, "webauthn.get", opts.expectedChallenge, config);
  const auth = parseAuthenticatorData(authenticatorData);
  checkRpIdHash(auth, config);
  checkUserFlags(auth, opts.requireUserVerification ?? false);

  // §7.2 step 20: the signature covers authenticatorData ‖ SHA-256(clientDataJSON).
  const { key, alg } = coseToPublicKey(fromBase64Url(credential.publicKey, "publicKey"));
  const signedData = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
  if (!verifySignature(alg, key, signedData, signature)) throw new WebAuthnError("signature", "signature does not verify");

  // §7.2 step 21: signature counter. Both zero ⇒ the authenticator doesn't count
  // (synced passkeys) — accept. Otherwise the new value must strictly exceed the
  // stored one; anything else is a possible cloned authenticator and is refused.
  const stored = credential.signCount;
  const received = auth.signCount;
  if (!(stored === 0 && received === 0) && received <= stored) {
    throw new WebAuthnError("counter", "signature counter did not increase (possible cloned authenticator)");
  }

  return { newSignCount: received, userVerified: auth.flags.uv, backedUp: auth.flags.bs };
}
