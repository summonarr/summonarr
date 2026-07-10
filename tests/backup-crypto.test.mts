// Unit tests for encrypted-backup streaming (src/lib/backup-crypto.ts).
// A restore feeds arbitrary uploads through wrapDecryptStream, so the failure
// modes (wrong password, truncation, bad magic) must throw BackupCryptoError
// *before* any TRUNCATE-adjacent code trusts the payload — and the NFKC
// password fold must make composed/decomposed passphrases interchangeable.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wrapEncryptStream,
  wrapDecryptStream,
  hasEncryptedMagic,
  BackupCryptoError,
} from "../src/lib/backup-crypto.ts";

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const parts: Buffer[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

function chunked(buf: Buffer, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < buf.length; i += size) out.push(new Uint8Array(buf.subarray(i, i + size)));
  return out;
}

const PASSWORD = "backup-passphrase-test";
const PLAINTEXT = Buffer.from(
  JSON.stringify({ tables: ["User", "Setting"], rows: "x".repeat(200) }),
  "utf8",
);
// Encrypt once at load; the KDF runs 600k PBKDF2 iterations, so tests share this blob.
const ENCRYPTED = await collect(wrapEncryptStream(streamFrom([new Uint8Array(PLAINTEXT)]), PASSWORD));

test("encrypt → decrypt roundtrip, decrypting across awkward chunk boundaries", async () => {
  // 7-byte chunks force the header/tag reassembly buffers to do real work.
  // Regression: chunks smaller than the 16-byte tag reserve used to stall the
  // decrypt stream forever (pull fulfilled without enqueuing is never re-invoked).
  const decrypted = await collect(wrapDecryptStream(streamFrom(chunked(ENCRYPTED, 7)), PASSWORD));
  assert.deepEqual(decrypted, PLAINTEXT);
});

test("zero-length source chunks do not stall the encrypt stream (same pull rule)", async () => {
  const chunks = [new Uint8Array(0), new Uint8Array(PLAINTEXT), new Uint8Array(0)];
  const enc = await collect(wrapEncryptStream(streamFrom(chunks), PASSWORD));
  const dec = await collect(wrapDecryptStream(streamFrom([new Uint8Array(enc)]), PASSWORD));
  assert.deepEqual(dec, PLAINTEXT);
});

test("output carries the magic header and is larger than plaintext (header + tag)", () => {
  assert.equal(hasEncryptedMagic(new Uint8Array(ENCRYPTED)), true);
  assert.equal(ENCRYPTED.length, 40 + PLAINTEXT.length + 16); // header + ciphertext + tag
  // Ciphertext must not contain the plaintext.
  assert.equal(ENCRYPTED.includes(PLAINTEXT.subarray(0, 24)), false);
});

test("hasEncryptedMagic is false for plaintext and short buffers", () => {
  assert.equal(hasEncryptedMagic(new Uint8Array(PLAINTEXT)), false);
  assert.equal(hasEncryptedMagic(new Uint8Array([0x52, 0x42])), false); // shorter than magic
  assert.equal(hasEncryptedMagic(new Uint8Array(0)), false);
});

test("wrong password → BackupCryptoError, no partial plaintext accepted", async () => {
  await assert.rejects(
    collect(wrapDecryptStream(streamFrom([new Uint8Array(ENCRYPTED)]), "wrong-password")),
    (err: unknown) => err instanceof BackupCryptoError && /Invalid password or corrupted/.test(err.message),
  );
});

test("truncated file → BackupCryptoError (missing auth tag)", async () => {
  const truncated = new Uint8Array(ENCRYPTED.subarray(0, 45)); // header + a few bytes, tag gone
  await assert.rejects(
    collect(wrapDecryptStream(streamFrom([truncated]), PASSWORD)),
    (err: unknown) => err instanceof BackupCryptoError,
  );
  const headerOnlyPartial = new Uint8Array(ENCRYPTED.subarray(0, 20)); // incomplete header
  await assert.rejects(
    collect(wrapDecryptStream(streamFrom([headerOnlyPartial]), PASSWORD)),
    (err: unknown) => err instanceof BackupCryptoError && /incomplete header/.test(err.message),
  );
});

test("bad magic bytes → BackupCryptoError before any decryption", async () => {
  const corrupted = Buffer.from(ENCRYPTED);
  corrupted[0] ^= 0xff;
  await assert.rejects(
    collect(wrapDecryptStream(streamFrom([new Uint8Array(corrupted)]), PASSWORD)),
    (err: unknown) => err instanceof BackupCryptoError && /bad magic/.test(err.message),
  );
});

test("empty password is refused at encrypt time", async () => {
  await assert.rejects(
    collect(wrapEncryptStream(streamFrom([new Uint8Array(PLAINTEXT)]), "")),
    (err: unknown) => err instanceof BackupCryptoError && /Password is required/.test(err.message),
  );
});

test("NFKC: composed and decomposed passphrases derive the same key", async () => {
  const composed = "café-secret"; // é as one codepoint
  const decomposed = "café-secret"; // e + combining acute
  const enc = await collect(wrapEncryptStream(streamFrom([new Uint8Array(PLAINTEXT)]), composed));
  const dec = await collect(wrapDecryptStream(streamFrom([new Uint8Array(enc)]), decomposed));
  assert.deepEqual(dec, PLAINTEXT);
});

test("unsupported version byte → BackupCryptoError before the KDF runs", async () => {
  // Byte 8 is the format version; a future-format file must be rejected with a
  // clear message rather than fed to the wrong-password path.
  const futureVersion = Buffer.from(ENCRYPTED);
  futureVersion[8] = 2;
  await assert.rejects(
    collect(wrapDecryptStream(streamFrom([new Uint8Array(futureVersion)]), PASSWORD)),
    (err: unknown) =>
      err instanceof BackupCryptoError && /Unsupported encrypted backup version: 2/.test(err.message),
  );
});

test("tamper detection: flipped ciphertext byte fails even with the CORRECT password", async () => {
  // Distinct from the wrong-password test: GCM must reject a modified payload
  // when the key is right, or a restore would trust attacker-altered bytes.
  const tampered = Buffer.from(ENCRYPTED);
  tampered[40] ^= 0x01; // first ciphertext byte (header is 0..39)
  await assert.rejects(
    collect(wrapDecryptStream(streamFrom([new Uint8Array(tampered)]), PASSWORD)),
    (err: unknown) =>
      err instanceof BackupCryptoError && /Invalid password or corrupted/.test(err.message),
  );
});

test("tamper detection: flipped auth-tag byte fails with the correct password", async () => {
  const tampered = Buffer.from(ENCRYPTED);
  tampered[tampered.length - 1] ^= 0x01; // inside the trailing 16-byte GCM tag
  await assert.rejects(
    collect(wrapDecryptStream(streamFrom([new Uint8Array(tampered)]), PASSWORD)),
    (err: unknown) =>
      err instanceof BackupCryptoError && /Invalid password or corrupted/.test(err.message),
  );
});

test("empty plaintext roundtrips: exactly header+tag (56 bytes) and decrypts to 0 bytes", async () => {
  // Exercises encrypt's done-on-first-read path and decrypt's tail==TAG_LEN
  // edge where `remaining` is empty but the tag must still verify.
  const enc = await collect(wrapEncryptStream(streamFrom([]), PASSWORD));
  assert.equal(enc.length, 40 + 16);
  assert.equal(hasEncryptedMagic(new Uint8Array(enc)), true);
  const dec = await collect(wrapDecryptStream(streamFrom([new Uint8Array(enc)]), PASSWORD));
  assert.equal(dec.length, 0);
});

test("empty password is refused at decrypt time too", async () => {
  // deriveKey runs inside ensureHeader on the decrypt side as well; the refusal
  // must fire before any PBKDF2/decryption work.
  await assert.rejects(
    collect(wrapDecryptStream(streamFrom([new Uint8Array(ENCRYPTED)]), "")),
    (err: unknown) =>
      err instanceof BackupCryptoError && /Password is required/.test(err.message),
  );
});

test("salt and IV are fresh per encryption (same plaintext+password → different headers)", async () => {
  // A regression to a fixed IV is catastrophic for GCM (keystream reuse leaks
  // plaintext XOR). Header bytes 12..28 are the salt, 28..40 the IV.
  const second = await collect(
    wrapEncryptStream(streamFrom([new Uint8Array(PLAINTEXT)]), PASSWORD),
  );
  assert.notDeepEqual(second.subarray(12, 40), ENCRYPTED.subarray(12, 40));
  // Different salt+IV must also yield a different ciphertext body.
  assert.notDeepEqual(second.subarray(40), ENCRYPTED.subarray(40));
});

test("truncation at exactly HEADER_LEN (40 bytes) → missing auth tag", async () => {
  // Complete header, zero ciphertext/tag: the boundary between the tested
  // 20-byte (incomplete header) and 45-byte (partial body) truncations, and the
  // empty-leftover branch of ensureHeader.
  const headerOnly = new Uint8Array(ENCRYPTED.subarray(0, 40));
  await assert.rejects(
    collect(wrapDecryptStream(streamFrom([headerOnly]), PASSWORD)),
    (err: unknown) =>
      err instanceof BackupCryptoError && /missing auth tag/.test(err.message),
  );
});
