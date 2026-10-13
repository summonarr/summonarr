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
const HEALTH = "src/components/admin/arr-health-panel.tsx";

test("queue: the live fetch and the snapshot read name the same url, built in one place", () => {
  const src = code(QUEUE);
  assert.equal(count(src, 'const queueUrl = () => withBasePath("/api/admin/queue");'), 1, "one builder");
  assert.equal(count(src, '"/api/admin/queue"'), 1, "the path appears only in the builder");
  assert.match(loadBody(src), /await fetch\(queueUrl\(\)\)/, "the live load fetches the builder's url");
  assert.match(snapshotCall(src), /^useArrSnapshot<QueueReport>\(configured \? queueUrl\(\) : null,/, "the snapshot reads the builder's url, none while not configured");
});

test("queue: markLive runs only for an ACCEPTED live answer — after the load gate, in the success branch", () => {
  const body = loadBody(code(QUEUE));
  assert.equal(count(body, "markLive()"), 1);
  const gate = body.indexOf("if (!gate.settle(id)) return;");
  assert.ok(gate >= 0, "the load gate");
  const success = body.indexOf('if ("report" in next)');
  assert.ok(success > gate, "the success branch follows the gate");
  const branch = blockAfter(body, success);
  assert.match(branch, /setReport\(next\.report\);[\s\S]*markLive\(\);/, "markLive is in the accepted-live branch, after the report is set");
  assert.ok(body.indexOf("markLive()") > gate, "never before the gate (a superseded load is not live for this view)");
  assert.doesNotMatch(body.slice(body.indexOf("{", success) + branch.length), /markLive/, "never on the error branch");
  assert.match(code(QUEUE), /\}, \[gate, t, markLive\]\);/, "load's deps carry markLive");
});

test("queue: the snapshot only paints an empty page and touches nothing but the report", () => {
  const call = snapshotCall(code(QUEUE));
  assert.match(call, /setReport\(\(cur\) => cur \?\? data\)/, "never replaces rows on screen (live, or a removal's optimistic drop)");
  for (const setter of ["setError", "setNotice", "setRemoving", "setImporting", "setManaging", "setActing", "setRemoveBusy", "setExpanded", "setFilter", "setQuery", "setTitleFilter"]) {
    assert.doesNotMatch(call, new RegExp(`\\b${setter}\\(`), `the snapshot leaves ${setter} alone`);
  }
});

test("queue: the stale note is shown beside the refresh controls, wired to the live-loading flag", () => {
  const src = code(QUEUE);
  assert.equal(count(src, "<ArrSnapshotNote at={snapshotAt} refreshing={loading} />"), 1);
  assert.match(src, /const \{ staleAt: snapshotAt, markLive \} = useArrSnapshot</);
  // Polling is unchanged: the interval still loads as a poll.
  assert.match(src, /void load\("poll"\)/);
});

test("health panel: the live fetch and the snapshot read name the same url, built in one place", () => {
  const src = code(HEALTH);
  assert.equal(count(src, 'const healthUrl = () => withBasePath("/api/admin/arr-health");'), 1, "one builder");
  assert.equal(count(src, '"/api/admin/arr-health"'), 1, "the path appears only in the builder");
  assert.match(loadBody(src), /await fetch\(healthUrl\(\)\)/);
  assert.match(snapshotCall(src), /^useArrSnapshot<HealthReport>\(healthUrl\(\),/);
});

test("health panel: markLive runs only after a live report was accepted, never for a failure", () => {
  const body = loadBody(code(HEALTH));
  assert.equal(count(body, "markLive()"), 1);
  const refused = body.indexOf("if (!res.ok || !data)");
  assert.ok(refused >= 0);
  const refusedBlock = blockAfter(body, refused);
  assert.doesNotMatch(refusedBlock, /markLive/, "not for a refused read");
  const accepted = body.indexOf("setReport(data);");
  assert.ok(accepted > body.indexOf("{", refused) + refusedBlock.length - 1, "the report is set after the refusal check");
  assert.ok(body.indexOf("markLive()") > accepted, "markLive follows the accepted report");
  const catchAt = body.indexOf("catch");
  assert.ok(catchAt > body.indexOf("markLive()"), "markLive is in the try, before the catch");
  assert.match(code(HEALTH), /\}, \[t, markLive\]\);/, "load's deps carry markLive");
});

test("health panel: the snapshot only paints an empty panel; the stale note is shown; props stay { variant }", () => {
  const src = code(HEALTH);
  const call = snapshotCall(src);
  assert.match(call, /setReport\(\(cur\) => cur \?\? data\)/);
  assert.match(call, /setBase\(\(cur\) => cur \|\| data\.webhookBase \|\| ""\)/, "an address the admin typed is kept");
  for (const setter of ["setLoadError", "setOpenSetup", "setSetup", "setLoading"]) {
    assert.doesNotMatch(call, new RegExp(`\\b${setter}\\(`), `the snapshot leaves ${setter} alone`);
  }
  assert.equal(count(src, "<ArrSnapshotNote at={snapshotAt} refreshing={loading} />"), 1);
  assert.match(src, /export function ArrHealthPanel\(\{ variant \}: \{ variant: "full" \| "webhooks" \}\)/, "Arr System, Download Queue and Settings → Webhooks render it unchanged");
});
