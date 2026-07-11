// Unit tests for the E2E push payload encryption (src/lib/push-e2e.ts). The
// wire format MUST stay byte-compatible with the iOS CryptoKit decryptor
// (PushCrypto.swift): ECIES over P-256, HKDF-SHA256 (empty salt, fixed info),
// AES-256-GCM, blob = ephPub(65) || nonce(12) || ct || tag(16). The test
// decrypts with an independent implementation of that exact recipe, so any
// drift in curve/encoding/KDF parameters fails here before it bricks devices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, createDecipheriv, hkdfSync } from "node:crypto";
import { encryptForDevice } from "../src/lib/push-e2e.ts";

function makeDevice() {
  const ecdh = createECDH("prime256v1");
  const pub = ecdh.generateKeys(); // 65-byte X9.63 uncompressed
  return { ecdh, pubB64: Buffer.from(pub).toString("base64") };
}

// Independent decryptor mirroring PushCrypto.swift's recipe.
function decryptAsDevice(device: ReturnType<typeof makeDevice>, wireB64: string): string {
  const blob = Buffer.from(wireB64, "base64");
  const ephPub = blob.subarray(0, 65);
  const nonce = blob.subarray(65, 77);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(77, blob.length - 16);

  const shared = device.ecdh.computeSecret(ephPub);
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("summonarr-push-e2e-v1", "utf8"), 32));
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

test("device holding the private key can decrypt the wire blob", () => {
  const device = makeDevice();
  const wire = encryptForDevice(device.pubB64, "New request: Dune (2021) — from alice");
  assert.equal(decryptAsDevice(device, wire), "New request: Dune (2021) — from alice");
});

test("wire layout: 65-byte X9.63 ephemeral key + 12-byte nonce + ct + 16-byte tag", () => {
  const device = makeDevice();
  const msg = "hello";
  const blob = Buffer.from(encryptForDevice(device.pubB64, msg), "base64");
  assert.equal(blob.length, 65 + 12 + Buffer.byteLength(msg, "utf8") + 16);
  assert.equal(blob[0], 0x04); // uncompressed-point marker
});

test("fresh ephemeral key + nonce per message (identical plaintexts differ)", () => {
  const device = makeDevice();
  assert.notEqual(encryptForDevice(device.pubB64, "same"), encryptForDevice(device.pubB64, "same"));
});

test("a different device's key cannot decrypt (GCM tag fails)", () => {
  const alice = makeDevice();
  const mallory = makeDevice();
  const wire = encryptForDevice(alice.pubB64, "for alice only");
  assert.throws(() => decryptAsDevice(mallory, wire));
});

test("malformed device keys are rejected up front", () => {
  assert.throws(() => encryptForDevice("", "msg"), /invalid device public key/);
  assert.throws(() => encryptForDevice(Buffer.alloc(64).toString("base64"), "msg"), /invalid device public key/); // wrong length
  const wrongMarker = Buffer.alloc(65, 0x04);
  wrongMarker[0] = 0x02; // compressed-point marker — CryptoKit-incompatible here
  assert.throws(() => encryptForDevice(wrongMarker.toString("base64"), "msg"), /invalid device public key/);
  assert.throws(() => encryptForDevice("not-base64!!!", "msg"), /invalid device public key/);
});

test("non-ASCII payloads roundtrip byte-exact", () => {
  const device = makeDevice();
  const msg = "Ny förfrågan: Amélie 🎬 — från Åsa";
  assert.equal(decryptAsDevice(device, encryptForDevice(device.pubB64, msg)), msg);
});

// Device keys arrive from client-controlled /api/push registration. A key that
// passes the up-front shape check (65 bytes, 0x04 marker) but whose X/Y is not
// a point on P-256 MUST throw from ECDH — never silently emit a blob no device
// could ever decrypt. Node validates the point in computeSecret and raises
// ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY, a different error path than the shape check.
test("well-shaped but off-curve key throws from ECDH, not the shape check", () => {
  // X/Y coordinates above the field prime — cannot be on the curve.
  const outOfRange = Buffer.alloc(65, 0xff);
  outOfRange[0] = 0x04;
  assert.throws(
    () => encryptForDevice(outOfRange.toString("base64"), "msg"),
    { code: "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY" },
  );

  // In-range X/Y that simply doesn't satisfy the curve equation.
  const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(32, 0x01), Buffer.alloc(32, 0x02)]);
  assert.throws(
    () => encryptForDevice(offCurve.toString("base64"), "msg"),
    { code: "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY" },
  );
});

test("empty plaintext yields the minimal 93-byte blob and roundtrips", () => {
  const device = makeDevice();
  const wire = encryptForDevice(device.pubB64, "");
  const blob = Buffer.from(wire, "base64");
  assert.equal(blob.length, 65 + 12 + 0 + 16); // ephPub + nonce + empty ct + tag
  assert.equal(decryptAsDevice(device, wire), "");
});
