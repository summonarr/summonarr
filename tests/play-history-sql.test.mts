// Placeholder/parameter-lockstep audit for the raw-SQL aggregate layer in
// src/lib/play-history.ts — the ~70 `$queryRawUnsafe` builders behind the admin
// Statistics page, the activity heatmaps, /popular, Wrapped, and the per-media
// and per-user stat panels.
//
// Why this file exists: CLAUDE.md records that "raw-SQL aggregates (the
// play-history stats/calendar queries) are not exercised at all", and this is
// the one part of the module that has already shipped a real bug — the `$1`
// placeholder offset in getActivityCalendarUncached (the 803cd11 class, where
// the SQL said `$2` while the value sat at params[0]). tests/play-history.test.mts
// pins the SHARED helper (appendPlayHistoryFilter) but nothing pins the callers,
// and the callers are where the risk actually lives:
//
//   - getMostPopularOnServer carries FIVE captured index variables
//     (arcGapIdx/completionIdx/trendingIdx/limitIdx/offsetIdx) behind TWO
//     conditional pushes (`mediaType`, `sort === "trending"`). Every index after
//     a skipped push shifts by one.
//   - getTranscodeOffenders uses a DIFFERENT idiom — `params.length + 1`
//     computed up front, with the value appended at the call (`...params, limit`)
//     rather than pushed. Nothing but arithmetic keeps those two in step.
//   - getHeatmapCellDetail builds ONE `where` + ONE params array and spreads it
//     across FIVE separate queries; a condition added to one query alone
//     desynchronizes the other four.
//
// A Postgres placeholder bug does not throw at the type level and does not throw
// in this harness — it throws (or, worse, silently reads the wrong column) only
// against a live DB, which the suite deliberately never touches. So the contract
// is checked structurally instead: capture every (sql, ...params) pair each
// function issues and assert the two are in lockstep. `auditQuery` enforces
//
//   1. no `$0` and no index above params.length  — the SQL can't read past the array
//   2. every index in 1..params.length is USED   — an orphan param is the off-by-one
//      signature (SQL starts at $2 while the value sits at params[0])
//
// Assertion 2 is the one that catches the shipped bug: dropping the `$1` fix
// leaves params.length === 1 with only `$2` referenced, so index 1 is orphaned.
//
// Also pinned here: hostile filter values reach the DB as BOUND PARAMETERS and
// never as SQL text. `userId` on the heatmap route is passed through without
// format validation (only `day`/`dow`/`hour` are validated there), so `bind()`
// is the sole thing standing between an admin-supplied string and the query.
//
// No DB: $queryRawUnsafe/$queryRaw are shadowed to record their arguments and
// return []. Every stats entry point is cache-memoized on its arguments, so each
// test varies `days`/`limit`/mode to land on a fresh cache key.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const {
  getActivityCalendar,
  getHeatmapCellDetail,
  getMediaPlayStats,
  getMostPopularOnServer,
  getMostRewatched,
  getPlayHistoryStats,
  getPlayStatsForServerUsers,
  getPlayYearsForServerUsers,
  getTranscodeOffenders,
  getUserPlayStats,
  getWrappedForServerUsers,
} = await import("../src/lib/play-history.ts");

// ── capture ─────────────────────────────────────────────────────────────────

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[] = [];

const record = async (sql: string, ...params: unknown[]): Promise<unknown[]> => {
  captured.push({ sql, params });
  return [];
};
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", record);
// Tagged-template form (getAllUsersStats). Prisma hands the strings array plus
// interpolated values; flatten to the same shape so one auditor covers both.
shadowPrismaClientMethod(prisma, "$queryRaw", async (strings: TemplateStringsArray, ...values: unknown[]) => {
  captured.push({ sql: Array.isArray(strings) ? strings.join("?") : String(strings), params: values });
  return [];
});

// Settings back the threshold getters (completion/arc-gap) that
// getMostPopularOnServer folds into its params.
shadowPrismaModel(prisma, "setting", { findMany: async () => [] });
// Poster backfill on the rewatch/top-watched leaderboards — never reached with
// zero rows, stubbed so a shape change can't silently hit a real delegate.
shadowPrismaModel(prisma, "tmdbMediaCore", { findMany: async () => [] });
shadowPrismaModel(prisma, "tmdbCache", { findMany: async () => [] });
shadowPrismaModel(prisma, "mediaServerUser", { findMany: async () => [], findUnique: async () => null });
// Several entry points mix ORM reads in with the raw aggregates (the Wrapped
// bundle's counts, getMediaPlayStats' recent-plays list). They contribute no
// SQL to the audit but must not reach a real delegate.
shadowPrismaModel(prisma, "playHistory", {
  count: async () => 0,
  findMany: async () => [],
  findFirst: async () => null,
  aggregate: async () => ({ _sum: {}, _avg: {}, _count: 0 }),
  groupBy: async () => [],
});
// getMediaPlayStats resolves the title's library rows alongside its aggregates.
shadowPrismaModel(prisma, "plexLibraryItem", { findFirst: async () => null, findMany: async () => [] });
shadowPrismaModel(prisma, "jellyfinLibraryItem", { findFirst: async () => null, findMany: async () => [] });

/** Run `fn`, returning every (sql, params) pair it issued. */
async function capture(fn: () => Promise<unknown>): Promise<Captured[]> {
  captured = [];
  await fn();
  const out = captured;
  captured = [];
  return out;
}

// ── the auditor ─────────────────────────────────────────────────────────────

function placeholderSet(sql: string): Set<number> {
  const out = new Set<number>();
  for (const m of sql.matchAll(/\$(\d+)/g)) out.add(Number(m[1]));
  return out;
}

/** One-line excerpt for failure messages — full aggregate SQL is unreadable. */
function excerpt(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

function auditQuery(label: string, q: Captured): void {
  const used = placeholderSet(q.sql);

  for (const n of used) {
    assert.ok(n >= 1, `${label}: SQL references $${n} — Postgres placeholders are 1-based\n  ${excerpt(q.sql)}`);
    assert.ok(
      n <= q.params.length,
      `${label}: SQL references $${n} but only ${q.params.length} param(s) were bound — the query would ` +
        `error at the DB (this harness cannot see it)\n  ${excerpt(q.sql)}`,
    );
  }

  for (let n = 1; n <= q.params.length; n++) {
    assert.ok(
      used.has(n),
      `${label}: param #${n} (${JSON.stringify(q.params[n - 1])}) is bound but NEVER referenced — the ` +
        `off-by-one signature of the 803cd11 $1-offset bug; every later index is reading the wrong value\n  ${excerpt(q.sql)}`,
    );
  }
}

function auditAll(label: string, queries: Captured[]): void {
  assert.ok(queries.length > 0, `${label}: issued NO query — the audit would pass vacuously`);
  queries.forEach((q, i) => auditQuery(`${label} [query ${i + 1}/${queries.length}]`, q));
}

/** Assert a hostile value never appears as SQL TEXT — it must be a bound param. */
function assertBoundNotInlined(label: string, queries: Captured[], value: string): void {
  const hits = queries.filter((q) => q.sql.includes(value));
  assert.equal(
    hits.length,
    0,
    `${label}: the value ${JSON.stringify(value)} was interpolated into the SQL text instead of bound — ` +
      `SQL injection\n  ${hits[0] ? excerpt(hits[0].sql) : ""}`,
  );
  const bound = queries.some((q) => q.params.includes(value));
  assert.ok(bound, `${label}: ${JSON.stringify(value)} reached neither the SQL nor the params — the test proves nothing`);
}

// ── getMostPopularOnServer: the conditional-push shifter ─────────────────────

// Two independent optional pushes sit AHEAD of four captured indices. With
// neither, params are [arcGap, completion, limit, offset]; adding `mediaType`
// shifts all four by one, and `sort=trending` shifts limit/offset by another.
// Every combination has to land, so the matrix is exhaustive rather than
// representative.
test("getMostPopularOnServer: every mediaType × sort combination keeps $-indices in lockstep with params", async () => {
  const sorts = ["plays", "viewers", "trending"] as const;
  const mediaTypes = [undefined, "MOVIE", "TV"] as const;

  let combos = 0;
  for (const sort of sorts) {
    for (const mediaType of mediaTypes) {
      // page varies per combo so each lands on a distinct popularCache key.
      combos++;
      const queries = await capture(() =>
        getMostPopularOnServer({ sort, mediaType, page: combos, limit: 10 }),
      );
      auditAll(`getMostPopularOnServer(sort=${sort}, mediaType=${mediaType ?? "none"})`, queries);
    }
  }
  assert.equal(combos, 9, "the matrix must stay exhaustive");
});

test("getMostPopularOnServer: the trending window is an extra BOUND param, and it shifts limit/offset", async () => {
  const [plain] = await capture(() => getMostPopularOnServer({ sort: "plays", page: 1, limit: 7 }));
  const [trending] = await capture(() => getMostPopularOnServer({ sort: "trending", page: 1, limit: 7 }));

  assert.equal(
    trending.params.length,
    plain.params.length + 1,
    "sort=trending pushes exactly one extra param (the 30-day cutoff)",
  );
  assert.ok(trending.params.some((p) => p instanceof Date), "the trending cutoff is bound as a Date, not inlined");
  assert.ok(!plain.sql.includes("FILTER (WHERE arc_started_at"), "the non-trending path emits no arc window filter");
  assert.ok(trending.sql.includes("FILTER (WHERE arc_started_at"), "the trending path filters arcs by the window");

  // LIMIT/OFFSET are the LAST two pushes, so they must be the last two indices
  // in both shapes — this is what a mis-captured index variable breaks.
  for (const [label, q] of [["plays", plain], ["trending", trending]] as const) {
    const n = q.params.length;
    assert.ok(
      q.sql.includes(`LIMIT $${n - 1} OFFSET $${n}`),
      `${label}: LIMIT/OFFSET must bind the final two params ($${n - 1}, $${n}) — got ${excerpt(q.sql).slice(-60)}`,
    );
    assert.equal(q.params[n - 2], 7, `${label}: the limit value binds where the SQL says LIMIT`);
  }
});

test("getMostPopularOnServer: page/limit clamps bind the CLAMPED values, never the caller's", async () => {
  // MAX_POPULAR_PAGE / POPULAR_PER_PAGE clamp at the source (an unclamped page
  // would defeat the cache and grow popularCache without bound).
  const [q] = await capture(() => getMostPopularOnServer({ page: 10_000_000, limit: 10_000 }));
  const n = q.params.length;
  const limit = Number(q.params[n - 2]);
  const offset = Number(q.params[n - 1]);

  assert.ok(limit > 0 && limit < 10_000, `limit was clamped below the caller's 10000 (got ${limit})`);
  assert.ok(offset >= 0 && Number.isFinite(offset), `offset stays a finite non-negative integer (got ${offset})`);
  assert.equal(offset % limit, 0, "offset is a whole number of clamped pages");
});

// ── getHeatmapCellDetail: one params array, five queries ─────────────────────

test("getHeatmapCellDetail (mode=day): all five queries share one params array and stay in lockstep", async () => {
  const queries = await capture(() => getHeatmapCellDetail({ mode: "day", day: "2026-03-14" }));
  auditAll("getHeatmapCellDetail(day)", queries);

  // Not user-scoped ⇒ the topUsers query runs, so all five fire.
  assert.equal(queries.length, 5, "day mode issues the agg + reasons + resolutions + titles + topUsers queries");
  const shapes = new Set(queries.map((q) => JSON.stringify(q.params)));
  assert.equal(shapes.size, 1, "every query binds the IDENTICAL params array — they share one `where`");
});

// The topTitles statement GROUPs BY ("tmdbId", "mediaType") — TMDB movie and TV
// ids overlap numerically, so a movie and a series sharing an integer are two
// rows. The projection MUST carry "mediaType" or the popover cannot key or link
// them apart (duplicate React keys + a blended stats page). Review 2026-09 f77.
test("getHeatmapCellDetail: the grouped-by-mediaType topTitles projection SELECTs mediaType", async () => {
  const queries = await capture(() => getHeatmapCellDetail({ mode: "day", day: "2026-03-15" }));
  const titles = queries.find((q) => q.sql.includes(`GROUP BY "tmdbId", "mediaType"`));
  assert.ok(titles, "the topTitles statement groups by (tmdbId, mediaType)");
  const selectList = titles!.sql.slice(0, titles!.sql.indexOf("FROM"));
  assert.ok(
    selectList.includes(`"mediaType"::text AS "mediaType"`),
    `topTitles must project the mediaType it groups by: ${selectList.trim()}`,
  );
});

test("getHeatmapCellDetail (mode=hour): dow/hour/days all bind, and the window is a Date param", async () => {
  const queries = await capture(() =>
    getHeatmapCellDetail({ mode: "hour", dow: 3, hour: 21, days: 90 }),
  );
  auditAll("getHeatmapCellDetail(hour)", queries);

  const [{ params }] = queries;
  assert.ok(params.some((p) => p instanceof Date), "the `days` window binds as a Date");
  assert.ok(params.includes(3), "dow binds by value");
  assert.ok(params.includes(21), "hour binds by value");
});

test("getHeatmapCellDetail: a user-scoped cell SKIPS the topUsers query and drops the days window", async () => {
  const queries = await capture(() =>
    getHeatmapCellDetail({ mode: "hour", dow: 1, hour: 8, days: 30, userId: "msu-1" }),
  );
  auditAll("getHeatmapCellDetail(hour, userId)", queries);

  assert.equal(queries.length, 4, "topUsers is skipped on a user-scoped cell — it would always be that same user");
  assert.ok(
    !queries.some((q) => q.sql.includes(`JOIN "MediaServerUser"`)),
    "no query joins MediaServerUser once the cell is user-scoped",
  );
  // Documented: the per-user heatmap is all-history, so `days` must NOT apply.
  assert.ok(
    !queries[0].params.some((p) => p instanceof Date),
    "the days window is deliberately dropped when userId is set, so the popover total matches the cell",
  );
});

test("getHeatmapCellDetail: every optional filter adds exactly one bound param and stays audited", async () => {
  const base = await capture(() => getHeatmapCellDetail({ mode: "day", day: "2026-01-02" }));
  const filtered = await capture(() =>
    getHeatmapCellDetail({ mode: "day", day: "2026-01-03", userId: "u1", source: "plex", mediaType: "TV" }),
  );
  auditAll("getHeatmapCellDetail(filtered)", filtered);

  assert.equal(
    filtered[0].params.length,
    base[0].params.length + 3,
    "userId + source + mediaType each bind exactly one param",
  );
});

test("getHeatmapCellDetail: a hostile userId is BOUND, never interpolated into the SQL", async () => {
  // The route validates mode/day/dow/hour but passes `userId` through as-is,
  // so bind() is the only thing between it and the query text.
  const hostile = `x'; DROP TABLE "PlayHistory"; --`;
  const queries = await capture(() =>
    getHeatmapCellDetail({ mode: "day", day: "2026-02-02", userId: hostile }),
  );
  assertBoundNotInlined("getHeatmapCellDetail", queries, hostile);
  auditAll("getHeatmapCellDetail(hostile userId)", queries);
});

// ── getActivityCalendar: the shipped $1-offset bug ──────────────────────────

test("getActivityCalendar: the filter suffix starts at $1 — the shipped offset bug stays dead", async () => {
  // The calendar binds NOTHING before its filter suffix (the 365-day window is
  // literal SQL), so an unfiltered call must bind zero params and reference no
  // placeholder at all.
  const bare = await capture(() => getActivityCalendar());
  auditAll("getActivityCalendar()", bare);
  assert.equal(bare[0].params.length, 0, "no filters ⇒ no params");
  assert.equal(placeholderSet(bare[0].sql).size, 0, "no params ⇒ no placeholders");

  // With one filter the value must be $1. The shipped bug emitted $2 here,
  // leaving params[0] orphaned — exactly what auditQuery's second assertion catches.
  const oneFilter = await capture(() => getActivityCalendar("plex"));
  auditAll("getActivityCalendar(source)", oneFilter);
  assert.deepEqual([...placeholderSet(oneFilter[0].sql)], [1], "the first filter param is $1, NOT $2");
  assert.deepEqual(oneFilter[0].params, ["plex"]);

  const twoFilters = await capture(() => getActivityCalendar("jellyfin", "MOVIE"));
  auditAll("getActivityCalendar(source, mediaType)", twoFilters);
  assert.deepEqual([...placeholderSet(twoFilters[0].sql)].sort(), [1, 2], "two filters bind $1 and $2 contiguously");
  assert.deepEqual(twoFilters[0].params, ["jellyfin", "MOVIE"]);
});

test("getActivityCalendar: an unrecognized filter value is ignored, not bound and not inlined", async () => {
  // `?source=MOVIE` is not a valid source — appendPlayHistoryFilter drops it.
  // The query must then be unfiltered rather than binding a junk value.
  const queries = await capture(() => getActivityCalendar("MOVIE" /* not a source */));
  auditAll("getActivityCalendar(bad source)", queries);
  assert.equal(queries[0].params.length, 0, "a whitelist miss binds nothing");
  assert.ok(!queries[0].sql.includes("MOVIE"), "and is never interpolated as text");
});

// ── getTranscodeOffenders: the `params.length + 1` idiom ────────────────────

test("getTranscodeOffenders: the precomputed limit index matches the appended limit arg", async () => {
  // This builder does NOT use push-then-read: it computes `params.length + 1`
  // up front and appends the value at the call site (`...params, limit`). The
  // two can drift independently, which is exactly what the audit pins.
  for (const filters of [
    {},
    { source: "plex" },
    { mediaType: "TV" },
    { source: "jellyfin", mediaType: "MOVIE" },
  ]) {
    const label = `getTranscodeOffenders(${JSON.stringify(filters)})`;
    // `days` varies per case so each lands on a distinct cache key.
    const queries = await capture(() => getTranscodeOffenders({ ...filters, days: 10 + Object.keys(filters).length }, 6));
    auditAll(label, queries);

    for (const q of queries) {
      const n = q.params.length;
      assert.ok(q.sql.includes(`LIMIT $${n}`), `${label}: LIMIT binds the FINAL param ($${n})`);
      assert.equal(q.params[n - 1], 6, `${label}: and that final param is the limit value`);
    }
  }
});

test("getTranscodeOffenders: both queries bind the same params — one shared filter, two statements", async () => {
  const queries = await capture(() => getTranscodeOffenders({ days: 45, source: "plex" }, 4));
  assert.equal(queries.length, 2, "the offenders panel issues the users + titles queries");
  assert.deepEqual(queries[0].params, queries[1].params, "both statements bind the identical param list");
  assert.ok(
    queries.every((q) => q.sql.includes(`"playMethod" = 'Transcode'`)),
    "the transcode narrowing is a literal, not a param — it must appear in both",
  );
});

// The users statement groups by "mediaServerUserId" and joins MediaServerUser,
// whose username is NOT unique (@@unique is [source, serverInstance,
// sourceUserId]) — the same person on two same-type servers (guardrail 35) or a
// departed + re-created account (guardrail 28) share (source, username). The
// row id is the only key the leaderboard can use, so the projection must carry
// it. Review 2026-09 f79.
test("getTranscodeOffenders: the users statement projects MediaServerUser.id as the per-row key", async () => {
  const queries = await capture(() => getTranscodeOffenders({ days: 46, source: "plex" }, 4));
  const users = queries.find((q) => q.sql.includes(`JOIN "MediaServerUser" m`));
  assert.ok(users, "the users statement joins MediaServerUser");
  assert.ok(users!.sql.includes(`m."id" AS id`), `users statement must SELECT m."id" AS id: ${users!.sql}`);
});

// ── the broad sweep: every remaining aggregate entry point ──────────────────

// getPlayHistoryStats alone fans out to ~40 statements sharing two param arrays
// (the current window and the previous-period comparison). Auditing them in
// bulk is the cheapest way to cover the long tail.
test("getPlayHistoryStats: every statement in the fan-out is in lockstep, across each filter shape", async () => {
  const shapes = [
    { days: 7 },
    { days: 30, source: "plex" },
    { days: 90, mediaType: "TV" },
    { days: 365, source: "jellyfin", mediaType: "MOVIE" },
  ];
  for (const filters of shapes) {
    const queries = await capture(() => getPlayHistoryStats(filters));
    auditAll(`getPlayHistoryStats(${JSON.stringify(filters)})`, queries);
    assert.ok(queries.length > 20, `the stats page fans out widely (got ${queries.length} statements)`);
  }
});

test("getPlayHistoryStats: the previous-period comparison binds its OWN window, not the current one", async () => {
  const queries = await capture(() => getPlayHistoryStats({ days: 30 }));
  const windows = queries
    .flatMap((q) => q.params)
    .filter((p): p is Date => p instanceof Date)
    .map((d) => d.getTime());

  assert.ok(windows.length >= 2, "at least the current cutoff and the previous-period cutoff are bound");
  assert.ok(
    new Set(windows).size >= 2,
    "the previous-period statements bind an EARLIER cutoff — a single shared window would compare the period to itself",
  );
});

test("the remaining aggregate entry points all keep SQL and params in lockstep", async () => {
  const cases: [string, () => Promise<unknown>][] = [
    ["getMostRewatched()", () => getMostRewatched({ days: 30 }, 10)],
    ["getMostRewatched(filtered)", () => getMostRewatched({ days: 60, source: "plex", mediaType: "TV" }, 5)],
    ["getPlayStatsForServerUsers", () => getPlayStatsForServerUsers(["msu-1", "msu-2"])],
    ["getUserPlayStats", () => getUserPlayStats("msu-1")],
    ["getPlayYearsForServerUsers", () => getPlayYearsForServerUsers(["msu-1"])],
    ["getWrappedForServerUsers", () => getWrappedForServerUsers(["msu-1"], 2025)],
    ["getMediaPlayStats(movie)", () => getMediaPlayStats(603, "MOVIE")],
    ["getMediaPlayStats(tv)", () => getMediaPlayStats(1399, "TV")],
    ["getMediaPlayStats(untyped)", () => getMediaPlayStats(1396)],
  ];

  for (const [label, fn] of cases) {
    auditAll(label, await capture(fn));
  }
});

test("no aggregate inlines a caller-supplied id — server-user and tmdb ids are always bound", async () => {
  const hostileId = `msu'); DELETE FROM "PlayHistory"; --`;
  for (const [label, fn] of [
    ["getPlayStatsForServerUsers", () => getPlayStatsForServerUsers([hostileId])],
    ["getUserPlayStats", () => getUserPlayStats(hostileId)],
    ["getPlayYearsForServerUsers", () => getPlayYearsForServerUsers([hostileId])],
    ["getWrappedForServerUsers", () => getWrappedForServerUsers([hostileId], 2024)],
  ] as [string, () => Promise<unknown>][]) {
    const queries = await capture(fn);
    assertBoundNotInlined(label, queries, hostileId);
  }
});

// ── guardrail 7 ─────────────────────────────────────────────────────────────

test("the aggregate layer stays silent across every path exercised here (guardrail 7)", () => {
  assert.deepEqual(errors, [], `unexpected console.error: ${errors.join(" | ")}`);
  assert.deepEqual(warns, [], `unexpected console.warn: ${warns.join(" | ")}`);
});

// The previous-period WHERE used to hand-rebuild the source/mediaType clause
// that appendPlayHistoryFilter is the documented single owner of. Now it binds
// its own $1/$2 window and takes the suffix from the helper, so a filtered
// comparison carries [prevStart, prevEnd, source, mediaType] with $3/$4 — the
// same shape the current-period statements get from buildStatsFilters.
test("getPlayHistoryStats: a filtered previous-period comparison binds window THEN filters via the shared helper", async () => {
  const queries = await capture(() => getPlayHistoryStats({ days: 30, source: "plex", mediaType: "TV" }));
  const prev = queries.filter((q) => q.sql.includes(`"startedAt" < $2`));
  assert.equal(prev.length, 1, "exactly one statement is the previous-period comparison");
  const [q] = prev;

  assert.equal(q!.params.length, 4);
  assert.ok(q!.params[0] instanceof Date && q!.params[1] instanceof Date, "window bounds are Dates");
  assert.ok((q!.params[0] as Date).getTime() < (q!.params[1] as Date).getTime(), "prevStart precedes prevEnd");
  assert.deepEqual(q!.params.slice(2), ["plex", "TV"]);
  assert.ok(q!.sql.includes(`"source" = $3`), excerpt(q!.sql));
  assert.ok(q!.sql.includes(`"mediaType"::text = $4`), excerpt(q!.sql));
  auditAll("getPlayHistoryStats(prev, filtered)", prev);
});

// getMediaPlayStats' avgCompletion is a mean of per-row playDuration/duration.
// playDuration is wall-clock playing seconds with no cap at the runtime, so a
// looped/rewound sitting stores playDuration > duration; each row must be
// clamped at 100% before it enters the mean or the title reads above 100%.
test("getMediaPlayStats: the per-row completion is clamped with LEAST before averaging", async () => {
  const queries = await capture(() => getMediaPlayStats(603, "MOVIE"));
  const avg = queries.filter((q) => q.sql.includes("avg_pct"));
  assert.equal(avg.length, 1, "exactly one avgCompletion statement");
  const sql = avg[0]!.sql.replace(/\s+/g, " ");
  assert.ok(
    sql.includes(`LEAST("playDuration"::float / "duration", 1.0) * 100`),
    `the ratio is clamped at 1.0 before scaling to a percentage: ${excerpt(sql)}`,
  );
});
