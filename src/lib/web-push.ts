// Pure-TypeScript Web Push (RFC 8030 / RFC 8291 / RFC 8292) implementation.
// Replaces the `web-push` npm package with only `node:crypto`. Covers the
// surface area Summonarr uses: VAPID keypair generation, signed JWT auth,
// aes128gcm payload encryption, and HTTP delivery via `safeFetch`.
//
// References:
//   RFC 8030 — Generic Event Delivery Using HTTP Push
//   RFC 8188 — Encrypted Content-Encoding for HTTP (aes128gcm)
//   RFC 8291 — Message Encryption for Web Push
//   RFC 8292 — Voluntary Application Server Identification (VAPID)

import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  createSign,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  createCipheriv,
} from "node:crypto";
import { safeFetch } from "@/lib/safe-fetch";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface SendOptions {
  contact: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
}

export class WebPushError extends Error {
  readonly statusCode: number;
  readonly body: string;
  constructor(statusCode: number, body: string, message?: string) {
    super(message ?? `Web Push request failed with status ${statusCode}`);
    this.name = "WebPushError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

// ---------- base64url ----------

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(str: string): Uint8Array {
  const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

// ---------- HKDF (RFC 5869) ----------

function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", salt).update(ikm).digest());
}

function hkdfExpand(prk: Uint8Array, info: Uint8Array, len: number): Uint8Array {
  const out = Buffer.alloc(len);
  let t = Buffer.alloc(0);
  let offset = 0;
  let counter = 1;
  while (offset < len) {
    const h = createHmac("sha256", prk);
    h.update(t);
    h.update(info);
    h.update(Buffer.from([counter]));
    t = h.digest();
    const take = Math.min(t.length, len - offset);
    t.copy(out, offset, 0, take);
    offset += take;
    counter += 1;
  }
  return new Uint8Array(out);
}

// ---------- DER-encoded ECDSA signature → raw r||s ----------

function derSignatureToRaw(der: Uint8Array): Uint8Array {
  // Parse: SEQUENCE { INTEGER r, INTEGER s }
  // 0x30 len 0x02 rlen r... 0x02 slen s...
  if (der.length < 8 || der[0] !== 0x30) {
    throw new Error("Invalid DER signature: missing SEQUENCE tag");
  }
  let cursor = 2;
  // Handle long-form length on the SEQUENCE itself (rare for ECDSA-P256 but cheap to support)
  if ((der[1] & 0x80) !== 0) {
    cursor = 2 + (der[1] & 0x7f);
  }
  if (der[cursor] !== 0x02) throw new Error("Invalid DER signature: missing INTEGER (r)");
  const rLen = der[cursor + 1];
  const rStart = cursor + 2;
  const rEnd = rStart + rLen;
  const rBytes = der.subarray(rStart, rEnd);

  if (der[rEnd] !== 0x02) throw new Error("Invalid DER signature: missing INTEGER (s)");
  const sLen = der[rEnd + 1];
  const sStart = rEnd + 2;
  const sEnd = sStart + sLen;
  const sBytes = der.subarray(sStart, sEnd);

  const raw = new Uint8Array(64);
  // Strip leading zero pad and left-pad to 32 bytes
  const rTrim = stripLeadingZeros(rBytes);
  const sTrim = stripLeadingZeros(sBytes);
  if (rTrim.length > 32 || sTrim.length > 32) {
    throw new Error("Invalid DER signature: r/s exceeds 32 bytes");
  }
  raw.set(rTrim, 32 - rTrim.length);
  raw.set(sTrim, 64 - sTrim.length);
  return raw;
}

function stripLeadingZeros(buf: Uint8Array): Uint8Array {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0x00) i += 1;
  return buf.subarray(i);
}

// ---------- VAPID key generation ----------

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

  // Export the raw 32-byte private scalar from the DER-encoded PKCS#8.
  // JWK encoding gives us base64url(d) directly, which we re-decode for raw form.
  const jwkPriv = privateKey.export({ format: "jwk" }) as { d?: string };
  if (!jwkPriv.d) throw new Error("Failed to extract VAPID private scalar");
  const d = base64UrlDecode(jwkPriv.d);
  if (d.length !== 32) {
    // Some keys can have leading-zero stripping in JWK; left-pad to 32.
    const padded = new Uint8Array(32);
    padded.set(d, 32 - d.length);
    return {
      publicKey: base64UrlEncode(exportUncompressedPoint(publicKey)),
      privateKey: base64UrlEncode(padded),
    };
  }

  return {
    publicKey: base64UrlEncode(exportUncompressedPoint(publicKey)),
    privateKey: base64UrlEncode(d),
  };
}

function exportUncompressedPoint(publicKey: ReturnType<typeof createPublicKey>): Uint8Array {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) throw new Error("Failed to extract VAPID public point");
  const x = base64UrlDecode(jwk.x);
  const y = base64UrlDecode(jwk.y);
  if (x.length > 32 || y.length > 32) throw new Error("VAPID public coordinates exceed 32 bytes");
  const out = new Uint8Array(65);
  out[0] = 0x04; // uncompressed
  out.set(x, 1 + (32 - x.length));
  out.set(y, 33 + (32 - y.length));
  return out;
}

// Rebuild a Node KeyObject from raw 32-byte P-256 private scalar + the
// uncompressed public point (both base64url). Node's JWK importer needs the
// public coordinates alongside `d`.
function importVapidPrivateKey(privateKeyB64: string, publicKeyB64: string) {
  const d = privateKeyB64;
  const pub = base64UrlDecode(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("VAPID public key must be 65-byte uncompressed P-256 point");
  }
  const x = base64UrlEncode(pub.subarray(1, 33));
  const y = base64UrlEncode(pub.subarray(33, 65));
  return createPrivateKey({
    key: { kty: "EC", crv: "P-256", d, x, y },
    format: "jwk",
  });
}

// ---------- VAPID JWT (RFC 8292) ----------

function buildVapidJwt(opts: { audience: string; contact: string; publicKey: string; privateKey: string }): string {
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12 hours
  const claims = base64UrlEncode(
    Buffer.from(JSON.stringify({ aud: opts.audience, exp, sub: opts.contact })),
  );
  const signingInput = `${header}.${claims}`;

  const keyObj = importVapidPrivateKey(opts.privateKey, opts.publicKey);
  const signer = createSign("sha256");
  signer.update(signingInput);
  signer.end();
  const derSig = signer.sign(keyObj);
  const rawSig = derSignatureToRaw(new Uint8Array(derSig));

  return `${signingInput}.${base64UrlEncode(rawSig)}`;
}

// ---------- Payload encryption (RFC 8291, aes128gcm) ----------

interface EncryptResult {
  body: Uint8Array;
}

function encryptPayload(
  payload: Uint8Array,
  uaPublicKeyRaw: Uint8Array,
  authSecret: Uint8Array,
  salt: Uint8Array,
  asEphemeralPublicRaw: Uint8Array,
  ecdhSharedSecret: Uint8Array,
): EncryptResult {
  // RFC 8291 §3.4 — derive IKM from the auth secret + ECDH shared secret + key info
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    uaPublicKeyRaw,
    asEphemeralPublicRaw,
  ]);
  const ikmPrk = hkdfExtract(authSecret, ecdhSharedSecret);
  const ikm = hkdfExpand(ikmPrk, new Uint8Array(keyInfo), 32);

  // RFC 8188 — derive CEK + nonce from salt + IKM
  const saltPrk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(saltPrk, new Uint8Array(Buffer.from("Content-Encoding: aes128gcm\0", "utf8")), 16);
  const nonce = hkdfExpand(saltPrk, new Uint8Array(Buffer.from("Content-Encoding: nonce\0", "utf8")), 12);

  // RFC 8188 §2.2 — single-record padding: payload || 0x02 || zeros
  // Single record so the last-record delimiter (0x02) is used; no extra zero padding required.
  const padded = Buffer.concat([Buffer.from(payload), Buffer.from([0x02])]);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]);

  // RFC 8188 §2.1 header: salt(16) || rs(4 BE) || idlen(1) || keyid(idlen)
  // rs must be at least 18 (payload byte + delimiter + tag overhead). 4096 is the
  // standard choice — larger than any realistic notification payload.
  const rs = 4096;
  const keyid = Buffer.from(asEphemeralPublicRaw);
  const header = Buffer.alloc(16 + 4 + 1 + keyid.length);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(keyid.length, 20);
  keyid.copy(header, 21);

  return { body: new Uint8Array(Buffer.concat([header, ciphertext])) };
}

// ---------- Public API ----------

export async function sendPushNotification(
  subscription: PushSubscription,
  payload: string,
  options: SendOptions,
): Promise<void> {
  const endpointUrl = new URL(subscription.endpoint);
  const audience = endpointUrl.origin;

  const jwt = buildVapidJwt({
    audience,
    contact: options.contact,
    publicKey: options.vapidPublicKey,
    privateKey: options.vapidPrivateKey,
  });

  // Generate ephemeral AS (application server) ECDH keypair
  const as = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const asPublicRaw = exportUncompressedPoint(as.publicKey);

  // Decode UA's public key + auth secret
  const uaPublicRaw = base64UrlDecode(subscription.keys.p256dh);
  if (uaPublicRaw.length !== 65 || uaPublicRaw[0] !== 0x04) {
    throw new Error("Invalid subscription p256dh: expected 65-byte uncompressed P-256 point");
  }
  const authSecret = base64UrlDecode(subscription.keys.auth);
  if (authSecret.length !== 16) {
    throw new Error(`Invalid subscription auth secret: expected 16 bytes, got ${authSecret.length}`);
  }

  // Rebuild a Node KeyObject for the UA public key from its raw coordinates
  const uaX = base64UrlEncode(uaPublicRaw.subarray(1, 33));
  const uaY = base64UrlEncode(uaPublicRaw.subarray(33, 65));
  const uaPublicKey = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: uaX, y: uaY },
    format: "jwk",
  });

  // ECDH shared secret (32 bytes for P-256)
  const ecdhSecret = new Uint8Array(diffieHellman({ privateKey: as.privateKey, publicKey: uaPublicKey }));

  const salt = new Uint8Array(randomBytes(16));
  const { body } = encryptPayload(
    new TextEncoder().encode(payload),
    uaPublicRaw,
    authSecret,
    salt,
    asPublicRaw,
    ecdhSecret,
  );

  const headers: Record<string, string> = {
    Authorization: `vapid t=${jwt}, k=${options.vapidPublicKey}`,
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "aes128gcm",
    TTL: String(options.ttl ?? 60),
  };
  if (options.urgency) headers.Urgency = options.urgency;

  // fetch() BodyInit accepts ArrayBuffer; pass the underlying buffer slice so
  // we don't depend on Uint8Array being in the BodyInit union (varies by lib.dom).
  const bodyAb = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  const res = await safeFetch(subscription.endpoint, {
    method: "POST",
    headers,
    body: bodyAb,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new WebPushError(res.status, errBody);
  }
  // Drain the response body so the underlying socket can be released.
  await res.arrayBuffer().catch(() => undefined);
}
