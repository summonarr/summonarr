// databasePoolMax (src/lib/prisma.ts): DATABASE_POOL_MAX sizes the pg pool;
// anything that isn't a whole number from 1 to 100 keeps the default of 5.
// That number is the process's ceiling only while every copy of the module
// shares ONE client, in production too — pinned below.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://u:p@127.0.0.1:1/none";
// Production is the environment the one-client rule below has to hold in. Set
// before the first import; the client connects lazily, so nothing is dialled.
(process.env as Record<string, string>).NODE_ENV = "production";

const first = await import("../src/lib/prisma.ts");
const { databasePoolMax, DEFAULT_DATABASE_POOL_MAX } = first;

test("production: a second copy of prisma.ts (another server chunk) shares the one client and pool", async () => {
  // A specifier in a variable, as tests/session-revocation.test.mts does: a
  // literal "?chunk=" path is not a module TypeScript can resolve.
  const specifier = "../src/lib/prisma.ts?chunk=second";
  const second: typeof import("../src/lib/prisma.ts") = await import(specifier);
  assert.notEqual(second, first, "the two imports must be distinct module instances");
  assert.equal(process.env.NODE_ENV, "production");
  assert.equal(second.prisma, first.prisma, "one PrismaClient, so one pg pool, per process");
  assert.equal((globalThis as unknown as { prisma: unknown }).prisma, first.prisma);
});

test("DATABASE_POOL_MAX: a whole number from 1 to 100 is used; anything else keeps the default", () => {
  assert.equal(DEFAULT_DATABASE_POOL_MAX, 5);
  assert.equal(databasePoolMax(undefined), 5);
  assert.equal(databasePoolMax("12"), 12);
  assert.equal(databasePoolMax(" 8 "), 8);
  assert.equal(databasePoolMax("1"), 1);
  assert.equal(databasePoolMax("100"), 100);
  for (const bad of ["", "0", "101", "-3", "2.5", "1e2", "ten", "0x10"]) {
    assert.equal(databasePoolMax(bad), 5, JSON.stringify(bad));
  }
});
