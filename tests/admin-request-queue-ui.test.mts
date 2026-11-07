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
  const batch = between(list(), "async function batchAction", "const totalPages");
  assert.doesNotMatch(batch, /setSelected\(new Set\(/, "no snapshot replaces the selection");
  const drop = between(batch, "const dropSettled = () => {", "};\n");
  assert.match(drop, /const done = answered\.filter\(\(id\) => !keep\.has\(id\)\);/);
  assert.match(drop, /setSelected\(\(prev\) => \{[\s\S]*?const next = new Set\(prev\);\s*for \(const id of done\) next\.delete\(id\);/, "a functional update over the CURRENT selection");
  assert.match(batch, /for \(const id of chunk\) answered\.push\(id\);/, "only a chunk the route answered counts as settled");
  // Every way out of the run settles through it.
  assert.equal(batch.match(/dropSettled\(\);/g)?.length, 3, "refusal, network failure and success");
});

test("a refusal or a network failure part-way keeps the earlier push-failure reason and refreshes the list", () => {
  const batch = between(list(), "async function batchAction", "const totalPages");
  assert.match(batch, /const withEarlier = \(message: string\) => \(arrError \? `\$\{arrError\}\\n\$\{message\}` : message\);/);
  const refused = between(batch, "if (!res.ok) {", "return;\n");
  assert.match(refused, /setBatchError\(withEarlier\(/);
  assert.match(refused, /dropSettled\(\);\s*refreshList\(\);/);
  const failed = between(batch, "} catch {", "} finally {");
  assert.match(failed, /setBatchError\(withEarlier\(t\("shared\.thread\.networkError"\)\)\);/);
  assert.match(failed, /dropSettled\(\);\s*refreshList\(\);/, "the chunks before the failure were applied: reconcile and refresh");
  // The two reasons are one line each.
  assert.match(list(), /className="w-full whitespace-pre-line"/);
});

// ── the batch decline input ─────────────────────────────────────────────────

test("the batch decline reason has an accessible name and the routes' note cap", () => {
  const src = list();
  assert.match(src, /import \{ ADMIN_NOTE_MAX \} from "@\/lib\/request-limits";/);
  const input = between(src, "<input\n            type=\"text\"\n            value={note}", "/>");
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
  assert.match(save, /body: JSON\.stringify\(\{ adminNote: note \}\)/, "note-only: no status, so no same-status 422");
});

test("a quality-profile read for an instance the row has since left is dropped", () => {
  const src = actions();
  const reset = between(src, "useEffect(() => {\n    profilesRequest.current++;", "}, [arrInstance, mediaType]);");
  assert.match(reset, /setProfiles\(null\);/);
  assert.match(reset, /setProfilesLoading\(false\);/);
  const open = between(src, "async function openProfilePicker()", "async function decide(");
  assert.match(open, /const token = \+\+profilesRequest\.current;\s*const current = \(\) => token === profilesRequest\.current;/);
  assert.match(open, /if \(!current\(\)\) return;\s*setProfiles\(data\.qualityProfiles\);/);
  assert.match(open, /new URLSearchParams\(\{ mediaType, instance: arrInstance \}\)/);
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
  assert.match(src, /if \(data\.arrPushOutcomeUnknown !== true\) setOptimisticStatus\(null\);/);
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
