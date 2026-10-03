// The server-token half of the Plex watchlist auto-request
// (src/lib/plex-friends-watchlist.ts) — guardrail 34b.
//
// What is pinned, and why:
//   1. THE IDENTITY BRIDGE. plex.tv's community GraphQL names a friend by an id
//      believed to be the account UUID; Summonarr stores the NUMERIC account id.
//      The v2 friends list (uuid → id) bridges them; an all-digit GraphQL id is
//      taken as numeric directly; anything unbridgeable is null (counted as an
//      unmatched friend), never guessed. UNVERIFIED against a live server — the
//      fixtures below encode the believed shapes.
//   2. USER RESOLUTION ORDER: an admin's manual pin (incl. a pin to nobody) >
//      User.plexUserId > an automatic MediaServerUser link. Never email. A
//      deactivated/purged account is dropped, not fallen through.
//   3. PAGINATION + PRIVACY: the watchlist is cursor-paged; a null watchlist is
//      the friend's privacy setting ("private"), not an error.
//   4. ADMIN TOKEN 401/403 → AdminTokenRejectedError; 429 retried once.
//
// Harness: in-memory prisma stubs, dns.lookup stubbed, scripted globalThis.fetch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "plex-friends-test-secret-0123456789abcdef";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

type Call = { url: URL; method: string; token: string | null; body: unknown };
const calls: Call[] = [];
let respond: (c: Call) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch");
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  const call: Call = {
    url,
    method: init?.method ?? "GET",
    token: headers.get("x-plex-token"),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  };
  calls.push(call);
  return respond(call);
}) as typeof fetch;
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");

type Msu = { sourceUserId: string; userId: string | null; manualUserLink: boolean; source: string };
let msuRows: Msu[] = [];
type U = { id: string; plexUserId: string | null; email: string; deactivatedAt: Date | null; purgedAt: Date | null };
let userRows: U[] = [];
const userQueries: unknown[] = [];
shadowPrismaModel(prisma, "mediaServerUser", {
  findMany: async (args: { where: { source: string; sourceUserId: { in: string[] } } }) =>
    msuRows.filter((r) => r.source === args.where.source && args.where.sourceUserId.in.includes(r.sourceUserId)),
});
shadowPrismaModel(prisma, "user", {
  findMany: async (args: { where: Record<string, unknown> }) => {
    userQueries.push(args.where);
    const w = args.where as { plexUserId?: { in: string[] }; id?: { in: string[] }; deactivatedAt?: null; purgedAt?: null };
    if (w.plexUserId) return userRows.filter((u) => u.plexUserId && w.plexUserId!.in.includes(u.plexUserId));
    if (w.id) {
      return userRows.filter(
        (u) =>
          w.id!.in.includes(u.id) &&
          (!("deactivatedAt" in w) || !u.deactivatedAt) &&
          (!("purgedAt" in w) || !u.purgedAt),
      );
    }
    throw new Error(`unexpected user query ${JSON.stringify(w)}`);
  },
});

const mod = await import("../src/lib/plex-friends-watchlist.ts");

beforeEach(() => {
  calls.length = 0;
  msuRows = [];
  userRows = [];
  userQueries.length = 0;
  respond = () => { throw new Error("unexpected fetch"); };
});

// ═══ the identity bridge (pure) ═══════════════════════════════════════════════

test("parseFriendUuidMap: uuid → numeric id, tolerant of a wrapper, case-folded, junk skipped", () => {
  const m = mod.parseFriendUuidMap([
    { id: 12345, uuid: "ABCDEF0123", username: "alice" },
    { id: "678", uuid: "f00d" },
    { id: 0, uuid: "zero" },
    { id: 99, uuid: "" },
    { uuid: "noid" },
    { id: "12a", uuid: "bad" },
    null,
  ]);
  assert.deepEqual([...m.entries()].sort(), [["abcdef0123", "12345"], ["f00d", "678"]]);
  assert.deepEqual([...mod.parseFriendUuidMap({ friends: [{ id: 5, uuid: "u5" }] })], [["u5", "5"]]);
  assert.equal(mod.parseFriendUuidMap({ unexpected: true }).size, 0);
});

test("friendAccountId: an all-digit GraphQL id passes through; a uuid goes through the map; unknown is null", () => {
  const map = new Map([["abcdef0123", "12345"]]);
  assert.equal(mod.friendAccountId("4242", map), "4242", "numeric id is the account id directly");
  assert.equal(mod.friendAccountId("ABCDEF0123", map), "12345", "uuid lookup is case-insensitive");
  assert.equal(mod.friendAccountId("deadbeef", map), null, "a uuid missing from v2/friends is unmatched, never guessed");
  assert.equal(mod.friendAccountId("0", map), null);
});

test("parseAllFriends: reads allFriendsV2[].user, numeric ids stringified; a body with no list throws", () => {
  const friends = mod.parseAllFriends({
    data: { allFriendsV2: [{ user: { id: "abc", username: "alice" } }, { user: { id: 77, username: "bob" } }, { user: null }, {}] },
  });
  assert.deepEqual(friends, [{ graphId: "abc", username: "alice" }, { graphId: "77", username: "bob" }]);
  assert.throws(() => mod.parseAllFriends({ errors: [{ message: "nope" }] }), /no list: nope/);
});

test("parseWatchlistPage: nodes + cursor; a null watchlist is PRIVATE; a server-side error string throws", () => {
  const ok = mod.parseWatchlistPage({
    data: { userV2: { watchlist: { nodes: [{ id: "5d77", title: "Heat", type: "MOVIE" }, { title: "no id" }], pageInfo: { hasNextPage: true, endCursor: "c1" } } } },
  });
  assert.deepEqual(ok, { status: "ok", nodes: [{ id: "5d77", title: "Heat", type: "movie" }], hasNextPage: true, endCursor: "c1" });
  assert.deepEqual(mod.parseWatchlistPage({ data: { userV2: { watchlist: null } }, errors: [{ message: "You do not have permission" }] }), { status: "private" });
  assert.deepEqual(mod.parseWatchlistPage({ data: { userV2: null } }), { status: "private" });
  assert.throws(() => mod.parseWatchlistPage({ data: null, errors: [{ message: "Internal server error" }] }), /Internal server error/);
  // hasNextPage without a cursor cannot be followed.
  const noCursor = mod.parseWatchlistPage({ data: { userV2: { watchlist: { nodes: [], pageInfo: { hasNextPage: true } } } } });
  assert.equal(noCursor.status === "ok" && noCursor.hasNextPage, false);
});

test("parseRetryAfterMs: seconds or an HTTP date; junk is null", () => {
  assert.equal(mod.parseRetryAfterMs("3"), 3000);
  assert.equal(mod.parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000), 6_000);
  assert.equal(mod.parseRetryAfterMs("soon"), null);
  assert.equal(mod.parseRetryAfterMs(null), null);
});

// ═══ plex.tv calls ════════════════════════════════════════════════════════════

test("fetchFriendWatchlist pages by cursor with the ADMIN token and the friend's GraphQL id", async () => {
  const pages: Record<string, unknown> = {
    first: { nodes: [{ id: "a1", title: "A", type: "movie" }], pageInfo: { hasNextPage: true, endCursor: "c1" } },
    c1: { nodes: [{ id: "b2", title: "B", type: "show" }], pageInfo: { hasNextPage: false, endCursor: "c2" } },
  };
  respond = (c) => {
    assert.equal(c.url.hostname, "community.plex.tv");
    assert.equal(c.method, "POST");
    const vars = (c.body as { variables: { after: string | null } }).variables;
    return json({ data: { userV2: { watchlist: pages[vars.after ?? "first"] } } });
  };
  const r = await mod.fetchFriendWatchlist("admin-tok", "friend-uuid", { maxItems: 500 });
  assert.deepEqual(r, { status: "ok", nodes: [{ id: "a1", title: "A", type: "movie" }, { id: "b2", title: "B", type: "show" }] });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.token === "admin-tok"));
  const v0 = (calls[0].body as { variables: { user: { id: string }; first: number; after: string | null } }).variables;
  assert.deepEqual(v0, { user: { id: "friend-uuid" }, first: mod.FRIEND_WATCHLIST_PAGE_SIZE, after: null });
  assert.equal((calls[1].body as { variables: { after: string } }).variables.after, "c1");
});

test("fetchFriendWatchlist: a private watchlist is a status, not a throw", async () => {
  respond = () => json({ data: { userV2: { watchlist: null } } });
  assert.deepEqual(await mod.fetchFriendWatchlist("admin-tok", "f", { maxItems: 500 }), { status: "private" });
});

test("fetchFriendWatchlist stops at maxItems and on an aborted signal (returns, never throws)", async () => {
  let n = 0;
  respond = () => {
    n++;
    return json({ data: { userV2: { watchlist: { nodes: Array.from({ length: 100 }, (_, i) => ({ id: `k${n}x${i}`, title: "", type: "movie" })), pageInfo: { hasNextPage: true, endCursor: `c${n}` } } } } });
  };
  const capped = await mod.fetchFriendWatchlist("t", "f", { maxItems: 250 });
  assert.equal(capped.status === "ok" && capped.nodes.length, 250);
  assert.equal(calls.length, 3);
  calls.length = 0;
  const ctl = new AbortController();
  ctl.abort();
  assert.deepEqual(await mod.fetchFriendWatchlist("t", "f", { maxItems: 500, signal: ctl.signal }), { status: "ok", nodes: [] });
  assert.equal(calls.length, 0);
});

test("admin token 401/403 → AdminTokenRejectedError on every call", async () => {
  for (const status of [401, 403]) {
    respond = () => json({}, status);
    await assert.rejects(mod.fetchPlexFriends("bad"), mod.AdminTokenRejectedError);
    await assert.rejects(mod.fetchFriendUuidMap("bad"), mod.AdminTokenRejectedError);
    await assert.rejects(mod.fetchOwnerAccountId("bad"), mod.AdminTokenRejectedError);
    await assert.rejects(mod.fetchFriendWatchlist("bad", "f", { maxItems: 10 }), mod.AdminTokenRejectedError);
  }
});

test("a 429 is retried exactly once after Retry-After; a second 429 fails", async () => {
  let n = 0;
  respond = () => (++n === 1 ? json({}, 429, { "retry-after": "0" }) : json({ data: { allFriendsV2: [] } }));
  assert.deepEqual(await mod.fetchPlexFriends("t"), []);
  assert.equal(n, 2);
  n = 0;
  respond = () => { n++; return json({}, 429, { "retry-after": "0" }); };
  await assert.rejects(mod.fetchPlexFriends("t"), /429/);
  assert.equal(n, 2, "one retry at most");
  n = 0;
  respond = () => { n++; return json({}, 429, { "retry-after": String(mod.MAX_RETRY_AFTER_MS / 1000 + 60) }); };
  await assert.rejects(mod.fetchPlexFriends("t"), /429/);
  assert.equal(n, 1, "a Retry-After past the bound is not waited out");
});

test("fetchFriendUuidMap / fetchOwnerAccountId hit plex.tv v2 with the admin token", async () => {
  respond = (c) => {
    assert.equal(c.url.hostname, "plex.tv");
    if (c.url.pathname === "/api/v2/friends") return json([{ id: 9, uuid: "U9" }]);
    if (c.url.pathname === "/api/v2/user") return json({ id: 1001, uuid: "owner" });
    throw new Error(c.url.pathname);
  };
  assert.deepEqual([...(await mod.fetchFriendUuidMap("t"))], [["u9", "9"]]);
  assert.equal(await mod.fetchOwnerAccountId("t"), "1001");
});

// ═══ friend → Summonarr user ══════════════════════════════════════════════════

test("resolvePlexAccountUsers: plexUserId first, then an automatic MSU link; never by email", async () => {
  userRows = [
    { id: "u-subject", plexUserId: "100", email: "a@x", deactivatedAt: null, purgedAt: null },
    { id: "u-msu", plexUserId: null, email: "b@x", deactivatedAt: null, purgedAt: null },
    { id: "u-other", plexUserId: null, email: "c@x", deactivatedAt: null, purgedAt: null },
  ];
  msuRows = [
    { source: "plex", sourceUserId: "100", userId: "u-other", manualUserLink: false }, // loses to the subject
    { source: "plex", sourceUserId: "200", userId: "u-msu", manualUserLink: false },
    { source: "jellyfin", sourceUserId: "300", userId: "u-other", manualUserLink: false }, // wrong source
  ];
  const r = await mod.resolvePlexAccountUsers(["100", "200", "300", "400"]);
  assert.deepEqual([...r.entries()].sort(), [["100", "u-subject"], ["200", "u-msu"]]);
  // Never an email lookup: every user query is by plexUserId or by resolved id.
  for (const q of userQueries) assert.ok(!JSON.stringify(q).includes("email"), JSON.stringify(q));
});

test("resolvePlexAccountUsers: an admin's manual pin wins — pinned to nobody skips the friend even with a matching plexUserId", async () => {
  userRows = [
    { id: "u-subject", plexUserId: "100", email: "a@x", deactivatedAt: null, purgedAt: null },
    { id: "u-pinned", plexUserId: null, email: "b@x", deactivatedAt: null, purgedAt: null },
  ];
  msuRows = [
    { source: "plex", sourceUserId: "100", userId: null, manualUserLink: true },
    { source: "plex", sourceUserId: "200", userId: "u-pinned", manualUserLink: true },
    { source: "plex", sourceUserId: "200", userId: "u-subject", manualUserLink: false },
  ];
  const r = await mod.resolvePlexAccountUsers(["100", "200"]);
  assert.deepEqual([...r.entries()], [["200", "u-pinned"]]);
});

test("resolvePlexAccountUsers: deactivated/purged accounts are dropped, not fallen through; ambiguous auto links skipped", async () => {
  userRows = [
    { id: "u-off", plexUserId: "100", email: "a@x", deactivatedAt: new Date(), purgedAt: null },
    { id: "u-msu", plexUserId: null, email: "b@x", deactivatedAt: null, purgedAt: null },
    { id: "u-gone", plexUserId: null, email: "c@x", deactivatedAt: new Date(), purgedAt: new Date() },
    { id: "u-a", plexUserId: null, email: "d@x", deactivatedAt: null, purgedAt: null },
    { id: "u-b", plexUserId: null, email: "e@x", deactivatedAt: null, purgedAt: null },
  ];
  msuRows = [
    { source: "plex", sourceUserId: "100", userId: "u-msu", manualUserLink: false }, // must NOT rescue the disabled subject
    { source: "plex", sourceUserId: "200", userId: "u-gone", manualUserLink: false },
    { source: "plex", sourceUserId: "300", userId: "u-a", manualUserLink: false },
    { source: "plex", sourceUserId: "300", userId: "u-b", manualUserLink: false },
  ];
  const r = await mod.resolvePlexAccountUsers(["100", "200", "300"]);
  assert.equal(r.size, 0);
});
