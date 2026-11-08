// The "before" cursor of the request-comment and issue-message thread reads,
// the merge rules the thread components apply to a reload and to a "load older"
// page, and the download-name reader the JSON export uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { olderThanWhere, parseThreadCursor, threadCursorOf } from "../src/lib/thread-cursor.ts";
import { mergeThreadReload, prependOlder } from "../src/lib/client/thread-view.ts";
import { filenameFromDisposition } from "../src/lib/client/blob-download.ts";

const at = "2026-10-01T12:00:00.000Z";

test("a cursor round-trips through its string form", () => {
  const raw = threadCursorOf({ createdAt: at, id: "c9" });
  assert.equal(raw, `${at}|c9`);
  const parsed = parseThreadCursor(raw);
  assert.equal(parsed?.id, "c9");
  assert.equal(parsed?.createdAt.toISOString(), at);
  assert.equal(threadCursorOf({ createdAt: new Date(at), id: "c9" }), raw);
});

test("an absent or malformed cursor reads as the first page", () => {
  for (const raw of [null, "", "nobar", "|id", `${at}|`, "not-a-date|id"]) {
    assert.equal(parseThreadCursor(raw), null, String(raw));
    assert.deepEqual(olderThanWhere(parseThreadCursor(raw)), {});
  }
});

test("the where-fragment is a strict keyset on (createdAt, id)", () => {
  const cursor = parseThreadCursor(`${at}|c9`)!;
  assert.deepEqual(olderThanWhere(cursor), {
    OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: "c9" } }],
  });
});

const m = (id: string, createdAt: string) => ({ id, createdAt });

test("a reload keeps older messages already loaded, and the viewer's pending sends", () => {
  const older = m("a", "2026-01-01T00:00:00Z");
  const b = m("b", "2026-01-02T00:00:00Z");
  const c = m("c", "2026-01-03T00:00:00Z");
  const mine = m("mine", "2026-01-04T00:00:00Z");
  assert.deepEqual(mergeThreadReload([b, c], [older, b], new Set()).map((x) => x.id), ["a", "b", "c"]);
  assert.deepEqual(mergeThreadReload([b, c], [older, b, mine], new Set(["mine"])).map((x) => x.id), ["a", "b", "c", "mine"]);
  // A message newer than the list's first that the list lacks is dropped.
  assert.deepEqual(mergeThreadReload([b], [c], new Set()).map((x) => x.id), ["b"]);
  // Nothing to keep: the list itself is the answer.
  const list = [b, c];
  assert.equal(mergeThreadReload(list, [b], new Set()), list);
});

test("an older page joins the top and never repeats a shown message", () => {
  const a = m("a", "2026-01-01T00:00:00Z");
  const b = m("b", "2026-01-02T00:00:00Z");
  const c = m("c", "2026-01-03T00:00:00Z");
  assert.deepEqual(prependOlder([c], [a, b]).map((x) => x.id), ["a", "b", "c"]);
  assert.deepEqual(prependOlder([b, c], [a, b]).map((x) => x.id), ["a", "b", "c"]);
  const shown = [b, c];
  assert.equal(prependOlder(shown, [b]), shown);
});

test("the download name comes from Content-Disposition, reduced to a bare file name", () => {
  assert.equal(filenameFromDisposition('attachment; filename="play-history-2026.json"', "x.json"), "play-history-2026.json");
  assert.equal(filenameFromDisposition("attachment; filename=a%20b.json", "x.json"), "a b.json");
  assert.equal(filenameFromDisposition('attachment; filename="../../etc/passwd"', "x.json"), "passwd");
  assert.equal(filenameFromDisposition(null, "x.json"), "x.json");
  assert.equal(filenameFromDisposition("attachment", "x.json"), "x.json");
});
