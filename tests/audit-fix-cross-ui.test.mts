// Audit fixes (cross-unit, UI wiring). The pages are .tsx client components the
// unit loader can't import, so their wiring is pinned by a structural scan;
// the wire fields they read are pinned at their routes elsewhere
// (tests/audit-fix-release-delete-outcome.test.mts for `uncertain`, the
// title-command route's `partial`).
//
//   C001 — the request queue's Open in / Manage icons follow the row's OWN
//          integration: a movie's need Radarr switched on, a show's Sonarr
//          (the routes behind them 404 while it is off — arrGate). The coarse
//          "both off" gate stays as the viewer gate.
//   C062 — the never-watched report's selection cap is the route's own
//          CLEANUP_MAX_ITEMS (never a private 500), and a full selection says so.
//   C015 — a cleanup delete whose outcome is unknown (`uncertain: true`) shows a
//          neutral "check Radarr/Sonarr before trying again" note.
//   C007 — a title manager Search missing that Sonarr refused part-way
//          (202 `partial: true`) says only part of the search started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const en = (area: string) => JSON.parse(read(`src/lib/i18n/messages/en/${area}.json`)) as Record<string, string>;

// ═══ C001 ════════════════════════════════════════════════════════════════════

test("C001: the request list gates each row's Open in / Manage on that row's own service", () => {
  const src = read("src/components/admin/admin-request-list.tsx");
  assert.match(src, /arrServices\?: \{ radarr: boolean; sonarr: boolean \};/);
  assert.match(
    src,
    /const showArrLinks =\s*canOpenArr && \(arrServices\?\.\[group\.mediaType === "MOVIE" \? "radarr" : "sonarr"\] \?\? true\);/,
  );
  assert.match(src, /\{showArrLinks && \(\s*<OpenInArrLink/);
  assert.match(src, /\{showArrLinks && \(group\.aggregateStatus === "APPROVED" \|\| group\.aggregateStatus === "AVAILABLE"\) && \(\s*<ManageTitleButton/);
  assert.doesNotMatch(src, /\{canOpenArr && /, "no icon renders off the coarse gate alone");
});

test("C001: the admin page passes each integration's switch to the request list", () => {
  const src = read("src/app/(app)/admin/page.tsx");
  assert.match(src, /arrServices=\{\{ radarr: radarrOn, sonarr: sonarrOn \}\}/);
});

// ═══ C062 ════════════════════════════════════════════════════════════════════

test("C062: the never-watched selection cap IS the route's CLEANUP_MAX_ITEMS, and a full selection shows the hint", () => {
  const src = read("src/components/admin/never-watched-report.tsx");
  assert.match(src, /import \{ CLEANUP_MAX_ITEMS \} from "@\/lib\/library-cleanup";/);
  assert.match(src, /const MAX_SELECTION = CLEANUP_MAX_ITEMS;/);
  assert.doesNotMatch(src, /MAX_SELECTION = \d/, "no private copy of the number");
  assert.match(
    src,
    /\{data\.cleanupEnabled && selected\.size >= MAX_SELECTION && \(\s*<p[^>]*>\{t\("adminManage\.cleanup\.selectionFull", \{ max: MAX_SELECTION \}\)\}<\/p>/,
  );
  assert.ok(en("adminManage")["adminManage.cleanup.selectionFull"]?.includes("{max}"));
});

// ═══ C015 ════════════════════════════════════════════════════════════════════

test("C015: a cleanup result with uncertain: true shows the neutral note; the type carries the flag", () => {
  const src = read("src/components/admin/cleanup-delete.tsx");
  assert.match(src, /failed: Array<\{[^}]*\}>; uncertain\?: boolean \}>;/);
  const panel = src.slice(src.indexOf("export function CleanupResultPanel"));
  assert.match(panel, /\{r\.uncertain === true && \(\s*<span style=\{\{ color: "var\(--ds-fg-muted\)" \}\}> \{t\("adminManage\.cleanup\.result\.uncertain"\)\}<\/span>/);
  assert.ok(en("adminManage")["adminManage.cleanup.result.uncertain"]);
});

test("C015: the route still puts `uncertain` on each result (the field the panel reads)", () => {
  const route = read("src/app/api/admin/cleanup/delete/route.ts");
  assert.ok((route.match(/\.\.\.\(uncertain \? \{ uncertain: true \} : \{\}\),/g) ?? []).length >= 2);
});

// ═══ C007 ════════════════════════════════════════════════════════════════════

test("C007: Search missing refused part-way says only part of the search started — cleared by the next command", () => {
  const src = read("src/components/admin/arr-title/title-manager.tsx");
  const run = src.slice(src.indexOf("const runCommand = useCallback"), src.indexOf("async function topCommand"));
  assert.match(run, /setPartialNote\(""\);[\s\S]*?await arrApi</, "cleared before the next command is sent");
  assert.match(run, /partial\?: boolean/);
  assert.match(run, /if \(res\.data\.partial === true\) setPartialNote\(t\("adminArr\.notice\.searchMissingPartial"\)\);/);
  assert.match(src, /\{partialNote && !error && !loadError && \(\s*<p role="status" className="m-0 text-xs text-zinc-400">\{partialNote\}<\/p>/);
  assert.ok(en("adminArr")["adminArr.notice.searchMissingPartial"]);
});

test("C007: the title command route answers a part-way Search missing with 202 and the flag the page reads", () => {
  const data = read("src/lib/arr-missing-data.ts");
  assert.match(data, /return \{ commands: queued\.length, seasons, episodes, partial: true, commandIds: commandIdsOf\(queued\) \};/);
  const route = read("src/app/api/admin/arr/title/command/route.ts");
  assert.match(route, /const result = await searchMissingTracked\("sonarr", instance, arrId, new Date\(\)\);\s*return NextResponse\.json\(result, \{ status: 202 \}\);/);
});
