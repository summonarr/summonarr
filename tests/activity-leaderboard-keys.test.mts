// Review 2026-09 package P82 — the two activity leaderboards whose React keys
// collided because the query grouped by (or joined on) something the mapped
// result did not expose:
//
//   f77 getHeatmapCellDetail.topTitles groups by ("tmdbId", "mediaType") but
//       dropped mediaType on the way out, so a movie and a series sharing a
//       TMDB integer (the two id spaces overlap) rendered with one React key
//       and both linked to a blended, untyped stats page.
//   f79 getTranscodeOffenders.topUsers groups by "mediaServerUserId" but
//       exposed only (username, source) — username is not unique across
//       instances (guardrail 35) or a departed + re-created row (guardrail 28).
//
// These pin the MAPPED shape (the SQL projection is pinned in
// tests/play-history-sql.test.mts): the stub answers each statement by its
// SQL text with rows that share every column the old key was built from and
// differ only in the new one, and the result must keep both rows distinct.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

console.warn = () => {};
console.error = () => {};

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { getHeatmapCellDetail, getTranscodeOffenders } = await import("../src/lib/play-history.ts");

shadowPrismaModel(prisma, "setting", { findMany: async () => [] });

shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string): Promise<unknown[]> => {
  // Heatmap topTitles: same tmdbId, two media types.
  if (sql.includes(`GROUP BY "tmdbId", "mediaType"`)) {
    return [
      { title: "Shared Id (movie)", tmdbId: 1399, mediaType: "MOVIE", count: 3n },
      { title: "Shared Id (series)", tmdbId: 1399, mediaType: "TV", count: 2n },
    ];
  }
  // Transcode top users: same (source, username), two MediaServerUser rows.
  if (sql.includes(`JOIN "MediaServerUser" m`) && sql.includes(`"playMethod" = 'Transcode'`)) {
    return [
      { id: "msu-default", username: "chris", source: "jellyfin", count: 5n },
      { id: "msu-remote", username: "chris", source: "jellyfin", count: 4n },
    ];
  }
  return [];
});

test("f77: heatmap topTitles keeps mediaType so a movie and a series sharing a tmdbId stay two rows", async () => {
  const detail = await getHeatmapCellDetail({ mode: "day", day: "2026-09-03" });
  assert.deepEqual(
    detail.topTitles,
    [
      { title: "Shared Id (movie)", tmdbId: 1399, mediaType: "MOVIE", count: 3 },
      { title: "Shared Id (series)", tmdbId: 1399, mediaType: "TV", count: 2 },
    ],
    "the mapped rows must expose the mediaType the SQL grouped by",
  );
  // The popover keys on (mediaType, tmdbId | title) — the tuple must be distinct.
  const keys = detail.topTitles.map((t) => `${t.mediaType ?? ""}:${t.tmdbId != null ? `id:${t.tmdbId}` : `t:${t.title}`}`);
  assert.equal(new Set(keys).size, keys.length, `popover keys collide: ${keys.join(", ")}`);
});

test("f79: transcode topUsers exposes the MediaServerUser id so two rows sharing (source, username) stay distinct", async () => {
  const offenders = await getTranscodeOffenders({ days: 9 }, 6);
  assert.deepEqual(
    offenders.topUsers,
    [
      { id: "msu-default", username: "chris", source: "jellyfin", count: 5 },
      { id: "msu-remote", username: "chris", source: "jellyfin", count: 4 },
    ],
    "the mapped rows must carry the row id — username is not unique",
  );
  const keys = offenders.topUsers.map((u) => `${u.source}:${u.id}`);
  assert.equal(new Set(keys).size, keys.length, `leaderboard keys collide: ${keys.join(", ")}`);
});
