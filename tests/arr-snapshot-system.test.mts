// Admin → Arr System, "instant, then live" (src/lib/arr-snapshot.ts): each tab
// (Tasks, Indexers & clients, Storage) paints the last answer the server kept
// for its read while the live read is out, then the live answer replaces it.
//
// The tabs (arr-system-*.tsx) are .tsx the unit loader can't import, so this
// pins their shape:
// - the live read and the snapshot read name ONE url, from one builder (a
//   second spelling would miss the server-side snapshot key);
// - markLive() runs only for a live answer load KEPT (a skipped or superseded
//   read must not dismiss the snapshot note or block a snapshot);
// - the snapshot only ever sets the report, and only one that passes the
//   report's shape check — never the error, the loading flag, or any of the
//   tabs' write state (switch overrides, held warnings, busy sections, test
//   results, command watches);
// - polling is unchanged and every tab renders the note beside its Reload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(new URL(`../src/components/admin/${f}`, import.meta.url), "utf8");
const parts = read("arr-system-parts.tsx");
const tabs = ["arr-system-tasks.tsx", "arr-system-providers.tsx", "arr-system-storage.tsx"].map(read).join("\n");

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

const useReport = block(parts, "export function useReport<T extends object>(", "poll: number | null) {");

test("one url builder for the live read and its snapshot, carrying the base path like every other call", () => {
  assert.match(parts, /const reportUrl = \(path: string\) => withBasePath\(path\);/);
  assert.match(useReport, /const url = reportUrl\(path\);/);
  assert.match(useReport, /useArrSnapshot<unknown>\(url, /, "the snapshot is read for the live read's url");
  const load = block(useReport, "const load = useCallback(");
  assert.match(load, /arrCall\(url, \{ schema, signal, fallback: fallbackRef\.current \}\)/, "the live read fetches that same url, through arr-call.ts (its timeout, its shape check)");
  assert.doesNotMatch(load, /withBasePath\(/, "no second spelling of the url inside the live read");
});

test("markLive only for a live answer that load kept, with that answer", () => {
  const load = block(useReport, "const load = useCallback(");
  const dropped = load.indexOf("if (res === undefined) return false;");
  const ok = block(load, "if (res.ok) {");
  assert.ok(dropped > -1 && load.indexOf(ok) > dropped, "the accepted branch runs after a skipped or superseded load returned");
  assert.match(ok, /markLive\(\);\s*setReport\(res\.data\);\s*setError\(""\);\s*return true;/);
  assert.equal(load.match(/markLive\(\)/g)?.length, 1, "nowhere else — not on a failure, a skipped poll or a superseded read");
  assert.match(useReport, /\}, \[url, schema, action, markLive\]\);/);
});

test("one key for every load: a poll is skipped while a read is out, a manual load supersedes it", () => {
  const load = block(useReport, "const load = useCallback(");
  assert.match(load, /action\.run\(\s*"load",[\s\S]*?\{ ifBusy: kind === "poll" \? "skip" : "restart" \},\s*\);/);
  assert.match(useReport, /const action = useAsyncAction\(\);/);
});

test("a background poll refreshes quietly: no spinner or disabled Reload every tick, and one failed poll is no banner", () => {
  const load = block(useReport, "const load = useCallback(");
  assert.match(load, /if \(kind !== "poll"\) setLoading\(true\);/);
  assert.equal(load.match(/setLoading\(true\)/g)?.length, 1, "nothing else turns the flag on");
  // Cleared only by a load that was kept (a superseded poll writes nothing).
  const dropped = load.indexOf("if (res === undefined) return false;");
  assert.ok(dropped > -1 && load.indexOf("setLoading(false);") > dropped);
  // A poll's failure is shown only from the second in a row; any answer resets the count.
  const ok = block(load, "if (res.ok) {");
  assert.match(ok, /pollFailures\.current = 0;/);
  const quiet = load.indexOf('if (kind === "poll" && ++pollFailures.current < 2) return false;');
  assert.ok(quiet > load.indexOf(ok) + ok.length - 1, "after the success branch");
  assert.ok(quiet < load.lastIndexOf("setError(res.error);"), "before the banner");
  assert.match(useReport, /const pollFailures = useRef\(0\);/);
});

test("the snapshot sets a checked report and nothing else", () => {
  const apply = useReport.slice(useReport.indexOf("useArrSnapshot<unknown>(url, "), useReport.indexOf("const { markLive } = snap;"));
  assert.match(apply, /const parsed = check\(schema, data\);\s*if \(!parsed\.ok\) return false;\s*setReport\(parsed\.value\);/, "a snapshot that isn't a report is refused — never painted, never a crash");
  assert.doesNotMatch(apply, /setError|setLoading|markLive|load\(/, "errors and the loading flag are the live read's");
  // The tabs' write state lives in the tabs; useReport never reaches it.
  assert.doesNotMatch(useReport, /setIndexers|setClients|setBusy|setMessages|watch\(/);
  assert.match(useReport, /return \{ report, loading, error, load, staleAt: snap\.staleAt \};/);
});

test("polling is unchanged: a tick still goes through load as a poll, and the first load still runs on open", () => {
  assert.match(useReport, /useEffect\(\(\) => \{\s*void load\(\);\s*\}, \[load\]\);/);
  assert.match(useReport, /if \(document\.visibilityState === "visible"\) void load\("poll"\);/);
  assert.match(tabs, /useReport<TasksResult>\("\/api\/admin\/arr\/tasks", TASKS_REPORT, [^)]*\), TASKS_POLL_MS\)/);
});

test("every tab shows when its snapshot was read, beside Reload", () => {
  const toolbar = block(parts, "export function Toolbar(", "string | null }) {");
  assert.match(toolbar, /<ArrSnapshotNote at=\{staleAt\} refreshing=\{loading\} \/>/);
  for (const [path, schema] of [["tasks", "TASKS_REPORT"], ["providers", "PROVIDERS_REPORT"], ["storage", "STORAGE_REPORT"]]) {
    assert.match(tabs, new RegExp(`const \\{ report, loading, error, load, staleAt \\} = useReport<[^\\n]*"/api/admin/arr/${path}", ${schema},`), path);
  }
  const toolbars = tabs.match(/<Toolbar [^\n]*?\/>/g) ?? [];
  assert.equal(toolbars.length, 3);
  for (const tb of toolbars) assert.match(tb, /loading=\{loading\}.* staleAt=\{staleAt\} \/>$/, tb);
});
