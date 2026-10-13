// Admin → Arr System, "instant, then live" (src/lib/arr-snapshot.ts): each tab
// (Tasks, Indexers & clients, Storage) paints the last answer the server kept
// for its read while the live read is out, then the live answer replaces it.
//
// The page is a .tsx the unit loader can't import, so this pins its shape:
// - the live read and the snapshot read name ONE url, from one builder (a
//   second spelling would miss the server-side snapshot key);
// - markLive() runs only for a live answer the load gate ACCEPTED (a skipped or
//   superseded read must not dismiss the snapshot note or block a snapshot);
// - the snapshot only ever sets the report — never the error, the loading
//   flag, or any of the tabs' write state (switch overrides, held warnings,
//   busy cards, test results, command watches);
// - polling is unchanged and every tab renders the note beside its Reload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/admin/arr-system.tsx", import.meta.url), "utf8");

/**
 * The text from `start` through the brace that closes the body. The body's `{`
 * is the last character of `opener`, the first one after `start` (default: the
 * first `{` from the end of `start` on).
 */
function block(text: string, start: string, opener = "{"): string {
  const at = text.indexOf(start);
  assert.notEqual(at, -1, `missing: ${start}`);
  const o = text.indexOf(opener, at + start.length - 1);
  assert.notEqual(o, -1, `missing body of: ${start}`);
  const open = o + opener.length - 1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(at, i + 1);
  }
  throw new Error(`unbalanced: ${start}`);
}

const useReport = block(src, "function useReport<T>(", "poll: number | null) {");

test("one url builder for the live read and its snapshot, carrying the base path like every other call", () => {
  assert.match(src, /const reportUrl = \(path: string\) => withBasePath\(path\);/);
  assert.match(useReport, /const url = reportUrl\(path\);/);
  assert.match(useReport, /useArrSnapshot<Report<T>>\(url, /, "the snapshot is read for the live read's url");
  const load = block(useReport, "const load = useCallback(");
  assert.match(load, /await callUrl<Report<T>>\(url, undefined, fallbackRef\.current\)/, "the live read fetches that same url");
  assert.doesNotMatch(load, /\bcall<|withBasePath\(/, "no second spelling of the url inside the live read");
  // callUrl fetches exactly what it is handed (no second base-path prefix).
  const callUrl = block(src, "async function callUrl<T>(", "Promise<CallResult<T>> {");
  assert.match(callUrl, /await fetch\(url, \{/);
  assert.match(block(src, "async function call<T>(", "Promise<CallResult<T>> {"), /return callUrl<T>\(withBasePath\(path\), init, fallback\);/);
});

test("markLive only for a live answer the load gate accepted, with that answer", () => {
  const load = block(useReport, "const load = useCallback(");
  const settle = load.indexOf("if (!gate.settle(id)) return false;");
  const ok = block(load, 'if ("data" in res) {');
  assert.ok(settle > -1 && load.indexOf(ok) > settle, "the accepted branch runs after the gate check");
  assert.match(ok, /markLive\(\);\s*setReport\(res\.data\);\s*setError\(""\);\s*return true;/);
  assert.equal(load.match(/markLive\(\)/g)?.length, 1, "nowhere else — not on a failure, a skipped poll or a superseded read");
  assert.match(useReport, /\}, \[url, gate, markLive\]\);/);
});

test("the snapshot sets the report and nothing else", () => {
  const apply = useReport.slice(useReport.indexOf("useArrSnapshot<Report<T>>(url, "), useReport.indexOf("const { markLive } = snap;"));
  assert.match(apply, /setReport\(data\)/);
  assert.doesNotMatch(apply, /setError|setLoading|markLive|load\(/, "errors and the loading flag are the live read's");
  // The tabs' write state lives in the tabs; useReport never reaches it.
  assert.doesNotMatch(useReport, /setOverrides|setHeld|setBusy|setResults|setSummaries|setMessages|watch\(/);
  assert.match(useReport, /return \{ report, loading, error, load, staleAt: snap\.staleAt \};/);
});

test("polling is unchanged: a tick still goes through the gate as a poll, and the first load still runs on open", () => {
  assert.match(useReport, /useEffect\(\(\) => \{\s*void load\(\);\s*\}, \[load\]\);/);
  assert.match(useReport, /if \(document\.visibilityState === "visible"\) void load\("poll"\);/);
  assert.match(src, /useReport<\{ tasks: ArrTask\[\]; commands: ArrCommandRow\[\] \}>\("\/api\/admin\/arr\/tasks", [^)]*\), TASKS_POLL_MS\)/);
});

test("every tab shows when its snapshot was read, beside Reload", () => {
  const toolbar = block(src, "function Toolbar(", "string | null }) {");
  assert.match(toolbar, /<ArrSnapshotNote at=\{staleAt\} refreshing=\{loading\} \/>/);
  for (const path of ["tasks", "providers", "storage"]) {
    assert.match(src, new RegExp(`const \\{ report, loading, error, load, staleAt \\} = useReport<[^\\n]*"/api/admin/arr/${path}"`), path);
  }
  const toolbars = src.match(/<Toolbar [^\n]*?\/>/g) ?? [];
  assert.equal(toolbars.length, 3);
  for (const tb of toolbars) assert.match(tb, /loading=\{loading\}.* staleAt=\{staleAt\} \/>$/, tb);
});
