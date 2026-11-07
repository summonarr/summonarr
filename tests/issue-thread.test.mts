// The issue thread and the request comment thread (issue-thread.tsx,
// request-thread.tsx) and their shared view rules (src/lib/client/thread-view.ts).
//
// - A silent live-event reload that superseded the first load, then failed,
//   left the thread on "loading" for good: spinner, disabled reply box, no
//   Retry. A silent failure now keeps only a READY thread as it was.
// - scrollIntoView on every update scrolled the whole page to an inline
//   thread; only the list's own box is scrolled now, and a reader scrolled up
//   is not pulled down by someone else's message.
// - A bubble's side follows who WROTE it (authorId), not the author's role.
// - ⌘↵ submits the real form instead of passing a KeyboardEvent off as a
//   FormEvent.
//
// No React DOM here: the rules are unit-tested, the wiring pinned from source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { failedLoadState, isNearBottom, NEAR_BOTTOM_PX } from "@/lib/client/thread-view.ts";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const THREADS = ["src/components/issues/issue-thread.tsx", "src/components/requests/request-thread.tsx"];

test("a failed silent reload keeps a READY thread, and surfaces the error over a first load it superseded", () => {
  assert.equal(failedLoadState("ready", true), "ready", "a transient miss never blanks a healthy thread");
  assert.equal(failedLoadState("loading", true), "error", "the superseded first load's answer was dropped: no more spinner");
  assert.equal(failedLoadState("idle", true), "error");
  assert.equal(failedLoadState("error", true), "error");
  assert.equal(failedLoadState("ready", false), "error", "a load the viewer asked for reports its failure");
  assert.equal(failedLoadState("loading", false), "error");
});

test("near the bottom is within NEAR_BOTTOM_PX of the end of the scroll box", () => {
  assert.equal(isNearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 }), true, "at the bottom");
  assert.equal(isNearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 - NEAR_BOTTOM_PX + 1 }), true);
  assert.equal(isNearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 - NEAR_BOTTOM_PX }), false);
  assert.equal(isNearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 0 }), false, "scrolled up to read");
  assert.equal(isNearBottom({ scrollHeight: 200, clientHeight: 300, scrollTop: 0 }), true, "a list shorter than its box");
});

for (const file of THREADS) {
  test(`${file}: a failed load goes through failedLoadState, never a bare silent skip`, () => {
    const src = read(file);
    assert.match(src, /setLoadState\(\(s\) => failedLoadState\(s, silent\)\);/);
    assert.doesNotMatch(src, /if \(!silent\) setLoadState\("error"\)/);
  });

  test(`${file}: only the list's own box scrolls, and a live reload follows only a reader at the bottom`, () => {
    const src = read(file);
    assert.doesNotMatch(src, /\.scrollIntoView\(/, "scrollIntoView scrolls every scrollable ancestor, the window included");
    assert.match(src, /ref=\{listRef\}/);
    assert.match(src, /el\.scrollTo\(\{ top: el\.scrollHeight, behavior: "smooth" \}\);/);
    assert.match(src, /if \(.*!el \|\| !stickRef\.current\) return;/);
    assert.match(src, /stickRef\.current = silent && el \? isNearBottom\(el\) : true;/, "measured before the reload renders");
    assert.match(src, /stickRef\.current = true;\n\s*\/\/ (The server also|The live event)/, "the viewer's own send follows the thread");
  });

  test(`${file}: a bubble is "mine" when the viewer wrote it`, () => {
    const src = read(file);
    assert.match(src, /authorId: string;/);
    assert.match(src, /const isMine = session \? \w+\.authorId === session\.user\.id : /);
    assert.match(src, /email\?: string \| null;/, "email is only sent to managers");
  });

  test(`${file}: ⌘↵ submits the textarea's own form`, () => {
    const src = read(file);
    assert.match(src, /e\.currentTarget\.form\?\.requestSubmit\(\);/);
    assert.doesNotMatch(src, /as unknown as React\.FormEvent/);
  });
}
