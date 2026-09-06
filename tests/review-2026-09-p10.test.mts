// Review 2026-09, package P10 (f80): the transcode-pressure "titles" leaderboard
// keys its React rows on (mediaType, tmdbId | lower(title)) — the SAME tuple the
// SQL in getTranscodeOffenders groups by. TMDB movie and TV ids are separate
// namespaces that overlap numerically, so a movie and a series sharing an
// integer come back as two rows; the component
// (src/components/admin/transcode-pressure.tsx) must not collapse them to one key.
//
// The suite does not render .tsx, so what is pinned here is the contract the key
// depends on: the titles statement must keep "mediaType" in BOTH its GROUP BY
// and its projection. A future "simplification" that groups by tmdbId alone (or
// drops mediaType from the SELECT) would silently reintroduce duplicate sibling
// keys, and nothing else would catch it.
//
// No DB: $queryRawUnsafe is shadowed to capture the SQL and return [].
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

console.warn = () => {};
console.error = () => {};

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaClientMethod } = await import("./_helpers.mts");
const { getTranscodeOffenders } = await import("../src/lib/play-history.ts");

const captured: { sql: string; params: unknown[] }[] = [];
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string, ...params: unknown[]) => {
  captured.push({ sql, params });
  return [];
});

test("getTranscodeOffenders titles statement groups by AND projects mediaType (the React-key dimension)", async () => {
  captured.length = 0;
  // Distinct days/limit from any other suite so the memoized cache key is fresh.
  const result = await getTranscodeOffenders({ days: 41 }, 9);

  const titles = captured.find((c) => c.sql.includes('FROM "PlayHistory"') && c.sql.includes("MAX(\"title\")"));
  assert.ok(titles, "expected the titles statement to be issued");

  // GROUP BY carries the mediaType dimension alongside tmdbId …
  assert.match(
    titles.sql,
    /GROUP BY\s+"tmdbId",\s*"mediaType"/,
    "titles GROUP BY must include \"mediaType\" next to \"tmdbId\"",
  );
  // … and the projection exposes it, so the component can key on it.
  assert.match(
    titles.sql,
    /SELECT[\s\S]*"mediaType"::text AS "mediaType"[\s\S]*FROM "PlayHistory"/,
    "titles SELECT must project \"mediaType\"",
  );
  // The null-tmdbId bucket is LOWER(title) — the component lowercases the
  // fallback title to mirror it.
  assert.ok(titles.sql.includes('LOWER("title")'), "null-tmdbId bucket must be LOWER(\"title\")");

  assert.deepEqual(result, { topUsers: [], topTitles: [] });
});

test("TranscodeOffenders.topTitles wire shape carries mediaType through the mapper", async () => {
  captured.length = 0;
  shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string, ...params: unknown[]) => {
    captured.push({ sql, params });
    if (sql.includes("MAX(\"title\")")) {
      // A movie and a series sharing tmdbId 1399 — two SQL rows.
      return [
        { title: "Game of Thrones", tmdbId: 1399, mediaType: "TV", count: 7n },
        { title: "Some Movie", tmdbId: 1399, mediaType: "MOVIE", count: 3n },
      ];
    }
    return [];
  });
  const result = await getTranscodeOffenders({ days: 43 }, 11);
  assert.deepEqual(result.topTitles, [
    { title: "Game of Thrones", tmdbId: 1399, mediaType: "TV", count: 7 },
    { title: "Some Movie", tmdbId: 1399, mediaType: "MOVIE", count: 3 },
  ]);
  // Mirrors the component's key derivation: same tmdbId, distinct keys.
  const keys = result.topTitles.map(
    (t) => `${t.mediaType ?? ""}:${t.tmdbId != null ? `id:${t.tmdbId}` : `t:${t.title.toLowerCase()}`}`,
  );
  assert.equal(new Set(keys).size, keys.length, "keys must be distinct across mediaType");
});
