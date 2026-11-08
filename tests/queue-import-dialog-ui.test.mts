// Admin → Download Queue → Import (queue-import-dialog.tsx). The unit loader
// can't import .tsx, so these pins are structural. What they hold:
//   - "no answer yet" is loading: the red role="alert" load-failure branch is
//     reached only with an error set, never on the first frame after opening
//     (files null, the load not started), when screen readers announced it;
//   - files, edits and an error belong to the download they were loaded for:
//     until the open row's own load settles the spinner shows, not the last
//     row's files;
//   - a correction's verdict updates the selection BOTH ways
//     (nextImportSelection): a file the arr no longer accepts is unticked —
//     its box is disabled, so it could never be unticked by hand and the
//     button counted it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/admin/queue-import-dialog.tsx", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("the load-failure alert needs an error: with no answer yet the dialog shows its spinner", () => {
  const spinner = src.indexOf("{loading || pending || (files === null && !error) ? (");
  assert.ok(spinner >= 0, "no files and no error is still loading");
  const alert = src.indexOf('role="alert"', spinner);
  const branch = src.slice(spinner, alert);
  assert.match(branch, /\) : files === null \? \($/m, "the alert branch follows the spinner, so it is reached only with an error");
  assert.doesNotMatch(src.slice(alert, src.indexOf("</div>", alert)), /loadFailed/, "no fallback text: the branch is never reached without an error");
});

test("data shown belongs to the download it was loaded for: another row's files wait behind the spinner", () => {
  assert.match(src, /const dataKey = service && instance !== undefined && downloadId !== null \? `\$\{service\}:\$\{instance\}:\$\{downloadId\}` : null;/);
  assert.match(src, /const pending = row !== null && dataKey !== loadedFor;/);
  assert.match(src, /setLoading\(false\);\s*setLoadedFor\(key\);/, "marked loaded only when the load settles, for its own key");
  assert.match(src, /\{error && files !== null && !pending && \(/, "an earlier row's error is not shown under the new row");
});

test("a correction's verdict ticks or unticks its file; a reset goes back to the arr's own verdict both ways", () => {
  const at = src.indexOf("async function applyEdit(");
  const body = src.slice(at, src.indexOf("\n  }\n", at));
  assert.match(body, /setSelected\(\(sel\) => nextImportSelection\(sel, file\.path, view\.importable\)\)/);
  // A reset re-selects a file the arr can import, as an Apply would, and unticks one it can't.
  assert.match(body, /setSelected\(\(sel\) => nextImportSelection\(sel, file\.path, file\.importable\)\)/);
  assert.doesNotMatch(body, /if \(!file\.importable\) setSelected/, "the reset never only deselects");
  assert.doesNotMatch(body, /new Set\(s\)\.add/, "never add-only");
});

test("an Apply still out when the dialog moves to another download never lands on that download's files", () => {
  // Each Apply is a keyed run; the load effect for a new download aborts every run first.
  const start = src.indexOf("useEffect(() => {\n    action.abort();");
  assert.ok(start >= 0 && start < src.indexOf("}, [service, instance, downloadId, action]);"), "the load effect aborts the runs still out");
  const at = src.indexOf("async function applyEdit(");
  const body = src.slice(at, src.indexOf("\n  }\n", at));
  assert.match(body, /const res = await action\.run\(`preview:\$\{file\.path\}`/);
  assert.match(body, /if \(!res\) return null;/, "a dropped verdict applies nothing");
  assert.ok(body.indexOf("if (!res) return null;") < body.indexOf("setEdits((m) => ({ ...m, [file.path]: override }))"));
});

test("a series' episodes that failed to load say so, with a Retry, instead of an empty season list", () => {
  assert.match(src, /schema: ImportEpisodesAnswer,/);
  assert.match(src, /\} else if \(series\.episodes === null\) \{[\s\S]*?role="alert"[\s\S]*?onClick=\{series\.retry\}/);
  assert.doesNotMatch(src, /setEpisodes\(\[\]\)/, "a failure is never an empty list");
});
