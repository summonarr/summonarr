// patchPlexShowFilePaths is one UPDATE … FROM (VALUES …) per chunk; the unit
// suite never executes it. Here the database decides what it touches.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma, resetDb, closeDb } from "./_harness.mts";
import { patchPlexShowFilePaths } from "@/lib/library-staging.ts";

before(resetDb);
beforeEach(resetDb);
after(closeDb);

const row = (tmdbId: number, over: Record<string, unknown> = {}) => ({
  tmdbId,
  mediaType: "TV" as const,
  serverInstance: "",
  plexRatingKey: `rk${tmdbId}`,
  ...over,
});

test("fills only TV rows of the named instance whose filePath is still null", async () => {
  await prisma.plexLibraryItem.createMany({
    data: [
      row(1), // patched
      row(2, { filePath: "/already/there" }), // never overwritten
      row(3, { serverInstance: "b" }), // another instance: untouched
      row(4, { mediaType: "MOVIE" }), // movies never patched
      row(5), // key not in the map: untouched
    ],
  });
  await patchPlexShowFilePaths(
    "",
    new Map([
      ["rk1", "/tv/one"],
      ["rk2", "/tv/two-new"],
      ["rk3", "/tv/three"],
      ["rk4", "/tv/four"],
      ["rk-unknown", "/tv/nothing"],
    ]),
  );
  const rows = await prisma.plexLibraryItem.findMany({ orderBy: { tmdbId: "asc" } });
  assert.deepEqual(rows.map((r) => [r.tmdbId, r.filePath]), [
    [1, "/tv/one"],
    [2, "/already/there"],
    [3, null],
    [4, null],
    [5, null],
  ]);
});

test("the same ratingKey on a different instance is patched only when that instance is named", async () => {
  await prisma.plexLibraryItem.createMany({
    data: [row(1, { plexRatingKey: "shared" }), row(2, { plexRatingKey: "shared", serverInstance: "b" })],
  });
  await patchPlexShowFilePaths("b", new Map([["shared", "/b/show"]]));
  const rows = await prisma.plexLibraryItem.findMany({ orderBy: { tmdbId: "asc" } });
  assert.deepEqual(rows.map((r) => r.filePath), [null, "/b/show"]);
});

test("an empty map is a no-op and a path with quotes round-trips as data", async () => {
  await prisma.plexLibraryItem.create({ data: row(1) });
  await patchPlexShowFilePaths("", new Map());
  assert.equal((await prisma.plexLibraryItem.findFirstOrThrow()).filePath, null);
  const odd = `/tv/O'Brien "Show" ; DROP TABLE x --`;
  await patchPlexShowFilePaths("", new Map([["rk1", odd]]));
  assert.equal((await prisma.plexLibraryItem.findFirstOrThrow()).filePath, odd);
});
