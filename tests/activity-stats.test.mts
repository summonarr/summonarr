// Admin Activity → Statistics (2026-10-10 audit). Pins each fix the audit made,
// against the aggregate layer in src/lib/play-history.ts and the pure helpers
// the page shares with its client components:
//
//   - peak concurrency applies a stop before a start at the same instant: both
//     pollers finalize an autoplayed episode and create the next one with ONE
//     `now`, and starts-first read every hand-off as two streams;
//   - "Movie decades · movies only" is filtered to movies (episodes carry their
//     own air year and outnumbered every film);
//   - the rewatch rate matches per EPISODE (not per show), across the window
//     edge, with a server-item fallback for unmatched plays — replacing "plays
//     per unique title", which read every new episode as a repeat;
//   - unique titles count (tmdbId, mediaType) pairs (movie and TV ids overlap);
//   - the source split and client apps are session analytics, like the stream
//     method they sit beside;
//   - a previous window play history doesn't fully cover yields no deltas;
//   - legacy Plex reason labels are read back as what Plex reported;
//   - a clearActivityCache() during a computation is not undone by that
//     computation caching its result afterwards, and concurrent cold loads
//     share one computation;
//   - the `days` parser the filter bar now shares with the server pages.
//
// No DB (the suite never touches one): $queryRawUnsafe is shadowed. The SQL
// itself was run against a real Postgres when these fixes were made; here the
// structure is pinned so a revert fails a named test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { getPlayHistoryStats, getHeatmapCellDetail, clearActivityCache } = await import("../src/lib/play-history.ts");
const { parseActivityDays, ACTIVITY_DEFAULT_DAYS, ACTIVITY_MAX_DAYS } = await import("../src/lib/activity-days.ts");
const reasons = await import("../src/lib/transcode-reasons.ts");

// ── stubs ───────────────────────────────────────────────────────────────────

interface Captured { sql: string; params: unknown[] }
let captured: Captured[] = [];
// Canned rows per statement, matched on a marker unique to that statement.
let canned: { marker: string; rows: unknown[] }[] = [];
// While set, every statement waits on it — parks a computation mid-flight.
let hold: Promise<void> | null = null;

shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string, ...params: unknown[]) => {
  captured.push({ sql, params });
  if (hold) await hold;
  return canned.find((c) => sql.includes(c.marker))?.rows ?? [];
});
let settingRows: { key: string; value: string | null }[] = [];
shadowPrismaModel(prisma, "setting", { findMany: async () => settingRows });
shadowPrismaModel(prisma, "tmdbMediaCore", { findMany: async () => [] });
shadowPrismaModel(prisma, "tmdbCache", { findMany: async () => [] });

async function capture(fn: () => Promise<unknown>): Promise<Captured[]> {
  captured = [];
  await fn();
  const out = captured;
  captured = [];
  return out;
}

function one(queries: Captured[], marker: string): Captured {
  const hits = queries.filter((q) => q.sql.includes(marker));
  assert.equal(hits.length, 1, `exactly one statement carries ${JSON.stringify(marker)} (found ${hits.length})`);
  return hits[0]!;
}

const flat = (sql: string) => sql.replace(/\s+/g, " ");

// Each test lands on its own cache key by varying `days`.
let dayKey = 100;
const freshDays = () => ++dayKey;

// ── SQL structure ────────────────────────────────────────────────────────────

test("peak concurrency applies a stop before a start at the same instant", async () => {
  const q = one(await capture(() => getPlayHistoryStats({ days: freshDays() })), "AS peak");
  assert.match(flat(q.sql), /ORDER BY t, delta ASC/, "starts-first counted every autoplay hand-off as two streams");
  assert.doesNotMatch(q.sql, /delta DESC/);
});

test('"Movie decades" counts movies only', async () => {
  const q = one(await capture(() => getPlayHistoryStats({ days: freshDays() })), "AS decade");
  assert.match(q.sql, /"mediaType"::text = 'MOVIE'/, "episodes carry their own air year and swamped the chart");
});

test("unique titles count (tmdbId, mediaType) pairs, never a bare tmdbId", async () => {
  const q = one(await capture(() => getPlayHistoryStats({ days: freshDays() })), "AS unique_titles");
  assert.match(q.sql, /COUNT\(DISTINCT \("tmdbId", "mediaType"\)\)/);
  assert.doesNotMatch(q.sql, /COUNT\(DISTINCT "tmdbId"\)/);
});

test("the rewatch query matches the same viewer and the same EPISODE, earlier, watched", async () => {
  const queries = await capture(() => getPlayHistoryStats({ days: freshDays(), source: "plex", mediaType: "TV" }));
  const q = one(queries, "AS rewatches");
  const sql = flat(q.sql);
  // The outer rows are the window's watched plays, with the page's filters bound.
  assert.match(sql, /FROM "PlayHistory" p WHERE p\."startedAt" >= \$1 AND p\."source" = \$2 AND p\."mediaType"::text = \$3 AND p\."watched" = true$/);
  assert.equal(q.params.length, 3);
  // Per episode: season AND episode must match — a show-level match is the old
  // plays-per-title trap (episode 2 after episode 1 is not a rewatch).
  assert.match(sql, /q\."seasonNumber" = p\."seasonNumber" AND q\."episodeNumber" = p\."episodeNumber"/);
  // Same viewer, strictly earlier, and that earlier play was itself watched.
  assert.equal((sql.match(/q\."mediaServerUserId" = p\."mediaServerUserId"/g) ?? []).length, 3, "every branch is per viewer");
  assert.equal((sql.match(/q\."startedAt" < p\."startedAt" AND q\."watched" = true/g) ?? []).length, 3, "every branch looks back at watched plays");
  // Unmatched plays fall back to the server's own item id, scoped per server.
  assert.match(sql, /q\."source" = p\."source" AND q\."serverInstance" = p\."serverInstance" AND q\."sourceItemId" = p\."sourceItemId"/);
  // The earlier play may predate the window: no window bound inside EXISTS.
  const lookbacks = sql.slice(sql.indexOf("EXISTS"), sql.indexOf(`FROM "PlayHistory" p WHERE`));
  assert.doesNotMatch(lookbacks, /\$\d/, "the lookback is not limited to the window (or any filter)");
});

test("source split and client apps count every session, like the stream method beside them", async () => {
  const queries = await capture(() => getPlayHistoryStats({ days: freshDays() }));
  const split = one(queries, `SELECT "source", COUNT(*)::bigint AS count`);
  const players = one(queries, "AS player");
  const method = one(queries, `"playMethod" AS method`);
  for (const [label, q] of [["source split", split], ["client apps", players], ["stream method", method]] as const) {
    assert.doesNotMatch(q.sql, /"watched" = true/, `${label} must not filter to watched plays`);
  }
});

test("the observed-history probe binds the previous window's start and the SOURCE filter only", async () => {
  const queries = await capture(() => getPlayHistoryStats({ days: 30, source: "jellyfin", mediaType: "MOVIE" }));
  const q = one(queries, "AS observed");
  assert.equal(q.params.length, 2);
  assert.ok(q.params[0] instanceof Date);
  const prevStart = (q.params[0] as Date).getTime();
  const expected = Date.now() - 60 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(prevStart - expected) < 60_000, "binds now − 2×days (the previous window's start)");
  assert.equal(q.params[1], "jellyfin");
  assert.match(flat(q.sql), /"startedAt" < \$1 AND "source" = \$2/);
  assert.doesNotMatch(q.sql, /mediaType/, "a media type nobody watched is not an untracked one");
});

test("legacy Plex reason labels are rewritten on Plex rows only, in both the page and the heatmap cell", async () => {
  const pageReasons = one(await capture(() => getPlayHistoryStats({ days: freshDays() })), "Other reasons");
  const cell = await capture(() => getHeatmapCellDetail({ mode: "hour", days: freshDays(), dow: 1, hour: 20 }));
  const cellReasons = one(cell, "AS reason");
  for (const [label, q] of [["page", pageReasons], ["heatmap cell", cellReasons]] as const) {
    const sql = flat(q.sql);
    assert.match(sql, /WHEN "source" = 'plex' THEN REPLACE\(/, `${label}: Plex rows are rewritten`);
    for (const [from, to] of Object.entries(reasons.LEGACY_PLEX_REASON_LABELS)) {
      assert.ok(sql.includes(`'${from}', '${to}'`), `${label}: ${from} → ${to}`);
    }
    assert.match(sql, /ELSE "transcodeReason" END/, `${label}: Jellyfin rows keep their own reasons`);
  }
});

// ── result mapping ───────────────────────────────────────────────────────────

test("the rewatch rate is rewatches over the SAME query's watched plays", async () => {
  canned = [
    { marker: "AS rewatches", rows: [{ plays: 8n, rewatches: 3n }] },
    { marker: "AS observed", rows: [{ observed: true }] },
  ];
  try {
    const stats = await getPlayHistoryStats({ days: freshDays() });
    assert.equal(stats.rewatchPlays, 3);
    assert.equal(stats.rewatchRate, 37.5);
  } finally {
    canned = [];
  }
  const empty = await getPlayHistoryStats({ days: freshDays() });
  assert.equal(empty.rewatchRate, 0, "no plays ⇒ 0, never NaN");
});

test("prevPeriod.complete: needs a recorded play before the previous window", async () => {
  canned = [{ marker: "AS observed", rows: [{ observed: true }] }];
  try {
    assert.equal((await getPlayHistoryStats({ days: freshDays() })).prevPeriod.complete, true);
    canned = [{ marker: "AS observed", rows: [{ observed: false }] }];
    assert.equal(
      (await getPlayHistoryStats({ days: freshDays() })).prevPeriod.complete,
      false,
      "tracking began inside the previous window ⇒ no delta",
    );
  } finally {
    canned = [];
  }
});

test("prevPeriod.complete: retention shorter than both windows cuts into the previous one", async (t) => {
  canned = [{ marker: "AS observed", rows: [{ observed: true }] }];
  settingRows = [{ key: "playHistoryRetentionDays", value: "45" }];
  // loadSettings memoizes for 15 s; step the clock past it so the stub is read.
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; canned = []; settingRows = []; });
  Date.now = () => realNow() + 60_000;
  assert.equal((await getPlayHistoryStats({ days: 30 })).prevPeriod.complete, false, "45 < 2 × 30");
  assert.equal((await getPlayHistoryStats({ days: 20 })).prevPeriod.complete, true, "45 ≥ 2 × 20");
});

// ── cache: generation guard + coalescing ─────────────────────────────────────

function holdStatements(): () => void {
  let release!: () => void;
  hold = new Promise<void>((r) => { release = r; });
  return () => { hold = null; release(); };
}
const settle = () => new Promise((r) => setImmediate(r));
const computations = (qs: Captured[]) => qs.filter((q) => q.sql.includes("AS peak")).length;

test("concurrent cold loads of one key share ONE computation", async () => {
  const days = freshDays();
  captured = [];
  const release = holdStatements();
  const a = getPlayHistoryStats({ days });
  const b = getPlayHistoryStats({ days });
  await settle();
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra, rb, "both callers receive the one shared result");
  assert.equal(computations(captured), 1, "the ~35-statement fan-out ran once, not once per caller");
});

test("a result computed across a clearActivityCache() is returned but NOT cached", async () => {
  const days = freshDays();
  captured = [];
  const release = holdStatements();
  const stale = getPlayHistoryStats({ days });
  await settle();
  clearActivityCache(); // a session finalized while the fan-out was in flight
  release();
  await stale;
  await getPlayHistoryStats({ days });
  assert.equal(computations(captured), 2, "the next load recomputes — the pre-clear numbers were not cached");
});

test("without a clear, the computed result IS cached (control)", async () => {
  const days = freshDays();
  captured = [];
  await getPlayHistoryStats({ days });
  await getPlayHistoryStats({ days });
  assert.equal(computations(captured), 1);
});

test("a load after a clear does not join the computation that predates it", async () => {
  const days = freshDays();
  captured = [];
  const release = holdStatements();
  const before = getPlayHistoryStats({ days });
  await settle();
  clearActivityCache();
  const after = getPlayHistoryStats({ days });
  await settle();
  release();
  await Promise.all([before, after]);
  assert.equal(computations(captured), 2, "the post-clear caller started its own computation");
  await getPlayHistoryStats({ days });
  assert.equal(computations(captured), 2, "…and that one, started after the clear, was cached");
});

// ── pure helpers ─────────────────────────────────────────────────────────────

test("parseActivityDays mirrors what the pages render", () => {
  assert.equal(parseActivityDays(undefined), ACTIVITY_DEFAULT_DAYS);
  assert.equal(parseActivityDays(null), ACTIVITY_DEFAULT_DAYS);
  assert.equal(parseActivityDays(""), ACTIVITY_DEFAULT_DAYS);
  assert.equal(parseActivityDays("0"), ACTIVITY_DEFAULT_DAYS, "?days=0 renders the default — the bar must not say Custom: 0");
  assert.equal(parseActivityDays("abc"), ACTIVITY_DEFAULT_DAYS);
  assert.equal(parseActivityDays("-5"), 1);
  assert.equal(parseActivityDays("45"), 45);
  assert.equal(parseActivityDays("45abc"), 45);
  assert.equal(parseActivityDays("99999"), ACTIVITY_MAX_DAYS);
});

test("every server page and route that reads ?days= uses parseActivityDays", () => {
  for (const path of [
    "../src/app/(app)/admin/activity/page.tsx",
    "../src/app/(app)/admin/activity/history/page.tsx",
    "../src/app/(app)/admin/activity/stats/page.tsx",
    "../src/app/api/play-history/stats/route.ts",
    "../src/app/api/play-history/transcode-offenders/route.ts",
    "../src/components/admin/activity-filter-bar.tsx",
  ]) {
    const src = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(src, /parseActivityDays\(/, `${path} parses days through the shared helper`);
    assert.doesNotMatch(src, /\|\| 30, 1\), 3650\)/, `${path} still carries a private copy of the clamp`);
  }
});

test("translateTranscodeReason translates each comma-joined part and keeps unknown ones", () => {
  const t = (k: string) => `<${k}>`;
  assert.equal(
    reasons.translateTranscodeReason("Video codec not supported, Subtitle burn-in", t),
    "<adminActivity.reason.videoCodecNotSupported>, <adminActivity.reason.subtitleBurnIn>",
  );
  assert.equal(reasons.translateTranscodeReason("Some future reason", t), "Some future reason");
  assert.equal(reasons.translateTranscodeReason(reasons.UNKNOWN_REASON, t), "<adminActivity.stats.unknown>");
});

test("isPlexStreamOnlyReason flags the Plex what-was-transcoded labels, not causes", () => {
  assert.equal(reasons.isPlexStreamOnlyReason(reasons.PLEX_VIDEO_TRANSCODED), true);
  assert.equal(reasons.isPlexStreamOnlyReason(`${reasons.PLEX_AUDIO_TRANSCODED}, ${reasons.PLEX_SUBTITLE_BURN_IN}`), true);
  assert.equal(reasons.isPlexStreamOnlyReason("Video codec not supported"), false);
  assert.equal(reasons.isPlexStreamOnlyReason(reasons.PLEX_SUBTITLE_BURN_IN), false);
});

test("every reason key exists in the English catalog, and every legacy rewrite lands on a known label", () => {
  const en = JSON.parse(
    readFileSync(new URL("../src/lib/i18n/messages/en/adminActivity.json", import.meta.url), "utf8"),
  ) as Record<string, string>;
  for (const [phrase, key] of Object.entries(reasons.TRANSCODE_REASON_KEYS)) {
    assert.ok(key in en, `${phrase} → ${key} is missing from en/adminActivity.json`);
  }
  for (const to of Object.values(reasons.LEGACY_PLEX_REASON_LABELS)) {
    assert.ok(to in reasons.TRANSCODE_REASON_KEYS, `${to} has a translation`);
  }
  for (const [from, to] of Object.entries(reasons.LEGACY_PLEX_REASON_LABELS)) {
    assert.ok(!/'/.test(from + to), "the rewrites are inlined as SQL literals — no quotes allowed");
  }
});

// ═══ 2026-10 audit fixes ════════════════════════════════════════════════════

test("reasonCalloutKind: Unknown (pre-capture rows), No reason reported (the server said nothing) and real causes are three different sentences", () => {
  assert.equal(reasons.reasonCalloutKind(reasons.UNKNOWN_REASON), "unknown");
  assert.equal(
    reasons.reasonCalloutKind(reasons.NO_REASON_REPORTED),
    "unreported",
    "falling through to 'cause' renders 'Most common reason: No reason reported' — an absence framed as a cause (19c)",
  );
  assert.equal(reasons.reasonCalloutKind("Video codec not supported"), "cause");
  assert.equal(reasons.reasonCalloutKind(reasons.PLEX_VIDEO_TRANSCODED), "cause");
});

test("the Statistics callout words its top reason through reasonCalloutKind, with its own 'unreported' sentence", () => {
  const src = readFileSync(new URL("../src/components/admin/activity-stats-redesign.tsx", import.meta.url), "utf8");
  assert.match(src, /reasonCalloutKind\(topReason\.reason\) === "unknown"/);
  assert.match(src, /reasonCalloutKind\(topReason\.reason\) === "unreported"/);
  assert.match(src, /t\("adminActivity\.stats\.noReasonReportedTop"/);
  assert.doesNotMatch(src, /topReason\.reason === UNKNOWN_REASON/, "the UNKNOWN-only branch is gone");
  const en = JSON.parse(
    readFileSync(new URL("../src/lib/i18n/messages/en/adminActivity.json", import.meta.url), "utf8"),
  ) as Record<string, string>;
  assert.doesNotMatch(en["adminActivity.stats.noReasonReportedTop"], /clears/, "an unreported reason does not clear as data accumulates");
});

test("a TV filter issues no Movie decades statement and answers [] (the two predicates contradict)", async () => {
  let stats: Awaited<ReturnType<typeof getPlayHistoryStats>> | null = null;
  const queries = await capture(async () => { stats = await getPlayHistoryStats({ days: freshDays(), mediaType: "TV" }); });
  assert.equal(queries.filter((q) => q.sql.includes("AS decade")).length, 0);
  assert.deepEqual(stats!.decadeBreakdown, []);
  const movie = await capture(() => getPlayHistoryStats({ days: freshDays(), mediaType: "MOVIE" }));
  assert.equal(movie.filter((q) => q.sql.includes("AS decade")).length, 1, "a MOVIE filter still asks");
});

test("the Movie decades card says why it is empty under the TV filter, and the page passes the filter down", () => {
  const ui = readFileSync(new URL("../src/components/admin/activity-stats-redesign.tsx", import.meta.url), "utf8");
  assert.match(ui, /mediaType === "TV" \?/);
  assert.match(ui, /t\("adminActivity\.stats\.movieDecadesTvFiltered"\)/);
  const page = readFileSync(new URL("../src/app/(app)/admin/activity/stats/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<ActivityStatsRedesign[^>]*mediaType=\{mediaType\}/);
});

test("rewatch: the item key is a match for EVERY play (an unmatched earlier play still counts), and the show-level tmdb match is movies only", async () => {
  const q = one(await capture(() => getPlayHistoryStats({ days: freshDays() })), "AS rewatches");
  const sql = flat(q.sql);
  assert.match(sql, /END\) OR \(p\."sourceItemId" IS NOT NULL AND EXISTS/, "the item key sits OUTSIDE the CASE");
  assert.doesNotMatch(sql, /WHEN p\."sourceItemId" IS NOT NULL THEN/, "as a CASE branch it only ran for unmatched plays");
  assert.match(sql, /WHEN p\."tmdbId" IS NOT NULL AND p\."mediaType"::text = 'MOVIE' THEN EXISTS/);
  assert.doesNotMatch(
    sql,
    /WHEN p\."tmdbId" IS NOT NULL THEN EXISTS/,
    "a numberless TV play matched every other numberless episode of the show through IS NOT DISTINCT FROM",
  );
});

// prevPeriod.complete reads Settings through loadSettings' 15 s memo, so each
// call steps the clock past it.
async function completeWith(
  t: { after: (fn: () => void) => void },
  rows: { key: string; value: string | null }[],
  filters: Parameters<typeof getPlayHistoryStats>[0],
): Promise<{ complete: boolean; probe: Captured }> {
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; canned = []; settingRows = []; });
  completeSkew += 20_000;
  const skew = completeSkew;
  Date.now = () => realNow() + skew;
  settingRows = rows;
  canned = [{ marker: "AS observed", rows: [{ observed: true }] }];
  clearActivityCache();
  let complete = false;
  const queries = await capture(async () => { complete = (await getPlayHistoryStats(filters)).prevPeriod.complete; });
  Date.now = realNow;
  return { complete, probe: one(queries, "AS observed") };
}
// Starts an hour ahead: earlier tests in this file step the clock too, and a
// settings memo they left behind must already be expired.
let completeSkew = 60 * 60_000;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() + completeSkew + 20_000 - n * DAY).toISOString();

test("prevPeriod.complete: a source's tracking stamp inside the previous window hides the delta, an older one or none does not", async (t) => {
  const j = (n: number | null) => (n === null ? [] : [{ key: "playHistoryJellyfinTrackedSince", value: daysAgo(n) }]);
  assert.equal((await completeWith(t, j(40), { days: 30, source: "jellyfin" })).complete, false, "turned back on 40 days ago: the previous window holds 10 days");
  assert.equal((await completeWith(t, j(70), { days: 30, source: "jellyfin" })).complete, true);
  assert.equal((await completeWith(t, j(null), { days: 30, source: "jellyfin" })).complete, true, "no stamp keeps the old behaviour");
  assert.equal(
    (await completeWith(t, j(40), { days: 30, source: "plex" })).complete,
    true,
    "a Jellyfin stamp says nothing about the Plex view",
  );
  assert.equal((await completeWith(t, j(40), { days: 30 })).complete, false, "the unfiltered view counts every source's stamp");
});

test("prevPeriod.complete: the global tracking stamp counts in every view", async (t) => {
  const g = [{ key: "playHistoryTrackedSince", value: daysAgo(40) }];
  assert.equal((await completeWith(t, g, { days: 30 })).complete, false);
  assert.equal((await completeWith(t, g, { days: 30, source: "plex" })).complete, false);
});

test("prevPeriod.complete: unfiltered, EVERY source with plays since the bound must have one before it", async (t) => {
  const unfiltered = flat((await completeWith(t, [], { days: 30 })).probe.sql);
  assert.match(unfiltered, /AND NOT EXISTS \( SELECT 1 FROM \(VALUES \('plex'\), \('jellyfin'\)\) AS s\(src\)/);
  assert.match(unfiltered, /n\."source" = s\.src AND n\."startedAt" >= \$1\) AND NOT EXISTS \(SELECT 1 FROM "PlayHistory" o WHERE o\."source" = s\.src AND o\."startedAt" < \$1\)/);
  const filtered = flat((await completeWith(t, [], { days: 30, source: "plex" })).probe.sql);
  assert.doesNotMatch(filtered, /VALUES/, "a filtered probe is already per source");
});

test("prevPeriod.complete: with retention ≥ both windows the probe's bound moves to a day past the purge cutoff", async (t) => {
  const bound = async (retention: string) => {
    const { probe } = await completeWith(t, [{ key: "playHistoryRetentionDays", value: retention }], { days: 30 });
    return (probe.params[0] as Date).getTime() - completeSkew; // back onto the real clock
  };
  const now = Date.now();
  const at60 = await bound("60");
  assert.ok(Math.abs(at60 - (now - 59 * DAY)) < 5 * 60_000, "retention = 2 × days: the purge erased every row before prevStart");
  const at90 = await bound("90");
  assert.ok(Math.abs(at90 - (now - 60 * DAY)) < 5 * 60_000, "retention well past both windows: prevStart, as before");
  const none = await bound("");
  assert.ok(Math.abs(none - (now - 60 * DAY)) < 5 * 60_000, "no retention: prevStart");
});
