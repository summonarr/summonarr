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
const ROUTE = readFileSync(
  new URL("../src/app/api/play-history/route.ts", import.meta.url),
  "utf8",
);

test("f69: the recent-plays page-1 seed orders by (startedAt desc, id desc) to match /api/play-history", () => {
  const start = PAGE.indexOf("prisma.playHistory.findMany({");
  assert.ok(start >= 0, "page seeds recent plays from prisma.playHistory.findMany");
  const block = PAGE.slice(start, PAGE.indexOf("take: 20", start));
  assert.match(
    block,
    /orderBy:\s*\[\s*\{\s*startedAt:\s*"desc"\s*\},\s*\{\s*id:\s*"desc"\s*\}\s*\]/,
    "seed must carry an `id` DESC tiebreak after startedAt DESC",
  );
  // The API side this must agree with: both keys share one direction.
  assert.match(ROUTE, /ORDER BY h\."\$\{sortBy\}" \$\{dir\}, h\."id" \$\{dir\}/);
});

test("f67: activity-recent-plays uses the shared fmtBitrate, not a private formatter copy", () => {
  assert.doesNotMatch(RECENT, /function formatBitrate\(/);
  assert.doesNotMatch(RECENT, /bitrateToKbps/, "no direct bitrate math in the component");
  assert.match(RECENT, /fmtBitrate,?\s*[\s\S]*?\} from "@\/components\/admin\/activity-ui"/);
  assert.match(RECENT, /fmtBitrate\(play\.bitrate, play\.source\)/);
});
