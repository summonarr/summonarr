// Placeholder/parameter-lockstep audit for the raw-SQL aggregate layer in
// src/lib/play-history.ts — the ~70 `$queryRawUnsafe` builders behind the admin
// Statistics page, the activity heatmaps, /popular, Wrapped, and the per-media
// and per-user stat panels.
//
// Why this file exists: CLAUDE.md records that "raw-SQL aggregates (the
// play-history stats/calendar queries) are not exercised at all", and this is
// the one part of the module that has already shipped a real bug — the `$1`
// placeholder offset in getActivityCalendarUncached (the 803cd11 class — that
// hash is no longer in the squashed history — where the SQL said `$2` while
// the value sat at params[0]). tests/play-history.test.mts
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
  getBusiestDay,
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
  clearActivityCache,
  POPULAR_PER_PAGE,
} = await import("../src/lib/play-history.ts");
const { MAX_POPULAR_ROWS } = await import("../src/lib/play-history-popular.ts");
const { invalidateStatsTimeZone } = await import("../src/lib/stats-time-zone-data.ts");

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
// getMostPopularOnServer folds into its params, and the statistics time zone
// (one findUnique). The zone is a test-controlled value, not the host's TZ.
let statsZone = "UTC";
shadowPrismaModel(prisma, "setting", {
  findMany: async () => [],
  findUnique: async (a: { where: { key: string } }) =>
    a.where.key === "statsTimeZone" ? { value: statsZone } : null,
});
function useStatsZone(zone: string): void {
  statsZone = zone;
  invalidateStatsTimeZone();
}
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

test("getMostPopularOnServer: the trending window is an extra BOUND param, and the ranking binds only its fixed row cap", async () => {
  // Rankings are cached per (mediaType, sort): the matrix above filled them.
  clearActivityCache();
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

  // A page is sliced from the cached ranking, so the statement has no OFFSET and
  // its LIMIT is the ranking's cap — the LAST push, so the last index in both
  // shapes (what a mis-captured index variable breaks).
  for (const [label, q] of [["plays", plain], ["trending", trending]] as const) {
    const n = q.params.length;
    assert.match(q.sql, new RegExp(`LIMIT \\$${n}\\s*$`), `${label}: LIMIT must bind the final param ($${n}) — got ${excerpt(q.sql).slice(-60)}`);
    assert.doesNotMatch(q.sql, /OFFSET/, `${label}: no per-page OFFSET`);
    assert.equal(q.params[n - 1], MAX_POPULAR_ROWS, `${label}: the cap binds where the SQL says LIMIT, never the page size`);
  }
});

test("getMostPopularOnServer: page/limit clamps bound the slice; no caller value reaches the statement", async () => {
  // MAX_POPULAR_PAGE / POPULAR_PER_PAGE clamp at the source, so a deep page can't
  // read past the ranking's cap.
  clearActivityCache();
  let result: Awaited<ReturnType<typeof getMostPopularOnServer>> | null = null;
  const [q] = await capture(async () => { result = await getMostPopularOnServer({ page: 10_000_000, limit: 10_000 }); });
  assert.ok(!q.params.includes(10_000) && !q.params.includes(10_000_000), "the caller's page and limit are never bound");
  assert.equal(q.params[q.params.length - 1], MAX_POPULAR_ROWS);
  assert.equal(result!.page, MAX_POPULAR_ROWS / POPULAR_PER_PAGE, "the page is clamped to the last reachable one");
  assert.deepEqual(result!.items, []);
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

test("getActivityCalendar: the filter suffix starts right after the zone — the shipped offset bug stays dead", async () => {
  // The calendar binds only the statistics zone ($1) before its filter suffix,
  // so an unfiltered call binds exactly that one param.
  const bare = await capture(() => getActivityCalendar());
  auditAll("getActivityCalendar()", bare);
  assert.deepEqual(bare[0].params, ["UTC"], "no filters ⇒ only the zone");
  assert.deepEqual([...placeholderSet(bare[0].sql)], [1], "the zone is $1");

  // With one filter the value must be $2. The shipped bug emitted the next index
  // here, leaving a param orphaned — exactly what auditQuery's second assertion catches.
  const oneFilter = await capture(() => getActivityCalendar("plex"));
  auditAll("getActivityCalendar(source)", oneFilter);
  assert.deepEqual([...placeholderSet(oneFilter[0].sql)].sort(), [1, 2], "the first filter param is $2, right after the zone");
  assert.deepEqual(oneFilter[0].params, ["UTC", "plex"]);

  const twoFilters = await capture(() => getActivityCalendar("jellyfin", "MOVIE"));
  auditAll("getActivityCalendar(source, mediaType)", twoFilters);
  assert.deepEqual([...placeholderSet(twoFilters[0].sql)].sort(), [1, 2, 3], "two filters bind $2 and $3 contiguously");
  assert.deepEqual(twoFilters[0].params, ["UTC", "jellyfin", "MOVIE"]);
});

test("getActivityCalendar: an unrecognized filter value is ignored, not bound and not inlined", async () => {
  // `?source=MOVIE` is not a valid source — appendPlayHistoryFilter drops it.
  // The query must then be unfiltered rather than binding a junk value.
  const queries = await capture(() => getActivityCalendar("MOVIE" /* not a source */));
  auditAll("getActivityCalendar(bad source)", queries);
  assert.deepEqual(queries[0].params, ["UTC"], "a whitelist miss binds nothing beyond the zone");
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

// Wrapped's "go-to screen" card: some clients report an empty device or
// platform, and a blank most-common value used to win the top slot and render an
// empty card. Every statement is scoped to the year IN THE STATISTICS ZONE: its
// bounds are the zone's midnights, bound as dates plus the zone.
test("getWrappedForServerUsers: a blank platform/device never wins, and the year is the statistics zone's", async () => {
  const queries = await capture(() => getWrappedForServerUsers(["msu-1", "msu-2"], 2025, "Asia/Tokyo"));
  const plat = queries.find((q) => q.sql.includes(`"platform" AS v`));
  const dev = queries.find((q) => q.sql.includes(`"device" AS v`));
  assert.ok(plat && dev);
  assert.match(plat.sql, /NULLIF\(btrim\("platform"\), ''\) IS NOT NULL/, excerpt(plat.sql));
  assert.match(dev.sql, /NULLIF\(btrim\("device"\), ''\) IS NOT NULL/, excerpt(dev.sql));
  for (const q of queries) {
    assert.ok(
      q.sql.includes(
        `"mediaServerUserId" IN ($1, $2) AND "startedAt" >= (((($3::date)::timestamp) AT TIME ZONE $5::text) AT TIME ZONE 'UTC') ` +
          `AND "startedAt" < (((($4::date)::timestamp) AT TIME ZONE $5::text) AT TIME ZONE 'UTC')`,
      ),
      excerpt(q.sql),
    );
    assert.deepEqual(q.params, ["msu-1", "msu-2", "2025-01-01", "2026-01-01", "Asia/Tokyo"]);
  }
  auditAll("getWrappedForServerUsers", queries);
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

// ── the statistics time zone ────────────────────────────────────────────────
// PlayHistory.startedAt holds UTC with no zone attached. Every hour,
// day-of-week, day, month and year bucket reads it on the statistics zone's wall
// clock — (("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE $n) with the zone a
// BOUND param — and every day boundary is that zone's midnight. A bare
// EXTRACT/date_trunc on the column buckets in UTC again.

const BARE_UTC_BUCKET =
  /EXTRACT\((?:DOW|HOUR|YEAR|MONTH|DAY) FROM (?:\w+\.)?"startedAt"\)|date_trunc\('[a-z]+', (?:\w+\.)?"startedAt"\)|DATE\((?:\w+\.)?"startedAt"\)|to_char\((?:\w+\.)?"startedAt"|"startedAt"\s*[<>]=?\s*\$\d+::date/;
const ZONED_START = /\(\("startedAt" AT TIME ZONE 'UTC'\) AT TIME ZONE \$(\d+)::text\)/g;
const ZONED_MIDNIGHT = /\) AT TIME ZONE \$(\d+)::text\) AT TIME ZONE 'UTC'\)/g;
const BUCKET = /EXTRACT\((?:DOW|HOUR|YEAR)|date_trunc\('(?:day|month)'|to_char\(/;

/** Every zone reference in `q` binds `zone`; returns how many there were. */
function assertZoneBound(label: string, q: Captured, zone: string): number {
  let refs = 0;
  for (const re of [ZONED_START, ZONED_MIDNIGHT]) {
    for (const m of q.sql.matchAll(re)) {
      refs++;
      assert.equal(q.params[Number(m[1]) - 1], zone, `${label}: $${m[1]} must bind the statistics zone\n  ${excerpt(q.sql)}`);
    }
  }
  return refs;
}

test("every hour/day bucket and day boundary reads startedAt in the statistics zone, bound as a param", async () => {
  useStatsZone("America/New_York");
  try {
    const zone = "America/New_York";
    const cases: [string, () => Promise<unknown>, number][] = [
      // [label, call, statements that bucket by hour/day/month/year]
      ["getPlayHistoryStats", () => getPlayHistoryStats({ days: 45 }), 2],
      ["getActivityCalendar", () => getActivityCalendar("plex", "TV"), 1],
      ["getBusiestDay", () => getBusiestDay({ days: 45 }), 1],
      ["getHeatmapCellDetail(day)", () => getHeatmapCellDetail({ mode: "day", day: "2026-04-01" }), 0],
      // The hour cell's five statements all filter on EXTRACT in the zone.
      ["getHeatmapCellDetail(hour)", () => getHeatmapCellDetail({ mode: "hour", dow: 5, hour: 21, days: 45 }), 5],
      ["getPlayStatsForServerUsers", () => getPlayStatsForServerUsers(["msu-z"]), 3],
      ["getPlayYearsForServerUsers", () => getPlayYearsForServerUsers(["msu-z"]), 1],
      ["getWrappedForServerUsers", () => getWrappedForServerUsers(["msu-z"], 2024), 4],
      ["getMediaPlayStats", () => getMediaPlayStats(4242, "MOVIE"), 1],
    ];
    for (const [label, fn, buckets] of cases) {
      const queries = await capture(fn);
      auditAll(label, queries);
      let zoned = 0;
      for (const q of queries) {
        assert.ok(!BARE_UTC_BUCKET.test(q.sql), `${label}: a bucket or day bound reads the bare UTC column\n  ${excerpt(q.sql)}`);
        const refs = assertZoneBound(label, q, zone);
        if (BUCKET.test(q.sql)) {
          assert.ok(refs > 0, `${label}: a bucketed statement never names the zone\n  ${excerpt(q.sql)}`);
          zoned++;
        }
      }
      assert.equal(zoned, buckets, `${label}: bucketed statements`);
    }

    // The drill-downs' cell definitions: the day is the zone's midnight to the
    // next, the hour cell matches EXTRACT on the zone's wall clock.
    const [day] = await capture(() => getHeatmapCellDetail({ mode: "day", day: "2026-04-02" }));
    assert.ok(
      day.sql.includes(
        `"startedAt" >= (((($1::date)::timestamp) AT TIME ZONE $2::text) AT TIME ZONE 'UTC') ` +
          `AND "startedAt" < (((($1::date + 1)::timestamp) AT TIME ZONE $2::text) AT TIME ZONE 'UTC')`,
      ),
      excerpt(day.sql),
    );
    assert.deepEqual(day.params.slice(0, 2), ["2026-04-02", zone]);
    const [hour] = await capture(() => getHeatmapCellDetail({ mode: "hour", dow: 6, hour: 22 }));
    assert.ok(hour.sql.includes(`EXTRACT(DOW FROM (("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE $1::text))::int = $2`), excerpt(hour.sql));
    assert.ok(hour.sql.includes(`EXTRACT(HOUR FROM (("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE $1::text))::int = $3`), excerpt(hour.sql));
    assert.deepEqual(hour.params, [zone, 6, 22]);
  } finally {
    useStatsZone("UTC");
  }
});

// Guardrail 19b: a memoized aggregate that depends on the zone carries it in its
// key, so a zone change never serves the old zone's buckets for the rest of a TTL.
test("the zone-bucketed aggregates are memoized per zone: a new zone recomputes, the same zone is a hit", async () => {
  const calls: [string, () => Promise<unknown>][] = [
    ["getPlayHistoryStats", () => getPlayHistoryStats({ days: 46 })],
    ["getActivityCalendar", () => getActivityCalendar("jellyfin")],
    ["getBusiestDay", () => getBusiestDay({ days: 46 })],
    ["getHeatmapCellDetail", () => getHeatmapCellDetail({ mode: "day", day: "2026-04-03" })],
  ];
  try {
    useStatsZone("Europe/Berlin");
    for (const [label, fn] of calls) {
      assert.ok((await capture(fn)).length > 0, `${label}: the first read computes`);
      assert.equal((await capture(fn)).length, 0, `${label}: the same zone is served from the cache`);
    }
    useStatsZone("Australia/Sydney");
    for (const [label, fn] of calls) {
      const queries = await capture(fn);
      assert.ok(queries.length > 0, `${label}: a new zone must not be served the old zone's buckets`);
      assert.ok(queries.some((q) => q.params.includes("Australia/Sydney")), `${label}: and recomputes in the new zone`);
    }
  } finally {
    useStatsZone("UTC");
  }
});
