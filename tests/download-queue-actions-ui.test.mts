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
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Source with comments removed, so a commented-out call can't satisfy a pin. */
const src = readFileSync(new URL("../src/components/admin/download-queue.tsx", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** The body of `async function <name>(…) {…}` inside the page component. */
function fnBody(name: string): string {
  const at = src.indexOf(`async function ${name}(`);
  assert.ok(at >= 0, `${name} is defined`);
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unbalanced");
}

/** The `useCallback(async (…) => { … }` body that defines `const load`. */
function loadBody(): string {
  const at = src.indexOf("const load = useCallback(");
  assert.ok(at >= 0);
  const open = src.indexOf("{", src.indexOf("=>", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unbalanced");
}

test("Grab now and Re-check report a failure on their own line, which a successful poll never clears", () => {
  for (const name of ["grabNow", "recheck"]) {
    const body = fnBody(name);
    assert.match(body, /setActionError\(""\)/, `${name} clears the last action's failure when it starts`);
    assert.ok((body.match(/setActionError\((?!"")/g) ?? []).length >= 2, `${name} reports a refusal and a network failure as an action error`);
    assert.doesNotMatch(body, /\bsetError\(/, `${name} never writes the load's error, which the next poll clears`);
  }
  assert.doesNotMatch(loadBody(), /setActionError/, "the load (and so every poll) leaves an action's failure alone");
  assert.match(src, /\{actionError && <p role="alert"/, "the failure is shown");
});

test("the in-flight actions are a Set, and each action removes only its own key", () => {
  assert.match(src, /const \[acting, setActing\] = useState<ReadonlySet<string>>\(/);
  assert.doesNotMatch(src, /setActing\(null\)/);
  assert.doesNotMatch(src, /acting === /, "disabled and spinner states read the Set");
  const grab = fnBody("grabNow");
  assert.match(grab, /startActing\(key\)/);
  assert.match(grab, /finally \{\s*stopActing\(key\);\s*\}/);
  const recheck = fnBody("recheck");
  assert.match(recheck, /startActing\("recheck"\)/);
  assert.match(recheck, /finally \{\s*stopActing\("recheck"\);\s*\}/);
  assert.match(src, /const stopActing = \(key: string\) => setActing\(\(s\) => \{\s*const next = new Set\(s\);\s*next\.delete\(key\);/, "removing a key removes that key alone");
  assert.match(src, /disabled=\{acting\.has\(key\)\}/);
  assert.match(src, /disabled=\{acting\.has\("recheck"\)\}/);
});

test("the re-read after an action is ONE tracked timer: a newer action replaces it, unmount clears it, and it is still a manual load", () => {
  assert.doesNotMatch(src, /window\.setTimeout\(\(\) => void load\(\)/, "no untracked deferred load");
  assert.equal((src.match(/window\.setTimeout\(/g) ?? []).length, 1, "the one scheduler sets the only timer");
  const at = src.indexOf("const reloadSoon = useCallback(");
  assert.ok(at >= 0, "the deferred-reload scheduler");
  const scheduler = src.slice(at, src.indexOf("}, [load]);", at));
  assert.match(scheduler, /if \(reloadTimer\.current !== null\) window\.clearTimeout\(reloadTimer\.current\);\s*reloadTimer\.current = window\.setTimeout\(/, "a pending re-read is cleared before a new one is set");
  assert.match(scheduler, /void load\(\);/, "a manual load: it supersedes one in flight (createLoadGate)");
  assert.match(src, /useEffect\(\(\) => \(\) => \{\s*if \(reloadTimer\.current !== null\) window\.clearTimeout\(reloadTimer\.current\);\s*\}, \[\]\);/, "cleared on unmount");
  for (const [name, ms] of [["grabNow", "2_000"], ["recheck", "5_000"]] as const) {
    assert.match(fnBody(name), new RegExp(`reloadSoon\\(${ms}\\)`), `${name} re-reads through the scheduler`);
  }
  assert.match(src, /reloadSoon\(3_000\)/, "an import too");
});

test("both instance-error lists render through ArrErrorList: the translated kind only, never the upstream text (guardrail 5e)", () => {
  assert.equal((src.match(/<ArrErrorList /g) ?? []).length, 2);
  const at = src.indexOf("function ArrErrorList(");
  const body = src.slice(at, src.indexOf("\n}\n", at));
  assert.match(body, /ARR_ERROR_KIND_KEYS\[isArrErrorKind\(e\.kind\) \? e\.kind : "other"\]/);
  assert.doesNotMatch(body, /e\.error/);
  assert.equal((src.match(/ARR_ERROR_KIND_KEYS\[/g) ?? []).length, 1, "no second copy of the list");
});
