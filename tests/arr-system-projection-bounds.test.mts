// Arr System's projections over an upstream list are linear AND bounded,
// whatever the arr sends (guardrail 5i): the command list, the indexers and
// download clients, Test All's results and a provider's validation failures.
// arrFetch caps a response only by size (50 MB), and these run synchronously on
// the one event loop — from the Tasks tab's 15 s poll, its snapshot refresh and
// cancelCommand's lookup.
//
// Pinned without timing: each keeps at most its exported cap, READS at most
// its bound of the raw list (a Proxy counts element reads), and dedupes ids
// through a Set (first seen wins). A list of failures longer than the read
// bound is never "warnings only" — that verdict lets an accepted save skip the
// arr's own test.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../src/lib/arr-system.ts";

const BIG = 100_000;

function counted<V>(arr: V[]): { list: V[]; reads: () => number } {
  let n = 0;
  const list = new Proxy(arr, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) n++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { list, reads: () => n };
}

/** How many elements Array.prototype search methods were asked to scan while `fn` ran. */
function searchVisits(fn: () => void): number {
  const proto = Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const names = ["some", "find", "findIndex", "includes", "indexOf"] as const;
  const originals = names.map((name) => proto[name]);
  let visits = 0;
  names.forEach((name, i) => {
    const original = originals[i];
    proto[name] = function (this: unknown[], ...args: unknown[]) {
      visits += this.length;
      return original.apply(this, args);
    };
  });
  try {
    fn();
  } finally {
    names.forEach((name, i) => {
      proto[name] = originals[i];
    });
  }
  return visits;
}

const command = (id: number, status = "completed") => ({ id, name: "RssSync", commandName: "Rss Sync", status, queued: "2026-10-01T10:00:00Z" });
const indexer = (id: number) => ({ id, name: `Indexer ${id}`, implementationName: "Newznab", protocol: "usenet", priority: 25, enableRss: true, fields: [{ name: "apiKey", value: "secret" }] });
const client = (id: number) => ({ id, name: `Client ${id}`, implementationName: "SABnzbd", protocol: "usenet", priority: 1, enable: true });
const testAll = (id: number) => ({ id, isValid: true, validationFailures: [] });

test("projectCommands reads at most MAX_COMMANDS_READ of the list — a fixed bound, also for cancelCommand's unlimited lookup", () => {
  assert.equal(S.MAX_COMMANDS_READ, (S.MAX_ACTIVE_COMMANDS + S.MAX_COMMANDS) * S.PROJECTION_SCAN_FACTOR);
  for (const limit of [S.MAX_COMMANDS, Number.MAX_SAFE_INTEGER]) {
    const { list, reads } = counted(Array.from({ length: BIG }, (_, i) => command(i + 1, "started")));
    const rows = S.projectCommands(list, limit);
    assert.ok(reads() <= S.MAX_COMMANDS_READ, `limit ${limit}: read ${reads()}`);
    assert.ok(rows.length <= S.MAX_COMMANDS_READ);
  }
  // Still: active ones first and never cut by the finished cap; finished ones capped.
  const mixed = [...Array.from({ length: 50 }, (_, i) => command(i + 1)), command(999, "queued"), command(998, "started")];
  const rows = S.projectCommands(mixed);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.status).sort(), ["queued", "started"]);
  assert.equal(rows.length, 2 + S.MAX_COMMANDS);
});

test("projectCommands dedupes ids through a Set: a repeated id keeps its first entry", () => {
  const rows = S.projectCommands([command(5, "queued"), command(5, "completed"), command(6)]);
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [[5, "queued"], [6, "completed"]]);
  // A status is looked up in the seven-word vocabulary per entry; a scan of the
  // kept list per entry would be ~125,000 visits here.
  const raw = Array.from({ length: 500 }, (_, i) => command(i + 1));
  const visits = searchVisits(() => S.projectCommands(raw));
  assert.ok(visits <= raw.length * 10, `searched ${visits} elements`);
});

for (const [name, project, make] of [
  ["projectIndexers", S.projectIndexers, indexer],
  ["projectDownloadClients", S.projectDownloadClients, client],
  ["projectTestAll", S.projectTestAll, testAll],
] as const) {
  test(`${name} keeps at most MAX_PROVIDERS of 100k, reads a bounded prefix, and dedupes ids through a Set`, () => {
    const many = counted(Array.from({ length: BIG }, (_, i) => make(i + 1)));
    assert.equal(project(many.list).length, S.MAX_PROVIDERS);
    assert.ok(many.reads() <= S.MAX_PROVIDERS * S.PROJECTION_SCAN_FACTOR, `read ${many.reads()}`);
    const dupes = counted(Array.from({ length: BIG }, () => make(7)));
    assert.equal(project(dupes.list).length, 1, "a repeated id is one entry");
    assert.ok(dupes.reads() <= S.MAX_PROVIDERS * S.PROJECTION_SCAN_FACTOR, `read ${dupes.reads()} duplicates`);
    const junk = counted(Array.from({ length: BIG }, () => null));
    assert.equal(project(junk.list).length, 0);
    assert.ok(junk.reads() <= S.MAX_PROVIDERS * S.PROJECTION_SCAN_FACTOR, `read ${junk.reads()} junk entries`);
    const raw = Array.from({ length: S.MAX_PROVIDERS }, (_, i) => make(i + 1));
    assert.ok(searchVisits(() => project(raw)) <= raw.length * 2, "no per-entry scan of the kept list");
  });
}

test("projectIndexers still never projects `fields`", () => {
  const [ix] = S.projectIndexers([indexer(3)]);
  assert.ok(!JSON.stringify(ix).includes("secret"));
});

test("projectFailures reads a bounded prefix, and a list cut there is never 'warnings only' (an error may sit past the cut)", () => {
  const warning = { isWarning: true, errorMessage: "No results" };
  const { list, reads } = counted(Array.from({ length: BIG }, () => warning));
  const failures = S.projectFailures(list);
  assert.ok(reads() <= S.MAX_VALIDATION_FAILURES_READ, `read ${reads()}`);
  assert.equal(failures.warningsOnly, false, "unread entries could be errors");
  assert.equal(failures.uncertain, false);
  assert.deepEqual(failures.messages, ["No results"]);
  // Within the bound nothing changes: all warnings is "warnings only".
  const fit = Array.from({ length: S.MAX_VALIDATION_FAILURES_READ }, () => warning);
  assert.equal(S.projectFailures(fit).warningsOnly, true);
  // Test All's unflagged failures: uncertain within the bound, never past it.
  const unflagged = { errorMessage: "Unable to connect" };
  assert.equal(S.projectFailures(Array.from({ length: 3 }, () => unflagged), "unknown").uncertain, true);
  assert.equal(S.projectFailures(Array.from({ length: S.MAX_VALIDATION_FAILURES_READ + 1 }, () => unflagged), "unknown").uncertain, false);
  // A save refused with a huge warnings-only list is not a warnings prompt.
  assert.equal(S.validationFailuresFromBody(JSON.stringify(Array.from({ length: 1_000 }, () => warning))).warningsOnly, false);
});
