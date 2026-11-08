// markLegacyPurgedAccounts recognises a scrubbed row by the same tombstone
// address purgedEmailFor writes: the SQL binds the two halves around the row's
// id rather than spelling the address again, so the two can't drift.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

const { prisma } = await import("../src/lib/prisma.ts");
const { markLegacyPurgedAccounts, purgedEmailFor } = await import("../src/lib/account-lifecycle.ts");

test("the legacy purge mark matches exactly the address a purge writes", async () => {
  let seen: { sql: string; values: unknown[] } | null = null;
  const db = prisma as unknown as Record<string, unknown>;
  const original = db.$executeRaw;
  db.$executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    seen = { sql: strings.join("?"), values };
    return 0;
  };
  try {
    await markLegacyPurgedAccounts();
  } finally {
    db.$executeRaw = original;
  }
  assert.ok(seen, "the backfill ran its UPDATE");
  const { sql, values } = seen as { sql: string; values: unknown[] };
  assert.match(sql, /email = \? \|\| id \|\| \?/);
  assert.equal(values.length, 2);
  const id = "abc123";
  assert.equal(`${String(values[0])}${id}${String(values[1])}`, purgedEmailFor(id));
});
