// The admin request queue's client wiring (admin-request-list.tsx,
// request-actions.tsx) and its two pages. The components are .tsx client code
// the unit loader can't render, so the behaviour that matters is pinned
// structurally, like tests/admin-pages-ui-wiring.test.mts.
//
//   - A batch run never replaces the selection with its start-time snapshot:
//     the checkboxes stay live, so it only removes the ids it settled. A refusal
//     or a network failure part-way keeps the earlier chunks' push-failure
//     reason on screen and refreshes the list.
//   - Every admin-note input stops at the routes' own cap (ADMIN_NOTE_MAX).
//   - The pager is links, not router.push buttons.
//   - The reply editor starts from the stored note each time it opens; a group
//     reply is saved request by request and a part-way stop says how many saved.
//   - A quality-profile read for an instance the row has since left is dropped.
//   - The pages clamp ?page= and don't block a render on live TMDB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const list = () => read("src/components/admin/admin-request-list.tsx");
const actions = () => read("src/components/admin/request-actions.tsx");
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `missing ${from}`);
  const b = src.indexOf(to, a);
  assert.ok(b > a, `missing ${to} after ${from}`);
  return src.slice(a, b);
};

// ── batch selection ─────────────────────────────────────────────────────────

test("a batch run only removes the ids it settled — a box ticked or unticked mid-run keeps the admin's choice", () => {
  const src = list();
  const batch = between(src, "async function batchAction", "const totalPages");
  assert.doesNotMatch(batch, /setSelected\(new Set\(/, "no snapshot replaces the selection");
  const drop = between(src, "function dropSettled(done: readonly string[]) {", "\n  }\n");
  assert.match(drop, /setSelected\(\(prev\) => \{[\s\S]*?const next = new Set\(prev\);\s*for \(const id of done\) next\.delete\(id\);/, "a functional update over the CURRENT selection");
  // One way out of the run: it settles exactly what the route answered (settledIds, tested in admin-request-batch).
  assert.equal(batch.match(/dropSettled\(/g)?.length, 1, "one call");
  assert.match(batch, /dropSettled\(settledIds\(progress\)\);/);
  // Only a chunk the route answered is recorded; the first failure returns before it.
  const send = between(src, "async function sendBatch(", "\n}\n");
  assert.match(send, /if \(!res\.ok\) return \{ progress, stop: res \};\s*progress = recordChunk\(progress, chunk, res\.data\);/);
  assert.match(send, /schema: BatchAnswer,/, "the 200 is read through its schema, not cast");
  // A second click while a run is going starts nothing.
  assert.match(batch, /\{ ifBusy: "skip" \}/);
});

test("a refusal or a network failure part-way keeps the earlier push-failure reason and refreshes the list", () => {
  const src = list();
  const batch = between(src, "async function batchAction", "const totalPages");
  assert.match(batch, /setBatchError\(batchErrorText\(progress, stop \? batchStopText\(stop, t\) : null\)\);/);
  assert.match(batch, /refreshNow\(\);\n  \}/, "every run ends in the refresh");
  const stopText = between(src, "function batchStopText(", "\n}\n");
  assert.match(stopText, /return t\("shared\.thread\.networkError"\);/, "no answer is the translated network line, never a raw message");
  assert.match(stopText, /if \(res\.status === 429\) return t\("shared\.rateLimited\.generic"\);/);
  // The two reasons are one line each.
  assert.match(src, /className="w-full whitespace-pre-line"/);
});

test("adds that got no answer are named above the list, outside the bar their rows leave", () => {
  const src = list();
  const batch = between(src, "async function batchAction", "const totalPages");
  assert.match(batch, /setBatchNotice\(outcomeUnknownNotice\(progress\.outcomeUnknown\)\);/);
  assert.match(src, /\{batchNotice && \(\s*<div\s+role="status"/);
  assert.match(src, /t\("adminQueue\.list\.outcomeUnknown", \{ count: ids\.length, titles: names\.join\(", "\) \}\)/);
});

test("a new status or type filter clears the selection; the bar names what is selected on other pages", () => {
  const src = list();
  assert.match(src, /useSelection\(requests, `\$\{statusFilter \?\? ""\}\|\$\{typeFilter \?\? ""\}`, batchLoading\)/);
  assert.match(src, /if \(filterKey !== prevFilterKey\) \{\s*setPrevFilterKey\(filterKey\);\s*if \(selected\.size > 0\) setSelected\(new Set\(\)\);/);
  assert.match(src, /offPage=\{offPageCount\(selected, requests\)\}/);
  assert.match(src, /\{offPage > 0 && \(/);
});

// ── the batch decline input ─────────────────────────────────────────────────

test("the batch decline reason has an accessible name and the routes' note cap", () => {
  const src = list();
  assert.match(src, /import \{ ADMIN_NOTE_MAX \} from "@\/lib\/request-limits";/);
  const input = between(src, "<input\n        type=\"text\"\n        value={note}", "/>");
  assert.match(input, /aria-label=\{t\("adminQueue\.actions\.declineReasonAria"\)\}/);
  assert.match(input, /maxLength=\{ADMIN_NOTE_MAX\}/);
});

// ── the pager ───────────────────────────────────────────────────────────────

test("Previous / Next are links to pageUrl, not router.push buttons", () => {
  const src = list();
  const pager = between(src, "function Pager(", "function PagerLink(");
  assert.match(pager, /<PagerLink href=\{page > 1 \? pageUrl\(page - 1\) : null\}>/);
  assert.match(pager, /<PagerLink href=\{page < totalPages \? pageUrl\(page \+ 1\) : null\}>/);
  const link = src.slice(src.indexOf("function PagerLink("));
  assert.match(link, /<Link href=\{href\} className="ds-hover-tint"/);
  assert.match(link, /if \(href === null\) \{\s*return \(\s*<button\s*type="button"\s*disabled/, "an end with no page is inert");
  assert.doesNotMatch(src, /router\.push\(/);
  assert.doesNotMatch(link, /cursor-pointer/, "guardrail 42");
});

test("the group row finds its representative request once", () => {
  const row = between(list(), "function RequestGroupRow(", "function Pager(");
  assert.equal(row.match(/group\.requesters\.find\(/g)?.length, 1);
  // Each field keeps its own fallback: a representative with no note still shows the primary's.
  assert.match(row, /const representativeAdminNote = rep\?\.adminNote \?\? primaryRequester\.adminNote;/);
  assert.match(row, /const groupInstances = groupArrInstances\.filter\(\(slug\) => slug !== ""\);/);
  assert.match(row, /const mixedInstances = groupArrInstances\.length > 1;/);
});

// ── request actions ─────────────────────────────────────────────────────────

test("every admin-note textarea stops at ADMIN_NOTE_MAX, and the reply no longer cuts at 500", () => {
  const src = actions();
  assert.match(src, /import \{ ADMIN_NOTE_MAX \} from "@\/lib\/request-limits";/);
  assert.equal(src.match(/<textarea/g)?.length, 2, "reply and decline");
  assert.equal(src.match(/maxLength=\{ADMIN_NOTE_MAX\}/g)?.length, 2);
  assert.doesNotMatch(src, /slice\(0, 500\)/);
});

test("opening the reply editor starts from the stored note", () => {
  assert.match(
    actions(),
    /onOpen=\{\(\) => \{ setReplyText\(existingAdminNote \?\? ""\); setShowReply\(true\); setReplySaved\(false\); \}\}/,
  );
});

test("a group reply is saved request by request; what saved is shown, and a part-way stop says how many", () => {
  const save = between(actions(), "async function saveReply(", "async function deleteRequest(");
  assert.doesNotMatch(save, /Promise\.all\(/);
  assert.match(save, /for \(const id of targetIds\) \{/);
  assert.match(save, /if \(res\.status === 429\) break;/, "a rate-limit refusal stops the rest");
  assert.match(save, /if \(saved > 0\) router\.refresh\(\);/);
  assert.match(save, /t\("adminQueue\.actions\.saveReplyPartial", \{ saved, total: targetIds\.length \}\)/);
  assert.match(save, /init: jsonInit\("PATCH", \{ adminNote: note \}\)/, "note-only: no status, so no same-status 422");
});

test("a quality-profile read for an instance the row has since left is dropped", () => {
  const src = actions();
  // The list, the open picker and a read still out are keyed by the instance:
  // a change of instance leaves them all behind, with no effect to reset them.
  assert.match(src, /const profileKey = `\$\{mediaType\}:\$\{arrInstance\}`;/);
  assert.match(src, /const profiles = profileState\?\.key === profileKey \? profileState : null;/);
  assert.match(src, /pickerOpen: pickerFor === profileKey,/);
  const open = between(src, "async function openProfilePicker()", "async function decide(");
  assert.match(open, /const key = profileKey;\s*setProfileState\(\{ key, phase: "loading" \}\);/);
  // The answer lands only over the read that started it.
  assert.match(open, /setProfileState\(\(prev\) => \(prev\?\.key === key && prev\.phase === "loading" \? next : prev\)\);/);
  assert.match(open, /new URLSearchParams\(\{ mediaType, instance: arrInstance \}\)/);
  assert.match(open, /schema: QualityProfilesAnswer,/, "the list is checked, not cast");
  // No prop is copied into state: the effects are the unmount cleanup that
  // stops the reads still out, and the two that tell the list while the Pick
  // release dialog is open (the callback's latest copy, then the open/close).
  assert.equal(src.match(/useEffect\(/g)?.length, 3);
  assert.match(src, /useEffect\(\(\) => \{\s*dialogActiveRef\.current = onDialogActive;\s*\}\);/);
  assert.match(src, /useEffect\(\(\) => \{\s*const out = reads\.current;\s*return \(\) => \{\s*for \(const ctl of out\) ctl\.abort\(\);/);
  assert.match(open, /signal: ctl\.signal,/, "the read can be stopped");
});

test("the profile spinner is announced", () => {
  assert.match(
    actions(),
    /<span role="status" aria-live="polite" className="flex items-center">\s*<Loader2 className="w-4 h-4 animate-spin text-zinc-500" \/>\s*<span className="sr-only">\{t\("adminQueue\.actions\.profilesLoading"\)\}<\/span>/,
  );
});

test("Search and Re-push share one PATCH; an approve whose push got no answer keeps the optimistic APPROVED", () => {
  const src = actions();
  assert.match(src, /const triggerSearch = \(\) => patchRequestAction\("SEARCH", \{ search: true \}\);/);
  assert.match(src, /const retryPush = \(\) => patchRequestAction\("RETRY", \{ retry: true \}\);/);
  assert.match(src, /decisionOutcome\(\{ arrError: res\.data\.arrError, pushOutcomeUnknown: res\.data\.arrPushOutcomeUnknown \}\)/);
  assert.match(src, /if \(!outcome\.keepOptimistic\) setOptimisticStatus\(null\);/);
});

test("the new queue strings exist in every locale with their placeholders", () => {
  for (const locale of ["en", "es", "fr", "de", "pt", "it", "zh"]) {
    const cat = JSON.parse(read(`src/lib/i18n/messages/${locale}/adminQueue.json`)) as Record<string, string>;
    assert.ok(cat["adminQueue.actions.profilesLoading"], `${locale} profilesLoading`);
    const partial = cat["adminQueue.actions.saveReplyPartial"] ?? "";
    assert.ok(partial.includes("{saved}") && partial.includes("{total}"), `${locale} saveReplyPartial`);
  }
});

// ── the pages ───────────────────────────────────────────────────────────────

test("/admin clamps ?page=, reads only what it shows, and bounds its wait on live TMDB", () => {
  const src = read("src/app/(app)/admin/page.tsx");
  assert.match(src, /const requestedPage = parsePageNumber\(pageParam\);/);
  assert.match(
    src,
    /prisma\.mediaRequest\.groupBy\(\{ by: \["requestedBy"\], where: \{ requestedBy: \{ in: pageRequesters \} \}, _count: \{ id: true \} \}\)/,
    "request totals only for this page's requesters",
  );
  assert.doesNotMatch(src, /groupBy\(\{ by: \["requestedBy"\], _count/, "no count for every user");
  assert.match(src, /plexLibraryItem\.findMany\(\{ where: \{ OR: pairs \}, select: \{ tmdbId: true, mediaType: true \} \}\)/);
  assert.match(src, /jellyfinLibraryItem\.findMany\(\{ where: \{ OR: pairs \}, select: \{ tmdbId: true, mediaType: true \} \}\)/);
  const live = between(src, "if (staleP.length) {", "const countFor");
  assert.match(live, /timer = setTimeout\(\(\) => resolve\(null\), LIVE_DETAILS_WAIT_MS\);/);
  assert.match(live, /Promise\.race\(\[\s*\(p\.mediaType === "MOVIE" \? getMovieDetails\(p\.tmdbId\) : getTVDetails\(p\.tmdbId\)\)\.catch\(\(\) => null\),\s*deadline,\s*\]\)/);
  assert.doesNotMatch(live, /Promise\.allSettled/);
});

test("/requests clamps ?page= and takes its total from the status counts", () => {
  const src = read("src/app/(app)/requests/page.tsx");
  assert.match(src, /const page = parsePageNumber\(pageParam\);/);
  assert.doesNotMatch(src, /mediaRequest\.count\(/);
  assert.match(src, /const total = status \? \(statusCounts\[status\] \?\? 0\) : totalAllStatuses;/);
});

// ── a batch whose push fails ────────────────────────────────────────────────

test("the selection is not pruned while a batch runs, and a run's error shows with nothing selected", () => {
  const src = list();
  // The route claims rows APPROVED before pushing; the refresh that triggers
  // lands mid-run and must not drop the rows whose push then fails.
  const hook = between(src, "function useSelection(", "function toggleAll()");
  assert.match(hook, /useEffect\(\(\) => \{\s*if \(batchRunningRef\.current\) return;\s*setSelected\(\(prev\) => pruneSelection\(prev, requests\)\);\s*\}, \[requests\]\);/);
  assert.ok(hook.indexOf("batchRunningRef.current = batchRunning;") < hook.indexOf("if (batchRunningRef.current) return;"), "the flag is synced before the prune reads it");
  assert.match(src, /useSelection\(requests, `\$\{statusFilter \?\? ""\}\|\$\{typeFilter \?\? ""\}`, batchLoading\);/);
  // The bar is the error's usual home, but it only exists while something is selected.
  assert.match(src, /\{selected\.size === 0 && batchError && \(\s*<div\s*role="alert"/);
});

test("the row's actions can be aimed at any request of the group, and a picked one starts clean", () => {
  const src = list();
  const row = between(src, "function RequestGroupRow(", "function GroupRatings(");
  assert.match(row, /const targets = actionTargets\(group\.requesters, group\.aggregateStatus\);/);
  assert.match(row, /const target = chosenActionTarget\(targets, chosenTargetId\) \?\? primaryRequester;/);
  assert.match(row, /\{targets\.length > 1 && \(\s*<StyledSelect/, "the picker only where there is a choice");
  assert.match(row, /key=\{targetIsRepresentative \? "representative" : target\.requestId\}/);
  assert.match(row, /requestId=\{target\.requestId\}\s*currentStatus=\{target\.status\}/);
  assert.match(row, /arrInstance=\{target\.arrInstance\}/);
});

test("Pick release holds the list's live refresh like the title manager, and an empty queue still refreshes", () => {
  const src = list();
  assert.match(src, /onDialogActive=\{onManagerActive\}/);
  const approved = between(actions(), "function ApprovedActions(", "function DeclineNoteForm(");
  assert.match(approved, /useEffect\(\(\) => \{\s*if \(!showReleases\) return;\s*dialogActiveRef\.current\?\.\(true\);\s*const active = dialogActiveRef;\s*return \(\) => active\.current\?\.\(false\);\s*\}, \[showReleases\]\);/);
  // The list carries the live listener; with no rows there is no list.
  const page = read("src/app/(app)/admin/page.tsx");
  const empty = between(page, "{rows.length === 0 ? (", "<AdminRequestList");
  assert.match(empty, /<LiveRefresh on=\{\["request:new", "request:updated", "request:deleted"\]\} \/>/);
});
