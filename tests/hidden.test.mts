// Unit tests for getUserHiddenSet (src/lib/hidden.ts) — the per-user "not
// interested" set. The whole point of the module is the key transform: the
// Prisma enum stores mediaType as "MOVIE"/"TV" but the filter side in
// attach-all.ts uses the lowercase TMDB casing, so the key MUST be lowercased
// here or Set.has never matches and per-user hiding silently breaks on every
// discovery surface. The function's sole impurity is one hiddenItem.findMany;
// the test shadows that delegate in-memory (the jellyfin-config.test pattern).
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.ts";
import { getUserHiddenSet } from "../src/lib/hidden.ts";

type StubRow = { tmdbId: number; mediaType: "MOVIE" | "TV" };

let nextRows: StubRow[] = [];
const findManyCalls: Array<{ where?: { userId?: string }; select?: unknown }> = [];

const hiddenItemStub = {
  findMany: async (args: { where?: { userId?: string }; select?: unknown }): Promise<StubRow[]> => {
    findManyCalls.push(args);
    return nextRows;
  },
};

// Shadow the delegate BEFORE any test runs; fail fast if a Prisma upgrade ever
// stops the shadow from taking effect (otherwise the first call would issue a
// real query against a DB that doesn't exist and hang).
(prisma as unknown as { hiddenItem: unknown }).hiddenItem = hiddenItemStub;
if ((prisma as unknown as { hiddenItem: unknown }).hiddenItem !== hiddenItemStub) {
  throw new Error("could not shadow prisma.hiddenItem with the in-memory stub — aborting before a real DB query can hang");
}

test("keys are '{tmdbId}:{lowercased mediaType}' — the attach-all keyspace", async () => {
  nextRows = [
    { tmdbId: 603, mediaType: "MOVIE" },
    { tmdbId: 1399, mediaType: "TV" },
  ];
  const set = await getUserHiddenSet("u_1");
  assert.deepEqual([...set].sort(), ["1399:tv", "603:movie"]);
  // The uppercase enum casing must NOT leak into the keyspace.
  assert.equal(set.has("603:MOVIE"), false);
  assert.equal(set.has("1399:TV"), false);
});

test("scopes the query to the given user", async () => {
  findManyCalls.length = 0;
  nextRows = [];
  await getUserHiddenSet("u_42");
  assert.equal(findManyCalls.length, 1);
  assert.deepEqual(findManyCalls[0].where, { userId: "u_42" });
});

test("no hidden rows → empty set", async () => {
  nextRows = [];
  const set = await getUserHiddenSet("u_1");
  assert.equal(set.size, 0);
});
