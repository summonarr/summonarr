// Unit tests for the encrypted-backup import pipeline (src/lib/backup-import.ts)
// — processBackupImport, the shared engine behind the admin restore and the
// first-run setup restore. Sibling ownership: tests/backup-crypto.test.mts owns
// the stream-crypto primitives (magic/version/truncation/tamper/KDF) and
// tests/backup-schema.test.mts owns the BACKUP_TABLES/BACKUP_ENUMS↔schema pins.
// This file pins the pipeline layered on top:
//   - the pre-auth setup-mode gates (TRUST_PROXY opt-in env gate; the
//     under-lock freshness re-check that runs BEFORE the TRUNCATE);
//   - crypto failures (wrong/empty password, truncation, not-encrypted) map to
//     clean status/error results with the database never touched;
//   - the ciphertext size-cap boundary (one-over → 413 via the replay counter;
//     exactly-at-cap passes the gate) and the exported cap constants;
//   - the SQL statement allowlist: non-SQL payloads, DROP, INSERTs into
//     non-backup tables, sub-SELECT VALUES, and multi-tuple smuggles are all
//     blocked (ok:false with HTTP-200 semantics so the UI can render the list),
//     the 20-error abort cap, and that a blocked dump executes NOTHING;
//   - schema-fingerprint refusal (409 before TRUNCATE) vs the no-fingerprint
//     and TEK-fingerprint-mismatch warnings;
//   - the empty-restore refusal (zero validated statements must never TRUNCATE);
//   - the happy path's exact transaction op ORDER (advisory lock 43 → TRUNCATE
//     of every BACKUP_TABLES entry in list order → statements in dump order,
//     with ON CONFLICT DO NOTHING appended only to INSERTs that lack it), the
//     tx timeout options, and the summary/conflict-skip accounting;
//   - mid-import failure → 500 "rolled back" with DB internals never echoed to
//     the client (tx rejection = rollback; the in-memory fake records that the
//     transaction callback threw through, which is what makes real Prisma
//     discard every prior write).
//
// Fixtures are REAL encrypted backups built with backup-crypto's exported
// wrapEncryptStream (600k-iteration PBKDF2 per encrypt/decrypt — fixture
// encryption is parallelized at module load to keep the file fast). No DB and
// no network: prisma.ts caches its client on globalThis, so that slot is
// pre-seeded with a recording fake (the poster-cache.test.mts pattern) whose
// $transaction exposes $executeRawUnsafe + the two setup-freshness delegates.
//
// Deliberately NOT covered (disproportionate for a unit file): enforcement of
// the 500 MB PLAINTEXT cap — reaching it requires streaming 500 MB through
// PBKDF2/AES and the char-by-char SQL splitter (multi-second, ~1 GB); the
// constant's value is pinned instead, and the ciphertext-side cap (the same
// 413 surface) is exercised for real on the cheap pre-KDF paths.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
delete process.env.TRUST_PROXY;
delete process.env.SUMMONARR_ALLOW_SETUP_RESTORE;

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── recording fake prisma (pre-seeded BEFORE the module graph loads) ────────
const txOps: string[] = [];
const txCalls: Array<Record<string, unknown> | undefined> = [];
const freshnessReads: Array<{ kind: string; args?: unknown }> = [];
let txRejections = 0;
let affectedForInsert = 1;
let failOnSqlIncludes: string | null = null;
let setupCompletedRow: { key: string; value: string } | null = null;
let userCount = 0;

const fakeTx = {
  $executeRawUnsafe: async (sql: string): Promise<number> => {
    txOps.push(sql);
    if (failOnSqlIncludes && sql.includes(failOnSqlIncludes)) {
      throw new Error('duplicate key value violates unique constraint "User_pkey" (sentinel-db-detail)');
    }
    return sql.startsWith("INSERT") ? affectedForInsert : 0;
  },
  setting: {
    findUnique: async (args: unknown) => {
      freshnessReads.push({ kind: "setting.findUnique", args });
      return setupCompletedRow;
    },
  },
  user: {
    count: async () => {
      freshnessReads.push({ kind: "user.count" });
      return userCount;
    },
  },
};

const fakePrisma = {
  $transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>, opts?: Record<string, unknown>) => {
    txCalls.push(opts);
    try {
      return await fn(fakeTx);
    } catch (err) {
      // Real Prisma issues ROLLBACK here — every op recorded in txOps for this
      // call is discarded. Recording the rejection is the atomicity pin.
      txRejections++;
      throw err;
    }
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// Dynamic imports so the global pre-seed and env stubs genuinely precede the
// module-graph load (static imports would hoist above them).
const { processBackupImport, MAX_PLAINTEXT_BYTES, MAX_CIPHERTEXT_BYTES } =
  await import("../src/lib/backup-import.ts");
const { wrapEncryptStream, ENCRYPTED_MAGIC } = await import("../src/lib/backup-crypto.ts");
const { BACKUP_TABLES, computeSchemaFingerprint } = await import("../src/lib/backup-schema.ts");
const { tokenEncryptionKeyFingerprint } = await import("../src/lib/token-crypto.ts");

// ── stream helpers ──────────────────────────────────────────────────────────
function streamFrom(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel() {
      onCancel?.();
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

const PASSWORD = "restore-passphrase-test";

function encrypt(sql: string): Promise<Buffer> {
  return collect(wrapEncryptStream(streamFrom([new Uint8Array(Buffer.from(sql, "utf8"))]), PASSWORD));
}

type ImportResult = Awaited<ReturnType<typeof processBackupImport>>;
type ImportFailure = Extract<ImportResult, { ok: false }>;
type ImportSuccess = Extract<ImportResult, { ok: true }>;

function runImport(
  chunks: Uint8Array[],
  opts: { password?: string; mode?: "setup" | "admin"; onCancel?: () => void } = {},
): Promise<ImportResult> {
  return processBackupImport(streamFrom(chunks, opts.onCancel), opts.password ?? PASSWORD, opts.mode ?? "admin");
}

function expectFailure(r: ImportResult): ImportFailure {
  assert.equal(r.ok, false, `expected a failure result, got: ${JSON.stringify(r)}`);
  return r as ImportFailure;
}

function expectSuccess(r: ImportResult): ImportSuccess {
  assert.equal(r.ok, true, `expected a success result, got: ${JSON.stringify(r)}`);
  return r as ImportSuccess;
}

// ── fixtures (statement shapes mirror db-export/route.ts exactly) ───────────
const FP = computeSchemaFingerprint();
const TEK_FP = tokenEncryptionKeyFingerprint();
if (!TEK_FP) throw new Error("test key must yield a TEK fingerprint");
const WRONG_FP = "0123456789abcdef";
if (FP === WRONG_FP) throw new Error("astronomically unlucky schema fingerprint — pick another WRONG_FP");

const STMT = {
  enumCreate:
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Role') THEN CREATE TYPE "Role" AS ENUM ('USER', 'ISSUE_ADMIN', 'ADMIN'); END IF; END $$`,
  userInsert:
    `INSERT INTO "public"."User" ("id", "email", "role") VALUES ('u1', 'admin@example.com', 'ADMIN') ON CONFLICT DO NOTHING`,
  settingInsert:
    `INSERT INTO "public"."Setting" ("key", "value") VALUES ('siteUrl', 'https://summonarr.example.com')`,
  requestInsert:
    `INSERT INTO "public"."MediaRequest" ("id", "tmdbId", "approved", "note") VALUES ('r1', 27205, TRUE, NULL)`,
} as const;

// `-- Table:` comments directly precede INSERTs on purpose: the splitter once
// conflated a line comment with the following statement, silently dropping the
// first INSERT after every summary comment — the happy path pins the fix.
const HAPPY_SQL = [
  "-- Summonarr Database Backup",
  `-- Schema-Fingerprint: ${FP}`,
  `-- Token-Encryption-Key-Fingerprint: ${TEK_FP}`,
  "",
  `${STMT.enumCreate};`,
  "-- Table: User (1 rows)",
  "",
  `${STMT.userInsert};`,
  "-- Table: Setting (1 rows)",
  "",
  `${STMT.settingInsert};`,
  `${STMT.requestInsert};`,
  "",
].join("\n");

const PLAIN_SQL = `${STMT.userInsert};\n`; // valid dump text, but NOT encrypted

const [
  HAPPY_ENC,
  GARBAGE_ENC,
  BADSTMTS_ENC,
  CAP20_ENC,
  FP_MISMATCH_ENC,
  NO_FP_ENC,
  TEK_MISMATCH_ENC,
  COMMENTS_ONLY_ENC,
] = await Promise.all([
  encrypt(HAPPY_SQL),
  encrypt("this is definitely not a sql dump"), // no trailing `;` — exercises the flush path
  encrypt(
    [
      `DROP TABLE "User";`,
      `INSERT INTO "public"."NotATable" ("id") VALUES ('x');`,
      `INSERT INTO "public"."User" ("id") VALUES ((SELECT 'x'));`,
      `INSERT INTO "public"."User" ("id") VALUES ('a'), ('b');`,
      `${STMT.userInsert};`,
    ].join("\n"),
  ),
  encrypt(Array.from({ length: 21 }, (_, i) => `DROP TABLE "T${i}";`).join("\n")),
  encrypt(`-- Schema-Fingerprint: ${WRONG_FP}\n${STMT.userInsert};\n`),
  encrypt(`${STMT.userInsert};\n`),
  encrypt(
    `-- Schema-Fingerprint: ${FP}\n-- Token-Encryption-Key-Fingerprint: ffffffffffffffff\n${STMT.userInsert};\n`,
  ),
  encrypt(`-- Schema-Fingerprint: ${FP}\n-- Table: User (0 rows)\n;\n  ;\n`),
]);

beforeEach(() => {
  txOps.length = 0;
  txCalls.length = 0;
  freshnessReads.length = 0;
  txRejections = 0;
  affectedForInsert = 1;
  failOnSqlIncludes = null;
  setupCompletedRow = null;
  userCount = 0;
  warns.length = 0;
  errors.length = 0;
  delete process.env.TRUST_PROXY;
  delete process.env.SUMMONARR_ALLOW_SETUP_RESTORE;
});

// ── caps ────────────────────────────────────────────────────────────────────

test("size-cap constants: 500 MB plaintext, ciphertext cap = plaintext + 4096", () => {
  // Both are part of the route contract (413 bodies and admin docs key off
  // them); plaintext-cap ENFORCEMENT is intentionally not exercised — see the
  // header — so this pin is what catches an accidental cap change.
  assert.equal(MAX_PLAINTEXT_BYTES, 500 * 1024 * 1024);
  assert.equal(MAX_CIPHERTEXT_BYTES, MAX_PLAINTEXT_BYTES + 4096);
});

test("ciphertext cap boundary: one byte over → 413 before any KDF; exactly at cap passes the gate", async () => {
  // Transiently allocates ~0.5 GB (over) and ~1.6 GB (at-cap, copied once into
  // the decrypt header buffer) — both paths fail before PBKDF2/AES run, so the
  // cost is memcpy only. The first chunk is the bare 8-byte magic so the
  // mid-stream replay counter (not just the head check) is the gate exercised.
  const magicChunk = new Uint8Array(ENCRYPTED_MAGIC);

  const overBody = Buffer.alloc(MAX_CIPHERTEXT_BYTES - magicChunk.length + 1); // total = cap + 1
  const over = expectFailure(await runImport([magicChunk, overBody]));
  assert.equal(over.status, 413);
  assert.equal(over.error, `Encrypted body exceeds ${MAX_CIPHERTEXT_BYTES} bytes`);

  // Exactly at cap: the `>` comparison must NOT fire — the payload proceeds
  // into the decryptor and dies on its zeroed version byte instead. Were the
  // gate `>=`, this would 413.
  const atCapBody = Buffer.alloc(MAX_CIPHERTEXT_BYTES - magicChunk.length); // total = cap
  const atCap = expectFailure(await runImport([magicChunk, atCapBody]));
  assert.equal(atCap.status, 400);
  assert.match(atCap.error, /Unsupported encrypted backup version: 0/);
  assert.doesNotMatch(atCap.error, /exceeds/);

  assert.equal(txCalls.length, 0);
});

// ── crypto and format failures never touch the database ─────────────────────

test("a non-encrypted upload (and an empty one) is refused before any decryption", async () => {
  const plain = expectFailure(await runImport([new Uint8Array(Buffer.from(PLAIN_SQL, "utf8"))]));
  assert.equal(plain.status, 400);
  assert.equal(plain.error, "Backup file is not an encrypted Summonarr dump.");

  const empty = expectFailure(await runImport([]));
  assert.equal(empty.status, 400);
  assert.equal(empty.error, "Backup file is not an encrypted Summonarr dump.");

  assert.equal(txCalls.length, 0);
});

test("crypto failures map to clean 400s: wrong password, empty password, truncated ciphertext", async () => {
  const wrongPw = expectFailure(await runImport([new Uint8Array(HAPPY_ENC)], { password: "not-the-password" }));
  assert.equal(wrongPw.status, 400);
  assert.match(wrongPw.error, /Invalid password or corrupted backup/);

  const emptyPw = expectFailure(await runImport([new Uint8Array(HAPPY_ENC)], { password: "" }));
  assert.equal(emptyPw.status, 400);
  assert.match(emptyPw.error, /Password is required/);

  // Valid header, body chopped before the GCM tag.
  const truncated = expectFailure(await runImport([new Uint8Array(HAPPY_ENC.subarray(0, 45))]));
  assert.equal(truncated.status, 400);
  assert.match(truncated.error, /truncated|missing auth tag/);

  assert.equal(txCalls.length, 0);
});

// ── setup-mode gates ────────────────────────────────────────────────────────

test("setup mode on an internet-facing instance requires the explicit env opt-in", async () => {
  process.env.TRUST_PROXY = "true";
  let cancelled = false;
  const gated = expectFailure(
    await runImport([new Uint8Array(HAPPY_ENC)], { mode: "setup", onCancel: () => { cancelled = true; } }),
  );
  assert.equal(gated.status, 403);
  assert.match(gated.error, /SUMMONARR_ALLOW_SETUP_RESTORE=true/);
  assert.equal(cancelled, true, "the upload body must be cancelled, not left dangling");
  assert.equal(txCalls.length, 0);

  // With the opt-in set the gate opens — this call proceeds far enough to be
  // rejected for what it actually is (a non-encrypted body), not for its mode.
  process.env.SUMMONARR_ALLOW_SETUP_RESTORE = "true";
  const passed = expectFailure(
    await runImport([new Uint8Array(Buffer.from(PLAIN_SQL, "utf8"))], { mode: "setup" }),
  );
  assert.equal(passed.status, 400);
  assert.equal(passed.error, "Backup file is not an encrypted Summonarr dump.");
});

test("setup mode re-checks freshness UNDER the advisory lock and refuses before TRUNCATE", async () => {
  userCount = 1; // a user exists — setup already happened
  const res = expectFailure(await runImport([new Uint8Array(HAPPY_ENC)], { mode: "setup" }));
  assert.equal(res.status, 409);
  assert.match(res.error, /fresh server with no users/);
  // The lock was taken, the freshness reads ran, and NOTHING destructive did.
  assert.deepEqual(txOps, ["SELECT pg_advisory_xact_lock(43)"]);
  assert.deepEqual(
    freshnessReads.map((r) => r.kind),
    ["setting.findUnique", "user.count"],
  );
  assert.deepEqual(freshnessReads[0].args, { where: { key: "setup_completed_at" } });
});

test("setup mode on a genuinely fresh server proceeds to the full restore", async () => {
  const res = expectSuccess(await runImport([new Uint8Array(HAPPY_ENC)], { mode: "setup" }));
  assert.equal(res.summary.executed, 4);
  assert.ok(txOps[1].startsWith("TRUNCATE TABLE "), "restore ran after the freshness check passed");
  assert.deepEqual(
    freshnessReads.map((r) => r.kind),
    ["setting.findUnique", "user.count"],
  );
});

// ── statement validation ────────────────────────────────────────────────────

test("garbage text inside a validly-encrypted stream fails validation (ok:false with HTTP-200 semantics)", async () => {
  const res = expectFailure(await runImport([new Uint8Array(GARBAGE_ENC)]));
  // Deliberate contract: validation failures report status 200 with ok:false +
  // an errors list so the admin UI renders them; only transport-level problems
  // use error statuses.
  assert.equal(res.status, 200);
  assert.equal(res.error, "Backup failed validation");
  assert.equal(res.errors?.length, 1);
  assert.match(res.errors?.[0] ?? "", /^Blocked disallowed statement: this is definitely not a sql dump/);
  assert.equal(res.summary?.executed, 0);
  assert.equal(txCalls.length, 0);
});

test("injection defenses: DROP, non-backup table, sub-SELECT VALUES, and multi-tuple smuggles are all blocked", async () => {
  const res = expectFailure(await runImport([new Uint8Array(BADSTMTS_ENC)]));
  assert.equal(res.status, 200);
  assert.equal(res.error, "Backup failed validation");
  const reasons = res.errors ?? [];
  assert.equal(reasons.length, 4);
  assert.match(reasons[0], /^Blocked disallowed statement: DROP TABLE "User"/);
  assert.match(reasons[1], /^Blocked disallowed statement: INSERT INTO "public"\."NotATable"/);
  assert.match(reasons[2], /^Blocked INSERT with non-literal VALUES: INSERT INTO "public"\."User" \("id"\) VALUES \(\(SELECT/);
  assert.match(reasons[3], /^Blocked INSERT with non-literal VALUES: INSERT INTO "public"\."User" \("id"\) VALUES \('a'\), \('b'\)/);
  // The one legitimate statement in the same dump must not execute anyway —
  // a partially-hostile dump is rejected wholesale.
  assert.equal(res.summary?.total, 5);
  assert.equal(res.summary?.executed, 0);
  assert.equal(txCalls.length, 0);
});

test("validation aborts at the 20-error cap and still drains the stream (tag verified, no crypto error)", async () => {
  const res = expectFailure(await runImport([new Uint8Array(CAP20_ENC)])); // 21 bad statements
  assert.equal(res.status, 200);
  assert.equal(res.error, "Backup failed validation");
  assert.equal(res.errors?.length, 20); // capped — the 21st statement is never even counted
  assert.equal(res.summary?.total, 20);
  assert.equal(txCalls.length, 0);
});

// ── fingerprints ────────────────────────────────────────────────────────────

test("schema-fingerprint mismatch refuses with 409 before the database is touched", async () => {
  const res = expectFailure(await runImport([new Uint8Array(FP_MISMATCH_ENC)]));
  assert.equal(res.status, 409);
  assert.ok(res.error.includes(WRONG_FP), "names the backup's fingerprint");
  assert.ok(res.error.includes(FP), "names this server's fingerprint");
  assert.match(res.error, /database has not been touched/);
  assert.equal(txCalls.length, 0);
});

test("a backup without a schema fingerprint restores but carries the older-version warning", async () => {
  const res = expectSuccess(await runImport([new Uint8Array(NO_FP_ENC)]));
  assert.match(res.warning ?? "", /no schema fingerprint/);
  assert.equal(res.summary.executed, 1);
});

test("TEK-fingerprint mismatch warns (secrets undecryptable) but does not refuse the restore", async () => {
  const res = expectSuccess(await runImport([new Uint8Array(TEK_MISMATCH_ENC)]));
  assert.match(res.warning ?? "", /different TOKEN_ENCRYPTION_KEY/);
  assert.match(res.warning ?? "", /Re-enter them in Settings/);
  assert.equal(res.summary.executed, 1); // data still restored
});

// ── the empty-restore refusal ───────────────────────────────────────────────

test("a dump with zero data statements is refused — never TRUNCATE on an empty restore", async () => {
  // Decrypts cleanly, fingerprint matches, but only comments/empty statements
  // inside: executing it would TRUNCATE every table and restore nothing.
  const res = expectFailure(await runImport([new Uint8Array(COMMENTS_ONLY_ENC)]));
  assert.equal(res.status, 400);
  assert.equal(
    res.error,
    "Backup contains no data statements — refusing to wipe the database with an empty restore.",
  );
  assert.equal(txCalls.length, 0);
});

// ── the happy path ──────────────────────────────────────────────────────────

test("happy path: exact op order (lock → full TRUNCATE → dump order), ON CONFLICT append rules, summary", async () => {
  const res = expectSuccess(await runImport([new Uint8Array(HAPPY_ENC)]));

  const expectedTruncate =
    `TRUNCATE TABLE ${BACKUP_TABLES.map((t) => `"public"."${t}"`).join(", ")} RESTART IDENTITY`;
  assert.deepEqual(txOps, [
    // Advisory lock 43 first — shared with /api/auth/register so a racing
    // registration can't slip a row between freshness check and truncate.
    "SELECT pg_advisory_xact_lock(43)",
    // Every backup table, in BACKUP_TABLES order, in ONE truncate.
    expectedTruncate,
    // Statements replay in dump order. The enum DO $$ block is not an INSERT —
    // nothing appended. (Its inner `;`s also prove $$-quote splitting held.)
    STMT.enumCreate,
    // Already carries ON CONFLICT — must not be double-appended.
    STMT.userInsert,
    // Legacy dumps without the clause get it appended for duplicate tolerance.
    `${STMT.settingInsert} ON CONFLICT DO NOTHING`,
    `${STMT.requestInsert} ON CONFLICT DO NOTHING`,
  ]);

  // One transaction, with the restore-sized timeout options.
  assert.equal(txCalls.length, 1);
  assert.deepEqual(txCalls[0], { timeout: 10 * 60 * 1000, maxWait: 10_000 });

  // Admin mode never runs the setup freshness reads.
  assert.deepEqual(freshnessReads, []);

  assert.equal(res.status, 200);
  assert.deepEqual(res.summary, {
    total: 4,
    executed: 4,
    skipped: 0,
    errors: 0,
    conflictSkippedByTable: {},
    conflictSkippedTotal: 0,
  });
  // Fingerprint present+matching, TEK matching, no conflicts ⇒ no warning.
  assert.equal(res.warning, null);
  assert.deepEqual(errors, []);
});

test("conflict-skipped rows (0 affected) are attributed per table and surface as a warning", async () => {
  affectedForInsert = 0; // every INSERT reports ON CONFLICT DO NOTHING dropped it
  const res = expectSuccess(await runImport([new Uint8Array(HAPPY_ENC)]));
  assert.equal(res.summary.executed, 4); // statements still executed…
  assert.deepEqual(res.summary.conflictSkippedByTable, { User: 1, Setting: 1, MediaRequest: 1 });
  assert.equal(res.summary.conflictSkippedTotal, 3); // …the DO $$ block is not counted
  assert.match(res.warning ?? "", /3 duplicate row\(s\) in the backup were skipped/);
});

// ── atomicity and error hygiene ─────────────────────────────────────────────

test("a mid-import failure throws through the transaction: 500, rolled-back message, no DB internals echoed", async () => {
  failOnSqlIncludes = "'siteUrl'"; // the third statement blows up mid-restore
  const res = expectFailure(await runImport([new Uint8Array(HAPPY_ENC)]));
  assert.equal(res.status, 500);
  assert.equal(
    res.error,
    "Restore failed and was rolled back — the database is unchanged. Check the server logs for details.",
  );
  // The raw Postgres error (constraint/column names) must never reach the client…
  assert.equal(res.error.includes("sentinel-db-detail"), false);
  assert.equal(res.error.includes("User_pkey"), false);
  // …but must be logged server-side under the [backup/import] scope.
  assert.equal(errors.length, 1);
  assert.ok(errors[0].startsWith("[backup/import] import failed:"));
  assert.ok(errors[0].includes("sentinel-db-detail"));
  // The transaction callback rejected THROUGH $transaction — with a real
  // client that is the ROLLBACK: earlier ops (lock, TRUNCATE, two statements)
  // were attempted inside the tx and are all discarded, never half-written.
  assert.equal(txRejections, 1);
  assert.ok(txOps.some((op) => op.startsWith("TRUNCATE TABLE ")), "failure happened after writes began");
});
