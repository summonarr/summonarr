// Operation coverage for the at-rest crypto extension in src/lib/prisma.ts —
// the Prisma $extends layer that transparently encrypts Setting.value and the
// three Account OAuth-token columns on write and decrypts them on read
// (guardrail 7a).
//
// Why this file exists: the extension is per-OPERATION, and Prisma exposes 19
// operations per model. The extension names 13 of them. Nothing anywhere checks
// that list against reality, and every gap in it is silent — a caller reaching
// an unhandled operation gets ciphertext back with no error, no warning and no
// type difference, then hands it to Radarr or Plex as an API key and gets a
// confusing upstream auth failure three layers away.
//
// This is not hypothetical. The extension's own comments record the shape of
// the bug twice over:
//
//   "The *OrThrow twins are separate Prisma operations, NOT aliases — an
//    uncovered *OrThrow returns ciphertext."
//   "…AndReturn is a distinct operation from createMany/updateMany: uncovered…"
//
// Both notes exist because both gaps shipped and had to be found by hand in a
// security review. The names read like aliases and behave like separate
// operations, so the omission is invisible on inspection — which is exactly the
// kind of thing a test should be holding, not a comment.
//
// tests/token-crypto.test.mts covers the cipher primitives (encryptToken /
// decryptToken round-trips, key handling, the enc:v1 envelope). It says nothing
// about which Prisma calls actually route through them. That wiring is what
// this file pins, from three angles:
//
//   1. Coverage — the real operation list is read off the generated client at
//      runtime, so a Prisma upgrade that ADDS an operation fails here rather
//      than silently opening a hole in a version bump.
//   2. Reachability — the deliberately-unhandled operations that CAN surface a
//      protected column (groupBy, aggregate) must stay unused. This test makes
//      the boundary explicit: start using one and you must extend the
//      extension first.
//   3. Behaviour — each handler is called with a fake query (the handlers are
//      exported from src/lib/prisma-crypto.ts), so what it sends the database
//      and what it hands back are OBSERVED: reads decrypt, writes encrypt
//      before the query, and the bypass guards (createMany/updateMany and their
//      *AndReturn twins, which apply one payload to many rows and so cannot be
//      encrypted per-key) throw BEFORE any query is issued.
//
// No database: the guards throw synchronously inside the extension, so they are
// reachable with DATABASE_URL pointed at a closed port. The one test that
// deliberately lets a call through asserts it fails on the CONNECTION instead,
// which is what proves the guard was not what stopped it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
// Port 1 is reserved and closed: a call that gets past the guards fails fast on
// connect instead of hanging the suite.
process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:1/none";

const errors: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Two tests below deliberately let a query reach the closed port. Prisma's own
// logger (`log: ["error"]`, fixed at client construction — not something a
// caller can turn off) emits that failure through console.LOG, not stderr and
// not console.error. Unexplained `prisma:error` lines in a full suite run
// read as a broken test, so the expected connection failure is captured here.
// Anything else still prints.
const realLog = console.log;
const prismaLogs: string[] = [];
console.log = (...args: unknown[]) => {
  const text = args.map(String).join(" ");
  if (/prisma:error|Can't reach database server|Invalid `prisma\./.test(text)) {
    prismaLogs.push(text);
    return;
  }
  realLog(...args);
};

const { prisma } = await import("../src/lib/prisma.ts");

const { cryptoQueryExtension } = await import("../src/lib/prisma-crypto.ts");
const { encryptToken } = await import("../src/lib/token-crypto.ts");
const H = await import("./_crypto-handlers.mts");

// ── what the extension actually handles ─────────────────────────────────────

/** Real operations Prisma exposes on a delegate, read off the generated client. */
function delegateOperations(model: "setting" | "account"): string[] {
  const META = new Set(["fields", "name", "$name", "$parent"]);
  return Object.keys(prisma[model] as object).filter((k) => !META.has(k));
}

const HANDLED = {
  setting: Object.keys(cryptoQueryExtension.setting),
  account: Object.keys(cryptoQueryExtension.account),
};

// Deliberately unhandled. `count` returns a scalar and `findRaw`/`aggregateRaw`
// are MongoDB-only, so those three are structurally incapable of leaking a
// column. `groupBy` and `aggregate` CAN surface the protected columns and are
// unhandled purely because nothing calls them — see the reachability test
// below, which is what keeps that true. An Account deleteMany returns a count,
// so it needs no handler; Setting's releases the decrypt-failure banner.
const EXPECTED_UNHANDLED = {
  setting: ["groupBy", "count", "aggregate", "findRaw", "aggregateRaw"],
  account: ["deleteMany", "groupBy", "count", "aggregate", "findRaw", "aggregateRaw"],
};

// ── non-vacuity ─────────────────────────────────────────────────────────────

test("both the delegate enumeration and the handler map found real data", () => {
  for (const model of ["setting", "account"] as const) {
    const ops = delegateOperations(model);
    assert.ok(ops.length >= 15, `only ${ops.length} operations enumerated on prisma.${model} — the probe is broken`);
    assert.ok(ops.includes("findMany") && ops.includes("upsert"), `prisma.${model} is missing core operations`);
    assert.ok(HANDLED[model].length >= 10, `only ${HANDLED[model].length} handlers for ${model}`);
  }
});

// ── coverage ────────────────────────────────────────────────────────────────

test("every operation the extension declares is a REAL Prisma operation", () => {
  // A typo'd handler name is dead code that looks like coverage.
  for (const model of ["setting", "account"] as const) {
    const real = new Set(delegateOperations(model));
    const bogus = HANDLED[model].filter((op) => !real.has(op));
    assert.deepEqual(
      bogus,
      [],
      `${model}: handler(s) declared for operation(s) Prisma does not expose — dead code masquerading as coverage`,
    );
  }
});

test("the unhandled set is exactly the known-safe operations — a Prisma upgrade cannot widen it silently", () => {
  for (const model of ["setting", "account"] as const) {
    const handled = new Set(HANDLED[model]);
    const unhandled = delegateOperations(model).filter((op) => !handled.has(op)).sort();
    assert.deepEqual(
      unhandled,
      [...EXPECTED_UNHANDLED[model]].sort(),
      `${model}: the set of operations bypassing the crypto extension changed. If Prisma added an operation, ` +
        "decide deliberately whether it can surface Setting.value / the Account token columns and either handle " +
        "it in src/lib/prisma-crypto.ts or add it to EXPECTED_UNHANDLED with a reason.",
    );
  }
});

test("every column model gets the same operation set from the one factory", () => {
  // The protected columns differ but the operations that can reach them do
  // not, so a handler present on one model and missing on another is a gap.
  const base = [...HANDLED.account].sort();
  assert.deepEqual([...Object.keys(cryptoQueryExtension.userTotp)].sort(), base);
  assert.deepEqual([...Object.keys(cryptoQueryExtension.notificationAgent)].sort(), base);
  assert.deepEqual([...HANDLED.setting].filter((op) => op !== "deleteMany").sort(), base);
});

// Declaring a handler is not the same as doing the work. These call each
// handler with a fake query and look at what goes in and what comes out.

const SENSITIVE_KEY = "radarrApiKey";

test("every Account handler that returns rows decrypts all three token columns", async () => {
  for (const column of ["access_token", "refresh_token", "id_token"]) {
    await H.assertReadsDecrypt(cryptoQueryExtension.account, column, (c) => ({ id: "acc-1", [column]: c }));
  }
});

test("every Setting handler that returns rows decrypts a sensitive key's value", async () => {
  await H.assertReadsDecrypt(
    cryptoQueryExtension.setting,
    "value",
    (c) => ({ key: SENSITIVE_KEY, value: c }),
    () => ({ where: { key: SENSITIVE_KEY } }),
  );
});

test("a Setting read of a key-less select names the row from where.key, and a plain key is never decrypted", async () => {
  const plain = "plain-secret-value";
  const { result } = await H.runHandler(cryptoQueryExtension.setting, "findUnique", { where: { key: SENSITIVE_KEY } }, { value: encryptToken(plain) });
  assert.equal((result as { value: string }).value, plain);
  const { result: flag } = await H.runHandler(cryptoQueryExtension.setting, "findUnique", { where: { key: "someFlag" } }, { key: "someFlag", value: "true" });
  assert.equal((flag as { value: string }).value, "true");
});

test("single-row writes encrypt every branch before the query and hand back plaintext", async () => {
  for (const column of ["access_token", "refresh_token", "id_token"]) {
    await H.assertSingleWritesEncrypt(cryptoQueryExtension.account, column, (value) => ({ [column]: value }), { id: "acc-1" });
  }
  await H.assertSingleWritesEncrypt(
    cryptoQueryExtension.setting,
    "value",
    (value) => ({ key: SENSITIVE_KEY, value }),
    { key: SENSITIVE_KEY },
  );
});

test("a Setting write of a NON-sensitive key stays plain text", async () => {
  const { sent } = await H.runHandler(cryptoQueryExtension.setting, "upsert", {
    where: { key: "someFlag" }, create: { key: "someFlag", value: "true" }, update: { value: "true" },
  }, { key: "someFlag", value: "true" });
  assert.equal((sent?.create as { value: string }).value, "true");
  assert.equal((sent?.update as { value: string }).value, "true");
});

test("Setting createMany encrypts each sensitive row", async () => {
  for (const op of ["createMany", "createManyAndReturn"]) {
    const { sent } = await H.runHandler(cryptoQueryExtension.setting, op, {
      data: [{ key: SENSITIVE_KEY, value: "s1" }, { key: "someFlag", value: "true" }],
    }, op === "createMany" ? { count: 2 } : []);
    const rows = sent?.data as Array<{ value: string }>;
    H.assertEncrypted(rows[0].value, `${op} sensitive row`);
    assert.equal(rows[1].value, "true", `${op} must leave a plain key alone`);
  }
});

test("setting.delete releases that key's decrypt-failure entry (its row is decrypted like every read)", async () => {
  const mod = await import("../src/lib/prisma.ts");
  // Record a failure for the key through a corrupt read (its expected log line is dropped).
  const logged = errors.length;
  await H.runHandler(cryptoQueryExtension.setting, "findUnique", { where: { key: SENSITIVE_KEY } }, { key: SENSITIVE_KEY, value: "enc:v1:corrupt" });
  errors.length = logged;
  assert.ok(mod.getSettingDecryptFailures().includes(SENSITIVE_KEY));
  // A row returned without its value: only the delete itself can release the entry.
  await H.runHandler(cryptoQueryExtension.setting, "delete", { where: { key: SENSITIVE_KEY } }, { key: SENSITIVE_KEY });
  assert.ok(!mod.getSettingDecryptFailures().includes(SENSITIVE_KEY), "a deleted key leaves the banner");
});

// ── reachability: the unhandled operations must stay unused ────────────────

test("nothing calls an operation that bypasses the crypto extension", () => {
  // The load-bearing half of the "unhandled is fine" argument. setting.delete()
  // returns the deleted row including `value`, and account.delete() returns the
  // token columns — both unwrapped, both raw ciphertext. Nothing calls them
  // today; this is what keeps that true.
  const roots = ["src", "scripts"];
  const files: string[] = [];
  const REPO = new URL("..", import.meta.url).pathname;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (p.includes("/generated/")) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts|mjs)$/.test(p)) files.push(p);
    }
  };
  for (const r of roots) walk(join(REPO, r));
  assert.ok(files.length > 400, `only ${files.length} files walked — the scan is broken`);

  // Only the operations that can actually surface a protected column.
  const risky = ["groupBy", "aggregate"];
  const pattern = new RegExp(`\\.(setting|account)\\.(${risky.join("|")})\\s*\\(`, "g");
  const offenders: string[] = [];
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(pattern)) {
      offenders.push(`${f.slice(REPO.length)}: .${m[1]}.${m[2]}()`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a call reached an operation the crypto extension does not intercept: `.groupBy()`/`.aggregate()` can " +
      "project the protected columns. Handle the operation in src/lib/prisma-crypto.ts first, or use the " +
      "findMany equivalent that is covered.",
  );

  // Query extensions intercept TOP-LEVEL operations only. A nested relation
  // write under a user query (`accounts: { create: … }`) stores the tokens in
  // plaintext, and a nested include/select of the relation hands them back as
  // ciphertext. The relation FILTERS (some/none/every) read no column and stay
  // allowed. Requiring the `:` after the operator keeps prose in comments out.
  const nested = /\baccounts:\s*(?:true\b|\{\s*(?:create|createMany|connectOrCreate|upsert|update|updateMany|set|select|include|omit|where|orderBy|take|skip|cursor|distinct)\s*:)/g;
  const nestedOffenders: string[] = [];
  let filters = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(nested)) nestedOffenders.push(`${f.slice(REPO.length)}: ${m[0]}`);
    filters += [...src.matchAll(/\baccounts:\s*\{\s*(?:some|none|every)\s*:/g)].length;
  }
  assert.ok(filters >= 4, `only ${filters} accounts relation filters found — the nested scan is not reading real code`);
  assert.deepEqual(
    nestedOffenders,
    [],
    "a nested accounts write or include/select bypasses the crypto extension: a nested write stores the OAuth " +
      "tokens in plaintext, a nested read returns ciphertext. Use a top-level prisma.account call instead.",
  );
});

test("the nested-accounts scan catches the shapes it exists for, and passes the relation filters", () => {
  const nested = /\baccounts:\s*(?:true\b|\{\s*(?:create|createMany|connectOrCreate|upsert|update|updateMany|set|select|include|omit|where|orderBy|take|skip|cursor|distinct)\s*:)/;
  for (const bad of [
    "data: { accounts: { create: { provider: 'plex', access_token: t } } }",
    "include: { accounts: true }",
    "select: { accounts: { select: { access_token: true } } }",
    "data: {\n  accounts: {\n    upsert: { where, create, update },\n  },\n}",
  ]) assert.match(bad, nested, bad);
  for (const ok of [
    "where: { accounts: { some: { provider: 'plex' } } }",
    "where: { accounts: { none: { provider: 'oidc' } } }",
    "// a nested `accounts: { create }` under user.create bypasses the hook",
  ]) assert.doesNotMatch(ok, nested, ok);
});

// ── behaviour: the bypass guards fire, and fire early ──────────────────────

/** Resolve to the thrown error, or null if the call did not throw. */
async function thrown(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as Error;
  }
}

test("guardrail 7a: every many-row write carrying a protected column is REFUSED", () => {
  // createMany/updateMany apply one `data` payload across many rows, so the
  // extension cannot know which Setting key it is encrypting for, nor encrypt
  // per row. Rather than write plaintext it refuses and names the alternative.
  const cases: [string, () => Promise<unknown>][] = [
    ["setting.updateMany", () => prisma.setting.updateMany({ where: {}, data: { value: "secret" } })],
    ["setting.updateManyAndReturn", () => prisma.setting.updateManyAndReturn({ where: {}, data: { value: "secret" } })],
    ["account.createMany", () => prisma.account.createMany({ data: [{ access_token: "secret" } as never] })],
    ["account.createManyAndReturn", () => prisma.account.createManyAndReturn({ data: [{ id_token: "secret" } as never] })],
    ["account.updateMany", () => prisma.account.updateMany({ where: {}, data: { refresh_token: "secret" } })],
    ["account.updateManyAndReturn", () => prisma.account.updateManyAndReturn({ where: {}, data: { access_token: "secret" } })],
  ];

  return (async () => {
    for (const [label, fn] of cases) {
      const started = Date.now();
      const err = await thrown(fn);
      assert.ok(err, `${label} with a protected column did NOT throw — it would write plaintext at rest`);
      assert.match(
        err.message,
        /is forbidden — use/,
        `${label} threw, but not the extension's bypass guard:\n  ${err.message.slice(0, 200)}`,
      );
      // Pre-DB: the guard runs before `query(args)`, so no connection is attempted.
      assert.ok(
        Date.now() - started < 50,
        `${label}'s guard took ${Date.now() - started}ms — it must reject BEFORE issuing the query, not after`,
      );
      // The message has to name the escape hatch or the caller cannot act on it.
      assert.match(err.message, /create|update|upsert/, `${label}'s guard must name the wrapped alternative`);
    }
  })();
});

test("the guards are precise — a many-row write with NO protected column is let through", () => {
  // An over-broad guard would break every legitimate bulk write on these two
  // tables. Reaching the closed port is the proof it was not the guard that
  // stopped the call.
  return (async () => {
    const err = await thrown(() =>
      prisma.setting.updateMany({ where: { key: "someFlag" }, data: { updatedAt: new Date() } }),
    );
    assert.ok(err, "expected the unreachable-database error");
    assert.doesNotMatch(
      err.message,
      /is forbidden — use/,
      "a payload with no protected column was refused by the bypass guard — legitimate bulk writes are broken",
    );
    assert.match(
      err.message,
      /reach database server|ECONNREFUSED|Can't reach/i,
      `expected a connection failure (proving the call got past the guard), got:\n  ${err.message.slice(0, 200)}`,
    );
  })();
});

test("the empty-payload case is not mistaken for a protected write", () => {
  return (async () => {
    const err = await thrown(() => prisma.account.createMany({ data: [] }));
    assert.doesNotMatch(
      err?.message ?? "",
      /is forbidden — use/,
      "an empty createMany carries no token column and must not be refused",
    );
  })();
});

test("the extension's decrypt failures are observable to the settings UI", () => {
  return (async () => {
    // getSettingDecryptFailures backs the admin banner that tells an operator
    // which key to re-save. A refactor that drops the export leaves a corrupt
    // row silently returning "" forever.
    const mod = await import("../src/lib/prisma.ts");
    assert.equal(typeof mod.getSettingDecryptFailures, "function");
    assert.ok(Array.isArray(mod.getSettingDecryptFailures()), "it must return an array even when nothing has failed");
  })();
});

// The failure set is cleared on a successful re-read of the key — but the two
// operator recovery paths for a corrupt token ("Disconnect Plex", de-register a
// media/arr instance) DELETE the row instead of re-saving it, and a deleted row
// is never read again. Without the deleteMany hook releasing the entry, the
// settings banner named a key with no row and no re-save target until restart.
test("settingKeysFromDeleteWhere recognizes exactly the where-shapes callers use", async () => {
  const { settingKeysFromDeleteWhere } = await import("../src/lib/prisma.ts");
  assert.deepEqual(settingKeysFromDeleteWhere({ key: "plexAdminToken" }), ["plexAdminToken"]);
  assert.deepEqual(settingKeysFromDeleteWhere({ key: { in: ["a", "b"] } }), ["a", "b"]);
  assert.deepEqual(settingKeysFromDeleteWhere({ key: { in: [] } }), []);
  // Anything it cannot read precisely must be null — the hook then clears
  // NOTHING for a filtered delete, never a guess.
  assert.equal(settingKeysFromDeleteWhere(undefined), null);
  assert.equal(settingKeysFromDeleteWhere(null), null);
  assert.equal(settingKeysFromDeleteWhere({ id: 1 }), null);
  assert.equal(settingKeysFromDeleteWhere({ key: { in: ["a", 2] } }), null);
  assert.equal(settingKeysFromDeleteWhere({ key: { startsWith: "a" } }), null);
});

test("setting.deleteMany releases the decrypt-failure entry for the deleted key(s), only after the delete resolved", async () => {
  const mod = await import("../src/lib/prisma.ts");
  const key = "plexAdminToken";
  const corrupt = () => H.runHandler(cryptoQueryExtension.setting, "findUnique", { where: { key } }, { key, value: "enc:v1:corrupt" });
  const logged = errors.length;
  await corrupt();
  errors.length = logged; // the corrupt read's expected log line
  assert.ok(mod.getSettingDecryptFailures().includes(key));
  // A failed delete leaves the entry (guardrail 27 ordering).
  await assert.rejects(cryptoQueryExtension.setting.deleteMany({ args: { where: { key } }, query: async () => { throw new Error("db down"); } }));
  assert.ok(mod.getSettingDecryptFailures().includes(key), "a failed delete must leave the banner in place");
  await H.runHandler(cryptoQueryExtension.setting, "deleteMany", { where: { key: { in: [key] } } }, { count: 1 });
  assert.ok(!mod.getSettingDecryptFailures().includes(key), "a deleted key leaves the banner");
});

test("nothing here logged an unexpected error beyond the deliberate connection failures", () => {
  console.error = realError;
  console.log = realLog;

  const unexpected = errors.filter((e) => !/reach database server|prisma:error|Can't reach/i.test(e));
  assert.deepEqual(unexpected, [], `unexpected console.error output: ${unexpected.join(" | ")}`);

  // The capture must have actually fired. If Prisma stops logging, or the
  // let-through tests stop reaching the network, the "guards are precise" proof
  // — that a connection error, not the guard, stopped the call — is hollow.
  assert.ok(
    prismaLogs.length > 0,
    "no connection failure was logged at all — the tests that prove a call got PAST the bypass guard never " +
      "reached the network, so they no longer prove it",
  );
});

// A caller that selects only the value (`select: { value: true }`) gets a row with
// no `key`, so the row cannot name itself and both the legacy-plaintext warning
// and the decrypt-failure error printed "Setting.?" — naming no row the operator
// could go and re-save. The query's own `where.key` identifies it in that case.
test("settingKeyFromArgs names the row a key-less select cannot name itself", async () => {
  const { settingKeyFromArgs } = await import("../src/lib/prisma.ts");

  // The shape that produced "Setting.?": findUnique by key, selecting value only.
  assert.equal(
    settingKeyFromArgs({ where: { key: "smtpPassword" }, select: { value: true } }),
    "smtpPassword",
  );
  assert.equal(settingKeyFromArgs({ where: { key: "vapidPrivateKey" } }), "vapidPrivateKey");

  // An `in` filter matches many rows, so borrowing it would mislabel every one of
  // them — the row's own `key` is the only correct source there.
  assert.equal(settingKeyFromArgs({ where: { key: { in: ["a", "b"] } } }), undefined);
  assert.equal(settingKeyFromArgs({ where: { value: "x" } }), undefined);
  assert.equal(settingKeyFromArgs({ where: {} }), undefined);
  assert.equal(settingKeyFromArgs({}), undefined);
  assert.equal(settingKeyFromArgs(undefined), undefined);
  assert.equal(settingKeyFromArgs(null), undefined);
});

// ── behaviour: what actually reaches the database ───────────────────────────
// The handler tests above call each handler with a fake query. These record the statement values
// the pg driver is handed, by stubbing pg.Client for the length of one call, so
// "the `{ set }` form is encrypted" is observed on the wire rather than inferred.
// The stub reports no rows; Prisma's own "record not found" for the update is
// tolerated — only the bound parameters matter.
async function recordedValues(run: () => Promise<unknown>): Promise<unknown[]> {
  const pg = (await import("pg")).default as unknown as { Client: { prototype: Record<string, unknown> } };
  const proto = pg.Client.prototype;
  const saved = { connect: proto.connect, query: proto.query, end: proto.end };
  const seen: unknown[] = [];
  proto.connect = function (cb?: (e: Error | null) => void) { if (cb) { cb(null); return undefined; } return Promise.resolve(); };
  proto.end = function (cb?: () => void) { if (cb) { cb(); return undefined; } return Promise.resolve(); };
  // pg-pool's pool.query() calls client.query(config, callback); fail the
  // statement with a stub error so Prisma gives up at once.
  proto.query = function (...args: unknown[]) {
    const cb = args.find((a) => typeof a === "function") as ((e: Error) => void) | undefined;
    const q = args[0];
    const cfg = (typeof q === "string" ? { text: q, values: args[1] } : q) as { text?: string; values?: unknown[] };
    if (/^\s*(INSERT|UPDATE)/i.test(String(cfg.text))) seen.push(...(cfg.values ?? []));
    const err = new Error("stub db");
    if (cb) { cb(err); return undefined; }
    return Promise.reject(err);
  };
  try {
    await run().catch(() => {});
  } finally {
    Object.assign(proto, saved);
  }
  return seen;
}

test("setting.update with value:{ set } on a sensitive key is stored as enc:v1 ciphertext, never plaintext", async () => {
  const values = await recordedValues(() =>
    prisma.setting.update({ where: { key: "radarrApiKey" }, data: { value: { set: "PLAINTEXT-API-KEY" } } }),
  );
  assert.ok(values.some((v) => typeof v === "string" && v.startsWith("enc:v1:")), `no ciphertext bound: ${JSON.stringify(values)}`);
  assert.ok(!values.includes("PLAINTEXT-API-KEY"), "the plaintext reached the driver");
});

test("setting.upsert with update.value:{ set } on a sensitive key is stored as enc:v1 ciphertext", async () => {
  const values = await recordedValues(() =>
    prisma.setting.upsert({
      where: { key: "radarrApiKey" },
      create: { key: "radarrApiKey", value: "CREATE-PLAINTEXT" },
      update: { value: { set: "UPDATE-PLAINTEXT" } },
    }),
  );
  assert.ok(values.some((v) => typeof v === "string" && v.startsWith("enc:v1:")), `no ciphertext bound: ${JSON.stringify(values)}`);
  assert.ok(!values.includes("UPDATE-PLAINTEXT"), "the { set } plaintext reached the driver");
  assert.ok(!values.includes("CREATE-PLAINTEXT"), "the create plaintext reached the driver");
});

test("setting.update writing a value without naming the row by key is refused before a query", async () => {
  // Without the key the extension can't tell whether the value is a secret; the
  // old best-effort path could fall through and store it unencrypted.
  const started = Date.now();
  const err = await thrown(() => prisma.setting.update({ where: { updatedAt: new Date() } as never, data: { value: "PLAINTEXT" } }));
  assert.match(err?.message ?? "", /without a string `where.key` is forbidden/);
  assert.ok(Date.now() - started < 50, "the refusal must come before any query");
});

test("setting.update / upsert with any value operator other than { set: string } are refused before a query", async () => {
  const bad = [{ increment: 1 }, { set: 5 }, { set: null }, {}] as unknown[];
  for (const value of bad) {
    const u = await thrown(() => prisma.setting.update({ where: { key: "radarrApiKey" }, data: { value: value as never } }));
    assert.match(u?.message ?? "", /non-string `value` operation is forbidden/, `update ${JSON.stringify(value)}`);
    const s = await thrown(() =>
      prisma.setting.upsert({ where: { key: "radarrApiKey" }, create: { key: "radarrApiKey", value: "x" }, update: { value: value as never } }),
    );
    assert.match(s?.message ?? "", /non-string `value` operation is forbidden/, `upsert ${JSON.stringify(value)}`);
  }
});

test("account.update with token:{ set } is stored as enc:v1 ciphertext for all three token columns", async () => {
  const values = await recordedValues(() =>
    prisma.account.update({
      where: { id: "acc1" },
      data: { access_token: { set: "AT-PLAIN" }, refresh_token: { set: "RT-PLAIN" }, id_token: { set: "IT-PLAIN" } },
    }),
  );
  for (const plain of ["AT-PLAIN", "RT-PLAIN", "IT-PLAIN"]) assert.ok(!values.includes(plain), `${plain} reached the driver`);
  assert.equal(values.filter((v) => typeof v === "string" && v.startsWith("enc:v1:")).length, 3);
});
