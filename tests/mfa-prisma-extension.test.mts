// Guardrail 7a for the two-factor secret: UserTotp.secret is encrypted at rest
// by the Prisma extension in src/lib/prisma.ts and decrypted on every read —
// callers never call encryptToken. Same three angles as
// tests/prisma-crypto-extension.test.mts (coverage read off the generated
// client, handler bodies wired to the helpers, reachability of the unhandled
// operations), plus a real encrypt→decrypt round-trip through the exported
// helpers, which the Setting/Account suite can't do without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

process.env.TOKEN_ENCRYPTION_KEY = "ef".repeat(32);
process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:1/none";

const errors: string[] = [];
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };

const { prisma, encryptTotpSecretInPlace, decryptTotpSecretInPlace } = await import("../src/lib/prisma.ts");
const SOURCE = readFileSync(new URL("../src/lib/prisma.ts", import.meta.url), "utf8");
const REPO = new URL("..", import.meta.url).pathname;

function handled(): string[] {
  const queryBlock = SOURCE.slice(SOURCE.indexOf("query: {"));
  const start = queryBlock.indexOf("      userTotp: {");
  assert.ok(start >= 0, "the extension declares no userTotp block");
  const segment = queryBlock.slice(start, queryBlock.indexOf("\n      },", start));
  return [...segment.matchAll(/^\s{8}async (\w+)\(/gm)].map((m) => m[1]);
}

function body(op: string): string {
  const queryBlock = SOURCE.slice(SOURCE.indexOf("query: {"));
  const start = queryBlock.indexOf("      userTotp: {");
  const segment = queryBlock.slice(start, queryBlock.indexOf("\n      },", start));
  const s = segment.indexOf(`        async ${op}(`);
  return segment.slice(s, segment.indexOf("\n        },", s));
}

// deleteMany returns a count (no rows), count/findRaw/aggregateRaw can't carry
// the column; delete/groupBy/aggregate CAN and are kept unused by the
// reachability test below.
const EXPECTED_UNHANDLED = ["delete", "deleteMany", "groupBy", "count", "aggregate", "findRaw", "aggregateRaw"];

test("every operation that can surface or write UserTotp.secret is intercepted", () => {
  const META = new Set(["fields", "name", "$name", "$parent"]);
  const real = Object.keys(prisma.userTotp as object).filter((k) => !META.has(k));
  assert.ok(real.length >= 15, "operation enumeration is broken");
  const h = new Set(handled());
  assert.deepEqual([...h].filter((op) => !real.includes(op)), [], "handlers for operations Prisma doesn't expose");
  assert.deepEqual(real.filter((op) => !h.has(op)).sort(), [...EXPECTED_UNHANDLED].sort());
});

test("read handlers decrypt; write handlers encrypt (bulk writes too — the value never depends on the row)", () => {
  for (const op of ["findUnique", "findFirst", "findUniqueOrThrow", "findFirstOrThrow", "findMany", "createManyAndReturn", "updateManyAndReturn"]) {
    assert.ok(body(op).includes("decryptTotpSecretInPlace"), `${op} returns rows without decrypting them`);
  }
  for (const op of ["create", "update", "upsert", "updateMany", "createMany", "updateManyAndReturn", "createManyAndReturn"]) {
    assert.match(body(op), /encryptTotp(SecretInPlace|RowsInPlace)/, `${op} writes the secret in plaintext`);
  }
});

test("round-trip: a written secret is enc:v1 ciphertext and reads back as the plaintext", () => {
  const data: Record<string, unknown> = { userId: "u1", secret: "JBSWY3DPEHPK3PXP" };
  encryptTotpSecretInPlace(data);
  assert.match(data.secret as string, /^enc:v1:/);
  assert.notEqual(data.secret, "JBSWY3DPEHPK3PXP");
  decryptTotpSecretInPlace(data);
  assert.equal(data.secret, "JBSWY3DPEHPK3PXP");

  const setForm: Record<string, unknown> = { secret: { set: "JBSWY3DPEHPK3PXP" } };
  encryptTotpSecretInPlace(setForm);
  assert.match((setForm.secret as { set: string }).set, /^enc:v1:/, "the { set } update form is encrypted too");
});

test("an undecryptable secret fails CLOSED to an empty string (verifies no code) and is logged", () => {
  const row: Record<string, unknown> = { userId: "u9", secret: "enc:v1:not-really-ciphertext" };
  decryptTotpSecretInPlace(row);
  assert.equal(row.secret, "");
  assert.ok(errors.some((e) => e.includes("[totp-crypto]") && e.includes("u9")));
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (p.includes("/generated/")) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|mjs)$/.test(p)) out.push(p);
  }
  return out;
}

test("nothing reaches the secret through an unintercepted path: no delete/groupBy/aggregate, no nested totp include", () => {
  const files = [...walk(join(REPO, "src")), ...walk(join(REPO, "scripts"))];
  assert.ok(files.length > 400);
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\.userTotp\.(delete|groupBy|aggregate)\s*\(/g)) offenders.push(`${f.slice(REPO.length)}: ${m[0]}`);
    // A nested `include: { totp: true }` from a user query is NOT intercepted by
    // the userTotp extension — it would hand back ciphertext (or, worse, leak it).
    for (const m of src.matchAll(/\btotp:\s*(true|\{)/g)) offenders.push(`${f.slice(REPO.length)}: nested ${m[0]}`);
  }
  assert.deepEqual(offenders, []);
});

test("guardrail 7a: no two-factor code path calls encryptToken itself", () => {
  const files = [...walk(join(REPO, "src", "lib", "mfa")), ...walk(join(REPO, "src", "app", "api", "profile", "mfa")), ...walk(join(REPO, "src", "app", "api", "auth", "sign-in", "mfa"))];
  assert.ok(files.length >= 10);
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /encryptToken/, f);
});
