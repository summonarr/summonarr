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
//   2. Reachability — the six deliberately-unhandled operations must stay
//      unused. `setting.delete()` returns the deleted row INCLUDING its value,
//      and `account.delete()` returns the token columns; neither is wrapped, so
//      both would hand the caller raw ciphertext. Today nothing calls them, and
//      that — not the extension — is the only thing closing that hole. This
//      test makes the boundary explicit: start using one and you must extend
//      the extension first.
//   3. Behaviour — the bypass guards (createMany/updateMany and their *AndReturn
//      twins, which apply one payload to many rows and so cannot be encrypted
//      per-key) must actually throw, and must throw BEFORE any query is issued.
//
// No database: the guards throw synchronously inside the extension, so they are
// reachable with DATABASE_URL pointed at a closed port. The one test that
// deliberately lets a call through asserts it fails on the CONNECTION instead,
// which is what proves the guard was not what stopped it.
//
// KNOWN LIMIT, stated plainly: the decrypt/encrypt wiring is checked by reading
// the handler SOURCE, not by observing a round-trip — the read path needs a real
// query to decrypt, and this suite never touches a database. So it catches a
// crypto call that was DELETED (the realistic refactor slip, and the shape both
// historical gaps took) but not one that was left in place and made unreachable
// by an early return. Verified by mutation: dropping the decrypt line from an
// *OrThrow handler, dropping the encrypt from account.create, and adding a new
// read handler with no decrypt are all caught; an `if (true) return query(args)`
// inserted above intact code is not. Closing that last case needs an integration
// test against a real Postgres, which is out of scope for this suite.
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
// not console.error. Unexplained `prisma:error` lines in a 190-file suite run
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

const SOURCE = readFileSync(new URL("../src/lib/prisma.ts", import.meta.url), "utf8");

// ── what the extension actually handles ─────────────────────────────────────

/** Operation names the extension declares under `query: { <model>: { … } }`. */
function handledOperations(model: "setting" | "account"): string[] {
  const queryBlock = SOURCE.slice(SOURCE.indexOf("query: {"));
  const start = queryBlock.indexOf(`      ${model}: {`);
  assert.ok(start >= 0, `the extension declares no query block for ${model} — parse or source drift`);
  const segment = queryBlock.slice(start, queryBlock.indexOf("\n      },", start));
  return [...segment.matchAll(/^\s{8}async (\w+)\(/gm)].map((m) => m[1]);
}

/** Source body of one declared handler, for checking it does real work. */
function handlerBody(model: "setting" | "account", op: string): string {
  const queryBlock = SOURCE.slice(SOURCE.indexOf("query: {"));
  const modelStart = queryBlock.indexOf(`      ${model}: {`);
  const segment = queryBlock.slice(modelStart, queryBlock.indexOf("\n      },", modelStart));
  const start = segment.indexOf(`        async ${op}(`);
  assert.ok(start >= 0, `${model}.${op} has no handler to read`);
  // Handlers are uniformly indented, so the next 8-space `},` closes this one.
  const end = segment.indexOf("\n        },", start);
  return segment.slice(start, end === -1 ? undefined : end);
}

/** Real operations Prisma exposes on a delegate, read off the generated client. */
function delegateOperations(model: "setting" | "account"): string[] {
  const META = new Set(["fields", "name", "$name", "$parent"]);
  return Object.keys(prisma[model] as object).filter((k) => !META.has(k));
}

const HANDLED = {
  setting: handledOperations("setting"),
  account: handledOperations("account"),
};

// Deliberately unhandled. `count` returns a scalar and `findRaw`/`aggregateRaw`
// are MongoDB-only, so those three are structurally incapable of leaking a
// column. `delete`, `groupBy` and `aggregate` CAN surface the protected columns
// and are unhandled purely because nothing calls them — see the reachability
// test below, which is what keeps that true.
const EXPECTED_UNHANDLED = ["delete", "groupBy", "count", "aggregate", "findRaw", "aggregateRaw"];

// ── non-vacuity ─────────────────────────────────────────────────────────────

test("both the delegate enumeration and the source parse found real data", () => {
  for (const model of ["setting", "account"] as const) {
    const ops = delegateOperations(model);
    assert.ok(ops.length >= 15, `only ${ops.length} operations enumerated on prisma.${model} — the probe is broken`);
    assert.ok(ops.includes("findMany") && ops.includes("upsert"), `prisma.${model} is missing core operations`);
    assert.ok(HANDLED[model].length >= 10, `only ${HANDLED[model].length} handlers parsed for ${model} — the parse is broken`);
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

test("the unhandled set is exactly the six known-safe operations — a Prisma upgrade cannot widen it silently", () => {
  for (const model of ["setting", "account"] as const) {
    const handled = new Set(HANDLED[model]);
    const unhandled = delegateOperations(model).filter((op) => !handled.has(op)).sort();
    assert.deepEqual(
      unhandled,
      [...EXPECTED_UNHANDLED].sort(),
      `${model}: the set of operations bypassing the crypto extension changed. If Prisma added an operation, ` +
        "decide deliberately whether it can surface Setting.value / the Account token columns and either handle " +
        "it in src/lib/prisma.ts or add it to EXPECTED_UNHANDLED with a reason.",
    );
  }
});

test("guardrail 7a: the *OrThrow twins are handled wherever their base operation is", () => {
  // The documented recurring bug. findUniqueOrThrow is NOT an alias for
  // findUnique — it is a separate operation with its own interception point,
  // and an uncovered one returns ciphertext.
  for (const model of ["setting", "account"] as const) {
    const handled = new Set(HANDLED[model]);
    for (const base of ["findUnique", "findFirst"]) {
      assert.ok(handled.has(base), `${model}.${base} is not handled`);
      assert.ok(
        handled.has(`${base}OrThrow`),
        `${model}.${base}OrThrow is NOT handled while ${model}.${base} is. They are separate Prisma operations, ` +
          "not aliases — the OrThrow variant returns raw ciphertext to the caller.",
      );
    }
  }
});

test("guardrail 7a: the *AndReturn twins are handled wherever their base operation is", () => {
  // Same class: createManyAndReturn is a distinct operation from createMany.
  for (const model of ["setting", "account"] as const) {
    const handled = new Set(HANDLED[model]);
    for (const base of ["createMany", "updateMany"]) {
      assert.ok(handled.has(base), `${model}.${base} is not handled`);
      assert.ok(
        handled.has(`${base}AndReturn`),
        `${model}.${base}AndReturn is NOT handled while ${model}.${base} is — a distinct operation, and the ` +
          "AndReturn variant both writes AND reads back the protected column.",
      );
    }
  }
});

// Declaring a handler is not the same as doing the work. A read handler that
// exists but returns `query(args)` untouched passes every coverage check above
// while shipping raw ciphertext to the caller — and it looks entirely
// unremarkable in a diff. These two tests read the handler bodies and require
// each one to actually invoke the crypto helper its position demands.

const DECRYPT_HELPER = {
  setting: "safeDecryptSettingValue",
  account: "decryptAccountTokensInPlace",
} as const;
const ENCRYPT_HELPER = {
  setting: /encryptToken|encryptSettingRowsInPlace/,
  account: /encryptAccountTokensInPlace|assertNoAccountTokens/,
} as const;

const READ_OPS = ["findUnique", "findFirst", "findUniqueOrThrow", "findFirstOrThrow", "findMany"];
const SINGLE_WRITE_OPS = ["create", "update", "upsert"];
const MANY_WRITE_OPS = ["createMany", "updateMany", "createManyAndReturn", "updateManyAndReturn"];

test("every READ handler actually decrypts — not just declared, but wired to the helper", () => {
  for (const model of ["setting", "account"] as const) {
    for (const op of READ_OPS) {
      const body = handlerBody(model, op);
      assert.ok(
        body.includes(DECRYPT_HELPER[model]),
        `${model}.${op} is declared but never calls ${DECRYPT_HELPER[model]} — it hands the caller raw ` +
          `ciphertext while looking fully covered.\n  ${body.replace(/\s+/g, " ").slice(0, 160)}`,
      );
    }
  }
});

test("every WRITE handler either encrypts or explicitly refuses the bypass", () => {
  for (const model of ["setting", "account"] as const) {
    for (const op of [...SINGLE_WRITE_OPS, ...MANY_WRITE_OPS]) {
      const body = handlerBody(model, op);
      const encrypts = ENCRYPT_HELPER[model].test(body);
      const refuses = /is forbidden — use/.test(body);
      assert.ok(
        encrypts || refuses,
        `${model}.${op} neither encrypts nor refuses — a write through it lands in PLAINTEXT at rest ` +
          `(guardrail 7a).\n  ${body.replace(/\s+/g, " ").slice(0, 160)}`,
      );
    }
    // The *AndReturn pair both writes AND reads back, so it owes the decrypt too
    // — unless it refuses outright, in which case nothing is returned at all.
    for (const op of ["createManyAndReturn", "updateManyAndReturn"]) {
      const body = handlerBody(model, op);
      if (/is forbidden — use/.test(body) && !body.includes("await query")) continue;
      assert.ok(
        body.includes(DECRYPT_HELPER[model]),
        `${model}.${op} returns rows without decrypting them — it both writes and reads back`,
      );
    }
  }
});

test("both models are covered identically — divergence is how one of them grows a hole", () => {
  assert.deepEqual(
    [...HANDLED.setting].sort(),
    [...HANDLED.account].sort(),
    "setting and account no longer intercept the same operation set. The protected columns differ but the " +
      "operations that can reach them do not, so a handler present on one and missing on the other is a gap.",
  );
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
  const risky = ["delete", "groupBy", "aggregate"];
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
    "a call reached an operation the crypto extension does not intercept. `.delete()` returns the deleted row " +
      "with its protected columns still encrypted; `.groupBy()`/`.aggregate()` can project them. Handle the " +
      "operation in src/lib/prisma.ts first, or use the deleteMany/findMany equivalents that are covered.",
  );
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

test("setting.deleteMany releases the decrypt-failure entry for the deleted key(s)", () => {
  // Same source-read technique as the read/write handler pins above (no DB to
  // observe a round-trip): reverting the handler to a bare `return query(args)`
  // must fail here.
  const body = handlerBody("setting", "deleteMany");
  assert.ok(
    body.includes("settingDecryptFailures") && body.includes("settingKeysFromDeleteWhere"),
    "setting.deleteMany no longer releases decrypt-failure entries — a corrupt row removed via " +
      "Disconnect / de-register keeps the settings banner alive until the process restarts.\n  " +
      body.replace(/\s+/g, " ").slice(0, 200),
  );
  // Release AFTER the delete resolves (guardrail 27 ordering): a failed delete
  // must leave the entry in place.
  const queryAt = body.indexOf("await query(args)");
  const releaseAt = body.indexOf("settingDecryptFailures");
  assert.ok(queryAt >= 0 && releaseAt > queryAt, "the release must run after `await query(args)`, not before");
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
