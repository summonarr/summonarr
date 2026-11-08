// The fix-match job tray (src/components/admin/fix-match-tray.tsx), pinned
// structurally (no .tsx harness), and its pure halves
// (src/components/admin/fix-match-labels.ts) directly.
//
// Why: a non-OK read of the jobs feed (a 500 from auth or the DB) set the tray
// to an empty list, which also switched its poll off — jobs still running on
// the server (for many minutes) vanished, and their outcome was never shown.
// And reads can overlap (the 6 s poll and a job-start event): a slow older
// answer landing last rolled a finished job back to "running", or switched the
// poll off under a job that had just started. Each job is checked on its own:
// one malformed entry (no id, an unknown status) is dropped, never rendered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trayJobsFrom, trayStatusText, copyOfSuffix, fixMatchRunningLabel, formatElapsed } from "../src/components/admin/fix-match-labels.ts";

const src = readFileSync(new URL("../src/components/admin/fix-match-tray.tsx", import.meta.url), "utf8");
const refresh = src.slice(src.indexOf("const refresh = useCallback("), src.indexOf("}, [reads]);", src.indexOf("const refresh = useCallback(")));
const t = (k: string, vars?: Record<string, unknown>) => (vars ? `${k}${JSON.stringify(vars)}` : k);

test("a failed read of the feed keeps the tray and its poll: only a sign-out empties it", () => {
  assert.match(refresh, /else if \(res\.kind === "http" && \(res\.status === 401 \|\| res\.status === 403\)\) \{\s*(\/\/[^\n]*\n\s*)*next = \[\];/);
  assert.match(refresh, /\} else \{\s*(\/\/[^\n]*\n\s*)*return;\s*\}/, "any other failure returns before touching state");
  assert.match(refresh, /schema: JobsFeed/, "an answer without a job list is a failed read, not an empty one");
  assert.doesNotMatch(refresh, /\?\? \[\]/, "never defaults a failed read to no jobs");
});

test("only the latest read lands, and none after unmount", () => {
  assert.match(refresh, /const res = await reads\.run\("refresh", \(signal\) =>/, "one key: a new read aborts the one in flight");
  assert.match(refresh, /if \(!res\) return;\s*let next/, "a superseded or unmounted read applies nothing");
});

test("the poll skips a hidden tab, and coming back into view reads at once", () => {
  assert.match(src, /setInterval\(\(\) => \{ if \(!document\.hidden\) void refresh\(\); \}, hasActive \? ACTIVE_POLL_MS : IDLE_POLL_MS\)/);
  assert.match(src, /const onVisible = \(\) => \{ if \(!document\.hidden\) void refresh\(\); \};\s*window\.addEventListener\(FIX_MATCH_STARTED_EVENT, onStarted\);\s*document\.addEventListener\("visibilitychange", onVisible\);/);
});

test("with nothing active the tray still re-reads slowly, so another admin's job shows up; a refused read stops it", () => {
  const poll = src.slice(src.indexOf("// Re-read only while the tab is in view"), src.indexOf("function dismiss("));
  assert.match(src, /const IDLE_POLL_MS = 60_000;/);
  assert.doesNotMatch(poll, /if \(!hasActive\) return;/, "the poll runs with nothing active too");
  assert.match(poll, /if \(denied\) return;/);
  assert.match(refresh, /next = \[\];\s*setDenied\(true\);/, "a 401/403 stops the idle poll");
});

test("a dismissal is kept for the browser session", () => {
  assert.match(src, /sessionStorage\.setItem\(DISMISSED_KEY,/);
  assert.match(src, /const next = new Set\(prev\)\.add\(id\);\s*saveDismissed\(next\);/);
});

test("each job names its server instance", () => {
  assert.match(src, /mediaInstanceLabel\(j\.server === "jellyfin" \? "jellyfin" : "plex", j\.serverInstance \?\? ""\)/);
});

test("trayJobsFrom keeps the well-formed jobs, each id once", () => {
  const ok = { id: "a", status: "running", title: null, server: "plex", startedAt: 1, finishedAt: null };
  const jobs = trayJobsFrom([
    ok,
    { ...ok, title: "dup" },
    { id: "b", status: "exploded", title: "x", server: "plex", startedAt: 1, finishedAt: null },
    { status: "done", title: "no id", server: "plex", startedAt: 1, finishedAt: 2 },
    null,
    "junk",
    { id: "c", status: "done", title: "C", server: "jellyfin", serverInstance: "remote", startedAt: 1, finishedAt: 2, warning: "w", extra: 1 },
  ]);
  assert.deepEqual(jobs.map((j) => j.id), ["a", "c"]);
  assert.equal(jobs[0].title, null, "the first copy of an id wins");
  assert.equal("extra" in jobs[1], false);
});

test("the tray's status line: queued, running (with its copy), the server's reason, or the outcome", () => {
  const base = { id: "a", title: null, server: "plex", startedAt: 1, finishedAt: null };
  assert.equal(trayStatusText({ ...base, status: "queued", queueAhead: 2 }, t), 'adminQueue.fixMatch.queued{"ahead":2}');
  assert.equal(trayStatusText({ ...base, status: "running" }, t), "adminQueue.fixMatch.tray.running");
  assert.equal(
    trayStatusText({ ...base, status: "running", progress: { phase: "confirming", attempt: 1, attempts: 3, copy: 2, copies: 3 } }, t),
    'adminQueue.fixMatch.tray.running · adminQueue.fixMatch.copyOf{"copy":2,"copies":3}',
  );
  assert.equal(trayStatusText({ ...base, status: "failed", error: "Another fix for this item is running" }, t), "Another fix for this item is running");
  assert.equal(trayStatusText({ ...base, status: "failed" }, t), "adminQueue.fixMatch.tray.failed");
  assert.equal(trayStatusText({ ...base, status: "done", warning: "partial" }, t), "partial");
});

test("the row button's running label and the copy suffix the two share", () => {
  assert.equal(copyOfSuffix({ copies: 1 }, t), "");
  assert.equal(copyOfSuffix(null, t), "");
  const p = { phase: "confirming" as const, remoteApplied: true, attempt: 1, attempts: 3, readFailures: 0, copy: 1, copies: 2, elapsedMs: 65_000 };
  assert.equal(fixMatchRunningLabel(p, t), 'adminQueue.fixMatch.confirming{"elapsed":"1:05"} · adminQueue.fixMatch.copyOf{"copy":1,"copies":2}');
  assert.equal(fixMatchRunningLabel({ ...p, phase: "queued", remoteApplied: false, queueAhead: 0 }, t), 'adminQueue.fixMatch.queued{"ahead":0}');
  assert.equal(fixMatchRunningLabel({ ...p, remoteApplied: false }, t), "adminQueue.fixMatch.applying");
  assert.equal(fixMatchRunningLabel(null, t), "adminQueue.fixMatch.applying");
  assert.equal(formatElapsed(-5), "0:00");
});
