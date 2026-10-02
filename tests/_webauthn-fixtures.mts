// WebAuthn test fixtures (not a test file — the runner glob is tests/*.test.mts).
//
// Builds authenticator output BYTE-FOR-BYTE the way a real authenticator does
// (WebAuthn §6.1 authenticator data, §6.5 attestation object, CTAP2 canonical
// CBOR) with node:crypto keypairs, so the verifier in src/lib/mfa/webauthn.ts
// is exercised against genuine signatures rather than mocks. The CBOR encoder
// here is deliberately independent of the decoder under test.

import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export type CborIn = number | string | Uint8Array | boolean | null | CborIn[] | Map<number | string, CborIn>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cborEncode(v: CborIn): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v === false) return Buffer.from([0xf4]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === null) return Buffer.from([0xf6]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cborEncode)]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cborEncode(k), cborEncode(val));
  return Buffer.concat(parts);
}

export type Alg = "ES256" | "EdDSA" | "RS256";

export interface Authenticator {
  alg: Alg;
  privateKey: KeyObject;
  coseKey: Buffer;
  credentialId: Buffer;
}

export function makeAuthenticator(alg: Alg = "ES256", credentialId?: Buffer): Authenticator {
  const id = credentialId ?? createHash("sha256").update(`cred-${Math.random()}`).digest().subarray(0, 16);
  if (alg === "ES256") {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const cose = new Map<number, CborIn>([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ]);
    return { alg, privateKey, coseKey: cborEncode(cose), credentialId: id };
  }
  if (alg === "EdDSA") {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    const cose = new Map<number, CborIn>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, "base64url")]]);
    return { alg, privateKey, coseKey: cborEncode(cose), credentialId: id };
  }
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const cose = new Map<number, CborIn>([
    [1, 3], [3, -257],
    [-1, Buffer.from(jwk.n, "base64url")],
    [-2, Buffer.from(jwk.e, "base64url")],
  ]);
  return { alg, privateKey, coseKey: cborEncode(cose), credentialId: id };
}

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

export function buildAuthData(opts: {
  rpId: string;
  flags: number;
  signCount: number;
  attested?: { credentialId: Buffer; coseKey: Buffer; aaguid?: Buffer };
  extensions?: Buffer;
  trailing?: Buffer;
}): Buffer {
  const parts: Buffer[] = [createHash("sha256").update(opts.rpId).digest(), Buffer.from([opts.flags])];
  const count = Buffer.alloc(4);
  count.writeUInt32BE(opts.signCount);
  parts.push(count);
  if (opts.attested) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(opts.attested.credentialId.length);
    parts.push(opts.attested.aaguid ?? Buffer.alloc(16), len, opts.attested.credentialId, opts.attested.coseKey);
  }
  if (opts.extensions) parts.push(opts.extensions);
  if (opts.trailing) parts.push(opts.trailing);
  return Buffer.concat(parts);
}

export function buildClientData(fields: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(fields), "utf8");
}

const b64u = (b: Buffer) => b.toString("base64url");

export function registrationResponse(opts: {
  auth: Authenticator;
  rpId: string;
  origin: string;
  challenge: string;
  type?: string;
  flags?: number;
  signCount?: number;
  fmt?: string;
  attStmt?: Map<number | string, CborIn>;
  rawId?: Buffer;
  crossOrigin?: boolean;
  transports?: unknown;
}) {
  const authData = buildAuthData({
    rpId: opts.rpId,
    flags: opts.flags ?? FLAG_UP | FLAG_AT,
    signCount: opts.signCount ?? 0,
    attested: { credentialId: opts.auth.credentialId, coseKey: opts.auth.coseKey },
  });
  const attestationObject = cborEncode(new Map<string, CborIn>([
    ["fmt", opts.fmt ?? "none"],
    ["attStmt", opts.attStmt ?? new Map()],
    ["authData", authData],
  ]));
  const clientDataJSON = buildClientData({
    type: opts.type ?? "webauthn.create",
    challenge: opts.challenge,
    origin: opts.origin,
    ...(opts.crossOrigin !== undefined ? { crossOrigin: opts.crossOrigin } : {}),
  });
  const rawId = b64u(opts.rawId ?? opts.auth.credentialId);
  return {
    id: rawId,
    rawId,
    type: "public-key",
    response: {
      clientDataJSON: b64u(clientDataJSON),
      attestationObject: b64u(attestationObject),
      transports: opts.transports ?? ["usb", "bogus"],
    },
  };
}

export function signAssertion(auth: Authenticator, data: Buffer): Buffer {
  if (auth.alg === "EdDSA") return sign(null, data, auth.privateKey);
  if (auth.alg === "ES256") return sign("sha256", data, { key: auth.privateKey, dsaEncoding: "der" });
  return sign("sha256", data, auth.privateKey);
}

export function assertionResponse(opts: {
  auth: Authenticator;
  rpId: string;
  origin: string;
  challenge: string;
  signCount: number;
  type?: string;
  flags?: number;
  userHandle?: string | null;
  crossOrigin?: boolean;
  // Sign with a different authenticator (a forged assertion).
  signWith?: Authenticator;
  // Mutate authenticator data AFTER signing (tampering).
  tamperAuthData?: (b: Buffer) => Buffer;
}) {
  const authData = buildAuthData({ rpId: opts.rpId, flags: opts.flags ?? FLAG_UP, signCount: opts.signCount });
  const clientDataJSON = buildClientData({
    type: opts.type ?? "webauthn.get",
    challenge: opts.challenge,
    origin: opts.origin,
    ...(opts.crossOrigin !== undefined ? { crossOrigin: opts.crossOrigin } : {}),
  });
  const signed = Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]);
  const signature = signAssertion(opts.signWith ?? opts.auth, signed);
  const finalAuthData = opts.tamperAuthData ? opts.tamperAuthData(Buffer.from(authData)) : authData;
  const rawId = b64u(opts.auth.credentialId);
  return {
    id: rawId,
    rawId,
    type: "public-key",
    response: {
      clientDataJSON: b64u(clientDataJSON),
      authenticatorData: b64u(finalAuthData),
      signature: b64u(signature),
      userHandle: opts.userHandle === undefined ? null : opts.userHandle,
    },
  };
}
