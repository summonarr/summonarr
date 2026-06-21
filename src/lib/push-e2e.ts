import { createECDH, hkdfSync, createCipheriv, randomBytes } from "node:crypto";

// End-to-end encryption for iOS push payloads. The self-hosted server encrypts
// the REAL notification text to a device's static P-256 public key; the central
// relay forwards only the ciphertext; the iOS Notification Service Extension
// decrypts it on-device. The relay never sees titles/usernames.
//
// Scheme: ECIES over P-256.
//   ephemeral ECDH(eph_priv, device_pub) -> 32-byte shared (X coord)
//   HKDF-SHA256(ikm=shared, salt="", info="summonarr-push-e2e-v1", L=32) -> AES key
//   AES-256-GCM(key, nonce=12 random) -> ciphertext + 16-byte tag
//   wire = base64( ephPub_x963(65) || nonce(12) || ciphertext || tag(16) )
//
// MUST stay byte-compatible with the iOS CryptoKit decrypt in
// Summonarr-iOS/Summonarr/Shared/PushCrypto.swift — keep the curve, point
// encoding, HKDF salt/info, nonce/tag sizes, and field order in sync.

const CURVE = "prime256v1";
const HKDF_INFO = Buffer.from("summonarr-push-e2e-v1", "utf8");
const HKDF_SALT = Buffer.alloc(0);
const KEY_LEN = 32;
const NONCE_LEN = 12;
const X963_LEN = 65; // 0x04 || X(32) || Y(32)

/**
 * Encrypts `plaintext` to a device's static P-256 public key (X9.63 uncompressed,
 * base64). Returns the base64 wire blob described above. Throws on a malformed key.
 */
export function encryptForDevice(publicKeyB64: string, plaintext: string): string {
  const devicePub = Buffer.from(publicKeyB64, "base64");
  if (devicePub.length !== X963_LEN || devicePub[0] !== 0x04) {
    throw new Error("invalid device public key (expected 65-byte X9.63 uncompressed P-256 point)");
  }

  const ecdh = createECDH(CURVE);
  const ephemeralPub = ecdh.generateKeys(); // Buffer, uncompressed (65 bytes)
  const shared = ecdh.computeSecret(devicePub); // 32-byte X coordinate
  const key = Buffer.from(hkdfSync("sha256", shared, HKDF_SALT, HKDF_INFO, KEY_LEN));

  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([ephemeralPub, nonce, ciphertext, tag]).toString("base64");
}
