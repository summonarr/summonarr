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

// The cap is env-configurable (default 4 GB); the boundary test below allocates
// the cap in memory, so pin the suite to the historical 500 MB.
process.env.BACKUP_MAX_RESTORE_MB = "500";

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
    // Guardrail 6g: the restore ends every session — recorded in the op stream so
    // the order (after the data, inside the one transaction) is pinned.
    updateMany: async (args: { data: { sessionsRevokedAt?: Date } }) => {
      txOps.push(`user.updateMany(${Object.keys(args.data).join(",")})`);
      return { count: 0 };
    },
  },
  authSession: {
    deleteMany: async (args: unknown) => {
      txOps.push(`authSession.deleteMany(${JSON.stringify(args)})`);
      return { count: 0 };
    },
  },
};

// The live Setting table the process memos read from (outside the restore's
// transaction): the Discord key, the session lengths, the feature flags.
const liveSettings = new Map<string, string>();
const fakePrisma = {
  setting: {
    findUnique: async (args: { where: { key: string } }) => {
      const value = liveSettings.get(args.where.key);
      return value === undefined ? null : { key: args.where.key, value };
    },
    findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
      const keys = args.where?.key?.in;
      return [...liveSettings.entries()]
        .filter(([key]) => !keys || keys.includes(key))
        .map(([key, value]) => ({ key, value }));
    },
  },
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
const { processBackupImport, MAX_PLAINTEXT_BYTES, MAX_CIPHERTEXT_BYTES, restoreTxTimeoutMs, keepsSessions } =
  await import("../src/lib/backup-import.ts");
const { wrapEncryptStream, ENCRYPTED_MAGIC } = await import("../src/lib/backup-crypto.ts");
const { BACKUP_TABLES, computeSchemaFingerprint } = await import("../src/lib/backup-schema.ts");
const { tokenEncryptionKeyFingerprint } = await import("../src/lib/token-crypto.ts");
const { cachedSessionCheckIsStale, invalidateCachedSessionChecks } =
  await import("../src/lib/session-revocation.ts");
const { arrSnapshotStats, clearArrSnapshots, rememberSnapshot, snapshotKey } =
  await import("../src/lib/arr-snapshot.ts");

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
  opts: { password?: string; mode?: "setup" | "admin"; onCancel?: () => void; keepSessions?: boolean } = {},
): Promise<ImportResult> {
  return processBackupImport(
    streamFrom(chunks, opts.onCancel),
    opts.password ?? PASSWORD,
    opts.mode ?? "admin",
    opts.keepSessions === undefined ? undefined : { keepSessions: opts.keepSessions },
  );
}

function expectFailure(r: ImportResult): ImportFailure {
  assert.equal(r.ok, false, `expected a failure result, got: ${JSON.stringify(r)}`);
  return r as ImportFailure;
}

function expectSuccess(r: ImportResult): ImportSuccess {
  assert.equal(r.ok, true, `expected a success result, got: ${JSON.stringify(r)}`);
  return r as ImportSuccess;
}

// ── fixtures (statement shapes mirror backup-export.ts exactly) ─────────────
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
  TIGHTENED_ENC,
] = await Promise.all([
  encrypt(HAPPY_SQL),
  encrypt("this is definitely not a sql dump"), // no trailing `;` — exercises the flush path
  encrypt(
    [
      `DROP TABLE "User";`,
      `INSERT INTO "public"."NotATable" ("id") VALUES ('x');`,
      `INSERT INTO "public"."User" ("id") VALUES ((SELECT 'x'));`,
      `INSERT INTO "public"."User" ("id") VALUES ('a'), ('b');`,
      // ON CONFLICT tail must be matched WHOLE, not by an `^ON CONFLICT` prefix:
      // ALLOWED_PATTERNS[0]'s greedy `VALUES \([\s\S]*\)` lets the trailing `\)`
      // bind to the LAST `)` in the statement, so a `DO UPDATE SET <expr>` clause
      // slipped past the allowlist AND the tuple validator — arbitrary SQL
      // expression execution from a crafted dump.
      `INSERT INTO "public"."Setting" ("key", "value") VALUES ('a', 'b') ON CONFLICT ("key") DO UPDATE SET "value" = (SELECT "passwordHash" FROM "public"."User" LIMIT 1);`,
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
  // Two regions the allowlist used to leave free-form. Both are structurally
  // pinned now; see the test that consumes this fixture.
  encrypt(
    [
      `INSERT INTO "public"."User" ("id"[(SELECT 1)]) VALUES ('x');`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Role') THEN CREATE TYPE "Role" AS ENUM ('a'; DROP TABLE "User"; --'); END IF; END $$;`,
    ].join("\n"),
  ),
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
  invalidateCachedSessionChecks(0); // a restore's session-check floor is process-wide
  clearArrSnapshots();
  liveSettings.clear();
});

// ── caps ────────────────────────────────────────────────────────────────────

test("size-cap constants: 500 MB plaintext, ciphertext cap = plaintext + 4096", () => {
  // Both are part of the route contract (413 bodies and admin docs key off
  // them); plaintext-cap ENFORCEMENT is intentionally not exercised — see the
  // header — so this pin is what catches an accidental cap change.
  assert.equal(MAX_PLAINTEXT_BYTES, 500 * 1024 * 1024);
  assert.equal(MAX_CIPHERTEXT_BYTES, MAX_PLAINTEXT_BYTES + 4096);
});

test("BACKUP_MAX_RESTORE_MB sets the cap; default is 4 GB; junk falls back to the default", async () => {
  const load = async (v: string | undefined, tag: string) => {
    if (v === undefined) delete process.env.BACKUP_MAX_RESTORE_MB;
    else process.env.BACKUP_MAX_RESTORE_MB = v;
    return (await import(`../src/lib/backup-import.ts?cap=${tag}`)).MAX_PLAINTEXT_BYTES as number;
  };
  try {
    assert.equal(await load("2048", "a"), 2048 * 1024 * 1024);
    assert.equal(await load(undefined, "b"), 4096 * 1024 * 1024);
    assert.equal(await load("0", "c"), 4096 * 1024 * 1024);
    assert.equal(await load("abc", "d"), 4096 * 1024 * 1024);
  } finally {
    process.env.BACKUP_MAX_RESTORE_MB = "500";
  }
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

// ── keep sessions (guardrail 6g exception: first-run transfer only) ─────────

const SESSION_WIPE = ["authSession.deleteMany({})", "user.updateMany(sessionsRevokedAt)"];

test("a setup restore with keepSessions skips BOTH session writes and nothing else", async () => {
  const kept = expectSuccess(await runImport([new Uint8Array(HAPPY_ENC)], { mode: "setup", keepSessions: true }));
  const keptOps = [...txOps];
  for (const w of SESSION_WIPE) assert.ok(!keptOps.includes(w), `${w} must not run`);
  assert.match(kept.warning ?? "", /^Sessions from the backup were KEPT/);

  // Same restore without it: identical except for the two wipe writes.
  txOps.length = 0;
  expectSuccess(await runImport([new Uint8Array(HAPPY_ENC)], { mode: "setup" }));
  assert.deepEqual(txOps, [...keptOps, ...SESSION_WIPE]);
});

test("a setup restore WITHOUT the option still wipes sessions (the default)", async () => {
  const res = expectSuccess(await runImport([new Uint8Array(HAPPY_ENC)], { mode: "setup", keepSessions: false }));
  for (const w of SESSION_WIPE) assert.ok(txOps.includes(w), `${w} must run`);
  assert.match(res.warning ?? "", /^Every account was signed out by the restore/);
});

test("an ADMIN restore ignores keepSessions: the wipe always runs", async () => {
  const res = expectSuccess(await runImport([new Uint8Array(HAPPY_ENC)], { mode: "admin", keepSessions: true }));
  for (const w of SESSION_WIPE) assert.ok(txOps.includes(w), `${w} must run`);
  assert.match(res.warning ?? "", /^Every account was signed out by the restore/);
});

test("keepsSessions is true only for setup mode with the flag exactly true", () => {
  assert.equal(keepsSessions("setup", { keepSessions: true }), true);
  assert.equal(keepsSessions("setup", { keepSessions: false }), false);
  assert.equal(keepsSessions("setup", {}), false);
  assert.equal(keepsSessions("setup", undefined), false);
  assert.equal(keepsSessions("admin", { keepSessions: true }), false);
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

test("injection defenses: DROP, non-backup table, sub-SELECT VALUES, multi-tuple and ON CONFLICT DO UPDATE smuggles are all blocked", async () => {
  const res = expectFailure(await runImport([new Uint8Array(BADSTMTS_ENC)]));
  assert.equal(res.status, 200);
  assert.equal(res.error, "Backup failed validation");
  const reasons = res.errors ?? [];
  assert.equal(reasons.length, 5);
  assert.match(reasons[0], /^Blocked disallowed statement: DROP TABLE "User"/);
  assert.match(reasons[1], /^Blocked disallowed statement: INSERT INTO "public"\."NotATable"/);
  assert.match(reasons[2], /^Blocked INSERT with non-literal VALUES: INSERT INTO "public"\."User" \("id"\) VALUES \(\(SELECT/);
  assert.match(reasons[3], /^Blocked INSERT with non-literal VALUES: INSERT INTO "public"\."User" \("id"\) VALUES \('a'\), \('b'\)/);
  // The tuple itself is all-literal here — only the ON CONFLICT tail is hostile,
  // so this is caught by remainderAfterTupleIsSafe's whole-match, not the tokens.
  assert.match(reasons[4], /^Blocked INSERT with non-literal VALUES: INSERT INTO "public"\."Setting"/);
  // The one legitimate statement in the same dump must not execute anyway —
  // a partially-hostile dump is rejected wholesale.
  assert.equal(res.summary?.total, 6);
  assert.equal(res.summary?.executed, 0);
  assert.equal(txCalls.length, 0);
});

test("injection defenses: the INSERT column list and the enum label list are structurally pinned, not free-form", async () => {
  const res = expectFailure(await runImport([new Uint8Array(TIGHTENED_ENC)]));
  assert.equal(res.status, 200);
  const reasons = res.errors ?? [];
  assert.equal(reasons.length, 2);

  // (a) The column list is a grammatical EXPRESSION position in Postgres
  // (`ColId opt_indirection` admits `[ a_expr ]` subscripts) and the allowlist
  // used to model it as a bare `[\s\S]*` with nothing inspecting it before
  // $executeRawUnsafe. db-export only ever emits quoted plain identifiers joined
  // by ", ", so anything else is a smuggle attempt.
  assert.match(reasons[0], /^Blocked INSERT with non-identifier column list: INSERT INTO "public"\."User"/);

  // (b) The enum label list used to be `\([^)]+\)` — "anything but a close paren",
  // which admits `;`, `--`, newlines and quotes inside a block executed verbatim
  // as plpgsql. Only a `'label'` list joined by ", " is accepted now.
  assert.match(reasons[1], /^Blocked disallowed statement: DO \$\$ BEGIN IF NOT EXISTS/);

  assert.equal(res.summary?.executed, 0);
  assert.equal(txCalls.length, 0, "a hostile dump must execute nothing");
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

test("a matching normalized fingerprint restores even when the byte fingerprint differs (comment-only schema edit)", async () => {
  const { computeNormalizedSchemaFingerprint } = await import("../src/lib/backup-schema.ts");
  const nfp = computeNormalizedSchemaFingerprint();
  const ok = expectSuccess(
    await runImport([
      new Uint8Array(
        await encrypt(`-- Schema-Fingerprint: ${WRONG_FP}\n-- Schema-Fingerprint-Normalized: ${nfp}\n${STMT.userInsert};\n`),
      ),
    ]),
  );
  assert.equal(ok.summary.executed, 1);
  assert.doesNotMatch(ok.warning ?? "", /no schema fingerprint/);

  // The normalized fingerprint is what decides once present: a mismatch refuses.
  const refused = expectFailure(
    await runImport([
      new Uint8Array(
        await encrypt(`-- Schema-Fingerprint: ${FP}\n-- Schema-Fingerprint-Normalized: ${WRONG_FP}\n${STMT.userInsert};\n`),
      ),
    ]),
  );
  assert.equal(refused.status, 409);
  assert.ok(refused.error.includes(nfp));
});

test("invalid UTF-8 is refused as unreadable, never restored as replacement characters", async () => {
  const bad = Buffer.concat([
    Buffer.from(`-- Schema-Fingerprint: ${FP}\nINSERT INTO "public"."Setting" ("key", "value") VALUES ('k', '`, "utf8"),
    Buffer.from([0xff, 0xfe]),
    Buffer.from(`');\n`, "utf8"),
  ]);
  const enc = await collect(wrapEncryptStream(streamFrom([new Uint8Array(bad)]), PASSWORD));
  const res = expectFailure(await runImport([new Uint8Array(enc)]));
  assert.equal(res.status, 400);
  assert.equal(res.error, "Failed to read backup");
  assert.equal(txCalls.length, 0);

  // A sequence cut off at the very end of the dump is corruption too.
  const cut = Buffer.concat([Buffer.from(`${STMT.userInsert};\n`, "utf8"), Buffer.from([0xe2, 0x82])]);
  const cutEnc = await collect(wrapEncryptStream(streamFrom([new Uint8Array(cut)]), PASSWORD));
  assert.equal(expectFailure(await runImport([new Uint8Array(cutEnc)])).error, "Failed to read backup");
  assert.equal(txCalls.length, 0);
});

test("an upload that breaks off inside the header is a clean read failure, not a thrown error", async () => {
  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(HAPPY_ENC.subarray(0, 3)));
    },
    pull(controller) {
      controller.error(new Error("client aborted"));
    },
  });
  const res = expectFailure(await processBackupImport(broken, PASSWORD, "admin"));
  assert.equal(res.status, 400);
  assert.equal(res.error, "Failed to read backup");
  assert.equal(txCalls.length, 0);
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
    // Guardrail 6g: the restore never brings sessions back. The dump's
    // AuthSession rows go, and every account's cutoff moves to now, so no token
    // from before the restore (a device signed out since the backup was taken)
    // works again — in the SAME transaction as the data.
    "authSession.deleteMany({})",
    "user.updateMany(sessionsRevokedAt)",
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
  // Fingerprint present+matching, TEK matching, no conflicts ⇒ the only
  // warning is that everyone was signed out.
  assert.match(res.warning ?? "", /^Every account was signed out by the restore/);
  assert.deepEqual(errors, []);
});

test("a committed restore sets the session-check floor, so a cookie checked before it goes back to the DB", async () => {
  // The restore deletes every AuthSession row, but a cookie whose dbCheckedAt
  // is still inside its 10s/60s window would skip that lookup. The floor is
  // what closes the window (session-refresh.ts reads it).
  const before = Math.floor(Date.now() / 1000) - 5;
  assert.equal(cachedSessionCheckIsStale(before), false, "no floor before the restore");
  expectSuccess(await runImport([new Uint8Array(HAPPY_ENC)]));
  assert.equal(cachedSessionCheckIsStale(before), true, "a check from before the restore must be redone");
  assert.equal(cachedSessionCheckIsStale(Math.floor(Date.now() / 1000) + 60), false, "a later check is not");
});

test("a refused or rolled-back restore leaves the session-check floor alone", async () => {
  const before = Math.floor(Date.now() / 1000) - 5;
  // Refused before the database is touched.
  expectFailure(await runImport([new Uint8Array(COMMENTS_ONLY_ENC)]));
  assert.equal(cachedSessionCheckIsStale(before), false, "nothing changed, so no session needs re-checking");
  // Rolled back mid-import: the old sessions are still valid.
  failOnSqlIncludes = "'siteUrl'";
  expectFailure(await runImport([new Uint8Array(HAPPY_ENC)]));
  assert.equal(txRejections, 1);
  assert.equal(cachedSessionCheckIsStale(before), false, "the floor is set only after the transaction commits");
});

// The restore replaced the Setting table, Radarr/Sonarr instances included,
// and a `cached=1` read skips its route's instance checks (guardrail 5h).
const keepArrSnapshot = () =>
  rememberSnapshot(snapshotKey("http://x/api/admin/arr/history?service=sonarr&instance=anime", "en")!, "{}");

test("a committed restore drops every kept admin arr answer", async () => {
  keepArrSnapshot();
  assert.equal(arrSnapshotStats().entries, 1);
  expectSuccess(await runImport([new Uint8Array(HAPPY_ENC)]));
  assert.equal(arrSnapshotStats().entries, 0);
});

test("a refused or rolled-back restore keeps the arr answers", async () => {
  keepArrSnapshot();
  expectFailure(await runImport([new Uint8Array(COMMENTS_ONLY_ENC)]));
  assert.equal(arrSnapshotStats().entries, 1, "refused before the database was touched");
  failOnSqlIncludes = "'siteUrl'";
  expectFailure(await runImport([new Uint8Array(HAPPY_ENC)]));
  assert.equal(txRejections, 1);
  assert.equal(arrSnapshotStats().entries, 1, "rolled back: the config they were read under is unchanged");
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

// ── the transaction timeout ─────────────────────────────────────────────────

test("the restore timeout scales with the statement count as well as the size", () => {
  const MB = 1024 * 1024;
  // A small dump keeps the 10-minute floor (the happy path pins the options).
  assert.equal(restoreTxTimeoutMs(1 * MB, 10), 10 * 60 * 1000);
  // Size alone: one second per MB.
  assert.equal(restoreTxTimeoutMs(1500 * MB, 1000), 1500 * 1000);
  // Many tiny rows: every statement is its own round trip, so 300 MB of
  // PlayHistory INSERTs (a million statements) must not get the 10-minute floor.
  const many = restoreTxTimeoutMs(300 * MB, 1_000_000);
  assert.ok(many > 300 * 1000 && many > 10 * 60 * 1000, `got ${many}ms`);
  assert.equal(many, 2_000_000);
});

// ── reading the spool back ──────────────────────────────────────────────────

test("a multi-MB statement replays byte-identical, in order, without re-copying the spool per read", async () => {
  // A 5 MB Setting value between two small rows. The spool is read back in
  // 64 KB pieces; joining every piece onto the unread remainder copied a big
  // statement once per piece (about 200 MB of copying for this one).
  const big = "x".repeat(5 * 1024 * 1024);
  const before = `INSERT INTO "public"."Setting" ("key", "value") VALUES ('a', 'first')`;
  const huge = `INSERT INTO "public"."Setting" ("key", "value") VALUES ('big', '${big}')`;
  const after = `INSERT INTO "public"."Setting" ("key", "value") VALUES ('z', 'last')`;
  const sql = `-- Schema-Fingerprint: ${FP}\n${before};\n${huge};\n${after};\n`;
  const enc = await encrypt(sql);

  const realConcat = Buffer.concat;
  let copied = 0;
  Buffer.concat = ((list: readonly Uint8Array[], total?: number) => {
    const out = realConcat(list, total);
    copied += out.length;
    return out;
  }) as typeof Buffer.concat;
  let res: ImportResult;
  try {
    res = await runImport([new Uint8Array(enc)]);
  } finally {
    Buffer.concat = realConcat;
  }
  expectSuccess(res);
  assert.deepEqual(txOps.slice(2, 5), [
    `${before} ON CONFLICT DO NOTHING`,
    `${huge} ON CONFLICT DO NOTHING`,
    `${after} ON CONFLICT DO NOTHING`,
  ]);
  // Decrypt, spool write and spool read each copy the dump about once.
  assert.ok(copied < 6 * sql.length, `copied ${copied} bytes for a ${sql.length}-byte dump`);
});

// ── the other process memos ─────────────────────────────────────────────────

const DISCORD_KEY_SPECIFIER = "../src/lib/discord-interactions/signature.ts?chunk=interactions";
const FLAG = "feature.admin.backup";

async function memoReaders() {
  // The interactions route lives in another chunk; a cache-busted copy of the
  // module stands in for it (guardrail 27a).
  const signature: typeof import("../src/lib/discord-interactions/signature.ts") = await import(DISCORD_KEY_SPECIFIER);
  const { getSessionDurations, invalidateSessionDurationsCache } = await import("../src/lib/auth.ts");
  const { getFeatureFlags, invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
  // Start each test from empty memos (they are process-wide).
  signature.invalidatePublicKeyCache();
  invalidateSessionDurationsCache();
  invalidateFeatureFlagCache();
  return {
    key: () => signature.getPublicKey(),
    desktop: async () => (await getSessionDurations()).desktopDuration,
    flag: async () => (await getFeatureFlags())[FLAG],
  };
}

async function primeMemos() {
  const read = await memoReaders();
  liveSettings.set("discordPublicKey", "aa".repeat(32));
  liveSettings.set("sessionDefaultDuration", "7200");
  liveSettings.set(FLAG, "false");
  assert.equal(await read.key(), "aa".repeat(32));
  assert.equal(await read.desktop(), 7200);
  assert.equal(await read.flag(), false);
  // The restore brings a different Setting table.
  liveSettings.set("discordPublicKey", "bb".repeat(32));
  liveSettings.set("sessionDefaultDuration", "5400");
  liveSettings.set(FLAG, "true");
  return read;
}

test("a committed restore drops the memos built from the replaced Settings (Discord key, session lengths, flags)", async () => {
  const read = await primeMemos();
  expectSuccess(await runImport([new Uint8Array(HAPPY_ENC)]));
  // The Discord key has no TTL: without the drop, interactions are verified
  // against the old key until a restart.
  assert.equal(await read.key(), "bb".repeat(32));
  // Sessions minted now carry the restored length for life (guardrail 6c).
  assert.equal(await read.desktop(), 5400);
  assert.equal(await read.flag(), true);
});

test("a refused or rolled-back restore keeps those memos", async () => {
  const read = await primeMemos();
  expectFailure(await runImport([new Uint8Array(COMMENTS_ONLY_ENC)]));
  failOnSqlIncludes = "'siteUrl'";
  expectFailure(await runImport([new Uint8Array(HAPPY_ENC)]));
  assert.equal(txRejections, 1);
  assert.equal(await read.key(), "aa".repeat(32), "nothing was replaced, so the memo stands");
  assert.equal(await read.desktop(), 7200);
  assert.equal(await read.flag(), false);
});
