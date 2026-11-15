// Audit fixes (cross-unit, UI wiring). The pages are .tsx client components the
// unit loader can't import, so their wiring is pinned by a structural scan;
// the wire fields they read are pinned at their routes elsewhere
// (tests/cleanup-delete-unknown-outcome-stamps.test.mts for `uncertain`, the
// title-command route's `partial`).
//
// the request queue's Open in / Manage icons follow the row's OWN
//          integration: a movie's need Radarr switched on, a show's Sonarr
//          (the routes behind them 404 while it is off — arrGate). The coarse
//          "both off" gate stays as the viewer gate.
// the never-watched report's selection cap is the route's own
//          CLEANUP_MAX_ITEMS (never a private 500), and a full selection says so.
// a cleanup delete whose outcome is unknown (`uncertain: true`) shows a
//          neutral "check Radarr/Sonarr before trying again" note.
// a title manager Search missing that Sonarr refused part-way
//          (202 `partial: true`) says only part of the search started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const en = (area: string) => JSON.parse(read(`src/lib/i18n/messages/en/${area}.json`)) as Record<string, string>;

// ═══ ════════════════════════════════════════════════════════════════════

test("the request list gates each row's Open in / Manage on that row's own service", () => {
  const src = read("src/components/admin/admin-request-list.tsx");
  assert.match(src, /arrServices\?: \{ radarr: boolean; sonarr: boolean \};/);
  assert.match(
    src,
    /const showArrLinks =\s*canOpenArr && \(arrServices\?\.\[group\.mediaType === "MOVIE" \? "radarr" : "sonarr"\] \?\? true\);/,
  );
  // One icon per instance the group's requests name (an HD and a 4K request are two), all behind the row's service gate.
  assert.match(src, /\{showArrLinks && \(\s*<ArrTitleIcons\s+group=\{group\}\s+groupArrInstances=\{groupArrInstances\}/);
  assert.equal(src.match(/<ArrTitleIcons\b/g)?.length, 1, "rendered only behind the gate");
  const icons = src.slice(src.indexOf("function ArrTitleIcons("), src.indexOf("\n}\n", src.indexOf("function ArrTitleIcons(")));
  assert.match(icons, /\{groupArrInstances\.map\(\(slug\) => \(\s*<OpenInArrLink/);
  assert.match(icons, /\{groupArrInstances\.map\(\(slug\) => \{/);
  assert.match(src, /if \(!available && !onInstance\.some\(\(r\) => r\.status === "APPROVED"\)\) return null;\s*return \(\s*<ManageTitleButton/, "a Manage icon only for an instance the title was pushed to");
  assert.match(src, /initialTab=\{manageTabFor\(available \? "requestAvailable" : "requestApproved", arrService\)\}/, "the tab comes from manageTabFor, never hand-picked");
  assert.doesNotMatch(src, /\{canOpenArr && /, "no icon renders off the coarse gate alone");
});

test("the admin page passes each integration's switch to the request list", () => {
  const src = read("src/app/(app)/admin/page.tsx");
  assert.match(src, /arrServices=\{\{ radarr: radarrOn, sonarr: sonarrOn \}\}/);
});

// ═══ ════════════════════════════════════════════════════════════════════

test("the never-watched selection cap IS the route's CLEANUP_MAX_ITEMS, and a full selection shows the hint", () => {
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

// ═══ ════════════════════════════════════════════════════════════════════

test("a cleanup result with uncertain: true shows the neutral note; the type carries the flag", () => {
  const src = read("src/components/admin/cleanup-delete.tsx");
  // The result type is the checked answer's (src/lib/cleanup-plan-answer.ts), which keeps the flag.
  assert.match(read("src/lib/cleanup-plan-answer.ts"), /uncertain: v\.optional\(v\.boolean\(\)\),/);
  const panel = src.slice(src.indexOf("export function CleanupResultPanel"));
  assert.match(panel, /\{r\.uncertain === true && \(\s*<span style=\{\{ color: "var\(--ds-fg-muted\)" \}\}> \{t\("adminManage\.cleanup\.result\.uncertain"\)\}<\/span>/);
  assert.ok(en("adminManage")["adminManage.cleanup.result.uncertain"]);
});

test("the execute step still puts `uncertain` on each result (the field the panel reads), and the route answers the results as they are", () => {
  const exec = read("src/lib/library-cleanup-execute.ts");
  assert.match(exec, /uncertain\?: true;/);
  assert.match(exec, /\.\.\.\(uncertain \? \{ uncertain: true as const \} : \{\}\),/);
  const route = read("src/app/api/admin/cleanup/delete/route.ts");
  assert.match(route, /const results = await mapLimit\(planned, TITLE_CONCURRENCY, \(p\) => executeCleanupTitle\(p, ctx\)\);/);
  assert.match(route, /\s+results,\n/);
});

// ═══ ════════════════════════════════════════════════════════════════════

test("Search missing refused part-way says only part of the search started — cleared by the next command", () => {
  const src = read("src/components/admin/arr-title/title-manager.tsx");
  // Both ways a command goes out clear the line before sending: the Seasons tab's and the command bar's.
  const run = src.slice(src.indexOf("const runCommand = useCallback"), src.indexOf("async function topCommand"));
  assert.match(run, /setPartialNote\(""\);[\s\S]*?await sendCommand\(/, "cleared before the next command is sent");
  const top = src.slice(src.indexOf("async function topCommand"), src.indexOf("function pickRelease("));
  assert.match(top, /clearLines\(\);[\s\S]*?sendCommand\(body, signal\)/);
  assert.match(src, /const clearLines = \(\) => \{\s*setNotice\(""\);\s*setPartialNote\(""\);/);
  assert.match(src, /if \(res\.data\.partial === true\) setPartialNote\(t\("adminArr\.notice\.searchMissingPartial"\)\);/);
  assert.match(src, /<StatusLine error=\{error\} [^>]*partialNote=\{partialNote\} \/>/);
  const parts = read("src/components/admin/arr-title/manager-parts.tsx");
  assert.match(parts, /\{partialNote && !error && \(\s*<p role="status" className="m-0 text-xs text-zinc-400">\{partialNote\}<\/p>/);
  assert.ok(en("adminArr")["adminArr.notice.searchMissingPartial"]);
});

test("the title command route answers a part-way Search missing with 202 and the flag the page reads", () => {
  const data = read("src/lib/arr-missing-data.ts");
  assert.match(data, /return \{ commands: queued\.length, seasons, episodes, partial: true, commandIds: commandIdsOf\(queued\) \};/);
  const route = read("src/app/api/admin/arr/title/command/route.ts");
  // The search's own answer, partial flag and all, is the 202's body.
  assert.match(route, /case "searchMissing":[\s\S]*?return searchMissingTracked\("sonarr", instance, arrId, new Date\(\)\);/);
  assert.match(route, /return NextResponse\.json\(await runCommand\(target, cmd\), \{ status: 202 \}\);/);
});
