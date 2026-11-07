// The client half of the admin's library Resync and Initial DB Fill buttons
// (src/lib/client/library-sync.ts): one full resync per configured server,
// every instance, each a background job polled until it answers (the
// guardrail-37a pattern).
//
// Pinned: the outcome rules — no answer (status 0, or a gateway's 502/503/504
// with no error of the route's own) is never a failure; the request each
// server gets; one service's servers run one after another (the route is
// single-flight per service) while Plex and Jellyfin overlap; a start request
// that gets no answer is "no answer"; unmounting stops it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { librarySyncLabel, librarySyncOutcome, runLibrarySyncs, type LibrarySyncServer } from "../src/lib/client/library-sync.ts";

test("outcomes: no answer is never a failure; the route's own refusal is", () => {
  assert.deepEqual(librarySyncOutcome({ status: 0, data: null }), { kind: "noAnswer" });
  assert.deepEqual(librarySyncOutcome({ status: 504, data: {} }), { kind: "noAnswer" }, "a proxy's HTML 504");
  assert.deepEqual(librarySyncOutcome({ status: 502, data: null }), { kind: "noAnswer" });
  assert.deepEqual(librarySyncOutcome({ status: 503, data: { error: "Sync stopped early" } }), { kind: "failed", error: "Sync stopped early", status: 503 });
  assert.deepEqual(librarySyncOutcome({ status: 500, data: null }), { kind: "failed", error: null, status: 500 });
  assert.deepEqual(librarySyncOutcome({ status: 400, data: { error: "Plex server not configured" } }), { kind: "failed", error: "Plex server not configured", status: 400 });
  assert.deepEqual(librarySyncOutcome({ status: 404, data: { error: "gone" } }), { kind: "failed", error: "gone", status: 404 });
  assert.deepEqual(librarySyncOutcome({ status: 200, data: { skipped: true, reason: "plex sync already running" } }), { kind: "running" });
  assert.deepEqual(librarySyncOutcome({ status: 200, data: { scanned: { movies: 2, tv: 3 }, full: true } }), { kind: "synced", count: 5 });
  assert.deepEqual(librarySyncOutcome({ status: 200, data: { error: "x" } }), { kind: "failed", error: "x", status: 200 });
});

test("labels: the default server reads as the product, a named one as 'Product (Name)'", () => {
  assert.equal(librarySyncLabel({ service: "plex", slug: "", name: "Default" }), "Plex");
  assert.equal(librarySyncLabel({ service: "jellyfin", slug: "remote", name: "Cabin" }), "Jellyfin (Cabin)");
});

const PLEX: LibrarySyncServer = { service: "plex", slug: "", name: "Default" };
const PLEX_REMOTE: LibrarySyncServer = { service: "plex", slug: "remote", name: "Remote" };
const JF: LibrarySyncServer = { service: "jellyfin", slug: "", name: "Default" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const url = (service: string) => `/api/sync/${service}`;
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r)); };

test("every server gets its own full resync; a service's servers run one after another while Plex and Jellyfin overlap", async () => {
  const events: string[] = [];
  const posts: Record<string, unknown>[] = [];
  let releasePlex!: () => void;
  const plexHeld = new Promise<void>((r) => { releasePlex = r; });
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      const job = `${u.includes("plex") ? "p" : "j"}-${String(body.instance ?? "default")}`;
      events.push(`post ${job}`);
      return json({ job }, 202);
    }
    const job = new URL(u, "http://x").searchParams.get("job")!;
    if (job === "p-default") await plexHeld; // the first Plex resync is still running
    events.push(`done ${job}`);
    return json({ scanned: { movies: 1, tv: 1 }, full: true });
  }) as typeof fetch;

  const run = runLibrarySyncs([PLEX, PLEX_REMOTE, JF], { url, fetchFn, sleep: async () => {} });
  await flush();
  assert.ok(events.includes("done j-default"), `Jellyfin ran beside the held Plex resync: ${events.join(", ")}`);
  assert.ok(!events.includes("post p-remote"), "the second Plex server waits for the first");
  releasePlex();
  const results = await run;
  assert.ok(events.indexOf("post p-remote") > events.indexOf("done p-default"));
  assert.deepEqual(results?.map((r) => [librarySyncLabel(r.server), r.outcome]), [
    ["Plex", { kind: "synced", count: 2 }],
    ["Plex (Remote)", { kind: "synced", count: 2 }],
    ["Jellyfin", { kind: "synced", count: 2 }],
  ]);
  // The default server's request is the one the route has always had; a named
  // server names itself; every one is a full, background resync.
  assert.deepEqual(posts.sort((a, b) => String(a.instance).localeCompare(String(b.instance))), [
    { full: true, instance: "remote", async: true },
    { full: true, async: true },
    { full: true, async: true },
  ]);
});

test("a start request that gets no answer is 'no answer' for that server only; unmounting stops the run", async () => {
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST" && String(input).includes("plex")) throw new TypeError("Failed to fetch");
    if (init?.method === "POST") return json({ job: "j" }, 202);
    return json({ scanned: { movies: 4, tv: 0 } });
  }) as typeof fetch;
  const results = await runLibrarySyncs([PLEX, JF], { url, fetchFn, sleep: async () => {} });
  assert.deepEqual(results?.map((r) => r.outcome.kind), ["noAnswer", "synced"]);

  let alive = true;
  const gone = (async () => { alive = false; return json({ job: "x" }, 202); }) as unknown as typeof fetch;
  assert.equal(await runLibrarySyncs([JF], { url, fetchFn: gone, isAlive: () => alive, sleep: async () => {} }), null);
});
