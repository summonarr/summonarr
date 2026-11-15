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
import { processSingleton } from "@/lib/process-singleton";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// Default TTL: how long the push service (FCM/autopush/Apple) keeps a message
// for a device that is offline. 24h matches the APNs relay's expiry window, so
// a user who opens their laptop or phone later still sees "approved"/"now
// available" pings. (A 60s TTL used to drop pushes to any device offline for
// more than a minute.)
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

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

// ---------- VAPID key generation ----------

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

  // Get the raw 32-byte private key. The JWK export holds it as base64url(d),
  // so decode that.
  const jwkPriv = privateKey.export({ format: "jwk" }) as { d?: string };
  if (!jwkPriv.d) throw new Error("Failed to extract VAPID private scalar");
  const d = base64UrlDecode(jwkPriv.d);
  // Node pads `d` to the curve size, but left-pad defensively so the stored
  // scalar is always exactly 32 bytes; a longer one is not a P-256 key.
  if (d.length > 32) throw new Error("VAPID private scalar exceeds 32 bytes");
  const scalar = new Uint8Array(32);
  scalar.set(d, 32 - d.length);

  return {
    publicKey: base64UrlEncode(exportUncompressedPoint(publicKey)),
    privateKey: base64UrlEncode(scalar),
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

// The base64url x/y coordinates of a 65-byte uncompressed P-256 point.
function pointToJwk(point: Uint8Array): { x: string; y: string } {
  return { x: base64UrlEncode(point.subarray(1, 33)), y: base64UrlEncode(point.subarray(33, 65)) };
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
  return createPrivateKey({
    key: { kty: "EC", crv: "P-256", d, ...pointToJwk(pub) },
    format: "jwk",
  });
}

// ---------- VAPID JWT (RFC 8292) ----------

interface VapidJwtOptions {
  audience: string;
  contact: string;
  publicKey: string;
  privateKey: string;
}

const VAPID_JWT_LIFETIME_SECONDS = 12 * 60 * 60;
// A cached token is reused while it has at least this long left, so a push
// service never sees one about to expire.
const VAPID_JWT_MIN_REMAINING_SECONDS = 60 * 60;
// One entry per push-service origin (FCM, autopush, Apple, …) per key; a handful
// in practice. The bound only stops a flood of odd endpoints growing it forever.
const VAPID_JWT_CACHE_MAX = 256;

// Exported for tests: signs a fresh token on every call.
export function signVapidJwt(opts: VapidJwtOptions): { jwt: string; exp: number } {
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const exp = Math.floor(Date.now() / 1000) + VAPID_JWT_LIFETIME_SECONDS;
  const claims = base64UrlEncode(
    Buffer.from(JSON.stringify({ aud: opts.audience, exp, sub: opts.contact })),
  );
  const signingInput = `${header}.${claims}`;

  const keyObj = importVapidPrivateKey(opts.privateKey, opts.publicKey);
  const signer = createSign("sha256");
  signer.update(signingInput);
  signer.end();
  // ES256 wants the raw 64-byte r||s (each left-padded to 32 bytes), not
  // Node's default DER encoding; ieee-p1363 produces exactly that.
  const rawSig = signer.sign({ key: keyObj, dsaEncoding: "ieee-p1363" });

  return { jwt: `${signingInput}.${base64UrlEncode(rawSig)}`, exp };
}

// Every subscription on one push service shares an audience, so a fan-out to
// N devices signs once instead of N times (a key import plus an ECDSA sign each).
const vapidJwtCache = processSingleton("web-push:vapidJwtCache", () => new Map<string, { jwt: string; exp: number }>());

function buildVapidJwt(opts: VapidJwtOptions): string {
  const key = [opts.audience, opts.contact, opts.publicKey, opts.privateKey].join("\0");
  const now = Math.floor(Date.now() / 1000);
  const hit = vapidJwtCache.get(key);
  if (hit && hit.exp - now >= VAPID_JWT_MIN_REMAINING_SECONDS) return hit.jwt;
  const fresh = signVapidJwt(opts);
  if (!hit && vapidJwtCache.size >= VAPID_JWT_CACHE_MAX) {
    // Drop what has expired; if nothing has, the oldest insertion.
    for (const [k, v] of vapidJwtCache) if (v.exp - now < VAPID_JWT_MIN_REMAINING_SECONDS) vapidJwtCache.delete(k);
    if (vapidJwtCache.size >= VAPID_JWT_CACHE_MAX) {
      const oldest = vapidJwtCache.keys().next();
      if (!oldest.done) vapidJwtCache.delete(oldest.value);
    }
  }
  vapidJwtCache.set(key, fresh);
  return fresh.jwt;
}

// ---------- Payload encryption (RFC 8291, aes128gcm) ----------

interface EncryptInput {
  payload: Uint8Array;
  /** The subscription's p256dh point (65-byte uncompressed). */
  uaPublicKeyRaw: Uint8Array;
  /** The subscription's 16-byte auth secret. */
  authSecret: Uint8Array;
  salt: Uint8Array;
  /** This send's ephemeral application-server public point. */
  asEphemeralPublicRaw: Uint8Array;
  ecdhSharedSecret: Uint8Array;
}

// RFC 8188 §2.1: the record size. 4096 is the standard choice, and the push
// services' own payload limit, so the whole payload is always one record.
const RECORD_SIZE = 4096;
// Per record: the 0x02 last-record delimiter plus the 16-byte GCM tag.
const RECORD_OVERHEAD = 1 + 16;
export const MAX_PUSH_PAYLOAD_BYTES = RECORD_SIZE - RECORD_OVERHEAD;

function encryptPayload(input: EncryptInput): Uint8Array {
  const { payload, uaPublicKeyRaw, authSecret, salt, asEphemeralPublicRaw, ecdhSharedSecret } = input;
  // A longer payload would need a second record; one record larger than rs is
  // malformed and every push service refuses it.
  if (payload.length > MAX_PUSH_PAYLOAD_BYTES) {
    throw new Error(`Web Push payload is ${payload.length} bytes, over the ${MAX_PUSH_PAYLOAD_BYTES}-byte single-record limit`);
  }
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

  // RFC 8188 §2.2 — the whole payload fits in one record, so it ends with the
  // last-record delimiter byte 0x02. No extra zero padding is needed.
  const padded = Buffer.concat([Buffer.from(payload), Buffer.from([0x02])]);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]);

  // RFC 8188 §2.1 header: salt(16) || rs(4 BE) || idlen(1) || keyid(idlen)
  const rs = RECORD_SIZE;
  const keyid = Buffer.from(asEphemeralPublicRaw);
  const header = Buffer.alloc(16 + 4 + 1 + keyid.length);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(keyid.length, 20);
  keyid.copy(header, 21);

  return new Uint8Array(Buffer.concat([header, ciphertext]));
}

// ---------- Public API ----------

// A TTL header is a non-negative whole number of seconds.
function clampTtl(ttl: number | undefined): number {
  if (ttl === undefined || !Number.isFinite(ttl)) return DEFAULT_TTL_SECONDS;
  return Math.max(0, Math.floor(ttl));
}

export async function sendPushNotification(
  subscription: PushSubscription,
  payload: string,
  options: SendOptions,
): Promise<void> {
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(subscription.endpoint);
  } catch {
    // Status 0: no push service answered, and no retry can fix the stored endpoint.
    throw new WebPushError(0, "", "Invalid subscription endpoint");
  }
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
  const uaPublicKey = createPublicKey({
    key: { kty: "EC", crv: "P-256", ...pointToJwk(uaPublicRaw) },
    format: "jwk",
  });

  // ECDH shared secret (32 bytes for P-256)
  const ecdhSecret = new Uint8Array(diffieHellman({ privateKey: as.privateKey, publicKey: uaPublicKey }));

  const salt = new Uint8Array(randomBytes(16));
  const body = encryptPayload({
    payload: new TextEncoder().encode(payload),
    uaPublicKeyRaw: uaPublicRaw,
    authSecret,
    salt,
    asEphemeralPublicRaw: asPublicRaw,
    ecdhSharedSecret: ecdhSecret,
  });

  const headers: Record<string, string> = {
    Authorization: `vapid t=${jwt}, k=${options.vapidPublicKey}`,
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "aes128gcm",
    TTL: String(clampTtl(options.ttl)),
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
    throw new WebPushError(res.status, await readBodyPrefix(res, MAX_ERROR_BODY_BYTES));
  }
  // Nothing in a success answer is used: release the socket without reading it.
  await res.body?.cancel().catch(() => undefined);
}

// The endpoint comes from a browser's subscription, so its error answer is
// untrusted: keep a short prefix (WebPushError.body is logged), never the
// whole body safeFetch would allow.
const MAX_ERROR_BODY_BYTES = 2048;

async function readBodyPrefix(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // A body that broke off keeps what arrived.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}
