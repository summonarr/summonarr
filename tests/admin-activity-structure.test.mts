// Review 2026-09, package P22 — structural pins for two admin/activity findings.
//
// f69: the admin/activity page seeds page 1 of "Recent plays" with a Prisma
// findMany, while `ActivityRecentPlays` loads page 2+ from /api/play-history's
// ungrouped query (`ORDER BY startedAt DESC, id DESC`). Same-poll sessions
// share a stamped `startedAt`, so a tie straddling the page boundary repeats
// one row (dropped by the client's Set dedup) and silently skips the other
// unless the seed carries the SAME `id` tiebreak in the SAME direction.
//
// f67: `activity-recent-plays.tsx` no longer carries a private copy of the
// bitrate formatter — guardrail 19a's "private copies drift" rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PAGE = readFileSync(
  new URL("../src/app/(app)/admin/activity/page.tsx", import.meta.url),
  "utf8",
);
const RECENT = readFileSync(
  new URL("../src/components/admin/activity-recent-plays.tsx", import.meta.url),
  "utf8",
);
// The card's rows and its list loading live beside it (recent-plays/).
const RECENT_ROW = readFileSync(
  new URL("../src/components/admin/recent-plays/row.tsx", import.meta.url),
  "utf8",
);
const RECENT_HOOK = readFileSync(
  new URL("../src/components/admin/recent-plays/use-recent-plays.ts", import.meta.url),
  "utf8",
);
// The play-history table's SQL lives beside the route (src/lib/play-history-list.ts).
const ROUTE = readFileSync(
  new URL("../src/lib/play-history-list.ts", import.meta.url),
  "utf8",
);

test("f69: the recent-plays page-1 seed orders by (startedAt desc, id desc) to match /api/play-history", () => {
  const start = PAGE.indexOf("prisma.playHistory.findMany({");
  assert.ok(start >= 0, "page seeds recent plays from prisma.playHistory.findMany");
  const end = PAGE.indexOf("take: RECENT_PLAYS_PAGE_SIZE", start);
  assert.ok(end > start, "the seed takes the shared page size");
  const block = PAGE.slice(start, end);
  assert.match(
    block,
    /orderBy:\s*\[\s*\{\s*startedAt:\s*"desc"\s*\},\s*\{\s*id:\s*"desc"\s*\}\s*\]/,
    "seed must carry an `id` DESC tiebreak after startedAt DESC",
  );
  // The API side this must agree with: both keys share one direction.
  assert.match(ROUTE, /ORDER BY h\."\$\{sortBy\}" \$\{dir\}, h\."id" \$\{dir\}/);
});

test("f67: activity-recent-plays uses the shared fmtBitrate, not a private formatter copy", () => {
  for (const src of [RECENT, RECENT_ROW, RECENT_HOOK]) {
    assert.doesNotMatch(src, /function formatBitrate\(/);
    assert.doesNotMatch(src, /bitrateToKbps/, "no direct bitrate math in the card");
  }
  assert.match(RECENT_ROW, /fmtBitrate,?\s*[\s\S]*?\} from "@\/components\/admin\/activity-ui"/);
  assert.match(RECENT_ROW, /fmtBitrate\(play\.bitrate, play\.source\)/);
});

// ═══ the activity overview's data reads ═══════════════════════════════════════

test("the overview tests each Plex admin token for PRESENCE with a key-only read — no token reaches the decryption extension", () => {
  const statusKeys = PAGE.slice(PAGE.indexOf("const plexStatusKeys"), PAGE.indexOf("const plexTokenKeys"));
  assert.doesNotMatch(statusKeys, /AdminToken/, "the value-reading Setting query no longer asks for the token");
  const tokenRead = PAGE.slice(PAGE.indexOf("where: { key: { in: plexTokenKeys }"));
  assert.match(tokenRead, /^where: \{ key: \{ in: plexTokenKeys \}, NOT: \{ value: "" \} \},\s*select: \{ key: true \},/);
});

test("the overview's live-session item lookup is scoped by source, so the [source, sourceItemId, …] index applies", () => {
  const LOOKUP = readFileSync(new URL("../src/lib/activity-session-tmdb.ts", import.meta.url), "utf8");
  assert.match(LOOKUP, /\("source" = \$\{arm\.src\} AND "sourceItemId" IN \(\$\{Prisma\.join\(arm\.ids\)\}\)\)/);
  assert.match(LOOKUP, /WHERE "tmdbId" IS NOT NULL AND/);
  // One row per item, not every past play of it, and still per server instance.
  assert.match(LOOKUP, /SELECT DISTINCT ON \("serverInstance", "sourceItemId"\)/, "still per server instance");
  assert.match(LOOKUP, /ORDER BY "serverInstance", "sourceItemId", "startedAt" DESC/, "the newest play of each item");
});

test("the Activity pages resolve posters through the shared lookup — no hand-parsed TmdbCache rows", () => {
  for (const rel of ["page.tsx", "recent/page.tsx", "play/[id]/page.tsx"]) {
    const src = readFileSync(new URL(`../src/app/(app)/admin/activity/${rel}`, import.meta.url), "utf8");
    assert.match(src, /resolvePosterMap\(/, `${rel} uses resolvePosterMap`);
    assert.doesNotMatch(src, /tmdbCache\.findMany/, `${rel} still reads TmdbCache itself`);
    assert.doesNotMatch(src, /JSON\.parse\(row\.data\)/, `${rel} still parses cache rows inline`);
  }
});

// The day and hour buckets are in the statistics time zone (an admin setting,
// stats-time-zone.ts); every surface showing one names that zone, which the
// server hands over with the data — never "UTC" hard-coded, never the browser's.
test("the overview labels its peak hour and busiest day with the statistics zone", () => {
  assert.match(PAGE, /const zoneLabel = zoneShortLabel\(stats\.timeZone\);/);
  assert.match(PAGE, /hour: `\$\{String\(peakHour\)\.padStart\(2, "0"\)\}:00 \$\{zoneLabel\}`/);
  assert.match(PAGE, /day: `\$\{fmtDay\(busiestDay\.day\)\} \$\{zoneLabel\}`/);
  assert.match(PAGE, /\} · \$\{zoneLabel\}`/, "the Busiest day KPI names its day's zone");
  assert.doesNotMatch(PAGE, / UTC`/, "no hard-coded UTC marker is left");
  // The calendar's window is the zone's 365 days, ending on the zone's today.
  assert.match(PAGE, /today=\{zonedTodayIso\(new Date\(\), stats\.timeZone\)\}/);
  assert.match(PAGE, /timeZone=\{stats\.timeZone\}/);
});

test("the personal views name the statistics zone on their day and hour buckets", () => {
  const wrapped = readFileSync(new URL("../src/components/watch-history/wrapped-view.tsx", import.meta.url), "utf8");
  assert.match(wrapped, /const zone = zoneShortLabel\(w\.timeZone\);/);
  assert.match(wrapped, /hour: `\$\{hourLabel\(prime\.hour, locale\)\} \$\{zone\}`/, "prime time");
  assert.match(wrapped, /fmtDay\(w\.biggestDay\.day, locale\)\}\{" "\}\s*<span[^>]*>\{zone\}<\/span>/, "biggest binge");
  // No offset arithmetic in the client: the server buckets in the zone.
  assert.doesNotMatch(wrapped, /getTimezoneOffset/);
  const myStats = readFileSync(new URL("../src/components/watch-history/my-stats-view.tsx", import.meta.url), "utf8");
  assert.match(myStats, /<HourHeatmap matrix=\{heatmapMatrix\} timeZone=\{s\.timeZone\} \/>/);
  assert.match(myStats, /<ActivityCalendar data=\{s\.activityCalendar\} today=\{s\.todayIso\} timeZone=\{s\.timeZone\} \/>/);
  // The shared HourHeatmap names the zone at the end of its hour axis, the full
  // name in the title.
  const ui = readFileSync(new URL("../src/components/admin/activity-heatmap.tsx", import.meta.url), "utf8");
  const heatmap = ui.slice(ui.indexOf("export function HourHeatmap("));
  assert.match(heatmap, /const zone = zoneShortLabel\(timeZone\);/);
  assert.match(heatmap, /title=\{t\("adminActivity\.heatmap\.zoneTitle", \{ zone: timeZone \}\)\}[\s\S]{0,400}\{zone\}\s*<\/div>/);
  // The pages hand the zone's today to the calendars, not the UTC instant.
  for (const rel of ["my-stats/page.tsx", "admin/activity/user/[id]/page.tsx"]) {
    const src = readFileSync(new URL(`../src/app/(app)/${rel}`, import.meta.url), "utf8");
    assert.match(src, /todayIso: zonedTodayIso\(new Date\(\), stats\.timeZone\)/, rel);
  }
});

// ═══ Recent plays: page size, live refresh, headers, ticking times ════════════

test("the recent-plays seed and the card's page-N requests share one page size", async () => {
  const { RECENT_PLAYS_PAGE_SIZE } = await import("../src/lib/activity-constants.ts");
  assert.equal(RECENT_PLAYS_PAGE_SIZE, 20);
  assert.match(PAGE, /import \{ RECENT_PLAYS_PAGE_SIZE \} from "@\/lib\/activity-constants"/);
  assert.doesNotMatch(PAGE, /take: 20\b/);
  assert.match(RECENT_HOOK, /filterParams\.set\("limit", String\(RECENT_PLAYS_PAGE_SIZE\)\)/);
  for (const src of [RECENT, RECENT_ROW, RECENT_HOOK]) {
    assert.doesNotMatch(src, />= 20\b/, "no private copy of the page size");
    assert.doesNotMatch(src, /"20"/, "no private copy of the page size");
  }
});

test("a live refresh past page 1 merges new plays by id instead of being ignored", () => {
  const start = RECENT_HOOK.indexOf("useEffect(() => {\n    if (page === 1)");
  assert.ok(start > 0, "the sync effect replaces on page 1");
  const effect = RECENT_HOOK.slice(start, RECENT_HOOK.indexOf("}, [initialPlays, page]);", start));
  assert.doesNotMatch(RECENT_HOOK, /if \(page !== 1\) return;/, "past page 1 every refresh was dropped");
  // Past page 1 the new plays are merged in by id (tests/recent-plays-map.test.mts)
  // and the paging state is left alone.
  const merge = effect.slice(effect.indexOf("return;"));
  assert.match(merge, /setPlays\(\(prev\) => mergeRefreshedPlays\(prev, initialPlays\)\);/);
  assert.doesNotMatch(merge, /setPage|setHasMore/);
});

test("every recent-plays column header has an accessible name", () => {
  const head = RECENT.slice(RECENT.indexOf("<thead>"), RECENT.indexOf("</thead>"));
  assert.match(head, /<span className="sr-only">\{t\("adminActivity\.field\.details"\)\}<\/span>/, "chevron column");
  assert.match(head, /<span className="sr-only">\{t\("adminActivity\.field\.progress"\)\}<\/span>/, "progress column");
  assert.doesNotMatch(head, /^\s*"",\s*$/m, "no blank header entry");
  assert.doesNotMatch(head, /<th[^>]*\/>/, "no empty self-closing header cell");
});

test("Recent plays' Started cells tick every minute on their own, not the whole table (guardrail 16)", () => {
  assert.match(RECENT_ROW, /import \{ useMinuteTick \} from "@\/hooks\/use-minute-tick"/);
  const cell = RECENT_ROW.slice(RECENT_ROW.indexOf("function StartedAgo("));
  assert.match(cell.slice(0, cell.indexOf("\n}\n")), /\n  useMinuteTick\(\);\n/, "the cell owns the tick");
  assert.match(RECENT_ROW, /mounted \? formatRelativeTimeLocalized\(iso, locale\) : ""/, "still mounted-gated");
  assert.match(RECENT_ROW, /<StartedAgo iso=\{p\.startedAt\} \/>/);
  assert.match(RECENT_ROW, /export const RecentPlayRow = memo\(function RecentPlayRow\(/, "rows skip the card's re-renders");
  assert.doesNotMatch(RECENT, /useMinuteTick/, "the card itself no longer re-renders every minute");
  const hook = readFileSync(new URL("../src/hooks/use-minute-tick.ts", import.meta.url), "utf8");
  assert.match(hook, /setInterval\(emit, 60_000\)/, "one shared minute ticker");
  assert.match(hook, /clearInterval\(id\)/);
  assert.match(hook, /useSyncExternalStore\(subscribe, getSnapshot, getServerSnapshot\)/, "every caller reads the one ticker");
  assert.doesNotMatch(hook, /Date\.now|new Date/, "the hook itself never reads the clock");
});

// ═══ Now playing ═══════════════════════════════════════════════════════════════

const SESSION_CARD = readFileSync(new URL("../src/components/admin/now-playing/session-card.tsx", import.meta.url), "utf8");
const TERMINATE = readFileSync(new URL("../src/components/admin/now-playing/terminate-button.tsx", import.meta.url), "utf8");

// The rule itself is unit-tested in tests/now-playing-rules.test.mts.
test("a relayed session whose location already reads relay shows RELAY once", () => {
  assert.match(SESSION_CARD, /const net = networkSignals\(s\);/);
  assert.match(SESSION_CARD, /\{net\.relay && \(/);
  assert.match(SESSION_CARD, /if \(net\.empty\) return DASH;/, "nothing to show is a placeholder, never a blank cell");
});

test("a terminate request with no answer shows translated copy, never the browser's raw message", () => {
  const onSubmit = TERMINATE.slice(TERMINATE.indexOf("async function onSubmit("));
  const body = onSubmit.slice(0, onSubmit.indexOf("\n  }\n"));
  assert.doesNotMatch(body, /err\.message|String\(err\)|res\.detail\)/);
  assert.match(body, /const outcome = terminateOutcome\(res, t\);/);
  assert.match(body, /if \(outcome\.log\) console\.error\(`\[activity-now-playing\] terminate failed \(\$\{outcome\.log\}\)`\);/);
  assert.match(body, /setError\(outcome\.message\);/);
  assert.doesNotMatch(TERMINATE, /setTimeout/, "a successful terminate no longer waits on a timer to free the dialog");
  assert.match(body, /\{ ifBusy: "skip" \}/, "a second submit while one is out never asks twice");
});

// ═══ Overview leaderboard ═════════════════════════════════════════════════════

test("the top-viewers hours bar is scaled to the real leader, not a 1-hour floor", () => {
  const sections = readFileSync(new URL("../src/components/admin/activity-sections.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(sections, /u\.hours\), 1\)/);
  assert.match(sections, /const maxHours = Math\.max\(0, \.\.\.users\.map\(\(u\) => u\.hours\)\) \|\| 1;/);
});

// ═══ Shared leaderboard row and memoized history rows ═════════════════════════

test("every Activity leaderboard renders its rows through the one shared LeaderboardRow", () => {
  const ui = readFileSync(new URL("../src/components/admin/activity-ui.tsx", import.meta.url), "utf8");
  assert.match(ui, /export function LeaderboardRow\(/);
  for (const rel of ["activity-sections.tsx", "activity-stats-redesign.tsx", "activity-title-detail.tsx"]) {
    const src = readFileSync(new URL(`../src/components/admin/${rel}`, import.meta.url), "utf8");
    assert.match(src, /<LeaderboardRow\b/, `${rel} uses the shared row`);
    assert.doesNotMatch(src, /function (LbRow|LeaderRow)\(/, `${rel} keeps no private row`);
    assert.doesNotMatch(src, /\.toString\(\)\.padStart\(2, "0"\)/, `${rel} builds no rank badge of its own`);
  }
});

test("the History rows are memoized with stable callbacks, so a search keystroke skips them", () => {
  const row = readFileSync(new URL("../src/components/admin/activity-history/table-row.tsx", import.meta.url), "utf8");
  assert.match(row, /export const HistoryTableRow = memo\(function HistoryTableRow\(/);
  const table = readFileSync(new URL("../src/components/admin/activity-history-table.tsx", import.meta.url), "utf8");
  assert.match(table, /const toggleExpanded = useCallback\(\s*\(id: string\) => setExpandedId\(\(cur\) => \(cur === id \? null : id\)\),\s*\[\],\s*\);/);
  assert.match(table, /onToggle=\{toggleExpanded\}/);
  assert.match(table, /onDelete=\{openDelete\}/);
  assert.match(table, /const rowNodes = useMemo\(/);
});

// ═══ Expandable rows, leaderboard colours ═════════════════════════════════════

test("an expandable Activity row toggles through a real button, not a focusable <tr>", () => {
  for (const rel of ["activity-history/table-row.tsx", "recent-plays/row.tsx"]) {
    const src = readFileSync(new URL(`../src/components/admin/${rel}`, import.meta.url), "utf8");
    const tr = src.slice(src.indexOf("<tr\n"), src.indexOf(">", src.indexOf("<tr\n")));
    assert.doesNotMatch(tr, /tabIndex|aria-expanded|onKeyDown/, `${rel}: the row is no longer a pseudo-button`);
    assert.match(src, /<button\s+type="button"[\s\S]{0,120}aria-expanded=\{isExpanded\}\s+aria-controls=\{isExpanded \? detailId : undefined\}/, rel);
    assert.match(src, /e\.stopPropagation\(\);\s+onToggle\(/, `${rel}: the button doesn't toggle twice through the row`);
    assert.match(src, /id=\{detailId\}|id=\{id\}/, `${rel}: the detail row carries the id the button names`);
  }
});

test("History rows stripe through a class, so the .history-row hover rule can show", () => {
  const row = readFileSync(new URL("../src/components/admin/activity-history/table-row.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(row, /"color-mix\(in oklab, var\(--ds-fg\) 1\.2%, transparent\)"/, "no inline zebra fill");
  assert.match(row, /background: isExpanded \? "var\(--ds-bg-3\)" : undefined,/);
});

test("leaderboard colours and keys follow the person or title, never the rank", () => {
  const sections = readFileSync(new URL("../src/components/admin/activity-sections.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(sections, /POSTER_ACCENTS|% POSTER_ACCENTS\.length|\$\{m\.tmdbId\}-\$\{i\}/);
  assert.match(sections, /accent=\{accentFor\(u\.id\)\}/);
  assert.match(sections, /accent=\{accentFor\(m\.title\)\}/);
  assert.match(sections, /key=\{`\$\{m\.mediaType\}-\$\{m\.tmdbId\}`\}/);
  assert.match(sections, /\{mediaTypeLabel\(t, m\.mediaType\)\}/, "the type tag is translated, not the raw enum");
  assert.match(SESSION_CARD, /import \{ accentFor \} from "@\/components\/admin\/activity-accent";/, "one hash for both");
});
