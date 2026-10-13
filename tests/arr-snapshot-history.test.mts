// "Instant, then live" on Admin → Download History
// (src/components/admin/arr-download-history.tsx): opening the page, or
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
//   and a snapshot never moves the page;
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

const SRC = readFileSync(new URL("../src/components/admin/arr-download-history.tsx", import.meta.url), "utf8");

/** The source of `const <name> = useCallback(` … through its deps line. */
function callbackBody(name: string): string {
  const startAt = SRC.indexOf(`const ${name} = useCallback(`);
  assert.ok(startAt >= 0, `${name} is a useCallback`);
  const end = SRC.indexOf("\n  }, [", startAt);
  assert.ok(end > startAt, `${name} has a deps line`);
  return SRC.slice(startAt, SRC.indexOf("\n", end + 1));
}

/** The source of the main view's snapshot apply. */
function applyBody(): string {
  const hook = "const { staleAt, markLive } = useArrSnapshot<ArrPage<ArrHistoryEvent> | ArrPage<BlocklistEntry>>(viewUrl, (data) => {";
  assert.ok(SRC.includes(hook), "the view's snapshot hook");
  // The apply's body only (the hook line itself names markLive).
  const startAt = SRC.indexOf(hook) + hook.length;
  const end = SRC.indexOf("\n  });", startAt);
  assert.ok(end > startAt);
  return SRC.slice(startAt, end + 6);
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
  assert.ok(!/`\/api\/admin\/arr\/history\?/.test(SRC), "no hand-built History GET");
  assert.equal([...SRC.matchAll(/`\/api\/admin\/arr\/blocklist\?/g)].length, 1, "the only blocklist query string left is the DELETE");
  assert.match(SRC, /fetch\(withBasePath\(`\/api\/admin\/arr\/blocklist\?\$\{q\.toString\(\)\}`\), \{ method: "DELETE" \}\)/);
  assert.match(
    SRC,
    /const view = useMemo<HistoryView \| null>\(\s*\(\) => \(inst \? \{ tab, service: inst\.service, instance: inst\.slug, page, pageSize: PAGE_SIZE, kind \} : null\),\s*\[inst, tab, page, kind\],\s*\);/,
  );
  assert.match(SRC, /const viewUrl = useMemo\(\(\) => \(view \? withBasePath\(historyViewPath\(view\)\) : null\), \[view\]\);/);
  assert.match(SRC, /const countUrl = useMemo\(\(\) => \(inst \? withBasePath\(blocklistCountPath\(inst\.service, inst\.slug\)\) : null\), \[inst\]\);/);
  // getJson fetches the string it is given — no second withBasePath.
  assert.match(SRC, /async function getJson<T>\(url: string, fallback: string\): Promise<\{ data: T \} \| \{ error: string \}> \{\s*try \{\s*const res = await fetch\(url\);/);
  const load = callbackBody("load");
  assert.match(load, /if \(!view \|\| !viewUrl\) return;/);
  assert.match(load, /getJson<ArrPage<ArrHistoryEvent>>\(viewUrl, /);
  assert.match(load, /getJson<ArrPage<BlocklistEntry>>\(viewUrl, /);
  assert.match(SRC, /getJson<ArrPage<BlocklistEntry>>\(countUrl, ""\)/);
  assert.match(SRC, /useArrSnapshot<ArrPage<ArrHistoryEvent> \| ArrPage<BlocklistEntry>>\(viewUrl, /);
  assert.match(SRC, /useArrSnapshot<ArrPage<BlocklistEntry>>\(countUrl, /);
  // Hooks run before the "nothing configured" early return.
  const early = SRC.indexOf("if (instances.length === 0 || !inst) {");
  assert.ok(SRC.indexOf("useArrSnapshot<ArrPage<BlocklistEntry>>(countUrl") < early);
  assert.ok(SRC.indexOf("useArrSnapshot<ArrPage<ArrHistoryEvent>") < early);
});

test("drawing a snapshot: gated, rows only — never errors, selection, confirms, busy or the page", () => {
  const apply = applyBody();
  assert.match(
    apply,
    /const draw = view !== null && paintsSnapshot\(\{\s*writing: busyRef\.current !== null \|\| clearingRef\.current,\s*jumpedHere: jumpedTo\.current === viewUrl,\s*page: view\.page,\s*data,\s*\}\);\s*setSnapshotDrawn\(draw \? viewUrl : null\);\s*if \(!draw\) return false;/,
  );
  assert.match(apply, /if \(view\.tab === "history"\) \{\s*setHistory\(data as ArrPage<ArrHistoryEvent>\);\s*setHistoryKind\(view\.kind\);\s*\} else setBlocklist\(data as ArrPage<BlocklistEntry>\);/);
  for (const forbidden of ["setError", "setSelected", "setNotice", "setConfirmClear", "setBusy", "setPage", "setLoading", "markLive", "setCurrent", "setTab", "setKind"]) {
    assert.ok(!apply.includes(forbidden), `applying a snapshot must not call ${forbidden}`);
  }
});

test("the write guard is current the moment a write starts, and covers Clear's command", () => {
  // setBusy mirrors into the ref synchronously (every write calls setBusy first).
  assert.match(SRC, /const \[busy, setBusyState\] = useState<"remove" \| "clear" \| "mark" \| null>\(null\);/);
  assert.match(SRC, /const setBusy = useCallback\(\(next: Busy\) => \{\s*busyRef\.current = next;\s*setBusyState\(next\);\s*\}, \[\]\);/);
  assert.equal([...SRC.matchAll(/setBusyState\(/g)].length, 1, "nothing sets busy behind the ref's back");
  for (const w of ['setBusy("mark")', 'setBusy("remove")', 'setBusy("clear")']) assert.ok(SRC.includes(w), w);
  assert.match(SRC, /useEffect\(\(\) => \{\s*clearingRef\.current = isWatchActive\(watches\.clear\);\s*\}, \[watches\.clear\]\);/);
});

test("a past-the-end jump marks the page it lands on, and an accepted live answer clears the mark", () => {
  const load = callbackBody("load");
  const jumps = [...load.matchAll(/keepErrorNext\.current = true;\s*jumpedTo\.current = withBasePath\(historyViewPath\(\{ \.\.\.view, page: last \}\)\);\s*setPage\(last\);\s*return;/g)];
  assert.equal(jumps.length, 2, "both tabs");
});

test("markLive: only for an accepted live answer of the current view, through the current url's callback", () => {
  const load = callbackBody("load");
  const history = load.slice(load.indexOf('if (view.tab === "history")'), load.indexOf("} else {\n      const res"));
  const blocklist = load.slice(load.indexOf("} else {\n      const res"));
  for (const [name, branch, accept] of [
    ["history", history, /setHistory\(res\.data\);\s*setHistoryKind\(kind\);\s*jumpedTo\.current = null;\s*markLive\(\);\s*\} else setError\(res\.error\);/],
    ["blocklist", blocklist, /setBlocklist\(res\.data\);\s*setSelected\([^\n]+\n\s*jumpedTo\.current = null;\s*markLive\(\);\s*\} else setError\(res\.error\);/],
  ] as const) {
    assert.match(branch, accept, `${name}: markLive with the accepted answer`);
    assert.equal([...branch.matchAll(/markLive\(\)/g)].length, 1, `${name}: once`);
    assert.ok(branch.indexOf("if (id !== seq.current) return;") < branch.indexOf("markLive()"), `${name}: after the sequence check`);
    assert.ok(branch.indexOf("setPage(last);\n          return;") < branch.indexOf("markLive()"), `${name}: after the past-the-end jump`);
  }
  assert.equal([...load.matchAll(/markLive\(\)/g)].length, 2, "nowhere else in load — never before the answer is accepted");
  assert.match(load, /\}, \[view, viewUrl, kind, tRef, markLive\]\);$/);
  // The count's live answer marks the count's snapshot, with the effect re-run per url.
  assert.match(SRC, /if \(live && "data" in res\) \{\s*setBlocklistCount\(\{ inst: key, total: res\.data\.totalRecords \}\);\s*markCountLive\(\);\s*\}/);
  assert.match(SRC, /\}, \[inst, countUrl, markCountLive\]\);/);
});

test("the stale note is rendered under the filter bar, only over a snapshot actually drawn, spinning while the live load is out", () => {
  assert.match(SRC, /<\/fieldset>\s*<ArrSnapshotNote at=\{snapshotDrawn === viewUrl \? staleAt : null\} refreshing=\{loading\} \/>/);
  assert.equal([...SRC.matchAll(/<ArrSnapshotNote /g)].length, 1);
});
