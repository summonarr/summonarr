// Unit tests for attachArrPending (src/lib/arr-availability.ts) — the
// wanted/available badge derivation over the Radarr/Sonarr cache tables, and
// the module that turned the two-instance (HD/4K) model into N named slugs.
// The contracts pinned here:
//
//   - table routing: movies read radarrWanted/AvailableItem, TV reads
//     sonarrWanted/AvailableItem, via one UNFILTERED-by-instance `tmdbId IN`
//     query per table selecting (tmdbId, arrInstance) — the per-slug fan-out
//     happens in memory, not as one query per instance. An empty side (no
//     movies / no TV) must not touch that service's tables at all;
//   - `arrPending` is scoped to the DEFAULT instance (slug ""): a wanted row
//     at "4k" or a named slug must NOT light the primary pending badge (the
//     back-compat field every grid reads), and an *available* row at ""
//     doesn't either — pending means wanted, not on-disk;
//   - the 4K back-compat pair (arr4kPending/arr4kAvailable) is attached ONLY
//     when include4k is passed — absent keys otherwise (tmdb-types: undefined
//     = "not attached", the UI shows nothing) — and reads the "4k" slug from
//     the wanted/available tables respectively, explicit false when absent;
//   - `arrInstances` is the full per-slug { pending, available } merge across
//     both tables, and the key is OMITTED entirely for an id with no rows —
//     absence, not an empty object, is the "no instance tracks this" signal;
//   - movie and TV state never cross-contaminate a shared tmdbId (independent
//     id spaces, separate maps);
//   - "pending" is cache-derived truth only: rows come from the last sync, so
//     every assertion here is about the local tables, never a live ARR call.
//
// Impurity: four findMany delegates, shadowed in-memory (tests/_helpers.mts).
// TOKEN_ENCRYPTION_KEY is set before prisma.ts enters the module graph, so
// source imports are dynamic (static imports would hoist above the env set).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { attachArrPending } = await import("../src/lib/arr-availability.ts");
type TmdbMedia = import("../src/lib/tmdb-types.ts").TmdbMedia;

function media(id: number, mediaType: string): TmdbMedia {
  return { id, mediaType } as unknown as TmdbMedia;
}

type ArrRow = { tmdbId: number; arrInstance: string };
type FindManyArgs = {
  where: { tmdbId: { in: number[] } };
  select: { tmdbId: boolean; arrInstance: boolean };
};

// One stub per cache table; each echoes back only the ids the query asked for.
function makeTable() {
  const state = { rows: [] as ArrRow[], calls: [] as FindManyArgs[] };
  const stub = {
    findMany: async (args: FindManyArgs): Promise<ArrRow[]> => {
      state.calls.push(args);
      return state.rows.filter((r) => args.where.tmdbId.in.includes(r.tmdbId));
    },
  };
  return { state, stub };
}

const radarrWanted = makeTable();
const sonarrWanted = makeTable();
const radarrAvail = makeTable();
const sonarrAvail = makeTable();

shadowPrismaModel(prisma, "radarrWantedItem", radarrWanted.stub);
shadowPrismaModel(prisma, "sonarrWantedItem", sonarrWanted.stub);
shadowPrismaModel(prisma, "radarrAvailableItem", radarrAvail.stub);
shadowPrismaModel(prisma, "sonarrAvailableItem", sonarrAvail.stub);

const ALL = [radarrWanted, sonarrWanted, radarrAvail, sonarrAvail];

beforeEach(() => {
  for (const t of ALL) {
    t.state.rows = [];
    t.state.calls.length = 0;
  }
});

test("empty input returns the same array and touches none of the four tables", async () => {
  const items: TmdbMedia[] = [];
  const out = await attachArrPending(items);
  assert.equal(out, items);
  for (const t of ALL) assert.equal(t.state.calls.length, 0);
});

test("movie-only input queries only the two Radarr tables, with the exact IN + select shape", async () => {
  await attachArrPending([media(603, "movie"), media(604, "movie")]);
  const expected = {
    where: { tmdbId: { in: [603, 604] } },
    select: { tmdbId: true, arrInstance: true },
  };
  assert.deepEqual(radarrWanted.state.calls, [expected]);
  assert.deepEqual(radarrAvail.state.calls, [expected]);
  assert.equal(sonarrWanted.state.calls.length, 0); // Sonarr side never runs
  assert.equal(sonarrAvail.state.calls.length, 0);
});

test("tv-only input queries only the two Sonarr tables", async () => {
  await attachArrPending([media(1399, "tv")]);
  const expected = {
    where: { tmdbId: { in: [1399] } },
    select: { tmdbId: true, arrInstance: true },
  };
  assert.deepEqual(sonarrWanted.state.calls, [expected]);
  assert.deepEqual(sonarrAvail.state.calls, [expected]);
  assert.equal(radarrWanted.state.calls.length, 0);
  assert.equal(radarrAvail.state.calls.length, 0);
});

test("a default-instance wanted row sets arrPending; absent ids read an explicit false", async () => {
  radarrWanted.state.rows = [{ tmdbId: 603, arrInstance: "" }];
  const out = await attachArrPending([media(603, "movie"), media(604, "movie")]);
  assert.deepEqual(
    out.map((i) => [i.id, i.arrPending]),
    [
      [603, true],
      [604, false], // explicit false — undefined means "not attached yet" to callers
    ],
  );
});

test("wanted rows at '4k' or a named slug do NOT set arrPending — it is default-instance scoped", async () => {
  radarrWanted.state.rows = [
    { tmdbId: 1, arrInstance: "4k" },
    { tmdbId: 2, arrInstance: "anime" },
  ];
  const out = await attachArrPending([media(1, "movie"), media(2, "movie")]);
  assert.deepEqual(out.map((i) => i.arrPending), [false, false]);
  // …but the per-slug map still surfaces them for named-instance UIs.
  assert.deepEqual(out[0].arrInstances, { "4k": { pending: true, available: false } });
  assert.deepEqual(out[1].arrInstances, { anime: { pending: true, available: false } });
});

test("an available row at the default slug does not read as pending — wanted and available stay distinct", async () => {
  radarrAvail.state.rows = [{ tmdbId: 5, arrInstance: "" }];
  const out = await attachArrPending([media(5, "movie")]);
  assert.equal(out[0].arrPending, false);
  assert.deepEqual(out[0].arrInstances, { "": { pending: false, available: true } });
});

test("without include4k the arr4k keys are ABSENT even when 4k rows exist", async () => {
  radarrWanted.state.rows = [{ tmdbId: 9, arrInstance: "4k" }];
  radarrAvail.state.rows = [{ tmdbId: 9, arrInstance: "4k" }];
  const out = await attachArrPending([media(9, "movie")]); // opts omitted entirely
  assert.equal("arr4kPending" in out[0], false); // key absent, not false/undefined-valued
  assert.equal("arr4kAvailable" in out[0], false);
});

test("include4k: true reads the '4k' slug — pending from wanted, available from available, false when absent", async () => {
  radarrWanted.state.rows = [{ tmdbId: 10, arrInstance: "4k" }];
  radarrAvail.state.rows = [{ tmdbId: 11, arrInstance: "4k" }];
  const out = await attachArrPending(
    [media(10, "movie"), media(11, "movie"), media(12, "movie")],
    { include4k: true },
  );
  assert.deepEqual(
    out.map((i) => [i.id, i.arr4kPending, i.arr4kAvailable]),
    [
      [10, true, false],
      [11, false, true],
      [12, false, false], // no 4k rows at all → explicit falses, keys present
    ],
  );
});

test("arrInstances merges pending+available per slug across tables; the key is omitted when no rows exist", async () => {
  radarrWanted.state.rows = [
    { tmdbId: 20, arrInstance: "" },
    { tmdbId: 20, arrInstance: "anime" },
  ];
  radarrAvail.state.rows = [{ tmdbId: 20, arrInstance: "anime" }];
  const out = await attachArrPending([media(20, "movie"), media(21, "movie")]);
  assert.deepEqual(out[0].arrInstances, {
    "": { pending: true, available: false },
    anime: { pending: true, available: true }, // both tables merged into one slug entry
  });
  // Absence — not an empty object — is the "no instance tracks this" signal.
  assert.equal("arrInstances" in out[1], false);
});

test("movie and TV state never cross-contaminate a shared tmdbId", async () => {
  // id 80 exists as both a movie and a show; only the Radarr tables track it.
  radarrWanted.state.rows = [{ tmdbId: 80, arrInstance: "" }];
  radarrAvail.state.rows = [{ tmdbId: 80, arrInstance: "4k" }];
  const out = await attachArrPending([media(80, "movie"), media(80, "tv")], { include4k: true });
  assert.deepEqual(
    out.map((i) => [i.mediaType, i.arrPending, i.arr4kAvailable]),
    [
      ["movie", true, true],
      ["tv", false, false], // Radarr rows must not leak into the TV lookup
    ],
  );
  assert.equal("arrInstances" in out[1], false);
});

test("TV parity: Sonarr rows drive tv items exactly like Radarr drives movies", async () => {
  sonarrWanted.state.rows = [{ tmdbId: 1399, arrInstance: "" }];
  sonarrAvail.state.rows = [{ tmdbId: 1399, arrInstance: "4k" }];
  const out = await attachArrPending([media(1399, "tv")], { include4k: true });
  assert.equal(out[0].arrPending, true);
  assert.equal(out[0].arr4kPending, false);
  assert.equal(out[0].arr4kAvailable, true);
  assert.deepEqual(out[0].arrInstances, {
    "": { pending: true, available: false },
    "4k": { pending: false, available: true },
  });
});

test("input objects are not mutated and unrelated fields survive the copy", async () => {
  radarrWanted.state.rows = [{ tmdbId: 550, arrInstance: "" }];
  const items = [
    { id: 550, mediaType: "movie", title: "Fight Club" } as unknown as TmdbMedia,
  ];
  const out = await attachArrPending(items);
  assert.notEqual(out[0], items[0]);
  assert.equal(items[0].arrPending, undefined); // original untouched
  assert.equal(out[0].title, "Fight Club");
  assert.equal(out[0].arrPending, true);
});
