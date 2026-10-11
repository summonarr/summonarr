// Links into the admin title manager and the Download Queue
// (src/lib/arr-manage-links.ts): the tab each admin list opens the manager on,
// the queue's link filters, and which configured instances hold a title.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  QUEUE_QUERY_MAX,
  arrHoldersByTmdbId,
  manageTabFor,
  matchesQueueTitle,
  parseQueueLinkFilters,
  queueLinkKey,
  queueTitleHref,
  type ManageContext,
} from "../src/lib/arr-manage-links.ts";

test("each list opens the manager on its tab, and never on Seasons for Radarr", () => {
  const expected: Record<ManageContext, { radarr: string; sonarr: string }> = {
    queue: { radarr: "history", sonarr: "history" },
    history: { radarr: "history", sonarr: "history" },
    blocklist: { radarr: "history", sonarr: "history" },
    cutoff: { radarr: "files", sonarr: "files" },
    missing: { radarr: "settings", sonarr: "seasons" },
    calendar: { radarr: "settings", sonarr: "seasons" },
    issue: { radarr: "files", sonarr: "seasons" },
  };
  for (const [context, tabs] of Object.entries(expected) as Array<[ManageContext, { radarr: string; sonarr: string }]>) {
    assert.equal(manageTabFor(context, "radarr"), tabs.radarr, `${context} radarr`);
    assert.equal(manageTabFor(context, "sonarr"), tabs.sonarr, `${context} sonarr`);
    assert.notEqual(manageTabFor(context, "radarr"), "seasons", `${context}: Radarr has no Seasons tab`);
  }
});

test("a queue link's title filter needs a known service, a valid slug and a positive int id", () => {
  assert.deepEqual(parseQueueLinkFilters({ service: "sonarr", instance: "4k", arrId: "12" }), {
    q: "",
    title: { service: "sonarr", instance: "4k", arrId: 12 },
  });
  assert.deepEqual(parseQueueLinkFilters({ service: "radarr", instance: "anime", arrId: "7" }).title, { service: "radarr", instance: "anime", arrId: 7 });
  // The default instance: an empty slug, or none at all.
  assert.deepEqual(parseQueueLinkFilters({ service: "radarr", instance: "", arrId: "5" }).title, { service: "radarr", instance: "", arrId: 5 });
  assert.deepEqual(parseQueueLinkFilters({ service: "radarr", arrId: "5" }).title, { service: "radarr", instance: "", arrId: 5 });
  // Any bad part drops the WHOLE filter — never a partial one (another title's downloads).
  const bad: Array<Record<string, string | string[] | undefined>> = [
    { service: "lidarr", instance: "", arrId: "5" },
    { service: "Radarr", instance: "", arrId: "5" },
    { instance: "", arrId: "5" },
    { service: "radarr", instance: "Anime", arrId: "5" },
    { service: "radarr", instance: "hd", arrId: "5" },
    { service: "radarr", instance: "../x", arrId: "5" },
    { service: "radarr", instance: "a".repeat(25), arrId: "5" },
    { service: "radarr", instance: "", arrId: "0" },
    { service: "radarr", instance: "", arrId: "-3" },
    { service: "radarr", instance: "", arrId: "05" },
    { service: "radarr", instance: "", arrId: "1.5" },
    { service: "radarr", instance: "", arrId: "1e3" },
    { service: "radarr", instance: "", arrId: " 5" },
    { service: "radarr", instance: "", arrId: "2147483648" },
    { service: "radarr", instance: "", arrId: "99999999999" },
    { service: "radarr", instance: "" },
  ];
  for (const sp of bad) assert.equal(parseQueueLinkFilters(sp).title, null, JSON.stringify(sp));
  assert.equal(parseQueueLinkFilters({ service: "radarr", instance: "", arrId: "2147483647" }).title?.arrId, 2147483647);
  // A repeated parameter reads its first value, as URLSearchParams.get does.
  assert.deepEqual(parseQueueLinkFilters({ service: ["sonarr", "radarr"], instance: ["", "4k"], arrId: ["3", "4"] }).title, { service: "sonarr", instance: "", arrId: 3 });
});

test("a queue link's text filter is trimmed, cleaned of control characters and capped", () => {
  assert.equal(parseQueueLinkFilters({}).q, "");
  assert.equal(parseQueueLinkFilters({ q: "  The Expanse " }).q, "The Expanse");
  assert.equal(parseQueueLinkFilters({ q: "a\u0000b\nc\u007fd" }).q, "abcd");
  assert.equal(parseQueueLinkFilters({ q: "x".repeat(500) }).q.length, QUEUE_QUERY_MAX);
  assert.equal(QUEUE_QUERY_MAX, 200, "the same cap as the queue's own filter box");
  assert.equal(parseQueueLinkFilters({ q: ["first", "second"] }).q, "first");
  // q and the title filter are independent.
  assert.deepEqual(parseQueueLinkFilters({ q: "dune", service: "nope" }), { q: "dune", title: null });
});

test("the queue link round-trips through the page's parser", () => {
  for (const ref of [
    { service: "sonarr" as const, instance: "", arrId: 1 },
    { service: "radarr" as const, instance: "4k", arrId: 42 },
    { service: "sonarr" as const, instance: "anime", arrId: 2147483647 },
  ]) {
    const href = queueTitleHref(ref);
    assert.ok(href.startsWith("/admin/queue?"), href);
    const sp = Object.fromEntries(new URL(href, "http://x").searchParams);
    assert.deepEqual(parseQueueLinkFilters(sp), { q: "", title: ref }, href);
  }
});

test("a queue row matches the title filter only on service, instance AND arr id", () => {
  const f = { service: "sonarr" as const, instance: "4k", arrId: 9 };
  assert.equal(matchesQueueTitle({ service: "sonarr", instance: "4k", arrMediaId: 9 }, f), true);
  assert.equal(matchesQueueTitle({ service: "radarr", instance: "4k", arrMediaId: 9 }, f), false, "Radarr movie 9 is another title");
  assert.equal(matchesQueueTitle({ service: "sonarr", instance: "", arrMediaId: 9 }, f), false, "series 9 on another instance is another title");
  assert.equal(matchesQueueTitle({ service: "sonarr", instance: "4k", arrMediaId: 10 }, f), false);
  assert.equal(matchesQueueTitle({ service: "sonarr", instance: "4k", arrMediaId: null }, f), false, "an unmatched download names no title");
});

test("the link key compares filters by value", () => {
  const a = parseQueueLinkFilters({ service: "radarr", instance: "", arrId: "5" });
  const b = parseQueueLinkFilters({ service: "radarr", instance: "", arrId: "5" });
  assert.notEqual(a, b);
  assert.equal(queueLinkKey(a), queueLinkKey(b), "a re-render of the same URL is the same filters");
  const distinct = [
    { q: "", title: null },
    { q: "x", title: null },
    { q: "", title: { service: "radarr" as const, instance: "", arrId: 5 } },
    { q: "", title: { service: "sonarr" as const, instance: "", arrId: 5 } },
    { q: "", title: { service: "radarr" as const, instance: "4k", arrId: 5 } },
    { q: "", title: { service: "radarr" as const, instance: "", arrId: 6 } },
    { q: "x", title: { service: "radarr" as const, instance: "", arrId: 5 } },
  ];
  assert.equal(new Set(distinct.map(queueLinkKey)).size, distinct.length);
});

test("holders are the configured instances holding the title, in registry order, once each", () => {
  const configured = [
    { slug: "", name: "Radarr", extra: 1 },
    { slug: "4k", name: "4K", extra: 2 },
    { slug: "anime", name: "Anime", extra: 3 },
  ];
  const rows = [
    { tmdbId: 100, arrInstance: "anime" },
    { tmdbId: 100, arrInstance: "" },
    { tmdbId: 100, arrInstance: "" }, // wanted AND available on one instance
    { tmdbId: 200, arrInstance: "gone" }, // an instance no longer configured
    { tmdbId: 300, arrInstance: "4k" },
  ];
  const holders = arrHoldersByTmdbId(configured, rows);
  assert.deepEqual(holders.get(100), [{ slug: "", name: "Radarr" }, { slug: "anime", name: "Anime" }]);
  assert.equal(holders.has(200), false, "only an unconfigured instance holds it — no icon");
  assert.deepEqual(holders.get(300), [{ slug: "4k", name: "4K" }]);
  assert.equal(holders.has(400), false);
  assert.equal(arrHoldersByTmdbId(configured, []).size, 0);
});

// The wiring the pure rules above can't see.
test("the History tab's own list never offers a manager inside the manager", () => {
  const tab = readFileSync(new URL("../src/components/admin/arr-title/history-tab.tsx", import.meta.url), "utf8");
  assert.ok(/<ArrHistoryList\b/.test(tab));
  assert.ok(!/renderManage/.test(tab), "the manager's History tab passes no Manage render prop");
  assert.ok(/queueTitleHref\(titleRef\)/.test(tab), "the History tab links to exactly this title's downloads");
  const page = readFileSync(new URL("../src/components/admin/arr-download-history.tsx", import.meta.url), "utf8");
  assert.ok(/renderManage=/.test(page), "the History page passes it");
  const list = readFileSync(new URL("../src/components/admin/arr-history-list.tsx", import.meta.url), "utf8");
  assert.ok(!/title-manager/.test(list), "the list never imports the manager that imports it");
});

test("the queue page reads its link filters through the validating parser", () => {
  const page = readFileSync(new URL("../src/app/(app)/admin/queue/page.tsx", import.meta.url), "utf8");
  assert.ok(/parseQueueLinkFilters\(await searchParams\)/.test(page));
  assert.ok(/initialFilters=\{initialFilters\}/.test(page));
});

test("the detail pages' ?manage= deep link names a service, a slug and a known tab — nothing else", async () => {
  const { parseManageLink } = await import("../src/lib/arr-links-data.ts");
  assert.deepEqual(parseManageLink("radarr:", "files", "radarr"), { instance: "", tab: "files" });
  assert.deepEqual(parseManageLink("sonarr:anime", "seasons", "sonarr"), { instance: "anime", tab: "seasons" });
  assert.deepEqual(parseManageLink("radarr:4k", "nonsense", "radarr"), { instance: "4k", tab: undefined }, "an unknown tab opens the default one");
  assert.equal(parseManageLink("sonarr:", "files", "radarr"), null, "the other service's link on a movie page");
  for (const bad of ["radarr", "radarr:../x", "radarr:Anime", `radarr:${"a".repeat(41)}`, "radarr:a b", ["radarr:"], undefined]) {
    assert.equal(parseManageLink(bad, undefined, "radarr"), null, String(bad));
  }
});

test("a row's Manage button tells its list about a removal only once the dialog closes", () => {
  // The list re-reads on a removal, which unmounts the row — and the dialog
  // with its "Removed" confirmation — if it heard about it straight away.
  const src = readFileSync(new URL("../src/components/admin/arr-title/title-manager.tsx", import.meta.url), "utf8");
  const button = src.slice(src.indexOf("export function ManageTitleButton"));
  assert.doesNotMatch(button, /onRemoved=\{onRemoved\}/, "the list's callback is never handed straight to the manager");
  assert.match(button, /onRemoved=\{\(\) => \{\s*removedRef\.current = true;\s*\}\}/);
  assert.match(button, /if \(!next && removedRef\.current\) \{\s*removedRef\.current = false;\s*onRemoved\?\.\(\);/);
  assert.match(button, /onOpenChange=\{changeOpen\}/);
});
