// "Instant, then live" on Admin → Download Queue and the Radarr/Sonarr health
// panel (also on Arr System and Settings → Webhooks): each paints the last
// answer the server kept for its read (useArrSnapshot) while its live load is
// out, and the live answer replaces it.
//
// The unit loader can't import .tsx, so these pins are structural. What they
// hold:
//   - the snapshot URL and the live fetch URL come from ONE builder per page,
//     so the server's snapshot key (path + query) is the one the live read kept;
//   - markLive() runs only where a live answer is ACCEPTED — after the queue's
//     load gate, inside the success branch, never for an error;
//   - the snapshot only paints an empty view (`cur ?? data`): it never replaces
//     rows already on screen, and never clears an error;
//   - the stale note is rendered, wired to the page's live-loading flag;
//   - the queue's reads all live in its data hook (use-queue-data.ts): the
//     page renders what the hook returns and reads the queue nowhere else;
//   - the health panel keeps its `{ variant }` props (three pages render it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

/** Source with comments removed, so a commented-out call can't satisfy a pin. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The text of the balanced `{…}` block that opens at or after `from`. */
function blockAfter(src: string, from: number): string {
  const open = src.indexOf("{", from);
  assert.ok(open >= 0, "block not found");
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unbalanced block");
}

function count(src: string, needle: string | RegExp): number {
  return typeof needle === "string" ? src.split(needle).length - 1 : (src.match(new RegExp(needle, "g")) ?? []).length;
}

/** The `useCallback(async (…) => { … }` body that defines `const load`. */
function loadBody(src: string): string {
  const at = src.indexOf("const load = useCallback(");
  assert.ok(at >= 0, "the page's load callback");
  return blockAfter(src, src.indexOf("=>", at));
}

/** The apply callback handed to useArrSnapshot (its whole call text). */
function snapshotCall(src: string): string {
  const at = src.indexOf("useArrSnapshot<");
  assert.ok(at >= 0, "useArrSnapshot is called");
  const open = src.indexOf("(", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error("unbalanced call");
}

const QUEUE = "src/components/admin/download-queue.tsx";
const QUEUE_DATA = "src/components/admin/use-queue-data.ts";
const HEALTH = "src/components/admin/arr-health-panel.tsx";

test("queue: the live fetch and the snapshot read name the same url, built in one place", () => {
  const src = code(QUEUE_DATA);
  assert.equal(count(src, 'const queueUrl = () => withBasePath("/api/admin/queue");'), 1, "one builder");
  assert.equal(count(src, '"/api/admin/queue"'), 1, "the path appears only in the builder");
  assert.match(loadBody(src), /await timedFetch\(queueUrl\(\)\)/, "the live load fetches the builder's url");
  assert.match(snapshotCall(src), /^useArrSnapshot<unknown>\(configured \? queueUrl\(\) : null,/, "the snapshot reads the builder's url, none while not configured");
  assert.match(snapshotCall(src), /if \(!isQueueReport\(data\)\) return false;/, "a painted snapshot is shape-checked before it is shown");
  const page = code(QUEUE);
  assert.doesNotMatch(page, /"\/api\/admin\/queue"/, "the page never reads the queue itself");
  assert.doesNotMatch(page, /useArrSnapshot/, "nor keeps a second snapshot");
});

test("queue: markLive runs only for an ACCEPTED live answer — after the load gate, in the success branch", () => {
  const body = loadBody(code(QUEUE_DATA));
  assert.equal(count(body, "markLive()"), 1);
  const gate = body.indexOf("if (!gate.settle(id)) return;");
  assert.ok(gate >= 0, "the load gate");
  const success = body.indexOf('if ("report" in next)');
  assert.ok(success > gate, "the success branch follows the gate");
  const branch = blockAfter(body, success);
  assert.match(branch, /setReport\(next\.report\);[\s\S]*markLive\(\);/, "markLive is in the accepted-live branch, after the report is set");
  assert.ok(body.indexOf("markLive()") > gate, "never before the gate (a superseded load is not live for this view)");
  assert.doesNotMatch(body.slice(body.indexOf("{", success) + branch.length), /markLive/, "never on the error branch");
  assert.match(code(QUEUE_DATA), /\}, \[gate, t, markLive\]\);/, "load's deps carry markLive");
});

// Every 20 s the poll turned the Refresh button into a disabled spinner and the
// stale note into "refreshing", and one failed tick raised the error banner
// beside a queue that was still on screen. Same rule as the Arr System page.
test("queue: a background poll refreshes quietly — no spinner or disabled Refresh every tick, and one failed poll is no banner", () => {
  const data = code(QUEUE_DATA);
  const body = loadBody(data);
  assert.match(body, /if \(kind !== "poll"\) setLoading\(true\);/);
  assert.equal(count(body, "setLoading(true)"), 1, "nothing else turns the flag on");
  const gate = body.indexOf("if (!gate.settle(id)) return;");
  assert.ok(gate > -1 && body.indexOf("setLoading(false);") > gate, "cleared only by the load the gate accepted");
  // A poll's failure shows only from the second in a row; any answer resets the count.
  const success = body.indexOf('if ("report" in next)');
  assert.match(blockAfter(body, success), /pollFailures\.current = 0;/);
  const quiet = body.indexOf('if (kind === "poll" && ++pollFailures.current < 2) return;');
  assert.ok(quiet > success, "after the success branch");
  assert.ok(quiet < body.lastIndexOf("setError(next.error);"), "before the banner");
  assert.match(data, /const pollFailures = useRef\(0\);/);
});

test("queue: the snapshot only paints an empty page and touches nothing but the report", () => {
  const call = snapshotCall(code(QUEUE_DATA));
  assert.match(call, /setReport\(\(cur\) => cur \?\? data\)/, "never replaces rows on screen (live, or a removal's optimistic drop)");
  for (const setter of ["setError", "setNotice", "setRemoving", "setImporting", "setManaging", "setActing", "setRemoveBusy", "setExpanded", "setFilter", "setQuery", "setTitleFilter"]) {
    assert.doesNotMatch(call, new RegExp(`\\b${setter}\\(`), `the snapshot leaves ${setter} alone`);
  }
});

test("queue: the stale note is shown beside the refresh controls, wired to the live-loading flag", () => {
  const src = code(QUEUE);
  assert.equal(count(src, "<ArrSnapshotNote at={snapshotAt} refreshing={loading} />"), 1);
  assert.match(src, /const \{[^}]*\bloading\b[^}]*\bsnapshotAt\b[^}]*\} = useQueueData\(/, "both from the data hook");
  const data = code(QUEUE_DATA);
  assert.match(data, /const \{ staleAt: snapshotAt, markLive \} = useArrSnapshot</);
  assert.match(data, /return \{[^}]*\bloading\b[^}]*\bsnapshotAt\b[^}]*\};/, "the hook hands both to the page");
  // Polling is unchanged: the interval still loads as a poll.
  assert.match(data, /void load\("poll"\)/);
});

test("health panel: the live fetch and the snapshot read name the same url, built in one place", () => {
  const src = code(HEALTH);
  assert.equal(count(src, 'const healthUrl = () => withBasePath("/api/admin/arr-health");'), 1, "one builder");
  assert.equal(count(src, '"/api/admin/arr-health"'), 1, "the path appears only in the builder");
  // Through arr-call.ts: its read timeout, so a read that never settles can't hold the spinner forever.
  assert.match(loadBody(src), /arrCall\(healthUrl\(\), \{ schema: HEALTH_REPORT, signal, fallback: /);
  assert.match(snapshotCall(src), /^useArrSnapshot<unknown>\(healthUrl\(\),/);
});

test("health panel: markLive runs only after a live report was accepted, never for a failure", () => {
  const body = loadBody(code(HEALTH));
  assert.equal(count(body, "markLive()"), 1);
  const refused = body.indexOf("if (!res.ok) {");
  assert.ok(refused >= 0);
  const refusedBlock = blockAfter(body, refused);
  assert.doesNotMatch(refusedBlock, /markLive/, "not for a refused read");
  const accepted = body.indexOf("setReport(res.data);");
  assert.ok(accepted > body.indexOf("{", refused) + refusedBlock.length - 1, "the report is set after the refusal check");
  assert.ok(body.indexOf("markLive()") > accepted, "markLive follows the accepted report");
  assert.match(code(HEALTH), /\}, \[action, tRef, markLive\]\);/, "load's deps carry markLive");
});

test("health panel: overlapping loads — only the newest writes the report or the error, and only it is `loading`", () => {
  const src = code(HEALTH);
  const body = loadBody(src);
  // One key for every load: a newer one aborts the one before (use-async-action.ts), whose answer is dropped.
  assert.match(body, /const res = await action\.run\("load", \(signal\) =>/);
  const dropped = body.indexOf("if (!res) return;");
  assert.ok(dropped > body.indexOf('action.run("load"'), "a superseded load's answer is dropped");
  for (const write of ["setLoadError(res.error)", "setReport(res.data);", "markLive()"]) {
    assert.ok(body.indexOf(write) > dropped, `${write} only for the newest load`);
  }
  assert.match(src, /const loading = action\.busy\("load"\);/, "the spinner is the newest load's");
  assert.doesNotMatch(src, /setLoading\(/);
});

test("health panel: the snapshot only paints an empty panel; the stale note is shown; props stay { variant }", () => {
  const src = code(HEALTH);
  const call = snapshotCall(src);
  assert.match(call, /const parsed = check\(HEALTH_REPORT, data\);\s*if \(!parsed\.ok \|\| report !== null\) return false;\s*setReport\(parsed\.value\);/, "a checked report, only over an empty panel — and a refusal says nothing was painted");
  assert.match(call, /setBase\(\(cur\) => cur \|\| parsed\.value\.webhookBase \|\| ""\)/, "an address the admin typed is kept");
  for (const setter of ["setLoadError", "setOpenSetup", "setSetup", "markLive"]) {
    assert.doesNotMatch(call, new RegExp(`\\b${setter}\\(`), `the snapshot leaves ${setter} alone`);
  }
  assert.equal(count(src, "<ArrSnapshotNote at={snapshotAt} refreshing={loading} />"), 1);
  assert.match(src, /export function ArrHealthPanel\(\{ variant \}: \{ variant: "full" \| "webhooks" \}\)/, "Arr System, Download Queue and Settings → Webhooks render it unchanged");
});

test("health panel: a setup is bounded and keyed per instance; its answer closes only its own form", () => {
  const src = code(HEALTH);
  const run = src.slice(src.indexOf("async function runSetup("), src.indexOf("const instances = report?.instances"));
  assert.match(run, /action\.run\(\s*`setup:\$\{k\}`,/, "one run per instance, through arr-call.ts's write timeout");
  assert.match(run, /arrCall\(withBasePath\("\/api\/admin\/arr-health\/webhook"\), \{[\s\S]*?schema: WEBHOOK_SETUP,\s*signal,/);
  assert.match(run, /\{ ifBusy: "skip" \}/, "a second click never sends a second setup");
  assert.match(run, /setOpenSetup\(\(cur\) => \(cur === k \? null : cur\)\);/, "another instance's form opened meanwhile stays open");
  assert.doesNotMatch(run, /setOpenSetup\(null\)/);
  assert.match(src, /setupBusy=\{action\.busy\(`setup:\$\{k\}`\)\}/);
});

test("the health panel's load does not re-run when only the translator's identity changes", () => {
  const src = readFileSync(new URL(`../${HEALTH}`, import.meta.url), "utf8");
  assert.match(src, /fallback: tRef\.current\("adminManage\.arrHealth\.loadError"\)/);
  assert.match(src, /\}, \[action, tRef, markLive\]\);/);
});
