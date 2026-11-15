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
import { failedLoadState, isNearBottom, mergeThreadReload, NEAR_BOTTOM_PX } from "@/lib/client/thread-view.ts";
import { mergeReload, readComment, readComments } from "../src/components/requests/request-thread-data.ts";

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
    // The request thread checks the comment shape in its data module.
    const shape = file.endsWith("request-thread.tsx") ? read("src/components/requests/request-thread-data.ts") : src;
    assert.match(shape, /authorId: (string;|v\.string\(\),)/);
    assert.match(src, /const isMine = session \? \w+\.authorId === session\.user\.id : /);
    assert.match(shape, /email(\?: string \| null;|: v\.optional\(v\.nullable\(v\.string\(\)\)\))/, "email is only sent to managers");
  });

  test(`${file}: ⌘↵ submits the textarea's own form`, () => {
    const src = read(file);
    assert.match(src, /e\.currentTarget\.form\?\.requestSubmit\(\);/);
    assert.doesNotMatch(src, /as unknown as React\.FormEvent/);
  });
}

test("issue thread: the reply box stays focusable while sending (read-only, never disabled by a send), and focus returns after it", () => {
  const src = read("src/components/issues/issue-thread.tsx");
  assert.match(src, /readOnly=\{sending\}/);
  assert.match(src, /disabled=\{loadState !== "ready"\}/, "only an unloaded thread disables it");
  assert.doesNotMatch(src, /disabled=\{sending \|\|[^}]*\}\s*className="flex-1 resize-none/);
  assert.match(src, /setBody\(""\);[\s\S]{0,300}textareaRef\.current\?\.focus\(\);/);
});

test("request thread: a reload that misses the viewer's own new comment keeps it; malformed entries are dropped", () => {
  const mk = (id: string) => ({
    id, createdAt: "2026-01-01T00:00:00Z", body: id, fromAdmin: false, authorId: "u",
    author: { name: "A", role: "USER" },
  });
  const a = mk("a"), b = mk("b"), mine = mk("mine");
  // A reload sent before the POST committed: the list lacks the new comment.
  assert.deepEqual(mergeReload([a, b], [a, mine], new Set(["mine"])).map((c) => c.id), ["a", "b", "mine"]);
  // Once a list holds it, the list is the answer.
  assert.deepEqual(mergeReload([a, mine], [a, mine], new Set()).map((c) => c.id), ["a", "mine"]);
  // Only locally appended ids and older loaded comments are carried over: a
  // comment the list doesn't hold that sorts AFTER its first one is dropped.
  assert.deepEqual(mergeReload([a], [b], new Set()).map((c) => c.id), ["a"]);
  assert.deepEqual(mergeReload([b], [a], new Set()).map((c) => c.id), ["a", "b"], "older loaded comments stay");
  assert.deepEqual(readComments([a, { id: "x" }, "junk", { ...b, author: null }]).map((c) => c.id), ["a"]);
  assert.equal(readComment({ ...a, body: 5 }), null);
  assert.deepEqual(readComment({ ...a, extra: 1 }), a);
  const src = read("src/components/requests/request-thread.tsx");
  assert.match(src, /pendingRef\.current\.add\(created\.id\);/);
  assert.match(src, /setComments\(\(prev\) => mergeReload\(list, prev, pending\)\);/);
  assert.doesNotMatch(src, /comments\.length \+ 1/, "no count read from a stale closure");
});

test("issue thread: live events while a reload is out cost one more read, not one each", () => {
  const src = read("src/components/issues/issue-thread.tsx");
  assert.match(src, /if \(live\.running\) \{\s*live\.again = true;\s*return;\s*\}/);
  assert.match(src, /\} while \(live\.again && !lifeRef\.current\?\.signal\.aborted\);/);
});

test("the issue thread skips the live re-read for a message it already shows, and the reply route names the message", () => {
  const thread = read("src/components/issues/issue-thread.tsx");
  assert.match(thread, /if \(event\.messageId && shownIdsRef\.current\.has\(event\.messageId\)\) return;\s*liveReload\(\);/);
  assert.match(thread, /shownIdsRef\.current = new Set\(messages\.map\(\(m\) => m\.id\)\);/);
  assert.match(read("src/app/api/issues/[id]/messages/route.ts"), /emitSSE\(\{ type: "issuemessage:created", issueId: id, messageId: message\.id, userId: issue\.reportedBy \}\);/);
});

test("both threads load older messages from the oldest one shown, and read whether more remain from X-Truncated", () => {
  for (const file of ["src/components/issues/issue-thread.tsx", "src/components/requests/request-thread.tsx"]) {
    const src = read(file);
    assert.match(src, /threadCursorOf\(oldest\)/, file);
    assert.match(src, /res\.headers\.get\(TRUNCATED_HEADER\) === "true"/, file);
    assert.match(src, /prependOlder\(prev, /, file);
  }
});

test("request thread: the reply box stays focusable while sending (read-only, never disabled by a send), and focus returns after it", () => {
  const src = read("src/components/requests/request-thread.tsx");
  assert.match(src, /readOnly=\{sending\}/);
  assert.match(src, /disabled=\{loadState !== "ready"\}\s*className="flex-1 resize-none/, "only an unloaded thread disables it");
  assert.doesNotMatch(src, /disabled=\{sending \|\|[^}]*\}\s*className="flex-1 resize-none/);
  assert.match(src, /pendingRef\.current\.add\(created\.id\);[\s\S]{0,500}textareaRef\.current\?\.focus\(\);/);
});

test("request thread: a 2xx that isn't the comment clears the draft and re-reads, never inviting a second send", () => {
  const src = read("src/components/requests/request-thread.tsx");
  const start = src.indexOf("async function send(");
  const body = src.slice(start, src.indexOf("function onKeyDown(", start));
  const invalid = body.slice(body.indexOf("if (!created) {"), body.indexOf("stickRef.current = true;"));
  // The refused / unanswered branch keeps the text and shows why.
  assert.match(invalid, /if \(!res\.ok && res\.kind !== "invalid"\) \{\s*setSendError\([^;]*;\s*return;\s*\}/);
  // The saved-but-unreadable branch: draft gone, thread re-read, no error.
  const saved = invalid.slice(invalid.indexOf("return;") + 7);
  assert.match(saved, /setBody\(""\);\s*void load\(undefined, \{ silent: true \}\);\s*return;/);
  assert.doesNotMatch(saved, /setSendError/);
});

test("both threads announce a failed send to a screen reader", () => {
  for (const file of THREADS) {
    assert.match(read(file), /\{sendError && \(?\s*<p role="alert"/, file);
  }
});

test("issue thread: a reload that misses the viewer's own new message keeps it", () => {
  const src = read("src/components/issues/issue-thread.tsx");
  assert.match(src, /pendingRef\.current\.add\(msg\.id\);\s*setMessages\(\(prev\) => \(prev\.some/);
  assert.match(src, /for \(const m of res\.data\) pendingRef\.current\.delete\(m\.id\);\s*const pending = new Set\(pendingRef\.current\);\s*setMessages\(\(prev\) => mergeThreadReload\(res\.data, prev, pending\)\);/);
  assert.doesNotMatch(src, /NO_PENDING/);
  // The shared rule the two threads now both feed.
  const mk = (id: string, createdAt: string) => ({ id, createdAt });
  const a = mk("a", "2026-01-01T00:00:00Z"), mine = mk("mine", "2026-01-01T00:00:05Z");
  assert.deepEqual(mergeThreadReload([a], [a, mine], new Set(["mine"])).map((m) => m.id), ["a", "mine"]);
  assert.deepEqual(mergeThreadReload([a], [a, mine], new Set()).map((m) => m.id), ["a"], "without the pending id the message is lost");
});
