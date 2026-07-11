// Unit tests for the pure-node:crypto Web Push implementation
// (src/lib/web-push.ts). The VAPID JWT (RFC 8292) and aes128gcm payload
// encryption (RFC 8188/8291) are wire contracts with third-party push
// services (FCM, Mozilla autopush, APNs web push) — any drift in curve,
// encoding, HKDF info strings, or record framing silently bricks every
// browser notification. The payload tests decrypt as the user agent with an
// INDEPENDENT implementation (Node's hkdfSync, not the module's hand-rolled
// HKDF), so a shared bug can't self-verify.
//
// No network is ever touched: subscription endpoints use IP-literal hosts
// (TEST-NET-3, 203.0.113.5 — reserved for documentation and never routed),
// which the SSRF resolver policy-checks WITHOUT a DNS lookup, and
// globalThis.fetch is stubbed to capture the outbound request.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDecipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  base64UrlEncode,
  base64UrlDecode,
  generateVapidKeys,
  sendPushNotification,
  WebPushError,
} from "../src/lib/web-push.ts";
import type { PushSubscription, SendOptions } from "../src/lib/web-push.ts";
import { SafeFetchError } from "../src/lib/safe-fetch.ts";

// TEST-NET-3 (RFC 5737) — an IP literal so the SSRF layer never does DNS.
const ENDPOINT = "https://203.0.113.5/push/v1/sub-abc";

const VAPID = generateVapidKeys();
const SEND_OPTS: SendOptions = {
  contact: "mailto:admin@example.com",
  vapidPublicKey: VAPID.publicKey,
  vapidPrivateKey: VAPID.privateKey,
};

// ---------- helpers ----------

interface CapturedCall {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: Buffer;
  bodyWasArrayBuffer: boolean;
}

// Stub globalThis.fetch for the duration of fn(), capturing every outbound
// request. safeFetch resolves IP-literal hosts without DNS, so the stub is the
// only I/O boundary — nothing leaves the process.
async function withFetchStub<T>(
  respond: () => Response,
  fn: () => Promise<T>,
): Promise<{ calls: CapturedCall[]; value: T }> {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: raw instanceof ArrayBuffer ? Buffer.from(new Uint8Array(raw)) : Buffer.alloc(0),
      bodyWasArrayBuffer: raw instanceof ArrayBuffer,
    });
    return respond();
  }) as typeof fetch;
  try {
    const value = await fn();
    return { calls, value };
  } finally {
    globalThis.fetch = original;
  }
}

const ok201 = () => new Response(null, { status: 201 });
const noFetchExpected = (): Response => {
  throw new Error("unexpected network attempt");
};

// A user agent (browser) side of a subscription: P-256 keypair + auth secret.
function makeUa(endpoint: string = ENDPOINT) {
  const ecdh = createECDH("prime256v1");
  const publicRaw = ecdh.generateKeys(); // 65-byte X9.63 uncompressed
  const authSecret = randomBytes(16);
  const subscription: PushSubscription = {
    endpoint,
    keys: {
      p256dh: publicRaw.toString("base64url"),
      auth: authSecret.toString("base64url"),
    },
  };
  return { ecdh, publicRaw, authSecret, subscription };
}

function parseJwt(token: string) {
  const parts = token.split(".");
  assert.equal(parts.length, 3, "JWT must have exactly three segments");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  return {
    header,
    claims,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: new Uint8Array(Buffer.from(parts[2], "base64url")),
  };
}

function vapidPublicKeyObject(publicKeyB64: string) {
  const point = base64UrlDecode(publicKeyB64);
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: Buffer.from(point.subarray(1, 33)).toString("base64url"),
      y: Buffer.from(point.subarray(33, 65)).toString("base64url"),
    },
    format: "jwk",
  });
}

// Independent RFC 8188/8291 decryptor using Node's built-in hkdfSync — mirrors
// what a browser push stack does with the aes128gcm body.
function decryptAsUa(ua: ReturnType<typeof makeUa>, body: Buffer) {
  const salt = Buffer.from(body.subarray(0, 16));
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = Buffer.from(body.subarray(21, 21 + idlen));
  const ciphertext = body.subarray(21 + idlen);

  const shared = ua.ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), ua.publicRaw, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, ua.authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12));

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const ct = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(ct), decipher.final()]);
  return { salt, rs, idlen, asPublic, padded };
}

// ---------- base64url ----------

test("base64url: encode strips padding and swaps +/ for -_ (pinned vector)", () => {
  // 0xfb 0xff → standard base64 "+/8=" → base64url "-_8"
  assert.equal(base64UrlEncode(new Uint8Array([0xfb, 0xff])), "-_8");
  assert.equal(base64UrlEncode(new Uint8Array(0)), "");
  // All 256 byte values: must match Node's own base64url codec and stay in the url-safe charset.
  const all = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
  const encoded = base64UrlEncode(all);
  assert.equal(encoded, Buffer.from(all).toString("base64url"));
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
});

test("base64url: decode(encode(x)) roundtrips every length 0..64", () => {
  for (let len = 0; len <= 64; len += 1) {
    const original = new Uint8Array(Array.from({ length: len }, (_, i) => (i * 7 + len) % 256));
    const decoded = base64UrlDecode(base64UrlEncode(original));
    assert.deepEqual(decoded, original, `roundtrip failed at length ${len}`);
  }
});

test("base64url: decode re-pads unpadded input and maps url-safe chars", () => {
  assert.deepEqual(base64UrlDecode("-_8"), new Uint8Array([0xfb, 0xff]));
  assert.deepEqual(base64UrlDecode("AQ"), new Uint8Array([0x01])); // 2-char group (pad 2)
  assert.deepEqual(base64UrlDecode("AQAB"), new Uint8Array([0x01, 0x00, 0x01]));
  assert.equal(base64UrlDecode("").length, 0);
});

// ---------- VAPID key generation ----------

test("generateVapidKeys: 65-byte 0x04 public point + 32-byte private scalar, base64url-encoded", () => {
  for (let i = 0; i < 5; i += 1) {
    const keys = generateVapidKeys();
    assert.match(keys.publicKey, /^[A-Za-z0-9_-]+$/);
    assert.match(keys.privateKey, /^[A-Za-z0-9_-]+$/);
    const pub = base64UrlDecode(keys.publicKey);
    const priv = base64UrlDecode(keys.privateKey);
    assert.equal(pub.length, 65, "public key must be an uncompressed P-256 point");
    assert.equal(pub[0], 0x04, "public key must carry the uncompressed-point marker");
    assert.equal(priv.length, 32, "private scalar must be exactly 32 bytes");
  }
});

test("generateVapidKeys: keypairs are unique and the scalar matches the public point (ES256 roundtrip)", () => {
  const a = generateVapidKeys();
  const b = generateVapidKeys();
  assert.notEqual(a.privateKey, b.privateKey);
  assert.notEqual(a.publicKey, b.publicKey);

  // Sign with the private scalar, verify with ONLY the public point. This
  // passes iff d·G equals the exported point — i.e. the pair belongs together.
  const point = base64UrlDecode(a.publicKey);
  const x = Buffer.from(point.subarray(1, 33)).toString("base64url");
  const y = Buffer.from(point.subarray(33, 65)).toString("base64url");
  const privKey = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: a.privateKey, x, y },
    format: "jwk",
  });
  const sig = createSign("sha256").update("vapid-probe").sign({ key: privKey, dsaEncoding: "ieee-p1363" });
  const verified = createVerify("sha256")
    .update("vapid-probe")
    .verify({ key: vapidPublicKeyObject(a.publicKey), dsaEncoding: "ieee-p1363" }, sig);
  assert.equal(verified, true);
});

// ---------- WebPushError ----------

test("WebPushError: carries status/body, default and custom messages", () => {
  const e = new WebPushError(410, "gone");
  assert.ok(e instanceof Error);
  assert.equal(e.name, "WebPushError");
  assert.equal(e.statusCode, 410);
  assert.equal(e.body, "gone");
  assert.equal(e.message, "Web Push request failed with status 410");
  assert.equal(new WebPushError(500, "x", "boom").message, "boom");
});

// ---------- sendPushNotification: request shape ----------

test("sendPushNotification: POSTs the encrypted body to the endpoint with RFC 8030 headers", async () => {
  const ua = makeUa();
  const { calls } = await withFetchStub(ok201, () =>
    sendPushNotification(ua.subscription, "hello", SEND_OPTS),
  );

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.method, "POST");
  assert.equal(call.bodyWasArrayBuffer, true, "body must be sent as raw bytes");
  assert.equal(call.headers.get("content-type"), "application/octet-stream");
  assert.equal(call.headers.get("content-encoding"), "aes128gcm");
  assert.equal(call.headers.get("ttl"), "60", "TTL defaults to 60 seconds");
  assert.equal(call.headers.get("urgency"), null, "Urgency omitted unless requested");
});

test("sendPushNotification: ttl and urgency options override the defaults", async () => {
  const ua = makeUa();
  const { calls } = await withFetchStub(ok201, () =>
    sendPushNotification(ua.subscription, "hello", { ...SEND_OPTS, ttl: 300, urgency: "high" }),
  );
  assert.equal(calls[0].headers.get("ttl"), "300");
  assert.equal(calls[0].headers.get("urgency"), "high");
});

// ---------- VAPID JWT (RFC 8292) ----------

test("VAPID JWT: ES256-signed, audience = endpoint origin, sub = contact, 12h expiry", async () => {
  // Port must survive into the audience; path and query must not.
  const ua = makeUa("https://203.0.113.5:8443/wp/box-1?device=9");
  const before = Math.floor(Date.now() / 1000);
  const { calls } = await withFetchStub(ok201, () =>
    sendPushNotification(ua.subscription, "hello", SEND_OPTS),
  );
  const after = Math.floor(Date.now() / 1000);

  const auth = calls[0].headers.get("authorization");
  assert.ok(auth, "Authorization header missing");
  const m = auth.match(/^vapid t=([A-Za-z0-9_.-]+), k=([A-Za-z0-9_-]+)$/);
  assert.ok(m, `Authorization header not in RFC 8292 form: ${auth}`);
  assert.equal(m[2], VAPID.publicKey, "k= must be the raw VAPID public key");

  const { header, claims, signingInput, signature } = parseJwt(m[1]);
  assert.deepEqual(header, { typ: "JWT", alg: "ES256" });
  assert.equal(claims.aud, "https://203.0.113.5:8443");
  assert.equal(claims.sub, "mailto:admin@example.com");
  assert.ok(typeof claims.exp === "number");
  assert.ok(claims.exp >= before + 12 * 3600 && claims.exp <= after + 12 * 3600, "exp must be now + 12h");

  // Raw (IEEE P1363) r||s signature, verifiable with the advertised public key.
  assert.equal(signature.length, 64, "ES256 signature must be raw 64-byte r||s, not DER");
  const keyObj = vapidPublicKeyObject(VAPID.publicKey);
  assert.equal(
    createVerify("sha256").update(signingInput).verify({ key: keyObj, dsaEncoding: "ieee-p1363" }, signature),
    true,
    "JWT signature must verify against the VAPID public key",
  );

  // Tampering with the signature must break verification (sanity on the verifier).
  const forged = Uint8Array.from(signature);
  forged[10] ^= 0xff;
  assert.equal(
    createVerify("sha256").update(signingInput).verify({ key: keyObj, dsaEncoding: "ieee-p1363" }, forged),
    false,
  );
});

// ---------- Payload encryption (RFC 8188 / RFC 8291) ----------

test("payload encryption: UA-side RFC 8291 decrypt recovers the exact payload", async () => {
  const ua = makeUa();
  const payload = JSON.stringify({ title: "Nu på Plex 🎬", body: "Amélie är tillgänglig" });
  const { calls } = await withFetchStub(ok201, () =>
    sendPushNotification(ua.subscription, payload, SEND_OPTS),
  );

  const body = calls[0].body;
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  // header(16+4+1+65) + ciphertext(payload + 0x02 delimiter) + GCM tag(16)
  assert.equal(body.length, 86 + payloadBytes + 1 + 16);

  const { salt, rs, idlen, asPublic, padded } = decryptAsUa(ua, body);
  assert.equal(salt.length, 16);
  assert.equal(rs, 4096, "record size must be the standard 4096");
  assert.equal(idlen, 65, "keyid must be the 65-byte AS ephemeral public point");
  assert.equal(asPublic[0], 0x04);
  assert.notEqual(asPublic.toString("hex"), ua.publicRaw.toString("hex"), "keyid is the AS key, not the UA key");

  // RFC 8188 single-record padding: plaintext || 0x02 (last-record delimiter).
  assert.equal(padded[padded.length - 1], 0x02);
  assert.equal(padded.subarray(0, padded.length - 1).toString("utf8"), payload);
});

test("payload encryption: fresh salt and ephemeral key per send", async () => {
  const ua = makeUa();
  const { calls } = await withFetchStub(ok201, async () => {
    await sendPushNotification(ua.subscription, "same payload", SEND_OPTS);
    await sendPushNotification(ua.subscription, "same payload", SEND_OPTS);
  });
  assert.equal(calls.length, 2);
  const [first, second] = calls;
  const saltA = first.body.subarray(0, 16).toString("hex");
  const saltB = second.body.subarray(0, 16).toString("hex");
  const keyidA = first.body.subarray(21, 86).toString("hex");
  const keyidB = second.body.subarray(21, 86).toString("hex");
  assert.notEqual(saltA, saltB, "salt must be fresh per message");
  assert.notEqual(keyidA, keyidB, "AS ephemeral keypair must be fresh per message");
  assert.notEqual(first.body.toString("hex"), second.body.toString("hex"));
  // Both still decrypt to the same plaintext.
  assert.equal(decryptAsUa(ua, first.body).padded.subarray(0, -1).toString("utf8"), "same payload");
  assert.equal(decryptAsUa(ua, second.body).padded.subarray(0, -1).toString("utf8"), "same payload");
});

// ---------- Failure paths ----------

test("sendPushNotification: push-service failure surfaces as WebPushError with status + body", async () => {
  const ua = makeUa();
  await withFetchStub(
    () => new Response("subscription expired", { status: 410 }),
    () =>
      assert.rejects(
        sendPushNotification(ua.subscription, "hello", SEND_OPTS),
        (err: unknown) =>
          err instanceof WebPushError &&
          err.statusCode === 410 &&
          err.body === "subscription expired" &&
          /410/.test(err.message),
      ),
  );
});

test("sendPushNotification: malformed subscription keys are rejected before any network call", async () => {
  const ua = makeUa();
  const { calls } = await withFetchStub(noFetchExpected, async () => {
    // p256dh too short (64 bytes)
    await assert.rejects(
      sendPushNotification(
        { endpoint: ENDPOINT, keys: { p256dh: randomBytes(64).toString("base64url"), auth: ua.authSecret.toString("base64url") } },
        "x",
        SEND_OPTS,
      ),
      /Invalid subscription p256dh/,
    );
    // right length, but compressed-point marker instead of 0x04
    const compressed = Buffer.concat([Buffer.from([0x02]), ua.publicRaw.subarray(1)]);
    await assert.rejects(
      sendPushNotification(
        { endpoint: ENDPOINT, keys: { p256dh: compressed.toString("base64url"), auth: ua.authSecret.toString("base64url") } },
        "x",
        SEND_OPTS,
      ),
      /Invalid subscription p256dh/,
    );
    // auth secret must be exactly 16 bytes
    await assert.rejects(
      sendPushNotification(
        { endpoint: ENDPOINT, keys: { p256dh: ua.publicRaw.toString("base64url"), auth: randomBytes(15).toString("base64url") } },
        "x",
        SEND_OPTS,
      ),
      /expected 16 bytes, got 15/,
    );
    // unparseable endpoint URL
    await assert.rejects(
      sendPushNotification({ ...ua.subscription, endpoint: "not-a-url" }, "x", SEND_OPTS),
      TypeError,
    );
  });
  assert.equal(calls.length, 0, "no request may leave the process for invalid subscriptions");
});

test("sendPushNotification: private/loopback endpoints are blocked by the SSRF policy (no fetch)", async () => {
  // Web push endpoints are user-controlled — a subscription pointing into the
  // LAN must die in safeFetch's policy, never reach fetch().
  const blocked = ["https://127.0.0.1/push", "https://192.168.1.10/push", "http://169.254.169.254/latest"];
  const { calls } = await withFetchStub(noFetchExpected, async () => {
    for (const endpoint of blocked) {
      const ua = makeUa(endpoint);
      await assert.rejects(
        sendPushNotification(ua.subscription, "x", SEND_OPTS),
        (err: unknown) => err instanceof SafeFetchError && err.reason === "ssrf-blocked",
        `expected ssrf-blocked for ${endpoint}`,
      );
    }
  });
  assert.equal(calls.length, 0);
});
