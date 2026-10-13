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

// ═══ plexRatingKeys are NEVER made exclusive on write (guardrails 37c + 14d) ═══
//
// A conflated item's key also rides the array of every title it claims whose
// clean copy sits in another section. The never-watched evidence join credits a
// play / upstream record / session of that key to EVERY title answering to it,
// so stripping it from all but one row turned a watched title into a false
// "never watched" — and that list feeds a delete. The single-answer readers
// pick one owner on READ (`pickPlexRowForKey`, below).

type KRow = { tmdbId: number; plexRatingKey: string | null; plexRatingKeys: string[] };
const krow = (tmdbId: number, plexRatingKey: string | null, plexRatingKeys: string[]): KRow =>
  ({ tmdbId, plexRatingKey, plexRatingKeys });
const keysById = (rows: KRow[]): Record<number, string[]> =>
  Object.fromEntries(rows.map((r) => [r.tmdbId, r.plexRatingKeys]));

test("a conflated key resolved by 37b STAYS on a second kept row's plexRatingKeys", async () => {
  // X at rk 100 claims A(1), B(2), C(3); C also sits clean at rk 200 in another
  // section, so the merge put 100 on C's array.
  reset([]);
  const rows = [krow(1, "100", ["100"]), krow(2, "100", ["100"]), krow(3, "200", ["200", "100"])];
  const kept = await deduplicatePlexRowsByRatingKey(rows, "TV", "", "sync");
  assert.deepEqual(ids(kept as unknown as Row[]), [1, 3], "37b keeps A for key 100, and C for its own key");
  assert.deepEqual(
    keysById(kept),
    { 1: ["100"], 3: ["200", "100"] },
    "key 100 stays on C's array: a watch of X credits C too in the never-watched join",
  );
  assert.equal(kept[1], rows[2], "a kept row is returned as-is, never copied or rewritten");
});

test("with NO canonical conflation, keys shared only through arrays come back untouched — in either arrival order, with no DB read", async () => {
  const forward = [krow(3, "200", ["200", "100"]), krow(4, "300", ["300", "100"])];
  reset([]);
  const a = await deduplicatePlexRowsByRatingKey(forward, "TV", "", "sync");
  reset([]);
  const b = await deduplicatePlexRowsByRatingKey([...forward].reverse(), "TV", "", "sync");
  assert.deepEqual(keysById(a), { 3: ["200", "100"], 4: ["300", "100"] });
  assert.deepEqual(keysById(b), keysById(a));
  assert.equal(a, forward, "no conflation ⇒ the input array itself is returned");
  assert.deepEqual(findManyWheres, [], "no canonical conflation ⇒ still no prior-mapping read");
});

test("a canonical key riding a lower tmdbId's array stays on both rows", async () => {
  // Row 100 {k1, [k1, k2]} and row 200 {k2, [k2]}: canonical keys are unique,
  // so 37b sees no conflict and both arrays are written as given.
  reset([]);
  const kept = await deduplicatePlexRowsByRatingKey([krow(100, "k1", ["k1", "k2"]), krow(200, "k2", ["k2"])], "TV", "", "sync");
  assert.deepEqual(keysById(kept), { 100: ["k1", "k2"], 200: ["k2"] });
});

test("a legitimate duplicate-copy key held by ONE row is kept, and that row is returned as-is", async () => {
  reset([]);
  const solo = krow(603, "rk-hd", ["rk-hd", "rk-4k"]);
  const kept = await deduplicatePlexRowsByRatingKey([solo, krow(604, "rk-x", ["rk-x"])], "MOVIE", "", "sync");
  assert.deepEqual(keysById(kept), { 603: ["rk-hd", "rk-4k"], 604: ["rk-x"] }, "37c's whole point: the 4K copy's key stays addressable");
  assert.equal(kept[0], solo, "an unchanged row is not copied");
});

// ═══ the read-side owner rule ═══════════════════════════════════════════════

const { pickPlexRowForKey, indexPlexRowsByKey } = await import("../src/lib/plex-dedupe.ts");

test("pickPlexRowForKey: the canonical holder beats an array holder, in both orders", () => {
  const canon = { tmdbId: 200, plexRatingKey: "k2" };
  const viaArray = { tmdbId: 100, plexRatingKey: "k1" };
  assert.equal(pickPlexRowForKey([viaArray, canon], "k2"), canon);
  assert.equal(pickPlexRowForKey([canon, viaArray], "k2"), canon, "first-row-wins (findFirst) would answer 100 here");
});

test("pickPlexRowForKey: among array-only holders the lowest tmdbId wins, in both orders; none ⇒ null", () => {
  const a = { tmdbId: 300, plexRatingKey: "k3" };
  const b = { tmdbId: 50, plexRatingKey: "k4" };
  assert.equal(pickPlexRowForKey([a, b], "k9"), b);
  assert.equal(pickPlexRowForKey([b, a], "k9"), b);
  assert.equal(pickPlexRowForKey([], "k9"), null);
});

test("indexPlexRowsByKey: every key a row answers to, each mapped to its one owner", () => {
  const r100 = { tmdbId: 100, plexRatingKey: "k1", plexRatingKeys: ["k1", "k2", "k5"] };
  const r200 = { tmdbId: 200, plexRatingKey: "k2", plexRatingKeys: ["k2"] };
  const r300 = { tmdbId: 300, plexRatingKey: "k3", plexRatingKeys: ["k3", "k5"] };
  for (const order of [[r100, r200, r300], [r300, r200, r100]]) {
    const idx = indexPlexRowsByKey(order);
    assert.deepEqual(
      Object.fromEntries([...idx].map(([k, r]) => [k, r.tmdbId]).sort()),
      { k1: 100, k2: 200, k3: 300, k5: 100 },
      "last-write-wins over a key map lets an array entry overwrite the canonical owner",
    );
  }
});
