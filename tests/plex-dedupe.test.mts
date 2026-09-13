// Unit tests for the conflated-ratingKey dedupe (src/lib/plex-dedupe.ts).
//
// Plex can put several TMDB ids on ONE ratingKey, and exactly one of them may
// keep a PlexLibraryItem row. The losers get no row at all — no availability
// badge, no TVEpisodeCache entry — so WHICH one wins is user-visible, and the
// rule that decides it has to give the same answer on every run.
//
// It did not. Live logs showed ratingKey 473163 (four shows) pinned to tmdb
// 225634 for two runs and to 113988 on a later one. The prior mapping was
// looked up by `tmdbId IN (this batch's candidates)`, so a fetch that happened
// to omit the pinned title found no mapping and fell through to "keep the first
// occurrence" of an array filled by a concurrent library walk.
//
// There is no local DB in this harness: src/lib/prisma.ts caches its client on
// globalThis, so we pre-seed that slot with an in-memory fake BEFORE the module
// graph loads — no query ever leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

type StoredRow = { tmdbId: number; plexRatingKey: string | null };
type FindManyArgs = {
  where: { mediaType: string; serverInstance: string; plexRatingKey?: { in: string[] }; tmdbId?: { in: number[] } };
  select: Record<string, boolean>;
};

const findManyWheres: FindManyArgs["where"][] = [];
let storedRows: StoredRow[] = [];

const fakePrisma = {
  plexLibraryItem: {
    findMany: async (args: FindManyArgs): Promise<StoredRow[]> => {
      findManyWheres.push(structuredClone(args.where));
      return storedRows;
    },
  },
};

(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
const { deduplicatePlexRowsByRatingKey } = await import("../src/lib/plex-dedupe.ts");

// warnOnChange writes to console.warn; the dedupe's summary line is not under
// test and would otherwise interleave with the runner's output.
const realWarn = console.warn;
console.warn = () => {};
process.on("exit", () => { console.warn = realWarn; });

type Row = { tmdbId: number; plexRatingKey: string | null; title: string };
const row = (tmdbId: number, plexRatingKey: string | null): Row =>
  ({ tmdbId, plexRatingKey, title: `Show ${tmdbId}` });

function reset(stored: StoredRow[] = []): void {
  findManyWheres.length = 0;
  storedRows = stored;
}

const RK = "473163";
const ids = (rows: Row[]): number[] => rows.map((r) => r.tmdbId);

test("the winner is order-independent — the same conflated batch in any arrival order keeps the same tmdbId", async () => {
  // The rows reach the dedupe from a Map filled by Promise.all over library
  // sections, so arrival order genuinely varies between runs. Every permutation
  // must agree, with no prior mapping to lean on.
  const candidates = [113988, 138807, 225634, 299939];
  const winners = new Set<number>();
  for (const first of candidates) {
    reset([]);
    const shuffled = [first, ...candidates.filter((id) => id !== first)].map((id) => row(id, RK));
    const kept = await deduplicatePlexRowsByRatingKey(shuffled, "TV", "", "sync");
    assert.equal(kept.length, 1, "exactly one candidate may keep a library row");
    winners.add(kept[0].tmdbId);
  }
  assert.deepEqual(
    [...winners],
    [113988],
    "every arrival order must resolve to the SAME tmdbId — 'keep the first occurrence' lets the " +
      "fetch order decide which show keeps its library row, and it silently moved between runs",
  );
});

test("the prior-mapping lookup is keyed by ratingKey (still instance- and type-scoped), never by the batch's tmdbIds", async () => {
  reset([]);
  await deduplicatePlexRowsByRatingKey(
    [row(113988, RK), row(225634, RK), row(700, "rk-solo")],
    "TV",
    "remote",
    "sync",
  );
  assert.deepEqual(
    findManyWheres,
    [{ mediaType: "TV", serverInstance: "remote", plexRatingKey: { in: [RK] } }],
    "keying the read on the candidate tmdbIds loses the pin whenever the pinned title is missing " +
      "from the current fetch; the scoping is guardrail 35 — an unscoped read would import another " +
      "server's ratingKey mapping",
  );
});

test("a stored mapping pins the winner even when a lower tmdbId is present", async () => {
  reset([{ tmdbId: 225634, plexRatingKey: RK }]);
  const kept = await deduplicatePlexRowsByRatingKey(
    [row(113988, RK), row(138807, RK), row(225634, RK), row(299939, RK)],
    "TV",
    "",
    "sync",
  );
  assert.deepEqual(
    ids(kept),
    [225634],
    "the pin is what stops the choice wandering; without it the tiebreak would hand the row to 113988",
  );
});

test("a pin naming a title absent from this fetch falls back to the tiebreak — it must not drop EVERY candidate", async () => {
  // The exact live shape: Plex is mid-scan, the fetch omits the pinned show.
  // Honouring the pin unconditionally would leave the ratingKey with no row at
  // all — and on the full-replace path that also destroys the pin.
  reset([{ tmdbId: 225634, plexRatingKey: RK }]);
  const kept = await deduplicatePlexRowsByRatingKey(
    [row(113988, RK), row(138807, RK)],
    "TV",
    "",
    "sync",
  );
  assert.deepEqual(ids(kept), [113988], "a pin outside the batch must not blank the ratingKey");
});

test("duplicate stored mappings for one ratingKey resolve the same way in either row order", async () => {
  // plexRatingKey is indexed, not unique, and findMany has no defined order —
  // so last-write-wins over the result set would be a second source of drift.
  const batch = [row(113988, RK), row(225634, RK)];
  reset([{ tmdbId: 225634, plexRatingKey: RK }, { tmdbId: 113988, plexRatingKey: RK }]);
  const forward = await deduplicatePlexRowsByRatingKey(batch, "TV", "", "sync");
  reset([{ tmdbId: 113988, plexRatingKey: RK }, { tmdbId: 225634, plexRatingKey: RK }]);
  const reverse = await deduplicatePlexRowsByRatingKey(batch, "TV", "", "sync");
  assert.deepEqual(ids(forward), ids(reverse), "the stored-mapping order must not decide the winner");
});

test("no conflation ⇒ every row survives and no DB read fires", async () => {
  reset([]);
  const rows = [row(1, "rk1"), row(2, "rk2"), row(3, null), row(4, null)];
  const kept = await deduplicatePlexRowsByRatingKey(rows, "MOVIE", "", "sync");
  assert.deepEqual(ids(kept), [1, 2, 3, 4], "a null ratingKey is not a collision with another null one");
  assert.deepEqual(findManyWheres, [], "the prior-mapping read must not fire when nothing is conflated");
});

test("unconflated rows pass through untouched alongside a conflated key", async () => {
  reset([]);
  const kept = await deduplicatePlexRowsByRatingKey(
    [row(700, "rk-solo"), row(225634, RK), row(113988, RK), row(800, null)],
    "TV",
    "",
    "sync",
  );
  assert.deepEqual(ids(kept), [700, 113988, 800], "only the conflated key loses candidates, and input order is preserved");
});
