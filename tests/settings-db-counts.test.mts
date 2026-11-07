// readDbCounts — the settings System tab's database counts as ONE statement
// whose columns are the metric names. Pins the shape (one query, every name a
// column, bigint → number) over a stubbed $queryRaw; the SQL itself was run
// against a real Postgres 17 when it was written.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ef".repeat(32);
process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5432/db"; // never dialed

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaClientMethod } = await import("./_helpers.mts");
const { readDbCounts, dbCountQueries } = await import("../src/lib/settings-db-counts.ts");

type Call = { sql: string; values: unknown[] };
let calls: Call[] = [];
let answer: Record<string, unknown>[] = [];

shadowPrismaClientMethod(prisma, "$queryRaw", async (first: TemplateStringsArray | Call, ...values: unknown[]) => {
  if (Array.isArray(first)) calls.push({ sql: (first as TemplateStringsArray).join("?"), values });
  else calls.push({ sql: (first as Call).sql, values: (first as Call).values });
  return answer;
});

beforeEach(() => {
  calls = [];
  answer = [];
});

const NAMES = Object.keys(dbCountQueries(new Date(0)));

test("one statement, with every metric as a named column", async () => {
  answer = [Object.fromEntries(NAMES.map((n, i) => [n, BigInt(i + 1)]))];
  const counts = await readDbCounts(new Date("2026-11-07T12:00:00Z"));
  assert.equal(calls.length, 1, "the counts must be ONE query");
  for (const name of NAMES) assert.ok(calls[0].sql.includes(`AS "${name}"`), `${name} is not a column`);
  // Each value is the number in its OWN column — the names travel with the
  // values, so no count can take its neighbour's label.
  NAMES.forEach((name, i) => assert.equal(counts[name as keyof typeof counts], i + 1, name));
  assert.equal(typeof counts.totalRequests, "number");
});

test("the only parameter is the cache-expiry clock; enum values are SQL literals", async () => {
  answer = [{}];
  const now = new Date("2026-11-07T12:00:00Z");
  await readDbCounts(now);
  assert.deepEqual(calls[0].values, [now]);
  assert.match(calls[0].sql, /"status" = 'PENDING'/);
  assert.match(calls[0].sql, /"role" = 'ISSUE_ADMIN'/);
});

test("the TV coverage pair keeps its DISTINCT / EXISTS shape", () => {
  const q = dbCountQueries(new Date(0));
  assert.match(q.plexTvShows.sql, /COUNT\(DISTINCT "tmdbId"\) FROM "PlexLibraryItem" WHERE "mediaType" = 'TV'/);
  assert.match(q.plexShowsWithEps.sql, /COUNT\(DISTINCT p\."tmdbId"\)[\s\S]*EXISTS \(SELECT 1 FROM "TVEpisodeCache" e WHERE e\."tmdbId" = p\."tmdbId" AND e\.source = 'plex'\)/);
  assert.match(q.jellyfinShowsWithEps.sql, /EXISTS \(SELECT 1 FROM "TVEpisodeCache" e WHERE e\."tmdbId" = j\."tmdbId" AND e\.source = 'jellyfin'\)/);
});

test("a missing column reads as 0, never NaN", async () => {
  answer = [{ totalRequests: 5n }];
  const counts = await readDbCounts(new Date());
  assert.equal(counts.totalRequests, 5);
  assert.equal(counts.playHistoryEntries, 0);
});
