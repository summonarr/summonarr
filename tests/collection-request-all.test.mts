// The collection "Request all" button (src/components/media/collection-request-all.tsx)
// against the bulk route it posts to. A "use client" JSX module Node can't
// import, so these are source pins, the idiom of detail-action-state.test.mts.
//
//   - One chunk cap, shared: the button chunked by a hand-copied 50 that had to
//     match the route's MAX_ITEMS; a lower server cap would 400 every chunk.
//   - Permanently declined titles are left out (the route skips them on every
//     click, and the button offered them again on every visit), and the
//     per-item `results` are read so the line says how many can't be requested.
//   - The outcome is announced (a live region), not just painted, and it stays
//     on screen after the refresh that empties the "missing" list.
//   - A 2xx whose body can't be read is an unknown outcome (refresh, never
//     "Requested 0 of N"); a chunk with no answer still refreshes.
//
// The chunking and the outcome line are collection-request.ts, driven here
// with a scripted fetch; the button (a .tsx module) is pinned by source.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BULK_REQUEST_MAX_ITEMS } from "../src/lib/request-limits.ts";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const src = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
const BUTTON = src("src/components/media/collection-request-all.tsx");
const LOGIC = src("src/components/media/collection-request.ts");
const ROUTE = src("src/app/api/requests/bulk/route.ts");

test("the button and the bulk route share one chunk cap", () => {
  assert.equal(BULK_REQUEST_MAX_ITEMS, 50, "the iOS app and other clients rely on the 50-item cap");
  for (const [name, body] of [["button", LOGIC], ["route", ROUTE]] as const) {
    assert.match(body, /import \{ BULK_REQUEST_MAX_ITEMS \} from "@\/lib\/request-limits";/, name);
    assert.doesNotMatch(body, /MAX_ITEMS = \d/, `${name}: a private numeric copy of the cap`);
  }
  assert.match(LOGIC, /payload\.slice\(i, i \+ BULK_REQUEST_MAX_ITEMS\)/);
  assert.match(ROUTE, /body\.items\.length > MAX_ITEMS/);
});

test("permanently declined titles are not counted or sent", () => {
  assert.match(LOGIC, /!declined\.has\(`\$\{m\.mediaType\}:\$\{m\.id\}`\)/);
  const row = src("src/components/media/collection-row.tsx");
  assert.match(row, /declinedKeys=\{declinedKeys\}/);
  const page = src("src/app/(app)/movie/[id]/page.tsx");
  assert.match(page, /permanentlyDeclinedKeys\(rawCollection, session\.user\.id\)/);
  assert.match(page, /declinedKeys=\{collectionDeclined\}/);
});

test("the per-item results are read and the unrequestable ones reported", () => {
  assert.match(LOGIC, /for \(const r of res\.data\.results \?\? \[\]\)/);
  assert.match(LOGIC, /request\.collection\.doneSkipped/);
  // Only outcomes that mean "this title can't be requested" — not the
  // already-* ones (nothing to do) and not created/auto-approved.
  const set = /const UNREQUESTABLE = new Set<string>\(\[([^\]]*)\] satisfies/.exec(LOGIC);
  assert.ok(set);
  const members = set[1].split(",").map((m) => m.trim().replace(/"/g, ""));
  assert.deepEqual(members.sort(), ["blacklisted", "no-permission", "rating-blocked", "skipped-declined"]);
});

test("the outcome line sits in an always-mounted live region", () => {
  const region = /<span className="sr-only" role="status">\s*\{showMsg \? msg : ""\}\s*<\/span>/.exec(BUTTON);
  assert.ok(region, "an always-mounted role=status region carries the message");
});

test("the outcome survives the refresh that empties the list", () => {
  assert.match(BUTTON, /if \(!canRequest \|\| \(missing\.length === 0 && result === null\)\) return null;/);
});

// ── behaviour, with a scripted fetch ─────────────────────────────────────────

let posts: unknown[] = [];
let answers: Array<() => Response> = [];
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  posts.push(JSON.parse(String(init?.body)));
  const next = answers.shift();
  assert.ok(next, "unexpected POST");
  return next();
}) as typeof fetch;
const lib = await import("../src/components/media/collection-request.ts");
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ""}`;
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ tmdbId: i + 1, mediaType: "MOVIE" as const }));
const run = (n: number) =>
  lib.requestInChunks(items(n), (chunk) => lib.postBulkChunk(chunk, new AbortController().signal, "wrong"));

beforeEach(() => {
  posts = [];
  answers = [];
});

test("chunks of the shared cap, summed, with the unrequestable ones counted", async () => {
  answers = [
    () => json(201, { created: 49, results: [{ result: "blacklisted" }] }),
    () => json(201, { created: 10, results: [{ result: "already-requested" }, { result: "no-permission" }] }),
  ];
  const s = await run(BULK_REQUEST_MAX_ITEMS + 12);
  assert.deepEqual(posts.map((p) => (p as { items: unknown[] }).items.length), [BULK_REQUEST_MAX_ITEMS, 12]);
  assert.deepEqual({ sent: s.sent, created: s.created, unrequestable: s.unrequestable, stopped: s.stopped }, { sent: 62, created: 59, unrequestable: 2, stopped: null });
  assert.deepEqual(lib.collectionRequestOutcome(s, t), {
    state: "done",
    message: 'request.collection.doneSkipped{"created":59,"total":62,"skipped":2}',
    refresh: true,
  });
});

test("titles the route failed on are reported as an error, not a done line", async () => {
  answers = [() => json(201, { created: 3, results: [{ result: "error" }, { result: "error" }, { result: "created" }] })];
  const s = await run(5);
  assert.equal(s.failed, 2);
  assert.deepEqual(lib.collectionRequestOutcome(s, t), {
    state: "error",
    message: 'request.collection.someFailed{"created":3,"total":5,"failed":2}',
    refresh: true,
  });
});

test("an unreadable 2xx is an unknown outcome, never 'Requested 0 of N'", async () => {
  for (const answer of [() => new Response("", { status: 201 }), () => json(201, { results: [] }), () => new Response("<html>", { status: 200 })]) {
    answers = [answer];
    const s = await run(3);
    assert.equal(s.unreadable, true);
    const out = lib.collectionRequestOutcome(s, t);
    assert.equal(out.message, 'request.collection.doneUnknown{"total":3}');
    assert.equal(out.refresh, true);
  }
});

test("a refused chunk stops the run; a partial one still refreshes for what was created", async () => {
  answers = [() => json(400, { error: "Too many items" })];
  const first = await run(3);
  assert.deepEqual(lib.collectionRequestOutcome(first, t), { state: "error", message: "Too many items", refresh: false });

  answers = [() => json(201, { created: 50 }), () => json(429, { error: "Slow down" })];
  const partial = await run(BULK_REQUEST_MAX_ITEMS + 1);
  assert.deepEqual(lib.collectionRequestOutcome(partial, t), {
    state: "error",
    message: 'request.collection.partial{"created":50,"total":51,"reason":"Slow down"}',
    refresh: true,
  });
});

test("no answer refreshes too: the route may have run the chunk", async () => {
  answers = [() => { throw new TypeError("offline"); }];
  const s = await run(2);
  assert.deepEqual(s.stopped, { kind: "no-answer" });
  assert.deepEqual(lib.collectionRequestOutcome(s, t), { state: "error", message: "request.networkError", refresh: true });
  answers = [() => new Response("<html>bad gateway</html>", { status: 502 })];
  assert.deepEqual((await run(2)).stopped, { kind: "no-answer" });
});

test("the titles sent skip available, own-requested, blacklisted and declined ones", () => {
  const base = { title: "x", overview: "", posterPath: null, backdropPath: null, releaseDate: null, releaseYear: null, voteAverage: 0 };
  const list = [
    { ...base, id: 1, mediaType: "movie" as const },
    { ...base, id: 2, mediaType: "movie" as const, plexAvailable: true },
    { ...base, id: 3, mediaType: "movie" as const, requestedByMe: true },
    { ...base, id: 4, mediaType: "movie" as const, blacklisted: true },
    { ...base, id: 5, mediaType: "movie" as const },
    { ...base, id: 6, mediaType: "tv" as const, requested: true },
  ];
  assert.deepEqual(lib.missingFromCollection(list, ["movie:5"]).map((m) => m.id), [1, 6]);
  assert.deepEqual(lib.toBulkItem(list[5]), { tmdbId: 6, mediaType: "TV" });
});
