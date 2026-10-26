// Watch sync, Plex ⇄ Jellyfin — the run (src/lib/watch-sync-data.ts,
// guardrail 19e). Pinned here:
//
// Plex → Jellyfin
//   1. A first run reads the WHOLE Plex history, queues every placeable play of
//      the paired account (owner "1" rewritten) and marks it with Plex's date.
//   2. An item the Jellyfin user already played is recorded "already" and never
//      POSTed (a POST with datePlayed bumps its PlayCount).
//   3. A re-run queues nothing twice (the ledger) and reads history only back to
//      the read point minus the overlap.
//   4. A failed Jellyfin lookup HOLDS the read point, so the window is re-planned.
//   5. A Plex history entry for an item THIS sync scrobbled is never a source (echo).
//
// Jellyfin → Plex
//   6. The Jellyfin user's played items are marked watched on Plex with the Plex
//      account's OWN token — a shared user's from shared_servers, a home user's
//      from the home switch, the owner's = the admin token — NEVER the admin token
//      for anyone else.
//   7. An item the Plex account already watched is "already", never scrobbled.
//   8. A Jellyfin item THIS sync marked played is never a source (echo).
//   9. No token for the account ⇒ the direction errors and nothing is scrobbled.
//  10. The pair's direction gates each side.
//
// Both: nothing ever unmarks (no DELETE / unscrobble), PlayHistory is never
// written, and an abort RETURNS (guardrail 41).
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
const ADMIN_TOKEN = "plex-admin-token";
const FRIEND_TOKEN = "friendtoken777abcd";
const HOME_TOKEN = "hometoken888abcd";
type Call = { method: string; url: URL; token: string | null; body: string | null };
let calls: Call[] = [];
let respond: (url: URL, method: string, token: string | null) => Response | Promise<Response> = (url) => { throw new Error(`unexpected fetch ${url}`); };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const token = new Headers(init?.headers).get("x-plex-token");
  calls.push({ method, url, token, body: typeof init?.body === "string" ? init.body : null });
  return respond(url, method, token);
}) as typeof fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");

const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (a: { where: { key: string } }) => (settings.has(a.where.key) ? { key: a.where.key, value: settings.get(a.where.key) } : null),
  findMany: async () => [...settings].map(([key, value]) => ({ key, value })),
});

type PairRow = { id: string; enabled: boolean; direction: string; syncProgress?: boolean; historyReadTo: Date | null; jellyfinReadTo: Date | null; lastResult?: unknown; createdAt: Date };
let pairs: PairRow[] = [];
let plexUser = { source: "plex", serverInstance: "", sourceUserId: "555", isServerAdmin: true };
const JF_USER = { source: "jellyfin", serverInstance: "", sourceUserId: "jfuser", active: true };
shadowPrismaModel(prisma, "watchSyncPair", {
  findMany: async () => pairs.filter((p) => p.enabled).map((p) => ({ ...p, plexUser, jellyfinUser: JF_USER })),
  update: async (a: { where: { id: string }; data: Partial<PairRow> }) => {
    const p = pairs.find((x) => x.id === a.where.id)!;
    Object.assign(p, a.data);
    return p;
  },
});

// One in-memory ledger stub per table, keyed by its item column.
type Mark = { pairId: string; key: string; datePlayed: Date | null; status: string; attempts: number; lastError: string | null; createdAt: number };
let seq = 0;
function ledger(col: "jellyfinItemId" | "plexRatingKey", compound: string) {
  const rows: Mark[] = [];
  const stub = {
    createMany: async (a: { data: Array<Record<string, unknown>> }) => {
      let count = 0;
      for (const d of a.data) {
        const key = d[col] as string;
        if (rows.some((m) => m.pairId === d.pairId && m.key === key)) continue;
        rows.push({ pairId: d.pairId as string, key, datePlayed: (d.datePlayed as Date | null) ?? null, status: "pending", attempts: 0, lastError: null, createdAt: seq++ });
        count++;
      }
      return { count };
    },
    findMany: async (a: { where: Record<string, unknown>; take?: number }) => {
      const w = a.where;
      if (w.status === "marked") {
        const ids = (w[col] as { in: string[] }).in;
        return rows.filter((m) => m.pairId === w.pairId && m.status === "marked" && ids.includes(m.key)).map((m) => ({ [col]: m.key }));
      }
      return rows.filter((m) => m.pairId === w.pairId && (m.status === "pending" || (m.status === "failed" && m.attempts < 5)))
        .sort((x, y) => x.createdAt - y.createdAt).slice(0, a.take).map((m) => ({ [col]: m.key, datePlayed: m.datePlayed }));
    },
    updateMany: async (a: { where: Record<string, unknown>; data: { status: string } }) => {
      const ids = (a.where[col] as { in: string[] }).in;
      let count = 0;
      for (const m of rows) if (m.pairId === a.where.pairId && ids.includes(m.key)) { m.status = a.data.status; count++; }
      return { count };
    },
    update: async (a: { where: Record<string, Record<string, string>>; data: { status: string; lastError: string } }) => {
      const k = a.where[compound];
      const m = rows.find((x) => x.pairId === k.pairId && x.key === k[col])!;
      m.status = a.data.status; m.attempts++; m.lastError = a.data.lastError;
      return m;
    },
  };
  return { rows, stub };
}
let jfLedger = ledger("jellyfinItemId", "pairId_jellyfinItemId");
let plexLedger = ledger("plexRatingKey", "pairId_plexRatingKey");
shadowPrismaModel(prisma, "watchSyncMark", new Proxy({}, { get: (_t, p) => (jfLedger.stub as Record<string | symbol, unknown>)[p] }));
shadowPrismaModel(prisma, "watchSyncPlexMark", new Proxy({}, { get: (_t, p) => (plexLedger.stub as Record<string | symbol, unknown>)[p] }));

shadowPrismaModel(prisma, "plexLibraryItem", {
  findMany: async () => [
    { tmdbId: 100, mediaType: "MOVIE", plexRatingKey: "11", plexRatingKeys: [] },
    { tmdbId: 200, mediaType: "MOVIE", plexRatingKey: "12", plexRatingKeys: ["12", "13"] },
    { tmdbId: 900, mediaType: "TV", plexRatingKey: "19", plexRatingKeys: [] },
  ],
});
let jfLibCalls = 0;
let jfLibFailOnCall = 0;
shadowPrismaModel(prisma, "jellyfinLibraryItem", {
  findMany: async () => {
    jfLibCalls++;
    if (jfLibFailOnCall && jfLibCalls === jfLibFailOnCall) throw new Error("simulated library read failure");
    return jfLibRows;
  },
});
const jfLibRows = [
    { tmdbId: 100, mediaType: "MOVIE", jellyfinItemId: "jm1", jellyfinItemIds: ["jm1"] },
    { tmdbId: 200, mediaType: "MOVIE", jellyfinItemId: "jm2", jellyfinItemIds: [] },
    { tmdbId: 900, mediaType: "TV", jellyfinItemId: "jshow", jellyfinItemIds: ["jshow"] },
];
const forbidden: string[] = [];
shadowPrismaModel(prisma, "playHistory", Object.fromEntries(
  ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"].map((m) => [m, async () => { forbidden.push(m); throw new Error("forbidden"); }]),
));

const { runWatchSync, watchSyncRunState } = await import("../src/lib/watch-sync-data.ts");
const { WATCH_SYNC_PLAN_CHUNK, WATCH_SYNC_STOPPED_MESSAGE } = await import("../src/lib/watch-sync.ts");

const S = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
let history: unknown[] = [];
let played: string[] = [];
let jfPlayed: unknown[] = [];
let plexWatched = new Set<string>();
let episodesFail = false;
let marked: string[] = [];
let scrobbled: Array<{ key: string; token: string | null }> = [];
// Resume-point fakes: per-item state on each side, and what was written.
type PlexState = { viewOffset?: number; viewCount?: number; lastViewedAt?: number; duration?: number };
type JfState = { pos?: number; played?: boolean; last?: string; run?: number };
let plexState = new Map<string, PlexState>();
let jfState = new Map<string, JfState>();
let plexDeck: string[] = [];
let jfResumable: string[] = [];
let progressWrites: Array<{ side: "plex" | "jellyfin"; id: string; ms: number; token?: string | null }> = [];
const JF_EP: Record<string, { SeriesId: string; ParentIndexNumber: number; IndexNumber: number }> = {
  je11: { SeriesId: "jshow", ParentIndexNumber: 1, IndexNumber: 1 },
  je12: { SeriesId: "jshow", ParentIndexNumber: 1, IndexNumber: 2 },
};
const PLEX_EP: Record<string, { grandparentRatingKey: string; parentIndex: number; index: number }> = {
  "191": { grandparentRatingKey: "19", parentIndex: 1, index: 1 },
  "192": { grandparentRatingKey: "19", parentIndex: 1, index: 2 },
};
const jfItem = (id: string) => {
  const st = jfState.get(id) ?? {};
  return {
    Type: JF_EP[id] ? "Episode" : "Movie", Id: id, ...(JF_EP[id] ?? {}), RunTimeTicks: (st.run ?? 6_000_000) * 10_000,
    UserData: { PlaybackPositionTicks: (st.pos ?? 0) * 10_000, Played: st.played === true, ...(st.last ? { LastPlayedDate: st.last } : {}) },
  };
};
const plexMeta = (k: string) => {
  const st = plexState.get(k) ?? {};
  return {
    ratingKey: k, type: PLEX_EP[k] ? "episode" : "movie", ...(PLEX_EP[k] ?? {}), duration: st.duration ?? 6_000_000,
    ...(plexWatched.has(k) || st.viewCount ? { viewCount: st.viewCount ?? 1 } : {}),
    ...(st.viewOffset ? { viewOffset: st.viewOffset } : {}),
    ...(st.lastViewedAt ? { lastViewedAt: st.lastViewedAt } : {}),
  };
};
const PLEX_ITEMS = new Set(["11", "12", "13", "191", "192"]);

function defaultRespond(url: URL, method: string, token: string | null): Response {
  if (url.hostname === "plex.tv") {
    if (url.pathname === "/api/v2/user") return json({ id: 555, email: "owner@example.com" });
    if (url.pathname === "/api/servers/MACHINE1/shared_servers") {
      return new Response(`<MediaContainer><SharedServer id="1" username="friend" userID="777" accessToken="${FRIEND_TOKEN}"><Section/></SharedServer></MediaContainer>`);
    }
    if (url.pathname === "/api/home/users/888/switch" && method === "POST") return new Response(`<user id="888" authenticationToken="${HOME_TOKEN}"/>`);
    return new Response("", { status: 404 });
  }
  if (url.origin === PLEX) {
    if (url.pathname === "/status/sessions/history/all") return json({ MediaContainer: { Metadata: history, totalSize: history.length, size: history.length } });
    if (url.pathname === "/identity") return json({ MediaContainer: { machineIdentifier: "MACHINE1" } });
    if (url.pathname === "/library/metadata/19/allLeaves") {
      const eps = [{ ratingKey: "191", parentIndex: 1, index: 1 }, { ratingKey: "192", parentIndex: 1, index: 2 }];
      return json({ MediaContainer: { Metadata: eps, totalSize: 2, size: 2 } });
    }
    if (url.pathname === "/library/onDeck") return json({ MediaContainer: { Metadata: plexDeck.map(plexMeta) } });
    if (url.pathname === "/:/progress") {
      const k = url.searchParams.get("key")!;
      const ms = Number(url.searchParams.get("time"));
      progressWrites.push({ side: "plex", id: k, ms, token });
      plexState.set(k, { ...(plexState.get(k) ?? {}), viewOffset: ms, lastViewedAt: Math.floor(Date.now() / 1000) });
      return new Response("");
    }
    if (url.pathname === "/:/scrobble") {
      scrobbled.push({ key: url.searchParams.get("key")!, token });
      return new Response("");
    }
    const m = /^\/library\/metadata\/([\d,]+)$/.exec(url.pathname);
    if (m) {
      const meta = m[1].split(",").filter((k) => PLEX_ITEMS.has(k)).map(plexMeta);
      return json({ MediaContainer: { Metadata: meta } });
    }
  }
  if (url.origin === JF && url.pathname === "/Items" && url.searchParams.get("ParentId") === "jshow") {
    if (episodesFail) return new Response("", { status: 503 });
    return json({ Items: [{ Id: "je11", ParentIndexNumber: 1, IndexNumber: 1 }, { Id: "je12", ParentIndexNumber: 1, IndexNumber: 2 }], TotalRecordCount: 2 });
  }
  if (url.origin === JF && url.pathname === "/Items" && url.searchParams.get("Filters") === "IsResumable") {
    return json({ Items: jfResumable.map(jfItem), TotalRecordCount: jfResumable.length });
  }
  if (url.origin === JF && url.pathname === "/Items" && url.searchParams.get("Ids")) {
    const known = new Set(["jm1", "jm2", "je11", "je12"]);
    return json({ Items: url.searchParams.get("Ids")!.split(",").filter((id) => known.has(id)).map(jfItem) });
  }
  const ud = /^\/UserItems\/([^/]+)\/UserData$/.exec(url.pathname);
  if (url.origin === JF && method === "POST" && ud) {
    const id = decodeURIComponent(ud[1]);
    const ticks = (JSON.parse(calls[calls.length - 1].body ?? "{}") as { PlaybackPositionTicks?: number }).PlaybackPositionTicks ?? 0;
    progressWrites.push({ side: "jellyfin", id, ms: ticks / 10_000 });
    jfState.set(id, { ...(jfState.get(id) ?? {}), pos: ticks / 10_000 });
    return json({});
  }
  if (url.origin === JF && url.pathname === "/Items" && url.searchParams.get("Filters") === "IsPlayed") {
    if (url.searchParams.get("SortOrder") === "Descending") return json({ Items: jfPlayed, TotalRecordCount: jfPlayed.length });
    return json({ Items: played.map((id) => ({ Type: "Movie", Id: id, UserData: { PlayCount: 1 } })), TotalRecordCount: played.length });
  }
  if (url.origin === JF && method === "POST" && url.pathname.startsWith("/UserPlayedItems/")) {
    marked.push(`${decodeURIComponent(url.pathname.split("/")[2])}@${url.searchParams.get("datePlayed")}`);
    return json({ Played: true });
  }
  throw new Error(`unexpected ${method} ${url}`);
}

const pair = (direction: string): PairRow => ({ id: "p1", enabled: true, direction, historyReadTo: null, jellyfinReadTo: null, createdAt: new Date(0) });

beforeEach(() => {
  settings.clear();
  settings.set("plexServerUrl", PLEX);
  settings.set("plexAdminToken", ADMIN_TOKEN);
  settings.set("jellyfinUrl", JF);
  settings.set("jellyfinApiKey", "jf-key");
  pairs = [pair("toJellyfin")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "555", isServerAdmin: true };
  jfLedger = ledger("jellyfinItemId", "pairId_jellyfinItemId");
  plexLedger = ledger("plexRatingKey", "pairId_plexRatingKey");
  calls = [];
  marked = [];
  scrobbled = [];
  played = [];
  jfPlayed = [];
  plexWatched = new Set();
  episodesFail = false;
  plexState = new Map();
  jfState = new Map();
  plexDeck = [];
  jfResumable = [];
  progressWrites = [];
  jfLibCalls = 0;
  jfLibFailOnCall = 0;
  respond = defaultRespond;
  history = [
    { type: "movie", ratingKey: "11", viewedAt: S("2025-02-01T10:00:00Z"), accountID: 1 },              // owner → 555
    { type: "episode", ratingKey: "31", grandparentRatingKey: "19", parentIndex: 1, index: 2, viewedAt: S("2025-01-20T10:00:00Z"), accountID: 555 },
    { type: "movie", ratingKey: "12", viewedAt: S("2025-01-10T10:00:00Z"), accountID: 555 },
    { type: "movie", ratingKey: "11", viewedAt: S("2025-01-05T10:00:00Z"), accountID: 42 },              // someone else
    { type: "episode", ratingKey: "32", grandparentRatingKey: "19", parentIndex: 0, index: 1, viewedAt: S("2025-01-04T10:00:00Z"), accountID: 555 }, // special
  ];
});

// ── Plex → Jellyfin ──────────────────────────────────────────────────────────

test("first run: whole history, the owner's '1' rewritten, every placeable play marked with Plex's date; a special is never matched", async () => {
  const r = await runWatchSync();
  assert.equal(r.aborted, false);
  const p = r.pairs[0];
  assert.equal(p.error, undefined);
  assert.equal(p.toPlex, null, "direction toJellyfin: no Plex side");
  assert.equal(p.toJellyfin?.error, undefined);
  assert.equal(p.toJellyfin?.queued, 3);
  assert.equal(p.toJellyfin?.marked, 3);
  assert.equal(p.toJellyfin?.unmatched, 1, "the special");
  assert.deepEqual(marked.sort(), [
    "je12@2025-01-20T10:00:00.000Z",
    "jm1@2025-02-01T10:00:00.000Z",
    "jm2@2025-01-10T10:00:00.000Z",
  ]);
  assert.deepEqual(pairs[0].historyReadTo, new Date("2025-02-01T10:00:00Z"));
  assert.ok(calls.every((c) => c.method !== "DELETE"), "never unmarks");
  assert.ok(!calls.some((c) => c.url.searchParams.get("SortOrder") === "Descending"), "the Jellyfin → Plex read never ran");
  assert.deepEqual(forbidden, [], "never writes PlayHistory");
});

test("an item the Jellyfin user already played is recorded 'already' and never POSTed (would bump PlayCount)", async () => {
  played = ["jm1"];
  const r = await runWatchSync();
  assert.equal(r.pairs[0].toJellyfin?.already, 1);
  assert.equal(r.pairs[0].toJellyfin?.marked, 2);
  assert.ok(!marked.some((m) => m.startsWith("jm1@")));
  assert.equal(jfLedger.rows.find((m) => m.key === "jm1")?.status, "already");
});

test("a re-run queues nothing twice and reads history only back to the read point minus the overlap", async () => {
  await runWatchSync();
  marked = [];
  calls = [];
  const r = await runWatchSync();
  assert.equal(r.pairs[0].toJellyfin?.queued, 0);
  assert.equal(r.pairs[0].toJellyfin?.marked, 0);
  assert.deepEqual(marked, []);
  assert.equal(jfLedger.rows.length, 3);
  // The incremental walk stops at the first record older than the bound (one page).
  assert.equal(calls.filter((c) => c.url.pathname === "/status/sessions/history/all").length, 1);
  assert.ok(!calls.some((c) => c.url.searchParams.get("Filters") === "IsPlayed"), "nothing to apply ⇒ no played-list read");
});

test("a failed Jellyfin episode lookup HOLDS the read point (the window is re-planned) and records the error", async () => {
  episodesFail = true;
  const r = await runWatchSync();
  assert.ok(r.pairs[0].toJellyfin?.error);
  assert.equal(pairs[0].historyReadTo, null, "read point not advanced");
  assert.equal(jfLedger.rows.length, 0, "nothing queued from a partial plan");
  episodesFail = false;
  const again = await runWatchSync();
  assert.equal(again.pairs[0].toJellyfin?.marked, 3);
});

test("the owner's plays are held (not skipped) when plex.tv can't say who the owner is", async () => {
  respond = (url, method, token) => (url.hostname === "plex.tv" ? new Response("", { status: 503 }) : defaultRespond(url, method, token));
  const r = await runWatchSync();
  assert.match(r.pairs[0].toJellyfin?.error ?? "", /owner/);
  assert.equal(pairs[0].historyReadTo, null);
});

test("ECHO: a Plex history entry for an item this sync scrobbled is never a source", async () => {
  await plexLedger.stub.createMany({ data: [{ pairId: "p1", plexRatingKey: "12", datePlayed: null }] });
  plexLedger.rows[0].status = "marked";
  const r = await runWatchSync();
  assert.equal(r.pairs[0].toJellyfin?.queued, 2, "movie 12's history entry is our own scrobble");
  assert.ok(!marked.some((m) => m.startsWith("jm2@")));
});

// ── Jellyfin → Plex ──────────────────────────────────────────────────────────

const JF_PLAYED = [
  { Type: "Movie", Id: "jm2", UserData: { Played: true, LastPlayedDate: "2025-03-02T10:00:00.0000000Z" } },
  { Type: "Episode", Id: "je11", SeriesId: "jshow", ParentIndexNumber: 1, IndexNumber: 1, UserData: { Played: true, LastPlayedDate: "2025-03-01T10:00:00.0000000Z" } },
  { Type: "Episode", Id: "je00", SeriesId: "jshow", ParentIndexNumber: 0, IndexNumber: 1, UserData: { Played: true, LastPlayedDate: "2025-02-28T10:00:00.0000000Z" } },
];

test("Jellyfin → Plex, a SHARED user: marked with their shared_servers token on every copy — never the admin token", async () => {
  pairs = [pair("toPlex")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "777", isServerAdmin: false };
  jfPlayed = JF_PLAYED;
  const r = await runWatchSync();
  const d = r.pairs[0].toPlex!;
  assert.equal(r.pairs[0].toJellyfin, null);
  assert.equal(d.error, undefined);
  assert.equal(d.queued, 3, "both copies of the movie (12, 13) and the episode (191)");
  assert.equal(d.unmatched, 1, "the special");
  assert.equal(d.marked, 3);
  assert.deepEqual(scrobbled.map((s) => s.key).sort(), ["12", "13", "191"]);
  assert.ok(scrobbled.every((s) => s.token === FRIEND_TOKEN), "scrobbled as the user");
  const userReads = calls.filter((c) => c.url.origin === PLEX && /^\/library\/metadata\/[\d,]+$/.test(c.url.pathname));
  assert.ok(userReads.length > 0 && userReads.every((c) => c.token === FRIEND_TOKEN), "played state read as the user");
  assert.deepEqual(pairs[0].jellyfinReadTo, new Date("2025-03-02T10:00:00Z"));
  assert.ok(!calls.some((c) => c.url.pathname === "/status/sessions/history/all"), "the Plex → Jellyfin read never ran");
  assert.deepEqual(forbidden, []);
});

test("Jellyfin → Plex: an item the Plex account already watched is 'already', never scrobbled; a gone item is 'missing'", async () => {
  pairs = [pair("toPlex")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "777", isServerAdmin: false };
  jfPlayed = JF_PLAYED;
  plexWatched = new Set(["12"]);
  PLEX_ITEMS.delete("13");
  try {
    const r = await runWatchSync();
    assert.equal(r.pairs[0].toPlex?.already, 1);
    assert.equal(r.pairs[0].toPlex?.missing, 1);
    assert.deepEqual(scrobbled.map((s) => s.key), ["191"]);
  } finally {
    PLEX_ITEMS.add("13");
  }
});

test("Jellyfin → Plex: a managed HOME user gets the home-switch token; the OWNER the admin token", async () => {
  pairs = [pair("toPlex")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "888", isServerAdmin: false };
  jfPlayed = JF_PLAYED.slice(0, 1);
  await runWatchSync();
  assert.ok(scrobbled.length > 0 && scrobbled.every((s) => s.token === HOME_TOKEN));

  plexLedger = ledger("plexRatingKey", "pairId_plexRatingKey");
  scrobbled = [];
  pairs = [pair("toPlex")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "555", isServerAdmin: true };
  await runWatchSync();
  assert.ok(scrobbled.length > 0 && scrobbled.every((s) => s.token === ADMIN_TOKEN));
});

test("Jellyfin → Plex: an unknown owner is not scrobbled with the admin token, even if isServerAdmin stuck on", async () => {
  pairs = [pair("toPlex")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "555", isServerAdmin: true };
  jfPlayed = JF_PLAYED.slice(0, 1);
  respond = (url, method, token) => (url.hostname === "plex.tv" ? new Response("", { status: 503 }) : defaultRespond(url, method, token));
  const r = await runWatchSync();
  assert.match(r.pairs[0].toPlex?.error ?? "", /owner/);
  assert.deepEqual(scrobbled, [], "a sticky admin flag must not borrow the current admin token");
});

test("Jellyfin → Plex: no token for the account ⇒ the direction errors and NOTHING is scrobbled (never the admin token instead)", async () => {
  pairs = [pair("toPlex")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "999", isServerAdmin: false };
  jfPlayed = JF_PLAYED;
  const r = await runWatchSync();
  assert.match(r.pairs[0].toPlex?.error ?? "", /No Plex access/);
  assert.deepEqual(scrobbled, []);
  assert.ok(plexLedger.rows.every((m) => m.status === "pending"), "kept for a later run");
});

test("ECHO: a Jellyfin item this sync marked played is never a Jellyfin → Plex source", async () => {
  pairs = [pair("toPlex")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "777", isServerAdmin: false };
  jfPlayed = JF_PLAYED;
  await jfLedger.stub.createMany({ data: [{ pairId: "p1", jellyfinItemId: "jm2", datePlayed: null }] });
  jfLedger.rows[0].status = "marked";
  const r = await runWatchSync();
  assert.equal(r.pairs[0].toPlex?.queued, 1, "only the episode — jm2 was our own mark");
  assert.deepEqual(scrobbled.map((s) => s.key), ["191"]);
});

test("Jellyfin → Plex: a re-run reads only back to the read point (stops at the first older item) and queues nothing twice", async () => {
  pairs = [pair("toPlex")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "777", isServerAdmin: false };
  jfPlayed = JF_PLAYED;
  await runWatchSync();
  scrobbled = [];
  const again = await runWatchSync();
  assert.equal(again.pairs[0].toPlex?.queued, 0);
  assert.deepEqual(scrobbled, []);
  assert.equal(plexLedger.rows.length, 3);
});

test("Jellyfin → Plex: a failed Plex episode lookup HOLDS the Jellyfin read point and queues nothing", async () => {
  pairs = [pair("toPlex")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "777", isServerAdmin: false };
  jfPlayed = JF_PLAYED;
  respond = (url, method, token) => (url.origin === PLEX && url.pathname.endsWith("/allLeaves") ? new Response("", { status: 503 }) : defaultRespond(url, method, token));
  const r = await runWatchSync();
  assert.ok(r.pairs[0].toPlex?.error);
  assert.equal(pairs[0].jellyfinReadTo, null, "read point not advanced");
  assert.equal(plexLedger.rows.length, 0, "nothing queued from a partial plan");
});

test("Jellyfin → Plex: an incremental read STOPS at the first item played before the read point minus the overlap", async () => {
  pairs = [pair("toPlex")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "777", isServerAdmin: false };
  jfPlayed = JF_PLAYED;
  await runWatchSync();
  // Newest-first list: an item played long before the read point sits after
  // the bound, so the incremental walk never reaches it.
  jfPlayed = [...JF_PLAYED, { Type: "Movie", Id: "jm1", UserData: { Played: true, LastPlayedDate: "2024-01-01T00:00:00.0000000Z" } }];
  const again = await runWatchSync();
  assert.equal(again.pairs[0].toPlex?.queued, 0, "jm1 (played in 2024) is past the bound");
  assert.ok(!plexLedger.rows.some((m) => m.key === "11"));
});

test("both ways in one run: each side marked, and a mark made this run is not echoed back the other way", async () => {
  pairs = [pair("both")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "555", isServerAdmin: true };
  jfPlayed = JF_PLAYED;
  const r = await runWatchSync();
  assert.ok(r.pairs[0].toJellyfin && r.pairs[0].toPlex);
  assert.equal(r.pairs[0].toJellyfin?.marked, 3);
  // Plex → Jellyfin runs first and marks jm2 (Plex movie 12); the Jellyfin →
  // Plex plan then reads jm2 as its own echo and skips it — only the episode
  // goes back to Plex.
  assert.equal(r.pairs[0].toPlex?.marked, 1);
  assert.deepEqual(scrobbled.map((x) => x.key), ["191"]);
  assert.ok(calls.every((c) => c.method !== "DELETE"), "never unmarks");
  assert.deepEqual(forbidden, []);
});

test("an already-aborted signal returns at once: no fetch, no write (guardrail 41)", async () => {
  pairs = [pair("both")];
  const c = new AbortController();
  c.abort();
  const r = await runWatchSync({ signal: c.signal });
  assert.equal(r.aborted, true);
  assert.equal(calls.length, 0);
  assert.equal(jfLedger.rows.length + plexLedger.rows.length, 0);
});

test("an unknown stored direction syncs NOTHING (fail closed)", async () => {
  pairs = [pair("sideways")];
  const r = await runWatchSync();
  assert.equal(r.pairs[0].toJellyfin, null);
  assert.equal(r.pairs[0].toPlex, null);
  assert.equal(calls.length, 0);
});

// ── resume points (pair.syncProgress) ────────────────────────────────────────

const progressPair = (direction: string): PairRow => ({ ...pair(direction), syncProgress: true });
const NOW_S = Math.floor(Date.now() / 1000);
const isoAgo = (s: number) => new Date((NOW_S - s) * 1000).toISOString();

test("resume points OFF (the default): no in-progress reads at all", async () => {
  pairs = [pair("both")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "777", isServerAdmin: false };
  const r = await runWatchSync();
  assert.equal(r.pairs[0].progress, null);
  assert.ok(!calls.some((c) => c.url.pathname === "/library/onDeck" || c.url.searchParams.get("Filters") === "IsResumable"));
});

test("Plex → Jellyfin resume point: 12 min on Plex lands as user data on Jellyfin (no session route), read as the user", async () => {
  pairs = [progressPair("both")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "777", isServerAdmin: false };
  plexDeck = ["12"];
  plexState.set("12", { viewOffset: 720_000, lastViewedAt: NOW_S - 60 });
  jfState.set("jm2", { pos: 0, last: isoAgo(86_400) });
  const r = await runWatchSync();
  assert.equal(r.pairs[0].progress?.error, undefined);
  assert.equal(r.pairs[0].progress?.toJellyfin, 1);
  assert.deepEqual(progressWrites, [{ side: "jellyfin", id: "jm2", ms: 720_000 }]);
  assert.ok(!calls.some((c) => /\/Sessions/.test(c.url.pathname)), "never a Jellyfin session/playing route");
  assert.ok(calls.filter((c) => c.url.pathname === "/library/onDeck").every((c) => c.token === FRIEND_TOKEN), "On Deck read as the user");
});

test("Jellyfin → Plex resume point: 30 min on Jellyfin lands on EVERY Plex copy with the user's own token", async () => {
  pairs = [progressPair("both")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "777", isServerAdmin: false };
  jfResumable = ["jm2"];
  jfState.set("jm2", { pos: 1_800_000, last: isoAgo(60) });
  plexState.set("12", { lastViewedAt: NOW_S - 86_400 });
  const r = await runWatchSync();
  assert.equal(r.pairs[0].progress?.toPlex, 1, "one title");
  assert.deepEqual(progressWrites.map((w) => [w.side, w.id, w.ms]).sort(), [["plex", "12", 1_800_000], ["plex", "13", 1_800_000]]);
  assert.ok(progressWrites.every((w) => w.token === FRIEND_TOKEN), "never the admin token");
});

test("resume points don't bounce: the run after a copy writes nothing (within tolerance, either side newer)", async () => {
  pairs = [progressPair("both")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "777", isServerAdmin: false };
  jfResumable = ["je11"];
  jfState.set("je11", { pos: 1_500_000, last: isoAgo(60) });
  await runWatchSync();
  assert.deepEqual(progressWrites.map((w) => [w.side, w.id]), [["plex", "191"]]);
  progressWrites = [];
  plexDeck = ["191"];
  const again = await runWatchSync();
  assert.deepEqual(progressWrites, [], "Plex now looks newer, but the positions match");
  assert.equal(again.pairs[0].progress?.toJellyfin, 0);
  assert.equal(again.pairs[0].progress?.toPlex, 0);
});

test("resume points: the target moved on (newer activity) or is watched ⇒ left alone; direction gates the write", async () => {
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "777", isServerAdmin: false };
  // Jellyfin played it more recently than the Plex pause: the user finished/restarted there.
  pairs = [progressPair("both")];
  plexDeck = ["12"];
  plexState.set("12", { viewOffset: 720_000, lastViewedAt: NOW_S - 86_400 });
  jfState.set("jm2", { pos: 0, last: isoAgo(60) });
  await runWatchSync();
  assert.equal(progressWrites.length, 0);
  // Watched on Jellyfin with no resume point (and older): watched beats in-progress.
  jfState.set("jm2", { pos: 0, played: true, last: isoAgo(172_800) });
  await runWatchSync();
  assert.equal(progressWrites.length, 0);
  // Plex → Jellyfin is the only direction that would write — and the pair is toPlex.
  jfState.set("jm2", { pos: 0, last: isoAgo(172_800) });
  pairs = [progressPair("toPlex")];
  await runWatchSync();
  assert.equal(progressWrites.length, 0);
  pairs = [progressPair("toJellyfin")];
  await runWatchSync();
  assert.deepEqual(progressWrites.map((w) => w.id), ["jm2"]);
});

test("resume points with no Plex token for the account: an error, and nothing written on either side", async () => {
  pairs = [progressPair("both")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "999", isServerAdmin: false };
  jfResumable = ["jm2"];
  jfState.set("jm2", { pos: 1_800_000, last: isoAgo(60) });
  const r = await runWatchSync();
  assert.match(r.pairs[0].progress?.error ?? "", /No Plex access/);
  assert.deepEqual(progressWrites, []);
});

// ── account filter, checkpoints, budget, run state ───────────────────────────

test("the Plex history read asks for the paired account only (owner = local id 1) and, incrementally, only after the read point", async () => {
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "777", isServerAdmin: false };
  await runWatchSync();
  let hist = calls.filter((c) => c.url.pathname === "/status/sessions/history/all");
  assert.equal(hist[0].url.searchParams.get("accountID"), "777");
  assert.equal(hist[0].url.searchParams.get("viewedAt>"), null, "first run: the whole history");

  calls = [];
  pairs = [pair("toJellyfin")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "555", isServerAdmin: true };
  await runWatchSync();
  hist = calls.filter((c) => c.url.pathname === "/status/sessions/history/all");
  assert.equal(hist[0].url.searchParams.get("accountID"), "1", "the owner's local account id");
  calls = [];
  await runWatchSync();
  hist = calls.filter((c) => c.url.pathname === "/status/sessions/history/all");
  const bound = Number(hist[0].url.searchParams.get("viewedAt>"));
  assert.ok(bound > 0 && bound < S("2025-02-01T10:00:00Z"), "after the read point less the overlap");
});

test("CHECKPOINT: a first run that fails mid-plan keeps every finished chunk — the read point sits at the last queued play", async () => {
  // More plays than one chunk, all resolving to movie 11 → jm1, oldest first.
  const n = WATCH_SYNC_PLAN_CHUNK + 50;
  history = Array.from({ length: n }, (_, i) => ({ type: "movie", ratingKey: "11", viewedAt: S("2025-01-01T00:00:00Z") + (n - i) * 60, accountID: 555 }));
  jfLibFailOnCall = 2; // the second chunk's Jellyfin lookup fails
  const r = await runWatchSync();
  assert.ok(r.pairs[0].toJellyfin?.error);
  const firstChunkNewest = new Date((S("2025-01-01T00:00:00Z") + WATCH_SYNC_PLAN_CHUNK * 60) * 1000);
  assert.deepEqual(pairs[0].historyReadTo, firstChunkNewest, "moved to the end of the first (oldest) chunk, no further");
  assert.equal(jfLedger.rows.length, 1, "the first chunk's mark was queued");
  // The next run resumes after the checkpoint and finishes.
  calls = [];
  const again = await runWatchSync();
  assert.equal(again.pairs[0].toJellyfin?.error, undefined);
  assert.deepEqual(pairs[0].historyReadTo, new Date((S("2025-01-01T00:00:00Z") + n * 60) * 1000));
  const bound = Number(calls.find((c) => c.url.pathname === "/status/sessions/history/all")!.url.searchParams.get("viewedAt>"));
  assert.ok(bound * 1000 < firstChunkNewest.getTime(), "re-read from the checkpoint (less the overlap), not from scratch");
});

test("BUDGET: a run that hits its time limit says so on every unfinished direction and still records the pair's result", async () => {
  pairs = [pair("both")];
  plexUser = { source: "plex", serverInstance: "", sourceUserId: "777", isServerAdmin: false };
  jfPlayed = JF_PLAYED;
  respond = async (url, method, token) => {
    await new Promise((res) => setTimeout(res, 15));
    return defaultRespond(url, method, token);
  };
  const r = await runWatchSync({ budgetMs: 5 });
  assert.equal(r.aborted, true);
  assert.equal(r.pairs[0].toJellyfin?.error, WATCH_SYNC_STOPPED_MESSAGE);
  assert.equal(r.pairs[0].toPlex?.error, WATCH_SYNC_STOPPED_MESSAGE);
  assert.ok(pairs[0].lastResult, "recorded on the pair — never a silent stop");
  assert.equal(watchSyncRunState().running, false);
});

test("RUN STATE: running (with the pair being synced) during a run, cleared after — even when it fails", async () => {
  const seen: Array<{ running: boolean; pairId: string | null }> = [];
  respond = (url, method, token) => {
    const st = watchSyncRunState();
    seen.push({ running: st.running, pairId: st.pairId });
    return defaultRespond(url, method, token);
  };
  await runWatchSync();
  assert.ok(seen.length > 0 && seen.every((x) => x.running && x.pairId === "p1"));
  assert.deepEqual(watchSyncRunState(), { running: false, startedAt: null, pairId: null });
});
