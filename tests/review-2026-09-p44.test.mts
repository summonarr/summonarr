// Review 2026-09 / P44 (f34): DELETE /api/admin/clear-cache?source=tmdb must wipe EVERY
// TmdbCache key namespace src/lib/tmdb.ts writes. Before the fix SOURCE_PREFIXES.tmdb
// lacked `search:` (searchMulti), `collection:` (getMovieCollection, 7-day TTL) and
// `movies:` (popular/upcoming/top_rated + the paged popular list — `movie:` does not
// prefix-match `movies:…` because the "s" precedes the colon), so a "cleared" TMDB cache
// kept serving stale search results, collection pages and popular-movies pages until TTL,
// and `?source=all` (the flat union) missed them too.
//
// Two pins:
//   1. the deleteMany OR sent for ?source=tmdb names those three prefixes explicitly;
//   2. a DRIFT pin: every literal `const key = "<ns>:…"` / `` `<ns>:…` `` in src/lib/tmdb.ts
//      is prefix-matched by at least one tmdb entry, so a new namespace added to the TMDB
//      layer without a matching clear-cache prefix fails here rather than silently rotting.
//
// Harness: an in-memory prisma stub (no DB, no network) seeded on globalThis before the
// module graph loads, a real signSessionJwt bearer token (skips the UA-fingerprint check,
// the DB-checked verify still runs in full), same shape as tests/admin-routes.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "review-2026-09-p44-test-secret-0123456789";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";

console.warn = () => {};
console.error = () => {};

type DbUser = {
  id: string; role: string; permissions: bigint; name: string | null; email: string | null;
  mediaServer: string | null; notificationEmail: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
  purgedAt: Date | null;
};
const usersById = new Map<string, DbUser>();
const authSessionsById = new Map<string, { userId: string; deviceLabel: string | null; createdAt: Date }>();
const deleteManyArgs: Array<{ where: { OR: Array<{ key: { startsWith: string } }> } }> = [];

const fakePrisma = {
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
    findMany: async () => [],
  },
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) => {
      const row = authSessionsById.get(args.where.sessionId);
      return row
        ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId, userId: row.userId, deviceLabel: row.deviceLabel }
        : null;
    },
    update: async () => ({}),
    findMany: async () => [],
  },
  setting: { findUnique: async () => null },
  tmdbCache: {
    deleteMany: async (args: { where: { OR: Array<{ key: { startsWith: string } }> } }) => {
      deleteManyArgs.push(args);
      return { count: 4 };
    },
  },
  auditLog: { create: async (args: { data: Record<string, unknown> }) => args.data },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

const { NextRequest } = await import("next/server");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { DELETE: clearCache } = await import("../src/app/api/admin/clear-cache/route.ts");

let seq = 0;
async function mintAdmin(): Promise<Record<string, string>> {
  seq++;
  const userId = `p44-admin-${seq}`;
  const sessionId = `p44-sess-${seq}`;
  usersById.set(userId, {
    id: userId, role: "ADMIN", permissions: 0n, name: `Admin ${seq}`, email: "admin@example.com",
    mediaServer: null, notificationEmail: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null, purgedAt: null,
  });
  authSessionsById.set(sessionId, { userId, deviceLabel: "p44-device", createdAt: new Date() });
  const token = await signSessionJwt(
    { id: userId, role: "ADMIN", permissions: "0", provider: "credentials", sessionId, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
    { expiresInSeconds: 7_200 },
  );
  return { authorization: `Bearer ${token}` };
}

async function prefixesFor(source: string): Promise<string[]> {
  const headers = await mintAdmin();
  deleteManyArgs.length = 0;
  const res = await clearCache(
    new NextRequest(`http://localhost:3000/api/admin/clear-cache?source=${source}`, { method: "DELETE", headers }),
    undefined,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { source, cleared: 4 });
  assert.equal(deleteManyArgs.length, 1, "exactly one TmdbCache.deleteMany per clear");
  return deleteManyArgs[0].where.OR.map((c) => c.key.startsWith);
}

// Every literal key namespace src/lib/tmdb.ts writes through setCache. The regex
// catches `const key = "ns:…"` and `const key = \`ns:…\`` — the only two spellings in
// that file — and also the inline setCache(`ns:…`) template calls.
function tmdbKeyNamespaces(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "..", "src", "lib", "tmdb.ts"), "utf8");
  const out = new Set<string>();
  for (const m of src.matchAll(/(?:const key = |setCache\()["'`]([a-z_]+):/g)) out.add(`${m[1]}:`);
  return [...out].sort();
}

test("f34: ?source=tmdb wipes search:, collection: and movies: rows (movie: does not cover movies:)", async () => {
  const prefixes = await prefixesFor("tmdb");
  for (const p of ["search:", "collection:", "movies:", "movie:", "tv:"]) {
    assert.ok(prefixes.includes(p), `tmdb clear must include the ${p} namespace; got ${JSON.stringify(prefixes)}`);
  }
  // The exact reason `movies:` is its own entry: startsWith is a prefix test, not a stem test.
  assert.equal("movies:popular:page:1".startsWith("movie:"), false);
  assert.equal("movies:popular:page:1".startsWith("movies:"), true);
});

test("f34: ?source=all is the flat union, so it inherits the three namespaces too", async () => {
  const prefixes = await prefixesFor("all");
  for (const p of ["search:", "collection:", "movies:", "mdblist:", "omdb:"]) {
    assert.ok(prefixes.includes(p), `all clear must include ${p}; got ${JSON.stringify(prefixes)}`);
  }
});

test("f34 drift pin: every TmdbCache key namespace written by src/lib/tmdb.ts is covered by a tmdb prefix", async () => {
  const prefixes = await prefixesFor("tmdb");
  const namespaces = tmdbKeyNamespaces();
  // Sanity: the scan actually found the namespaces this pin exists for.
  for (const expected of ["movie:", "movies:", "tv:", "search:", "collection:", "person:", "trending:", "genres:", "watchproviders:"]) {
    assert.ok(namespaces.includes(expected), `source scan lost the ${expected} namespace — fix the regex, not the assertion`);
  }
  const uncovered = namespaces.filter((ns) => !prefixes.some((p) => ns.startsWith(p)));
  assert.deepEqual(uncovered, [], `src/lib/tmdb.ts writes TmdbCache namespaces the tmdb clear never deletes: ${JSON.stringify(uncovered)} — add them to SOURCE_PREFIXES.tmdb in src/app/api/admin/clear-cache/route.ts`);
});
