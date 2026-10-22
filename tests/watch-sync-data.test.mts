// Watch sync, Plex → Jellyfin — the run (src/lib/watch-sync-data.ts,
// guardrail 19e). Pinned here:
//   1. A first run reads the WHOLE Plex history, queues every placeable play of
//      the paired account (owner "1" rewritten) and marks it with Plex's date.
//   2. An item the Jellyfin user already played is recorded "already" and never
//      POSTed (a POST with datePlayed bumps its PlayCount).
//   3. A re-run queues nothing twice (the ledger) and reads history only back to
//      the read point minus the overlap.
//   4. A failed Jellyfin lookup HOLDS the read point, so the window is re-planned.
//   5. Nothing ever asks Jellyfin to unmark (DELETE), and PlayHistory is never written.
//   6. An abort RETURNS (guardrail 41).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "watch-sync-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

// plex.tv goes through safeFetchTrusted (DNS-checked): answer a PUBLIC address.
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");
console.warn = () => {};
console.error = () => {};

const PLEX = "http://10.81.0.1:32400";
const JF = "http://10.82.0.1:8096";
type Call = { method: string; url: URL };
let calls: Call[] = [];
let respond: (url: URL, method: string) => Response | Promise<Response> = (url) => { throw new Error(`unexpected fetch ${url}`); };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  calls.push({ method, url });
  return respond(url, method);
}) as typeof fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");

const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (a: { where: { key: string } }) => (settings.has(a.where.key) ? { key: a.where.key, value: settings.get(a.where.key) } : null),
  findMany: async () => [...settings].map(([key, value]) => ({ key, value })),
});

type PairRow = { id: string; enabled: boolean; historyReadTo: Date | null; lastResult?: unknown; createdAt: Date };
let pairs: PairRow[] = [];
const PLEX_USER = { source: "plex", serverInstance: "", sourceUserId: "555", isServerAdmin: true };
const JF_USER = { source: "jellyfin", serverInstance: "", sourceUserId: "jfuser", active: true };
shadowPrismaModel(prisma, "watchSyncPair", {
  findMany: async () => pairs.filter((p) => p.enabled).map((p) => ({ ...p, plexUser: PLEX_USER, jellyfinUser: JF_USER })),
  update: async (a: { where: { id: string }; data: Partial<PairRow> }) => {
    const p = pairs.find((x) => x.id === a.where.id)!;
    Object.assign(p, a.data);
    return p;
  },
});

type Mark = { pairId: string; jellyfinItemId: string; datePlayed: Date | null; status: string; attempts: number; lastError: string | null; createdAt: number };
let marks: Mark[] = [];
let seq = 0;
shadowPrismaModel(prisma, "watchSyncMark", {
  createMany: async (a: { data: Array<{ pairId: string; jellyfinItemId: string; datePlayed: Date | null }> }) => {
    let count = 0;
    for (const d of a.data) {
      if (marks.some((m) => m.pairId === d.pairId && m.jellyfinItemId === d.jellyfinItemId)) continue;
      marks.push({ ...d, status: "pending", attempts: 0, lastError: null, createdAt: seq++ });
      count++;
    }
    return { count };
  },
  findMany: async (a: { where: { pairId: string }; take: number }) =>
    marks.filter((m) => m.pairId === a.where.pairId && (m.status === "pending" || (m.status === "failed" && m.attempts < 5)))
      .sort((x, y) => x.createdAt - y.createdAt).slice(0, a.take),
  updateMany: async (a: { where: { pairId: string; jellyfinItemId: { in: string[] } }; data: { status: string } }) => {
    let count = 0;
    for (const m of marks) if (m.pairId === a.where.pairId && a.where.jellyfinItemId.in.includes(m.jellyfinItemId)) { m.status = a.data.status; count++; }
    return { count };
  },
  update: async (a: { where: { pairId_jellyfinItemId: { pairId: string; jellyfinItemId: string } }; data: { status: string; lastError: string } }) => {
    const m = marks.find((x) => x.pairId === a.where.pairId_jellyfinItemId.pairId && x.jellyfinItemId === a.where.pairId_jellyfinItemId.jellyfinItemId)!;
    m.status = a.data.status; m.attempts++; m.lastError = a.data.lastError;
    return m;
  },
});

shadowPrismaModel(prisma, "plexLibraryItem", {
  findMany: async () => [
    { tmdbId: 100, mediaType: "MOVIE", plexRatingKey: "11", plexRatingKeys: [] },
    { tmdbId: 200, mediaType: "MOVIE", plexRatingKey: "12", plexRatingKeys: [] },
    { tmdbId: 900, mediaType: "TV", plexRatingKey: "19", plexRatingKeys: [] },
  ],
});
shadowPrismaModel(prisma, "jellyfinLibraryItem", {
  findMany: async () => [
    { tmdbId: 100, mediaType: "MOVIE", jellyfinItemId: "jm1", jellyfinItemIds: ["jm1"] },
    { tmdbId: 200, mediaType: "MOVIE", jellyfinItemId: "jm2", jellyfinItemIds: [] },
    { tmdbId: 900, mediaType: "TV", jellyfinItemId: "jshow", jellyfinItemIds: ["jshow"] },
  ],
});
const forbidden: string[] = [];
shadowPrismaModel(prisma, "playHistory", Object.fromEntries(
  ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"].map((m) => [m, async () => { forbidden.push(m); throw new Error("forbidden"); }]),
));

const { runWatchSync } = await import("../src/lib/watch-sync-data.ts");

const S = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
let history: unknown[] = [];
let played: string[] = [];
let episodesFail = false;
let marked: string[] = [];

function defaultRespond(url: URL, method: string): Response {
  if (url.hostname === "plex.tv") return json({ id: 555, email: "owner@example.com" });
  if (url.origin === PLEX && url.pathname === "/status/sessions/history/all") {
    return json({ MediaContainer: { Metadata: history, totalSize: history.length, size: history.length } });
  }
  if (url.origin === JF && url.pathname === "/Items" && url.searchParams.get("ParentId") === "jshow") {
    if (episodesFail) return new Response("", { status: 503 });
    return json({ Items: [{ Id: "je11", ParentIndexNumber: 1, IndexNumber: 1 }, { Id: "je12", ParentIndexNumber: 1, IndexNumber: 2 }], TotalRecordCount: 2 });
  }
  if (url.origin === JF && url.pathname === "/Items" && url.searchParams.get("Filters") === "IsPlayed") {
    return json({ Items: played.map((id) => ({ Type: "Movie", Id: id, UserData: { PlayCount: 1 } })), TotalRecordCount: played.length });
  }
  if (url.origin === JF && method === "POST" && url.pathname.startsWith("/UserPlayedItems/")) {
    marked.push(`${decodeURIComponent(url.pathname.split("/")[2])}@${url.searchParams.get("datePlayed")}`);
    return json({ Played: true });
  }
  throw new Error(`unexpected ${method} ${url}`);
}

beforeEach(() => {
  settings.clear();
  settings.set("plexServerUrl", PLEX);
  settings.set("plexAdminToken", "plex-token");
  settings.set("jellyfinUrl", JF);
  settings.set("jellyfinApiKey", "jf-key");
  pairs = [{ id: "p1", enabled: true, historyReadTo: null, createdAt: new Date(0) }];
  marks = [];
  calls = [];
  marked = [];
  played = [];
  episodesFail = false;
  respond = defaultRespond;
  history = [
    { type: "movie", ratingKey: "11", viewedAt: S("2025-02-01T10:00:00Z"), accountID: 1 },              // owner → 555
    { type: "episode", ratingKey: "31", grandparentRatingKey: "19", parentIndex: 1, index: 2, viewedAt: S("2025-01-20T10:00:00Z"), accountID: 555 },
    { type: "movie", ratingKey: "12", viewedAt: S("2025-01-10T10:00:00Z"), accountID: 555 },
    { type: "movie", ratingKey: "11", viewedAt: S("2025-01-05T10:00:00Z"), accountID: 42 },              // someone else
    { type: "episode", ratingKey: "32", grandparentRatingKey: "19", parentIndex: 0, index: 1, viewedAt: S("2025-01-04T10:00:00Z"), accountID: 555 }, // special
  ];
});

test("first run: whole history, the owner's '1' rewritten, every placeable play marked with Plex's date; a special is never matched", async () => {
  const r = await runWatchSync();
  assert.equal(r.aborted, false);
  const p = r.pairs[0];
  assert.equal(p.error, undefined);
  assert.equal(p.queued, 3);
  assert.equal(p.marked, 3);
  assert.equal(p.unmatched, 1, "the special");
  assert.deepEqual(marked.sort(), [
    "je12@2025-01-20T10:00:00.000Z",
    "jm1@2025-02-01T10:00:00.000Z",
    "jm2@2025-01-10T10:00:00.000Z",
  ]);
  assert.deepEqual(pairs[0].historyReadTo, new Date("2025-02-01T10:00:00Z"));
  assert.ok(calls.every((c) => c.method !== "DELETE"), "never unmarks");
  assert.deepEqual(forbidden, [], "never writes PlayHistory");
});

test("an item the Jellyfin user already played is recorded 'already' and never POSTed (would bump PlayCount)", async () => {
  played = ["jm1"];
  const r = await runWatchSync();
  assert.equal(r.pairs[0].already, 1);
  assert.equal(r.pairs[0].marked, 2);
  assert.ok(!marked.some((m) => m.startsWith("jm1@")));
  assert.equal(marks.find((m) => m.jellyfinItemId === "jm1")?.status, "already");
});

test("a re-run queues nothing twice and reads history only back to the read point minus the overlap", async () => {
  await runWatchSync();
  marked = [];
  calls = [];
  const r = await runWatchSync();
  assert.equal(r.pairs[0].queued, 0);
  assert.equal(r.pairs[0].marked, 0);
  assert.deepEqual(marked, []);
  assert.equal(marks.length, 3);
  // The incremental walk stops at the first record older than the bound (one page).
  assert.equal(calls.filter((c) => c.url.pathname === "/status/sessions/history/all").length, 1);
  assert.ok(!calls.some((c) => c.url.searchParams.get("Filters") === "IsPlayed"), "nothing to apply ⇒ no played-list read");
});

test("a failed Jellyfin episode lookup HOLDS the read point (the window is re-planned) and records the error", async () => {
  episodesFail = true;
  const r = await runWatchSync();
  assert.ok(r.pairs[0].error);
  assert.equal(pairs[0].historyReadTo, null, "read point not advanced");
  assert.equal(marks.length, 0, "nothing queued from a partial plan");
  episodesFail = false;
  const again = await runWatchSync();
  assert.equal(again.pairs[0].marked, 3);
});

test("the owner's plays are held (not skipped) when plex.tv can't say who the owner is", async () => {
  respond = (url, method) => (url.hostname === "plex.tv" ? new Response("", { status: 503 }) : defaultRespond(url, method));
  const r = await runWatchSync();
  assert.match(r.pairs[0].error ?? "", /owner/);
  assert.equal(pairs[0].historyReadTo, null);
});

test("an already-aborted signal returns at once: no fetch, no write (guardrail 41)", async () => {
  const c = new AbortController();
  c.abort();
  const r = await runWatchSync({ signal: c.signal });
  assert.equal(r.aborted, true);
  assert.equal(calls.length, 0);
  assert.equal(marks.length, 0);
});
