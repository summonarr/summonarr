import {
  randomBytes,
  pbkdf2Sync,
  createCipheriv,
  createDecipheriv,
  type DecipherGCM,
} from "node:crypto";

const MAGIC = Buffer.from("RBKBKP01", "ascii");
const VERSION = 1;
const HEADER_LEN = 40;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
// NIST SP 800-132 recommends ≥210k for SHA-256; 600k provides a comfortable margin against brute-force
const KDF_ITERATIONS = 600_000;
const KEY_LEN = 32;

export const ENCRYPTED_HEADER_LEN = HEADER_LEN;
export const ENCRYPTED_MAGIC = MAGIC;

export class BackupCryptoError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
    this.name = "BackupCryptoError";
  }
}

function deriveKey(password: string, salt: Buffer): Buffer {
  if (typeof password !== "string" || password.length === 0) {
    throw new BackupCryptoError("Password is required for encrypted backups");
  }
  // NFKC normalisation ensures identical passphrases with different Unicode forms produce the same key
  return pbkdf2Sync(password.normalize("NFKC"), salt, KDF_ITERATIONS, KEY_LEN, "sha256");
}

function buildHeader(salt: Buffer, iv: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16BE(0, 10);
  salt.copy(header, 12);
  iv.copy(header, 28);
  return header;
}

export function hasEncryptedMagic(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return false;
  }
  return true;
}

export function wrapEncryptStream(
  source: ReadableStream<Uint8Array>,
  password: string,
): ReadableStream<Uint8Array> {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const header = buildHeader(salt, iv);

  const reader = source.getReader();
  let headerSent = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!headerSent) {
          controller.enqueue(new Uint8Array(header));
          headerSent = true;
          return;
        }
        const { value, done } = await reader.read();
        if (done) {
          const finalCt = cipher.final();
          if (finalCt.length > 0) controller.enqueue(new Uint8Array(finalCt));
          const tag = cipher.getAuthTag();
          controller.enqueue(new Uint8Array(tag));
          controller.close();
          return;
        }
        if (value && value.byteLength > 0) {
          const ct = cipher.update(value);
          if (ct.length > 0) controller.enqueue(new Uint8Array(ct));
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

export function wrapDecryptStream(
  source: ReadableStream<Uint8Array>,
  password: string,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();

  let headerBuf = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;

  // GCM auth tag (16 bytes) is appended at the very end; buffer the tail to avoid treating it as ciphertext
  let tail = Buffer.alloc(0);
  let done = false;

  async function ensureHeader(): Promise<void> {
    while (headerBuf.length < HEADER_LEN) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) {
        throw new BackupCryptoError("Backup file is truncated (incomplete header)");
      }
      headerBuf = Buffer.concat([headerBuf, Buffer.from(value)]);
    }

    const magic = headerBuf.subarray(0, 8);
    if (!magic.equals(MAGIC)) {
      throw new BackupCryptoError("Not a valid encrypted backup file (bad magic bytes)");
    }
    const version = headerBuf.readUInt8(8);
    if (version !== VERSION) {
      throw new BackupCryptoError(`Unsupported encrypted backup version: ${version}`);
    }
    const salt = headerBuf.subarray(12, 28);
    const iv = headerBuf.subarray(28, 40);
    const key = deriveKey(password, Buffer.from(salt));
    decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv)) as DecipherGCM;

    const leftover = headerBuf.subarray(HEADER_LEN);
    headerBuf = Buffer.alloc(0);
    if (leftover.length > 0) {
      tail = Buffer.from(leftover);
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (done) {
          controller.close();
          return;
        }
        if (!decipher) await ensureHeader();

        const { value, done: readerDone } = await reader.read();
        if (readerDone) {
          done = true;
          if (tail.length < TAG_LEN) {
            throw new BackupCryptoError("Backup file is truncated (missing auth tag)");
          }
          const tag = tail.subarray(tail.length - TAG_LEN);
          const remaining = tail.subarray(0, tail.length - TAG_LEN);
          if (remaining.length > 0) {
            const pt = decipher!.update(remaining);
            if (pt.length > 0) controller.enqueue(new Uint8Array(pt));
          }
          decipher!.setAuthTag(tag);
          try {
            const finalPt = decipher!.final();
            if (finalPt.length > 0) controller.enqueue(new Uint8Array(finalPt));
          } catch {
            throw new BackupCryptoError("Invalid password or corrupted backup");
          }
          controller.close();
          return;
        }

        const incoming = Buffer.from(value);
        const combined = tail.length > 0 ? Buffer.concat([tail, incoming]) : incoming;
        if (combined.length <= TAG_LEN) {
          tail = combined;
          return;
        }
        const releasable = combined.subarray(0, combined.length - TAG_LEN);
        tail = Buffer.from(combined.subarray(combined.length - TAG_LEN));
        const pt = decipher!.update(releasable);
        if (pt.length > 0) controller.enqueue(new Uint8Array(pt));
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

