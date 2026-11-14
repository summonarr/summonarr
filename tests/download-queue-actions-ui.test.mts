// Admin → Download Queue: what its row and page actions (Grab now, Re-check,
// Import, Remove) leave on screen and running. The unit loader can't import
// .tsx, so these pins are structural. What they hold:
//   - a Grab now / Re-check failure has its OWN line (`actionError`): the
//     load's `error` is cleared by the next poll's successful read, which
//     wiped an action's failure within 20 s;
//   - the in-flight actions are a SET of keys, and each action removes only
//     its own when it settles — a single slot let Re-check finishing re-enable
//     a Grab still running (and the reverse), so it could be sent twice;
//   - the re-read after an action is ONE tracked timer, replaced by a newer
//     action and cleared on unmount — untracked timers stacked and fired a full
//     queue read after the admin had left the page;
//   - both error lists render through one component that shows the translated
//     kind only, never the upstream text (guardrail 5e).
// The page is download-queue.tsx; its reads (the load, the poll, the re-read
// timer) live in use-queue-data.ts, its actions in use-queue-actions.ts, its
// filters in use-queue-filters.ts and its rows in queue-table.tsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Source with comments removed, so a commented-out call can't satisfy a pin. */
const code = (file: string) =>
  readFileSync(new URL(`../src/components/admin/${file}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const src = code("download-queue.tsx");
const actions = code("use-queue-actions.ts");
const data = code("use-queue-data.ts");
const table = code("queue-table.tsx");

/** The body of `async function <name>(…) {…}` inside the page's actions hook. */
function fnBody(name: string): string {
  const at = actions.indexOf(`async function ${name}(`);
  assert.ok(at >= 0, `${name} is defined`);
  const open = actions.indexOf("{", actions.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < actions.length; i++) {
    if (actions[i] === "{") depth++;
    else if (actions[i] === "}" && --depth === 0) return actions.slice(open, i + 1);
  }
  throw new Error("unbalanced");
}

/** The `useCallback(async (…) => { … }` body that defines `const load` (in the data hook). */
function loadBody(): string {
  const at = data.indexOf("const load = useCallback(");
  assert.ok(at >= 0);
  const open = data.indexOf("{", data.indexOf("=>", at));
  let depth = 0;
  for (let i = open; i < data.length; i++) {
    if (data[i] === "{") depth++;
    else if (data[i] === "}" && --depth === 0) return data.slice(open, i + 1);
  }
  throw new Error("unbalanced");
}

test("Grab now and Re-check report a failure on their own line, which a successful poll never clears", () => {
  for (const name of ["grabNow", "recheck"]) {
    const body = fnBody(name);
    assert.match(body, /setActionError\(""\)/, `${name} clears the last action's failure when it starts`);
    // fetchJson folds a refusal and no answer into one result: both are an action error.
    assert.match(body, /if \(!res\.ok && res\.kind !== "invalid"\) \{\s*setActionError\(res\.kind === "http" \? res\.error : t\(/, `${name} reports a refusal and a network failure as an action error`);
    assert.doesNotMatch(body, /\bsetError\(/, `${name} never writes the load's error, which the next poll clears`);
  }
  assert.doesNotMatch(loadBody(), /setActionError/, "the load (and so every poll) leaves an action's failure alone");
  assert.match(src, /\{actionError && <p role="alert"/, "the failure is shown");
});

test("the in-flight actions are a Set, and each action removes only its own key", () => {
  assert.match(actions, /const \[acting, setActing\] = useState<ReadonlySet<string>>\(/);
  assert.doesNotMatch(actions, /setActing\(null\)/);
  for (const file of [src, actions, table]) assert.doesNotMatch(file, /acting === /, "disabled and spinner states read the Set");
  const grab = fnBody("grabNow");
  assert.match(grab, /startActing\(key\)/);
  assert.match(grab, /finally \{\s*stopActing\(key\);\s*\}/);
  const recheck = fnBody("recheck");
  assert.match(recheck, /startActing\("recheck"\)/);
  assert.match(recheck, /finally \{\s*stopActing\("recheck"\);\s*\}/);
  assert.match(actions, /const stopActing = \(key: string\) => setActing\(\(s\) => \{\s*const next = new Set\(s\);\s*next\.delete\(key\);/, "removing a key removes that key alone");
  assert.match(table, /disabled=\{acting\.has\(key\)\}/, "a row's Grab now reads the page's Set under its own key");
  assert.match(src, /acting=\{acting\}/, "which the page hands the table whole");
  assert.match(src, /rechecking=\{acting\.has\("recheck"\)\}/, "Re-check reads the Set under its own key");
  assert.match(src, /disabled=\{rechecking\}/);
});

test("the re-read after an action is ONE tracked timer: a newer action replaces it, unmount clears it, and it is still a manual load", () => {
  for (const file of [src, actions, data, table]) assert.doesNotMatch(file, /window\.setTimeout\(\(\) => void load\(\)/, "no untracked deferred load");
  assert.equal([src, actions, data, table].reduce((n, file) => n + (file.match(/window\.setTimeout\(/g) ?? []).length, 0), 1, "the one scheduler sets the only timer");
  const at = data.indexOf("const reloadSoon = useCallback(");
  assert.ok(at >= 0, "the deferred-reload scheduler");
  const scheduler = data.slice(at, data.indexOf("}, [load]);", at));
  assert.match(scheduler, /if \(reloadTimer\.current !== null\) window\.clearTimeout\(reloadTimer\.current\);\s*reloadTimer\.current = window\.setTimeout\(/, "a pending re-read is cleared before a new one is set");
  assert.match(scheduler, /void load\(\);/, "a manual load: it supersedes one in flight (createLoadGate)");
  assert.match(data, /useEffect\(\(\) => \(\) => \{\s*if \(reloadTimer\.current !== null\) window\.clearTimeout\(reloadTimer\.current\);\s*\}, \[\]\);/, "cleared on unmount");
  assert.match(src, /const \{[^}]*\breloadSoon\b[^}]*\} = useQueueData\(/, "the page re-reads through the hook's scheduler");
  for (const [name, ms] of [["grabNow", "2_000"], ["recheck", "5_000"]] as const) {
    assert.match(fnBody(name), new RegExp(`reloadSoon\\(${ms}\\)`), `${name} re-reads through the scheduler`);
  }
  assert.match(actions, /reloadSoon\(3_000\)/, "an import too");
  assert.match(src, /useQueueActions\(\{\s*reloadSoon,/, "through the page's own scheduler");
});

test("both instance-error lists render through ArrErrorList: the translated kind only, never the upstream text (guardrail 5e)", () => {
  assert.equal((src.match(/<ArrErrorList /g) ?? []).length, 2);
  const at = src.indexOf("function ArrErrorList(");
  const body = src.slice(at, src.indexOf("\n}\n", at));
  assert.match(body, /ARR_ERROR_KIND_KEYS\[isArrErrorKind\(e\.kind\) \? e\.kind : "other"\]/);
  assert.doesNotMatch(body, /e\.error/);
  assert.equal((src.match(/ARR_ERROR_KIND_KEYS\[/g) ?? []).length, 1, "no second copy of the list");
});

test("a finished action's success line replaces the last one's failure line — Remove and Import included", () => {
  const succeeded = actions.slice(actions.indexOf("function succeeded("), actions.indexOf("async function loadVersions("));
  assert.match(succeeded, /setActionError\(""\);\s*setNotice\(text\);/);
  for (const name of ["function imported(", "function removed("]) {
    const at = actions.indexOf(name);
    assert.ok(at >= 0, name);
    assert.match(actions.slice(at, actions.indexOf("\n  }\n", at)), /succeeded\(/, `${name} clears an earlier failure`);
    assert.doesNotMatch(actions.slice(at, actions.indexOf("\n  }\n", at)), /setNotice\(/, `${name} never sets the notice alone`);
  }
});

test("a removal re-reads the queue, so a load that began before it cannot put the row back for long", () => {
  const at = actions.indexOf("function removed(");
  const body = actions.slice(at, actions.indexOf("\n  }\n", at));
  // The row goes at once; the re-read is a manual load, which supersedes one still out.
  assert.match(body, /dropRow\(row\);\s*reloadSoon\(2_000\);/);
});
