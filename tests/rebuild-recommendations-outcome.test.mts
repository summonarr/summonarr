// The For You "Rebuild" button's reading of /api/cron/warm-recommendations
// (src/components/media/rebuild-recommendations-outcome.ts). The route answers
// 200 + `error` when SOME users failed: the other shelves — usually the
// admin's own — were rebuilt, so that is a warning and the grid refreshes.
// Only `graphFailed` means nothing changed. The server's own sentences are
// English, so they ride along as a tooltip and the visible text is translated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rebuildOutcome } from "../src/components/media/rebuild-recommendations-outcome.ts";
import type { FetchJsonResult } from "../src/lib/client/fetch-json.ts";

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const ok = (data: unknown): FetchJsonResult<unknown> => ({ ok: true, status: 200, data });
const http = (status: number, body: unknown): FetchJsonResult<unknown> => ({ ok: false, kind: "http", status, error: "", body, detail: "" });

test("a partial rebuild (200 + error, graph built) is a warning that still refreshes the grid", () => {
  const out = rebuildOutcome(ok({ error: "2 user(s) failed to warm", usersUpdated: 3, usersEligible: 5, usersFailed: 2 }), t);
  assert.equal(out.type, "warning");
  assert.equal(out.refresh, true, "the rebuilt shelves must be shown");
  assert.match(out.text, /^browse\.forYou\.rebuild\.partial /);
  assert.deepEqual(JSON.parse(out.text.slice(out.text.indexOf(" ") + 1)), { updated: 3, count: 5, failed: 2 });
  assert.equal(out.detail, "2 user(s) failed to warm", "the server's English text is a tooltip only");
});

test("a graph failure is an error, translated, and never refreshes", () => {
  const out = rebuildOutcome(ok({ error: "the recommendation graph refresh failed", graphFailed: true, usersFailed: 0 }), t);
  assert.equal(out.type, "error");
  assert.equal(out.refresh, false, "a graph-failed run changed nothing to show");
  assert.equal(out.text, "browse.forYou.rebuild.graphFailed");
});

test("a non-2xx answer is an error naming the status, and never refreshes", () => {
  const out = rebuildOutcome(http(403, { error: "Forbidden" }), t);
  assert.equal(out.type, "error");
  assert.equal(out.refresh, false);
  assert.equal(out.text, 'browse.forYou.rebuild.failed {"status":403}');
  assert.equal(out.detail, "Forbidden");
});

test("a skip (200 {skipped, reason}) is not a success that never ran, nor a failure", () => {
  const out = rebuildOutcome(ok({ skipped: true, reason: "already running" }), t);
  assert.equal(out.type, "success");
  assert.equal(out.refresh, false);
  assert.equal(out.text, "browse.forYou.rebuild.alreadyRunning", "translated, not the server's English reason");
  assert.equal(out.detail, "already running");
});

test("no answer (a proxy's page, a dropped connection) says contact was lost, not that the job failed", () => {
  for (const kind of ["network", "timeout"] as const) {
    const out = rebuildOutcome({ ok: false, kind, status: 0, error: "", body: null, detail: "" }, t);
    assert.equal(out.text, "browse.forYou.rebuild.lostContact", kind);
    assert.equal(out.refresh, false, kind);
  }
});

test("a clean run reports the counts and refreshes", () => {
  const out = rebuildOutcome(ok({ usersUpdated: 4, usersEligible: 4, usersFailed: 0, graphFailed: false }), t);
  assert.equal(out.type, "success");
  assert.equal(out.refresh, true);
  assert.equal(out.text, 'browse.forYou.rebuild.done {"updated":4,"count":4}');
});

test("a malformed 2xx body never reads as a rebuilt shelf with garbage counts", () => {
  const out = rebuildOutcome(ok({ usersUpdated: "lots" }), t);
  assert.equal(out.text, 'browse.forYou.rebuild.done {"updated":0,"count":0}');
});

test("the button waits with no client timeout and keeps a fixed accessible name", () => {
  const src = readFileSync(new URL("../src/components/media/rebuild-recommendations-button.tsx", import.meta.url), "utf8");
  assert.match(src, /timeoutMs: Infinity/);
  assert.match(src, /aria-label=\{t\("browse\.forYou\.rebuild\.label"\)\}/);
  assert.match(src, /if \(outcome\.refresh\) router\.refresh\(\);/);
});
