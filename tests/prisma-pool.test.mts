// databasePoolMax (src/lib/prisma.ts): DATABASE_POOL_MAX sizes the pg pool;
// anything that isn't a whole number from 1 to 100 keeps the default of 5.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://u:p@127.0.0.1:1/none";

const { databasePoolMax, DEFAULT_DATABASE_POOL_MAX } = await import("../src/lib/prisma.ts");

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
