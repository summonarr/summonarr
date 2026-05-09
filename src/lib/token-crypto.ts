import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// Version prefix lets us detect whether a stored value is encrypted or plaintext (legacy passthrough)
const ENC_PREFIX = "enc:v1:";

export class TokenCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoConfigError";
  }
}

// Lazy validator: resolves and caches the key on first use. We intentionally do NOT throw
// at module load because Next.js evaluates server modules during `next build` (page-data
// collection) where the env var legitimately isn't set. Throwing then would break builds.
// Runtime fail-closed is preserved two ways:
//   (1) src/instrumentation.ts calls assertTokenEncryptionKey() at server boot.
//   (2) any encryptToken/decryptToken call without a valid key still throws here.
let cachedKey: Buffer | null = null;

function resolveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new TokenCryptoConfigError(
      "[token-crypto] TOKEN_ENCRYPTION_KEY is required and must be a 64-character hex string (32 bytes). " +
        "Generate one with: openssl rand -hex 32"
    );
  }
  cachedKey = Buffer.from(hex, "hex");
  return cachedKey;
}

// Explicit validation entry point for the boot guard. Throws TokenCryptoConfigError
// if the env var is missing or malformed. Safe to call repeatedly (cached).
export function assertTokenEncryptionKey(): void {
  resolveKey();
}

// Per-label warning bookkeeping for legacy plaintext values still on disk.
// We dedupe by label (e.g. `Setting.jellyfinApiKey`, `Account.access_token (id=…)`)
// so an operator can see exactly which rows still need re-saving without the same
// row spamming the log on every read.
const legacyPlaintextWarned = new Set<string>();
function warnLegacyPlaintextOnce(label: string): void {
  if (legacyPlaintextWarned.has(label)) return;
  legacyPlaintextWarned.add(label);
  console.warn(
    `[token-crypto] Legacy plaintext value observed for ${label} — re-save this row to encrypt at rest.`
  );
}

export function encryptToken(plaintext: string): string {
  // Empty/null is a legitimate "no value" passthrough — don't synthesize ciphertext for nothing.
  if (plaintext === null || plaintext === undefined || plaintext === "") return plaintext;
  // The IV here is 16 bytes rather than the canonical 12 for GCM. It's still functional
  // (Node accepts any IV length for GCM) and there are existing rows on disk encoded this way.
  // Don't change it without a migration story for those rows.
  const key = resolveKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + iv.toString("hex") + ":" + tag.toString("hex") + ":" + ciphertext.toString("hex");
}

export function decryptToken(value: string, label: string = "unknown row"): string {
  // Legacy plaintext passthrough: rows written before encryption was rolled out, and rows for
  // keys not in the SENSITIVE_KEYS list, are stored verbatim. Surface a labelled warning so an
  // operator can identify which row still needs re-saving.
  if (!value.startsWith(ENC_PREFIX)) {
    warnLegacyPlaintextOnce(label);
    return value;
  }
  const parts = value.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("[token-crypto] Decrypt failed: malformed ciphertext (expected 3 colon-separated parts)");
  }
  let iv: Buffer;
  let tag: Buffer;
  let ct: Buffer;
  try {
    iv  = Buffer.from(parts[0], "hex");
    tag = Buffer.from(parts[1], "hex");
    ct  = Buffer.from(parts[2], "hex");
  } catch {
    throw new Error("[token-crypto] Decrypt failed: malformed ciphertext (hex decode failed)");
  }
  if (iv.length !== 16 || tag.length !== 16) {
    throw new Error("[token-crypto] Decrypt failed: malformed ciphertext (IV or auth tag has wrong length)");
  }
  try {
    const key = resolveKey();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct).toString("utf8") + decipher.final("utf8");
  } catch (err) {
    // Re-throw config errors with their original message so callers can distinguish
    // "key missing" from "auth-tag mismatch" if they care.
    if (err instanceof TokenCryptoConfigError) throw err;
    throw new Error("[token-crypto] Decrypt failed: auth-tag mismatch — wrong key or tampered ciphertext");
  }
}
