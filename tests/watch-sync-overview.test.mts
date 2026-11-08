// The Watch Sync page's reading of its data (src/components/admin/watch-sync-overview.ts):
// the overview is checked once, each pair's direction narrowed (an unknown
// stored value syncs nothing, guardrail 19e), each stored last result read on
// its own so one odd row can't fail the page, and the Run now summary counted
// from a checked answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../src/lib/validate.ts";
import {
  OverviewSchema, directionOf, lastFor, pairLevelError, readLastResult, runSummary, toOverview, toward,
} from "../src/components/admin/watch-sync-overview.ts";

const su = (id: string) => ({ id, username: id, server: "S", active: true });
const pair = (o: Record<string, unknown> = {}) => ({
  id: "p", enabled: true, direction: "both", syncProgress: false, plex: su("x"), jellyfin: su("j"),
  historyReadTo: null, jellyfinReadTo: null, lastRunAt: null, lastResult: null, ...o,
});
const overview = (pairs: unknown[]) => ({ pairs, plexUsers: [su("x")], jellyfinUsers: [su("j")], suggestions: [], run: { running: false, startedAt: null, pairId: null }, truncated: false });

test("the overview is checked: a body without the lists is a failed load, not a render crash", () => {
  assert.ok(check(OverviewSchema, overview([pair()])).ok);
  assert.equal(check(OverviewSchema, { pairs: [] }).ok, false);
  assert.equal(check(OverviewSchema, "<html>").ok, false);
});

test("a direction is narrowed once; an unknown one syncs toward nothing", () => {
  assert.equal(directionOf("toPlex"), "toPlex");
  assert.equal(directionOf("sideways"), null);
  assert.equal(toward(null, "toJellyfin"), false);
  assert.equal(toward(null, "toPlex"), false);
  assert.equal(toward("both", "toPlex"), true);
  assert.equal(toward("toJellyfin", "toPlex"), false);
  const parsed = check(OverviewSchema, overview([pair({ direction: "sideways" })]));
  assert.ok(parsed.ok);
  assert.equal(toOverview(parsed.value).pairs[0].direction, null);
});

test("an odd stored last result reads as none instead of failing the page", () => {
  const parsed = check(OverviewSchema, overview([pair({ lastResult: { toJellyfin: { error: { nested: true } } } }), pair({ id: "q", lastResult: { marked: 2 } })]));
  assert.ok(parsed.ok, "one odd blob doesn't fail the overview");
  const [odd, flat] = toOverview(parsed.value).pairs;
  assert.equal(odd.lastResult, null);
  assert.deepEqual(flat.lastResult, { marked: 2 });
});

test("a flat (older) result is Plex → Jellyfin; a per-direction one names its own and the pair's error", () => {
  const flat = readLastResult({ marked: 1, error: "flat" });
  assert.deepEqual(lastFor(flat, "toJellyfin"), { marked: 1, error: "flat" });
  assert.equal(lastFor(flat, "toPlex"), null);
  assert.equal(pairLevelError(flat), null, "a flat result's error belongs to its direction");
  const split = readLastResult({ toJellyfin: { marked: 1 }, toPlex: null, error: "pair" });
  assert.deepEqual(lastFor(split, "toJellyfin"), { marked: 1 });
  assert.equal(lastFor(split, "toPlex"), null);
  assert.equal(pairLevelError(split), "pair");
});

test("the Run now summary counts marks and the pairs with a problem", () => {
  assert.deepEqual(runSummary({ pairs: [
    { toJellyfin: { marked: 2 }, toPlex: { marked: 1 } },
    { toJellyfin: { marked: 1, failed: 1 }, toPlex: null },
    { error: "stopped", toJellyfin: null, toPlex: null },
    { toPlex: { error: "boom" } },
  ] }), { marked: 4, problems: 3 });
  assert.deepEqual(runSummary(null), { marked: 0, problems: 0 });
  assert.deepEqual(runSummary({ ok: true }), { marked: 0, problems: 0 });
});
