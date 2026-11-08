// "Instant, then live" on Admin → Download History
// (src/components/admin/arr-download-history.tsx, its view in
// use-history-view.ts): opening the page, or
// changing its tab, instance, kind or page, draws the snapshot the server kept
// for exactly that read, then the live load replaces it.
//
// What matters:
// - the snapshot URL IS the live URL (one builder, arr-history-view.ts): the
//   server keys a snapshot on path + query, so another spelling paints another
//   page's rows — or never finds one;
// - a snapshot is never drawn while a write is in flight (Mark failed, Remove,
//   Clear, or Clear's command still being followed) nor for the page a live
//   load just jumped to after the list shrank (the post-write re-read draws it),
//   nor when it isn't a page of the view's tab (the shape check), and a
//   snapshot never moves the page;
// - drawing touches the rows only — not errors, the selection, confirms, busy;
// - markLive() runs only for an ACCEPTED live answer (after the sequence check
//   and the past-the-end jump), through the current url's callback;
// - the stale note is rendered, and only over a snapshot actually drawn.
// The page is a .tsx the unit loader can't import, so its wiring is pinned
// structurally; the helper it reads its URLs from is pinned directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blocklistCountPath, historyViewPath, paintsSnapshot } from "../src/lib/arr-history-view.ts";
import { snapshotKey } from "../src/lib/arr-snapshot.ts";
import { cachedUrl } from "../src/lib/client/arr-snapshot.ts";

const read = (f: string) => readFileSync(new URL(`../src/components/admin/${f}`, import.meta.url), "utf8");
const HOOK = read("use-history-view.ts");
const SHELL = read("arr-download-history.tsx");

/** The source of `const <name> = useCallback(` … through its deps line. */
function callbackBody(src: string, name: string): string {
  const startAt = src.indexOf(`const ${name} = useCallback(`);
  assert.ok(startAt >= 0, `${name} is a useCallback`);
  const end = src.indexOf("\n  }, [", startAt);
  assert.ok(end > startAt, `${name} has a deps line`);
  return src.slice(startAt, src.indexOf("\n", end + 1));
}

/** The source of the main view's snapshot apply. */
function applyBody(): string {
  const hook = "const { staleAt, markLive } = useArrSnapshot<unknown>(viewUrl, (data) => {";
  assert.ok(HOOK.includes(hook), "the view's snapshot hook");
  // The apply's body only (the hook line itself names markLive).
  const startAt = HOOK.indexOf(hook) + hook.length;
  const end = HOOK.indexOf("\n  });", startAt);
  assert.ok(end > startAt);
  return HOOK.slice(startAt, end + 6);
}

// ── the builder ──────────────────────────────────────────────────────────────

test("builder: the History read names service, instance, page, pageSize and (when filtered) kind; the Blocklist read has no kind", () => {
  const base = { service: "sonarr", instance: "4k", page: 2, pageSize: 50 } as const;
  assert.equal(historyViewPath({ ...base, tab: "history", kind: "all" }), "/api/admin/arr/history?service=sonarr&instance=4k&page=2&pageSize=50");
  assert.equal(historyViewPath({ ...base, tab: "history", kind: "failed" }), "/api/admin/arr/history?service=sonarr&instance=4k&page=2&pageSize=50&kind=failed");
  assert.equal(historyViewPath({ ...base, tab: "blocklist", kind: "failed" }), "/api/admin/arr/blocklist?service=sonarr&instance=4k&page=2&pageSize=50");
  assert.equal(blocklistCountPath("radarr", ""), "/api/admin/arr/blocklist?service=radarr&instance=&page=1&pageSize=1");
});

test("builder: a view's snapshot read and its live read are one server key; another kind, page or tab is another", () => {
  const v = { tab: "history", service: "radarr", instance: "", page: 1, pageSize: 50, kind: "grabbed" } as const;
  const live = `http://x${historyViewPath(v)}`;
  const key = snapshotKey(live, "en");
  assert.equal(snapshotKey(cachedUrl(live), "en"), key);
  assert.notEqual(snapshotKey(`http://x${historyViewPath({ ...v, kind: "all" })}`, "en"), key);
  assert.notEqual(snapshotKey(`http://x${historyViewPath({ ...v, page: 2 })}`, "en"), key);
  assert.notEqual(snapshotKey(`http://x${historyViewPath({ ...v, tab: "blocklist" })}`, "en"), key);
});

// ── the gate ─────────────────────────────────────────────────────────────────

const PAGE = { records: [{ id: 1 }], totalRecords: 120, pageSize: 50 };

test("gate: a snapshot is drawn when nothing is in flight and it is a real page", () => {
  assert.equal(paintsSnapshot({ writing: false, jumpedHere: false, page: 2, data: PAGE }), true);
  assert.equal(paintsSnapshot({ writing: false, jumpedHere: false, page: 1, data: { records: [], totalRecords: 0, pageSize: 50 } }), true, "an empty list is a real answer");
});

test("gate: never while a write is in flight", () => {
  assert.equal(paintsSnapshot({ writing: true, jumpedHere: false, page: 2, data: PAGE }), false);
});

test("gate: never for the page a live load just jumped to (the list shrank — the post-write re-read draws it)", () => {
  assert.equal(paintsSnapshot({ writing: false, jumpedHere: true, page: 2, data: PAGE }), false);
});

test("gate: never a snapshot that is itself past the end — only a live answer moves the page", () => {
  assert.equal(paintsSnapshot({ writing: false, jumpedHere: false, page: 4, data: { records: [], totalRecords: 120, pageSize: 50 } }), false);
});

// ── the page's wiring ────────────────────────────────────────────────────────

test("one builder: the live load fetches the view's URL and the snapshot is read for the same string", () => {
  // The GET endpoints are spelled only in the builder (the writes keep their own paths).
  for (const src of [HOOK, SHELL]) assert.ok(!/`\/api\/admin\/arr\/history\?/.test(src), "no hand-built History GET");
  assert.equal([...(HOOK + SHELL).matchAll(/`\/api\/admin\/arr\/blocklist\?/g)].length, 1, "the only blocklist query string left is the DELETE");
  assert.match(SHELL, /arrCall\(withBasePath\(`\/api\/admin\/arr\/blocklist\?\$\{q\.toString\(\)\}`\), \{\s*method: "DELETE",/);
  assert.match(
    HOOK,
    /const view = useMemo<HistoryView \| null>\(\s*\(\) => \(inst \? \{ tab, service: inst\.service, instance: inst\.slug, page, pageSize: PAGE_SIZE, kind \} : null\),\s*\[inst, tab, page, kind\],\s*\);/,
  );
  assert.match(HOOK, /const viewUrl = useMemo\(\(\) => \(view \? withBasePath\(historyViewPath\(view\)\) : null\), \[view\]\);/);
  assert.match(HOOK, /const countUrl = useMemo\(\(\) => \(inst \? withBasePath\(blocklistCountPath\(inst\.service, inst\.slug\)\) : null\), \[inst\]\);/);
  // The load fetches the string it is given — no second withBasePath — through
  // arr-call.ts (its read timeout: a read that never settles can't hold the spinner).
  const load = callbackBody(HOOK, "load");
  assert.match(load, /if \(!view \|\| !viewUrl\) return;/);
  assert.match(load, /reads\.run\("load", \(signal\) => arrCall\(viewUrl, \{ schema, signal, fallback: tRef\.current\(fallbackKey\) \}\)\)/);
  assert.match(load, /readPage\(HISTORY_PAGE, /);
  assert.match(load, /readPage\(BLOCKLIST_PAGE, /);
  assert.match(HOOK, /reads\.run\("count", \(signal\) => arrCall\(countUrl, \{ schema: BLOCKLIST_PAGE, signal, fallback: "" \}\)\)/);
  assert.match(HOOK, /useArrSnapshot<unknown>\(viewUrl, /);
  assert.match(HOOK, /useArrSnapshot<unknown>\(countUrl, /);
  // The view's hooks run before the page's "nothing configured" early return.
  const early = SHELL.indexOf("if (instances.length === 0 || !inst) {");
  assert.ok(SHELL.indexOf("useHistoryView({") < early);
});

test("drawing a snapshot: a checked page of the view's tab, gated, rows only — never errors, selection, confirms, busy or the page", () => {
  const apply = applyBody();
  assert.match(
    apply,
    /const parsed = check\(schema, data\);\s*const ok = view !== null && parsed\.ok && paintsSnapshot\(\{\s*writing: writing\(\),\s*jumpedHere: jumpedTo\.current === viewUrl,\s*page: view\.page,\s*data: parsed\.value,\s*\}\);\s*setSnapshotDrawn\(ok \? viewUrl : null\);\s*if \(!ok \|\| !parsed\.ok\) return false;/,
  );
  assert.match(apply, /view\.tab === "history"\s*\? offer\(HISTORY_PAGE, \(page\) => \{\s*setHistory\(page\);\s*setHistoryKind\(view\.kind\);\s*\}\)\s*: offer\(BLOCKLIST_PAGE, \(page\) => setBlocklist\(page\)\);/);
  for (const forbidden of ["setError", "setSelected", "setNotice", "setConfirmClear", "setBusy", "setPage", "setLoading", "markLive", "setCurrent", "setTab", "setKind"]) {
    assert.ok(!apply.includes(forbidden), `applying a snapshot must not call ${forbidden}`);
  }
});

test("the write guard is current the moment a write starts, and covers Clear's command", () => {
  // Every write is an action of its own (use-async-action.ts): its busy state is
  // set synchronously when it starts, and the snapshot gate reads it live.
  assert.match(SHELL, /const WRITES = \["mark", "remove", "clear"\] as const;/);
  for (const w of ['writes.run(\n      "mark"', 'writes.run(\n      "remove"', 'writes.run(\n      "clear"']) assert.ok(SHELL.includes(w), w);
  assert.match(SHELL, /writing: \(\) => WRITES\.some\(\(k\) => writes\.busy\(k\)\) \|\| clearing,/);
  assert.match(SHELL, /const clearing = isWatchActive\(watches\.clear\);/);
  assert.doesNotMatch(SHELL + HOOK, /busyRef|clearingRef|setBusyState/, "no hand-mirrored busy flags left");
});

test("a past-the-end jump marks the page it lands on, and an accepted live answer clears the mark", () => {
  const load = callbackBody(HOOK, "load");
  const jumps = [...load.matchAll(/keepErrorNext\.current = true;\s*jumpedTo\.current = withBasePath\(historyViewPath\(\{ \.\.\.view, page: last \}\)\);\s*setPage\(last\);\s*return;/g)];
  assert.equal(jumps.length, 1, "one read for both tabs");
});

test("markLive: only for an accepted live answer of the current view, through the current url's callback", () => {
  const load = callbackBody(HOOK, "load");
  const read = load.slice(load.indexOf("async function readPage<T>("), load.indexOf('if (view.tab === "history") {'));
  assert.match(read, /draw\(res\.data\);\s*jumpedTo\.current = null;\s*markLive\(\);\s*\}/);
  assert.equal([...load.matchAll(/markLive\(\)/g)].length, 1, "once, nowhere else in load — never before the answer is accepted");
  assert.ok(read.indexOf("if (!res) return;") < read.indexOf("markLive()"), "after a superseded load returned");
  assert.ok(read.indexOf("if (!res.ok) {") < read.indexOf("markLive()"), "never for a failure");
  assert.ok(read.indexOf("setPage(last);\n        return;") < read.indexOf("markLive()"), "after the past-the-end jump");
  assert.match(load, /\}, \[view, viewUrl, reads, tRef, markLive\]\);$/);
  // Each tab's accepted page draws only its own rows (and the blocklist its count and selection).
  assert.match(load, /readPage\(HISTORY_PAGE, "adminArr\.history\.loadFailed", \(data\) => \{\s*setHistory\(data\);\s*setHistoryKind\(view\.kind\);\s*\}\);/);
  assert.match(load, /readPage\(BLOCKLIST_PAGE, "adminArr\.blocklist\.loadFailed", \(data\) => \{[\s\S]*?setBlocklist\(data\);[\s\S]*?setSelected\(/);
  // The count's live answer marks the count's snapshot, with the effect re-run per url.
  assert.match(HOOK, /if \(res\?\.ok\) \{\s*setBlocklistCount\(\{ inst: key, total: res\.data\.totalRecords \}\);\s*markCountLive\(\);\s*\}/);
  assert.match(HOOK, /\}, \[inst, countUrl, reads, markCountLive\]\);/);
});

test("the Blocklist tab's count: no second read while the tab is on screen; its own page read keeps the count", () => {
  // The count effect skips its pageSize=1 read on the Blocklist tab, read through
  // a ref so the effect still re-runs only per instance (deps pinned above).
  const effect = HOOK.slice(HOOK.indexOf("if (!inst || !countUrl) return;"), HOOK.indexOf("}, [inst, countUrl, reads, markCountLive]);"));
  assert.match(effect, /^if \(!inst \|\| !countUrl\) return;\s*(?:\/\/[^\n]*\n\s*)?if \(tabRef\.current === "blocklist"\) return;\s*const key = arrInstanceKey\(inst\);/);
  assert.ok(effect.indexOf('tabRef.current === "blocklist"') < effect.indexOf('reads.run("count"'), "before the read");
  assert.match(effect, /return \(\) => reads\.abort\("count"\);/, "another instance's count read is dropped");
  assert.match(HOOK, /const tabRef = useRef<Tab>\(tab\);\s*useEffect\(\(\) => \{\s*tabRef\.current = tab;\s*\}, \[tab\]\);/);
  // The ref is kept current BEFORE the count effect runs (effects run in order).
  assert.ok(HOOK.indexOf("tabRef.current = tab;") < HOOK.indexOf('if (tabRef.current === "blocklist") return;'));
  // A live blocklist page sets the count for ITS instance, after the answer was accepted.
  const load = callbackBody(HOOK, "load");
  const blocklist = load.slice(load.indexOf('readPage(BLOCKLIST_PAGE'));
  assert.match(blocklist, /setBlocklistCount\(\{ inst: arrInstanceKey\(\{ service: view\.service, slug: view\.instance \}\), total: data\.totalRecords \}\);/);
});

test("the stale note is rendered under the filter bar, only over a snapshot actually drawn, spinning while the live load is out", () => {
  assert.match(SHELL, /<\/fieldset>\s*<ArrSnapshotNote at=\{view\.staleAt\} refreshing=\{view\.loading\} \/>/);
  assert.equal([...SHELL.matchAll(/<ArrSnapshotNote /g)].length, 1);
  assert.match(HOOK, /staleAt: snapshotDrawn === viewUrl \? staleAt : null,/);
});
