// The episode cache's unchanged-set skip against a REAL Postgres. The unit suite
// pins the call sequence with a fake digest; only a real database can prove that
// the JS digest (episodeCacheDigest) and the SQL one computed over the stored
// rows agree byte for byte — and that a stored row edited by anyone else is
// seen as a change. If the two ever disagree on a value, the skip just stops
// firing for that set (the rewrite runs, as it always did); these tests make
// that silent loss visible.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma, resetDb, closeDb } from "./_harness.mts";
import { replaceEpisodeCacheForSource, type EpisodeCacheRow } from "@/lib/episode-cache.ts";

before(resetDb);
beforeEach(resetDb);
after(closeDb);

// Values chosen to stress the text encoding on both sides: multi-byte UTF-8
// (accents, CJK, an emoji outside the BMP), the field separators themselves,
// quotes, backslashes, newlines, empty strings vs nulls, a zero runtime, a
// pre-1970 timestamp and millisecond precision.
const rows = (): EpisodeCacheRow[] => [
  { tmdbId: 1399, seasonNumber: 1, episodeNumber: 1, episodeName: "Winter Is Coming", airDate: "2011-04-17", stillPath: "/still1.jpg", runtime: 62, overview: "Lord Stark…", addedAt: new Date("2024-03-01T10:00:00.123Z") },
  { tmdbId: 1399, seasonNumber: 1, episodeNumber: 2, episodeName: "", airDate: null, stillPath: null, runtime: 0, overview: "", addedAt: null },
  { tmdbId: 1399, seasonNumber: 0, episodeNumber: 1, episodeName: "Épisode spécial — 日本語 🎬", airDate: "2010-12-05", stillPath: null, runtime: null, overview: null, addedAt: new Date("1969-07-20T20:17:40.001Z") },
  { tmdbId: 42, seasonNumber: 3, episodeNumber: 10, episodeName: "a|b:c", airDate: "-", stillPath: "0:", runtime: 2147483647, overview: "line one\nline \"two\" \\ three\t", addedAt: new Date("2026-11-06T20:05:47.999Z") },
];

async function stored(source: "plex" | "jellyfin") {
  return prisma.tVEpisodeCache.findMany({
    where: { source },
    orderBy: [{ tmdbId: "asc" }, { seasonNumber: "asc" }, { episodeNumber: "asc" }],
  });
}

test("a set written once compares as unchanged on the next run, in any order", async () => {
  assert.equal(await replaceEpisodeCacheForSource("plex", rows()), "replaced");
  const before = await stored("plex");
  assert.equal(before.length, 4);

  assert.equal(await replaceEpisodeCacheForSource("plex", rows()), "unchanged", "the JS and SQL digests must agree");
  assert.equal(await replaceEpisodeCacheForSource("plex", rows().reverse()), "unchanged");
  assert.deepEqual(await stored("plex"), before, "a skipped run leaves every row as it was");
  assert.equal(await prisma.tVEpisodeCacheStaging.count(), 0, "nothing was staged");
});

test("a changed field rewrites, and the next identical run skips again", async () => {
  await replaceEpisodeCacheForSource("jellyfin", rows());
  const changed = rows();
  changed[3] = { ...changed[3], overview: "line one\nline \"two\" \\ three" }; // trailing tab dropped
  assert.equal(await replaceEpisodeCacheForSource("jellyfin", changed), "replaced");
  const row = (await stored("jellyfin")).find((r) => r.tmdbId === 42);
  assert.equal(row?.overview, "line one\nline \"two\" \\ three");
  assert.equal(await replaceEpisodeCacheForSource("jellyfin", changed), "unchanged");
});

test("a one-millisecond addedAt change is a change", async () => {
  await replaceEpisodeCacheForSource("plex", rows());
  const changed = rows();
  changed[0] = { ...changed[0], addedAt: new Date("2024-03-01T10:00:00.124Z") };
  assert.equal(await replaceEpisodeCacheForSource("plex", changed), "replaced");
});

test("an edit made by another writer is seen, and the sync puts the server's row back", async () => {
  await replaceEpisodeCacheForSource("plex", rows());
  // The season page's TMDB refresh updates rows in place, outside the sync.
  await prisma.tVEpisodeCache.update({
    where: { source_tmdbId_seasonNumber_episodeNumber: { source: "plex", tmdbId: 1399, seasonNumber: 1, episodeNumber: 1 } },
    data: { overview: "TMDB's text" },
  });
  assert.equal(await replaceEpisodeCacheForSource("plex", rows()), "replaced");
  const row = (await stored("plex")).find((r) => r.seasonNumber === 1 && r.episodeNumber === 1);
  assert.equal(row?.overview, "Lord Stark…");
});

test("each source is compared on its own rows only", async () => {
  await replaceEpisodeCacheForSource("plex", rows());
  await replaceEpisodeCacheForSource("jellyfin", rows().slice(0, 2));
  assert.equal(await replaceEpisodeCacheForSource("plex", rows()), "unchanged");
  assert.equal(await replaceEpisodeCacheForSource("jellyfin", rows().slice(0, 2)), "unchanged");
  assert.equal(await replaceEpisodeCacheForSource("jellyfin", rows()), "replaced");
  assert.equal((await stored("jellyfin")).length, 4);
});

test("duplicates across servers compare as the earliest arrival the swap stores", async () => {
  const twoServers: EpisodeCacheRow[] = [
    ...rows(),
    { ...rows()[0], addedAt: new Date("2023-01-01T00:00:00.000Z") },
  ];
  assert.equal(await replaceEpisodeCacheForSource("plex", twoServers), "replaced");
  const row = (await stored("plex")).find((r) => r.seasonNumber === 1 && r.episodeNumber === 1);
  assert.equal(row?.addedAt?.toISOString(), "2023-01-01T00:00:00.000Z");
  assert.equal(await replaceEpisodeCacheForSource("plex", twoServers), "unchanged");
});

test("an empty set skips against an empty table and clears a full one", async () => {
  assert.equal(await replaceEpisodeCacheForSource("plex", []), "unchanged");
  await replaceEpisodeCacheForSource("plex", rows());
  assert.equal(await replaceEpisodeCacheForSource("plex", []), "replaced");
  assert.equal((await stored("plex")).length, 0);
});
