// getMdblistTopRated carries the background flag to BOTH of its MDBList reads
// (the top-lists index and each list's items), so the warm-list-cache cron
// stops at the reserve the plan keeps for pages (guardrail 31b) while the /top
// page still reads. The call-site scan is tests/mdblist-background-callers.test.mts;
// this pins that the flag actually reaches MDBList's pause check.
//
// ORDER-DEPENDENT: the usage report is process-wide. Each file runs in its own
// process, so this one starts clean.
//
// No DB or network: prisma.setting / prisma.tmdbCache are shadowed, fetch is
// scripted, and dns/promises.lookup is stubbed.
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

const T0 = Date.UTC(2026, 9, 28, 7, 27, 30);
mock.timers.enable({ apis: ["Date"], now: T0 });
const MIDNIGHT = Date.UTC(2026, 9, 29, 0, 0, 0);

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { fetchAndCacheMdblistForTmdb, getMdblistTopRated, mdblistPause } = await import("../src/lib/mdblist.ts");

shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) =>
    args.where.key === "mdblistApiKey" ? { key: "mdblistApiKey", value: "test-mdblist-key" } : null,
});
// Cache keys a test wants served (key → value); everything else is a miss.
const cached = new Map<string, unknown>();
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => {
    const value = cached.get(args.where.key);
    return value === undefined
      ? null
      : { key: args.where.key, data: JSON.stringify(value), cachedAt: new Date(T0), expiresAt: new Date(T0 + 86_400_000) };
  },
  findMany: async () => [],
  upsert: async (args: { create: unknown }) => args.create,
  deleteMany: async () => ({ count: 0 }),
});

const fetchCalls: URL[] = [];
// The account sits exactly at the 25% reserve (25,000 of 100,000 left).
const usage = {
  "x-ratelimit-limit": "100000",
  "x-ratelimit-remaining": "25000",
  "x-ratelimit-reset": String(Math.floor(MIDNIGHT / 1000)),
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...usage } });
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  if (url.pathname === "/lists/top") return json([{ id: 7, name: "Top", slug: "top", items: 1, likes: 1 }]);
  if (url.pathname === "/lists/7/items") {
    return json([{ id: 1, rank: 1, title: "Film", year: 2020, mediatype: "movie", imdb_id: null, tmdb_id: 42, score: 90 }]);
  }
  return json({ title: "x", ratings: [{ source: "imdb", value: 7 }] });
}) as typeof fetch;

beforeEach(() => {
  fetchCalls.length = 0;
  cached.clear();
});

test("setup: a page read brings the account to the reserve, which stops background callers only", async () => {
  await fetchAndCacheMdblistForTmdb(1, "movie", "mdblist:tmdb:movie:1");
  assert.equal(mdblistPause({ background: true }), "reserve");
  assert.equal(mdblistPause(), null);
});

test("a background top-rated read sends nothing at the reserve — not even the top-lists index", async () => {
  assert.deepEqual(await getMdblistTopRated("movie", 2, { background: true }), []);
  assert.equal(fetchCalls.length, 0);
});

test("a background top-rated read with the index cached still sends no list-items request", async () => {
  cached.set("mdblist:top-lists", [{ id: 7, name: "Top", slug: "top", items: 1, likes: 1 }]);
  assert.deepEqual(await getMdblistTopRated("movie", 2, { background: true }), []);
  assert.equal(fetchCalls.length, 0, "the list-items read carries the flag too");
});

test("the same read from a page still reaches MDBList", async () => {
  const items = await getMdblistTopRated("movie", 2);
  assert.deepEqual(items.map((m) => m.id), [42]);
  assert.deepEqual(fetchCalls.map((u) => u.pathname), ["/lists/top", "/lists/7/items"]);
});
