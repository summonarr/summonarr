import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// Version prefix lets us detect whether a stored value is encrypted or plaintext (key absent / pre-encryption)
const ENC_PREFIX = "enc:v1:";

function getKey(): Buffer | null {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, "hex");
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  // If TOKEN_ENCRYPTION_KEY is absent, return plaintext — allows deployment without encryption at cost of secrecy
  if (!key) return plaintext;
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + iv.toString("hex") + ":" + tag.toString("hex") + ":" + ciphertext.toString("hex");
}

export function decryptToken(value: string): string {
  if (!value.startsWith(ENC_PREFIX)) return value;
  const key = getKey();
  if (!key) return value;
  const parts = value.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) return value;
  try {
    const iv  = Buffer.from(parts[0], "hex");
    const tag = Buffer.from(parts[1], "hex");
    const ct  = Buffer.from(parts[2], "hex");
    if (iv.length !== 16 || tag.length !== 16) return value;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct).toString("utf8") + decipher.final("utf8");
  } catch {
    return value;
  }
}
