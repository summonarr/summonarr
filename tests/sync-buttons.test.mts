// The library page's sync buttons (Resync libraries, Sync episodes) and the
// state they share (src/components/admin/sync-button-state.tsx): what a run's
// answer reads as, and the source pins for what a unit can't render (the suite
// has no DOM — docs/testing.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tvEpisodeJobOutcome, tvEpisodeSyncOutcome } from "../src/components/admin/tv-episode-sync-text.ts";
import type { FetchJsonResult } from "../src/lib/client/fetch-json.ts";
import type { TvEpisodeSyncAnswer } from "../src/components/admin/tv-episode-sync-text.ts";

const t = (key: string, vars?: Readonly<Record<string, string | number>>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const ok = (data: TvEpisodeSyncAnswer): FetchJsonResult<TvEpisodeSyncAnswer> => ({ ok: true, status: 200, data });
const failed = (kind: "aborted" | "timeout" | "network" | "http" | "invalid", status: number, error = ""): FetchJsonResult<TvEpisodeSyncAnswer> =>
  ({ ok: false, kind, status, error, body: null, detail: "" });

const read = (p: string) => readFileSync(new URL(`../src/components/admin/${p}`, import.meta.url), "utf8");

test("episodes: a 2xx that isn't the route's answer is a failed sync, never a successful '0 episodes'", () => {
  assert.deepEqual(tvEpisodeSyncOutcome(failed("invalid", 200), t, "en"), { status: "error", text: "adminManage.library.btn.syncFailed", refresh: false });
  assert.deepEqual(tvEpisodeSyncOutcome(failed("network", 0), t, "en"), { status: "error", text: "adminManage.library.btn.syncFailed", refresh: false });
  assert.deepEqual(tvEpisodeSyncOutcome(failed("timeout", 0), t, "en"), { status: "error", text: "adminManage.library.btn.syncFailed", refresh: false });
});

test("episodes: a refusal shows the route's reason, else the status; a dropped run applies nothing", () => {
  assert.deepEqual(tvEpisodeSyncOutcome(failed("http", 403, "Forbidden here"), t, "en"), { status: "error", text: "Forbidden here", refresh: false });
  assert.equal(tvEpisodeSyncOutcome(failed("http", 500), t, "en")?.text, 'adminManage.users.error.requestFailed {"status":500}');
  assert.equal(tvEpisodeSyncOutcome(failed("aborted", 0), t, "en"), null);
});

test("episodes: counts beside a source's error stay red, and the page refreshes only when a cache was rewritten", () => {
  const partial = tvEpisodeSyncOutcome(ok({ plex: 12345, jellyfin: 0, errors: ["Jellyfin: down"] }), t, "en");
  assert.equal(partial?.status, "error");
  assert.equal(partial?.refresh, true);
  assert.match(partial?.text ?? "", /^adminManage\.library\.btn\.episodesWithParts .*"parts":"Plex 12,345".* · Jellyfin: down$/);
  assert.deepEqual(tvEpisodeSyncOutcome(ok({ plex: 0, jellyfin: 0, errors: ["Plex: down", "Jellyfin: down"] }), t, "en"),
    { status: "error", text: "Plex: down; Jellyfin: down", refresh: false });
  assert.deepEqual(tvEpisodeSyncOutcome(ok({ plex: 0, jellyfin: 0, errors: [] }), t, "en"),
    { status: "done", text: 'adminManage.library.btn.episodes {"count":0,"formatted":"0"}', refresh: true });
  assert.equal(tvEpisodeSyncOutcome(ok({ error: "nope" }), t, "en")?.status, "error");
});

test("a run's end applies nothing once the button is gone, and reloads with refresh, never a push of the old URL", () => {
  const state = read("sync-button-state.tsx");
  const finish = state.slice(state.indexOf("const finish = useCallback("), state.indexOf("}, [later, router]);"));
  assert.ok(finish.indexOf("if (!alive.current) return;") >= 0, "finish checks the button is still mounted");
  assert.ok(finish.indexOf("if (!alive.current) return;") < finish.indexOf("router.refresh()"), "before it refreshes");
  for (const f of ["sync-button-state.tsx", "resync-library-button.tsx", "sync-tv-episodes-button.tsx"]) {
    assert.doesNotMatch(read(f), /router\.push\(/, `${f} pushes no duplicate history entry`);
  }
  for (const f of ["resync-library-button.tsx", "sync-tv-episodes-button.tsx"]) {
    assert.match(read(f), /useSyncButtonState\(\)/, `${f} shares the state`);
    assert.match(read(f), /<SyncResultText status=\{status\} result=\{result\} \/>/, `${f} shares the result line`);
    assert.doesNotMatch(read(f), /setTimeout\(|role=\{/, `${f} keeps no timer or result markup of its own`);
  }
  // The episode rebuild is a background job: polled, never one held-open
  // request, and unmounting stops the polls and drops the answer.
  const tv = read("sync-tv-episodes-button.tsx");
  assert.match(tv, /runReplaceFileJob\(fetch, withBasePath\("\/api\/sync\/tv-episodes"\), \{\}, \{/);
  assert.match(tv, /isAlive: \(\) => !signal\.aborted,/);
  assert.match(tv, /answer = await action\.run\("sync", \(signal\) =>/);
  assert.doesNotMatch(tv, /fetchJson\(/, "no held-open request");
});

test("opening the Resync confirm drops the last run's line, so Cancel never brings it back untimed", () => {
  const state = read("sync-button-state.tsx");
  const confirm = state.slice(state.indexOf("const confirm = useCallback("), state.indexOf("}, [later]);"));
  assert.match(confirm, /later\.cancel\(\);\s*setResult\(null\);\s*setStatus\("confirm"\);/);
});

test("episodes: a background run with no answer may still be running — never a failed sync", () => {
  const noAnswer = { status: "done", text: "adminManage.library.btn.episodesNoAnswer", refresh: false };
  assert.deepEqual(tvEpisodeJobOutcome({ status: 0, data: null }, t, "en"), noAnswer, "the polls failed or ran out");
  assert.deepEqual(tvEpisodeJobOutcome({ status: 504, data: {} }, t, "en"), noAnswer, "a proxy's own 504");
  assert.deepEqual(tvEpisodeJobOutcome({ status: 502, data: null }, t, "en"), noAnswer);
});

test("episodes: a background run's own answer reads exactly as the synchronous one did", () => {
  assert.deepEqual(tvEpisodeJobOutcome({ status: 200, data: { plex: 0, jellyfin: 0, errors: [], skipped: [] } }, t, "en"),
    { status: "done", text: 'adminManage.library.btn.episodes {"count":0,"formatted":"0"}', refresh: true });
  const partial = tvEpisodeJobOutcome({ status: 200, data: { plex: 12345, jellyfin: 0, errors: ["Jellyfin: down"], skipped: ["jellyfin"] } }, t, "en");
  assert.equal(partial.status, "error");
  assert.equal(partial.refresh, true);
  // The job is gone (a restart, or expired): the route's own words, in red.
  assert.deepEqual(tvEpisodeJobOutcome({ status: 404, data: { error: "That run is gone" } }, t, "en"),
    { status: "error", text: "That run is gone", refresh: false });
  assert.equal(tvEpisodeJobOutcome({ status: 500, data: null }, t, "en").text, 'adminManage.users.error.requestFailed {"status":500}');
  // A 2xx that is not the route's answer is a failed sync, never "0 episodes".
  assert.deepEqual(tvEpisodeJobOutcome({ status: 200, data: { plex: "many" } }, t, "en"),
    { status: "error", text: "adminManage.library.btn.syncFailed", refresh: false });
});
