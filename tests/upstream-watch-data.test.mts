// The upstream watch-record snapshot job (src/lib/upstream-watch-data.ts). The
// never-watched report and the cleanup rules read its rows as evidence that a
// title WAS watched before they offer it for deletion, so the guarantees pinned
// here are the ones whose failure deletes a watched title:
//
//   1. A SUCCESSFUL fetch replaces exactly that server's rows: one transaction, a
//      deleteMany scoped to (source, serverInstance), then the rows (guardrails
//      4/13/35). Other servers' rows are untouched.
//   2. A FAILED server keeps its previous rows (a partial or empty snapshot would
//      drop evidence) and records ok:false with the previous fetchedAt and counts
//      preserved; the error is short and carries no URL or token.
//   3. Servers are isolated: one failing never stops another.
//   4. An abort mid-run RETURNS without writing the server in progress — no rows,
//      no status — and reaches no later server (guardrail 41).
//   5. The job never writes PlayHistory or ActiveSession (guardrail 19).
//   6. An unconfigured server is skipped: no fetch, no status (guardrail 36).
//   7. The self-check: matched (rows landing on a library title of THIS server,
//      either key column), samples/agreed (Summonarr's own completed plays in the
//      window vs the server's raw item keys) — and the unhealthy states are logged
//      once per condition (guardrail 7b).
//
// Harness: in-memory prisma stubs (shadowPrismaModel), a staged-commit
// $transaction, and a scripted globalThis.fetch on RFC1918 IP literals (admin-
// configured hosts; IP literals skip DNS). No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "upstream-watch-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = () => {};

// ── scripted upstreams ───────────────────────────────────────────────────────
const PLEX = "http://10.71.0.1:32400";
const PLEX_REMOTE = "http://10.71.0.2:32400";
const JF = "http://10.72.0.1:8096";
type Call = { origin: string; path: string; params: URLSearchParams };
let calls: Call[] = [];
let respond: (url: URL) => Response | Promise<Response> = (url) => {
  throw new Error(`unexpected fetch ${url}`);
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  calls.push({ origin: url.origin, path: url.pathname, params: url.searchParams });
  return respond(url);
}) as typeof fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const plexPage = (metadata: unknown[]) => json({ MediaContainer: { Metadata: metadata, totalSize: metadata.length, size: metadata.length } });

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { resetLogDedup } = await import("../src/lib/log-dedup.ts");
const { BATCH_TX_TIMEOUT } = await import("../src/lib/cron-auth.ts");

// ── settings ─────────────────────────────────────────────────────────────────
const settings = new Map<string, string>();
let settingUpsertFails = false;
let statusWrites: string[] = [];
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  upsert: async (args: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
    if (settingUpsertFails) throw new Error("simulated setting write failure");
    statusWrites.push(args.where.key);
    settings.set(args.where.key, args.update.value);
    return { key: args.where.key, value: args.update.value };
  },
});
const status = (source: string, instance: string) => {
  const raw = settings.get(`upstreamWatch:status:${source}:${instance}`);
  return raw ? JSON.parse(raw) : null;
};

// ── library ──────────────────────────────────────────────────────────────────
type PlexLib = { mediaType: string; serverInstance: string; plexRatingKey: string | null; plexRatingKeys: string[] };
type JfLib = { mediaType: string; serverInstance: string; jellyfinItemId: string | null; jellyfinItemIds: string[] };
let plexLib: PlexLib[] = [];
let jfLib: JfLib[] = [];
shadowPrismaModel(prisma, "plexLibraryItem", {
  findMany: async (args: { where: { serverInstance: string } }) => plexLib.filter((r) => r.serverInstance === args.where.serverInstance),
});
shadowPrismaModel(prisma, "jellyfinLibraryItem", {
  findMany: async (args: { where: { serverInstance: string } }) => jfLib.filter((r) => r.serverInstance === args.where.serverInstance),
});

// ── play history (read-only for this job) ────────────────────────────────────
type Play = { source: string; serverInstance: string; completed: boolean; startedAt: Date; sourceItemId: string | null };
let plays: Play[] = [];
let historyWheres: Array<Record<string, unknown>> = [];
const forbidden: string[] = [];
const forbid = (model: string) => Object.fromEntries(
  ["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"].map((m) => [
    m,
    async () => {
      forbidden.push(`${model}.${m}`);
      throw new Error(`${model}.${m} must never be called by the upstream-watch job`);
    },
  ]),
);
shadowPrismaModel(prisma, "playHistory", {
  ...forbid("playHistory"),
  findMany: async (args: { where: { source: string; serverInstance: string; completed: boolean; startedAt: { gte: Date }; sourceItemId: { not: null } }; distinct?: string[] }) => {
    historyWheres.push(args.where as unknown as Record<string, unknown>);
    const w = args.where;
    const hits = plays.filter((p) =>
      p.source === w.source && p.serverInstance === w.serverInstance && p.completed === w.completed &&
      p.startedAt >= w.startedAt.gte && p.sourceItemId !== null);
    const seen = new Set<string>();
    return hits.filter((p) => (seen.has(p.sourceItemId!) ? false : (seen.add(p.sourceItemId!), true))).map((p) => ({ sourceItemId: p.sourceItemId }));
  },
});
shadowPrismaModel(prisma, "activeSession", { ...forbid("activeSession"), findMany: async () => [] });

// ── evidence + a staged-commit transaction ───────────────────────────────────
type Ev = { source: string; serverInstance: string; itemKey: string; seasonNumber: number; mediaType: string; playCount: number; lastPlayedAt: Date | null; fetchedAt: Date };
let evidence: Ev[] = [];
let txLog: Array<{ opts: unknown; ops: string[] }> = [];
let createManyFails = false;
// Runs when a transaction locks a registry row — a test removes an instance here
// to play a removal that commits while the refresh was reading.
let onRegistryLock: ((key: string) => void | Promise<void>) | null = null;
shadowPrismaModel(prisma, "upstreamWatchEvidence", {
  // Outside a transaction these are forbidden: the replace must be atomic.
  deleteMany: async () => { forbidden.push("upstreamWatchEvidence.deleteMany (outside tx)"); return { count: 0 }; },
  createMany: async () => { forbidden.push("upstreamWatchEvidence.createMany (outside tx)"); return { count: 0 }; },
  findMany: async () => evidence,
});
shadowPrismaClientMethod(prisma, "$transaction", async (fn: unknown, opts: unknown) => {
  if (typeof fn !== "function") throw new Error("only interactive transactions are expected");
  const entry = { opts, ops: [] as string[] };
  txLog.push(entry);
  let staged = [...evidence];
  const stagedSettings = new Map<string, string>();
  const tx = {
    // The registry-row lock stillRegisteredInTx takes: SELECT "value" … FOR UPDATE.
    $queryRaw: async (q: { sql?: string; values?: unknown[] }) => {
      const key = String(q.values?.[0]);
      entry.ops.push(`lock ${key}${/FOR UPDATE/.test(q.sql ?? "") ? "" : " (NOT FOR UPDATE)"}`);
      await onRegistryLock?.(key);
      const v = settings.get(key);
      return v === undefined ? [] : [{ value: v }];
    },
    setting: {
      upsert: async (args: { where: { key: string }; update: { value: string } }) => {
        entry.ops.push(`upsert ${args.where.key}`);
        if (settingUpsertFails) throw new Error("simulated setting write failure");
        stagedSettings.set(args.where.key, args.update.value);
        return { key: args.where.key, value: args.update.value };
      },
    },
    upstreamWatchEvidence: {
      deleteMany: async (args: { where: { source: string; serverInstance: string } }) => {
        entry.ops.push(`deleteMany ${JSON.stringify(args.where)}`);
        const before = staged.length;
        staged = staged.filter((e) => !(e.source === args.where.source && e.serverInstance === args.where.serverInstance));
        return { count: before - staged.length };
      },
      createMany: async (args: { data: Ev[]; skipDuplicates?: boolean }) => {
        entry.ops.push(`createMany ${args.data.length}`);
        if (createManyFails) throw new Error("simulated insert failure");
        staged.push(...args.data);
        return { count: args.data.length };
      },
    },
  };
  const out = await (fn as (t: unknown) => Promise<unknown>)(tx);
  evidence = staged; // commit only when the callback resolved
  for (const [k, v] of stagedSettings) { statusWrites.push(k); settings.set(k, v); }
  return out;
});

const { refreshUpstreamWatch, upstreamRefreshProblems, upstreamServerReserve, upstreamServerShare, UPSTREAM_RUN_BUDGET_MS, UPSTREAM_SERVER_RESERVE_MS } = await import("../src/lib/upstream-watch-data.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");

// ── fixtures ─────────────────────────────────────────────────────────────────
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

function configurePlex(instance = "", url = PLEX) {
  const seg = instance ? instance[0].toUpperCase() + instance.slice(1) : "";
  settings.set(`plex${seg}ServerUrl`, url);
  settings.set(`plex${seg}AdminToken`, `token-${instance || "default"}`);
}
function configureJellyfin(url = JF) {
  settings.set("jellyfinUrl", url);
  settings.set("jellyfinApiKey", "jf-key");
}
const oldRow = (source: string, serverInstance: string, itemKey = "old"): Ev => ({
  source, serverInstance, itemKey, seasonNumber: -1, mediaType: "MOVIE", playCount: 1, lastPlayedAt: null, fetchedAt: new Date("2025-01-01T00:00:00.000Z"),
});

// The default Plex history used by most tests: 2 views of movie 100, two
// episodes of show 500 (one with grandparentRatingKey, one only grandparentKey),
// a movie not in this server's library, and a music track.
function plexHistory() {
  return [
    { type: "movie", ratingKey: "100", viewedAt: secs(ago(5)), accountID: 1 },
    { type: "movie", ratingKey: "100", viewedAt: secs(ago(10)), accountID: 2 },
    { type: "episode", ratingKey: "501", grandparentRatingKey: "500", parentIndex: 1, index: 1, viewedAt: secs(ago(6)), accountID: 1 },
    { type: "episode", ratingKey: "502", grandparentKey: "/library/metadata/500", parentIndex: 2, index: 1, viewedAt: secs(ago(7)), accountID: 1 },
    { type: "movie", ratingKey: "999", viewedAt: secs(ago(8)), accountID: 3 },
    { type: "track", ratingKey: "3000", viewedAt: secs(ago(1)), accountID: 1 },
  ];
}

beforeEach(() => {
  settings.clear();
  invalidateFeatureFlagCache();
  resetLogDedup();
  calls = [];
  warns.length = 0;
  statusWrites = [];
  historyWheres = [];
  txLog = [];
  evidence = [];
  forbidden.length = 0;
  settingUpsertFails = false;
  createManyFails = false;
  onRegistryLock = null;
  plexLib = [
    { mediaType: "MOVIE", serverInstance: "", plexRatingKey: "100", plexRatingKeys: [] },
    // The show's canonical key is 450; 500 is a duplicate copy's key — matched
    // only through the array column (guardrail 37c).
    { mediaType: "TV", serverInstance: "", plexRatingKey: "450", plexRatingKeys: ["450", "500"] },
    // 999 is in ANOTHER server's library — must not count as matched here.
    { mediaType: "MOVIE", serverInstance: "remote", plexRatingKey: "999", plexRatingKeys: [] },
  ];
  jfLib = [];
  plays = [];
  respond = (url) => {
    throw new Error(`unexpected fetch ${url}`);
  };
});

// ── 1: success ───────────────────────────────────────────────────────────────

test("plex success: ONE transaction — a deleteMany scoped to (plex, '') then the rows; movie → own key at -1, episode → show key + season", async () => {
  configurePlex();
  evidence = [oldRow("plex", ""), oldRow("plex", "remote"), oldRow("jellyfin", "")];
  respond = (url) => {
    assert.equal(url.origin, PLEX);
    assert.equal(url.pathname, "/status/sessions/history/all");
    return plexPage(plexHistory());
  };
  const result = await refreshUpstreamWatch();
  assert.equal(result.aborted, false);

  assert.equal(txLog.length, 1, "one transaction per server");
  assert.deepEqual((txLog[0].opts as { timeout?: number }).timeout, BATCH_TX_TIMEOUT);
  assert.deepEqual(txLog[0].ops, [`deleteMany ${JSON.stringify({ source: "plex", serverInstance: "" })}`, "createMany 4"]);

  const mine = evidence.filter((e) => e.source === "plex" && e.serverInstance === "");
  const byKey = new Map(mine.map((e) => [`${e.itemKey}/${e.seasonNumber}`, e]));
  assert.deepEqual([...byKey.keys()].sort(), ["100/-1", "500/1", "500/2", "999/-1"], "the old row is gone, replaced by the snapshot");
  assert.equal(byKey.get("100/-1")!.mediaType, "MOVIE");
  assert.equal(byKey.get("100/-1")!.playCount, 2);
  assert.equal(byKey.get("500/1")!.mediaType, "TV");
  assert.equal(byKey.get("500/2")!.mediaType, "TV", "grandparentKey fallback places the episode on its show");
  assert.ok(evidence.some((e) => e.source === "plex" && e.serverInstance === "remote" && e.itemKey === "old"), "another server's rows are untouched");
  assert.ok(evidence.some((e) => e.source === "jellyfin" && e.itemKey === "old"), "another source's rows are untouched");

  const s = status("plex", "");
  assert.equal(s.ok, true);
  assert.equal(s.entries, 5, "the music track is not a watch record");
  assert.equal(s.matched, 3, "999 is only in ANOTHER server's library; 500 matches through plexRatingKeys");
  assert.equal(s.error, null);
  assert.equal(s.fetchedAt, s.attemptedAt);
  assert.deepEqual(new Date(mine[0].fetchedAt).toISOString(), s.fetchedAt, "rows and status carry the same fetchedAt");
  assert.deepEqual(result.servers, [{ source: "plex", instance: "", ok: true, entries: 5, matched: 3, samples: 0, agreed: 0, error: null, health: "ok" }]);
  assert.deepEqual(forbidden, []);
});

test("agreement: samples are Summonarr's completed plays on THIS server since the earliest record Plex returned; agreed counts the item's OWN keys", async () => {
  configurePlex();
  respond = () => plexPage(plexHistory());
  plays = [
    { source: "plex", serverInstance: "", completed: true, startedAt: ago(5), sourceItemId: "100" }, // movie: agrees
    { source: "plex", serverInstance: "", completed: true, startedAt: ago(6), sourceItemId: "501" }, // episode's own key: agrees
    { source: "plex", serverInstance: "", completed: true, startedAt: ago(4), sourceItemId: "777" }, // Plex doesn't have it
    { source: "plex", serverInstance: "", completed: false, startedAt: ago(4), sourceItemId: "888" }, // not completed
    { source: "plex", serverInstance: "", completed: true, startedAt: ago(20), sourceItemId: "889" }, // before Plex's reach (10 days)
    { source: "plex", serverInstance: "remote", completed: true, startedAt: ago(3), sourceItemId: "890" }, // other server
    { source: "jellyfin", serverInstance: "", completed: true, startedAt: ago(3), sourceItemId: "891" }, // other source
  ];
  await refreshUpstreamWatch();
  const s = status("plex", "");
  assert.equal(s.samples, 3);
  assert.equal(s.agreed, 2);
  const gte = (historyWheres[0].startedAt as { gte: Date }).gte;
  assert.ok(Math.abs(gte.getTime() - ago(10).getTime()) < 5_000, "the window starts at Plex's earliest returned view, not 90 days back");
});

// ── 2: a failed server keeps its rows ────────────────────────────────────────

test("a failed fetch keeps the previous rows and records ok:false with the previous fetchedAt and counts preserved — the error is safe", async () => {
  configurePlex();
  evidence = [oldRow("plex", "")];
  const prevFetched = "2025-02-01T00:00:00.000Z";
  settings.set("upstreamWatch:status:plex:", JSON.stringify({
    fetchedAt: prevFetched, attemptedAt: prevFetched, ok: true, entries: 7, matched: 6, samples: 4, agreed: 4, error: null,
  }));
  respond = () => new Response("nope", { status: 401 }); // 4xx fast-fails (no retry)
  const result = await refreshUpstreamWatch();

  assert.equal(txLog.length, 0, "nothing is written for a failed server");
  assert.deepEqual(evidence, [oldRow("plex", "")], "the previous snapshot is kept");
  const s = status("plex", "");
  assert.equal(s.ok, false);
  assert.equal(s.fetchedAt, prevFetched);
  assert.notEqual(s.attemptedAt, prevFetched);
  assert.deepEqual([s.entries, s.matched, s.samples, s.agreed], [7, 6, 4, 4]);
  assert.equal(s.error, "HTTP 401");
  assert.ok(!JSON.stringify(s).includes("token-default") && !JSON.stringify(s).includes("10.71"), "no token or URL in the stored status");
  assert.equal(result.servers[0].ok, false);
  assert.equal(result.servers[0].health, "failed");
  assert.equal(upstreamRefreshProblems(result), 1);
});

test("a failed insert rolls the replace back — the old rows survive and the status is ok:false", async () => {
  configurePlex();
  evidence = [oldRow("plex", "")];
  createManyFails = true;
  respond = () => plexPage(plexHistory());
  const result = await refreshUpstreamWatch();
  assert.deepEqual(evidence, [oldRow("plex", "")]);
  assert.equal(status("plex", "").ok, false);
  assert.equal(result.servers[0].ok, false);
});

test("a failed server is warned about ONCE per condition, and again after it cleared and recurred (guardrail 7b)", async () => {
  configurePlex();
  respond = () => new Response("x", { status: 403 });
  await refreshUpstreamWatch();
  await refreshUpstreamWatch();
  const failedWarns = () => warns.filter((w) => w.startsWith("[upstream-watch] plex:") && w.includes("could not read"));
  assert.equal(failedWarns().length, 1);
  respond = () => plexPage(plexHistory());
  await refreshUpstreamWatch();
  respond = () => new Response("x", { status: 403 });
  await refreshUpstreamWatch();
  assert.equal(failedWarns().length, 2, "a recurrence after a healthy run logs again");
});

// ── 3: isolation ─────────────────────────────────────────────────────────────

test("servers are isolated: the default Plex failing doesn't stop the named Plex or Jellyfin", async () => {
  configurePlex();
  configurePlex("remote", PLEX_REMOTE);
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  configureJellyfin();
  respond = (url) => {
    if (url.origin === PLEX) return new Response("down", { status: 404 });
    if (url.origin === PLEX_REMOTE) return plexPage([{ type: "movie", ratingKey: "999", viewedAt: secs(ago(2)) }]);
    if (url.origin === JF && url.pathname === "/Users") return json([{ Id: "u1", Name: "One" }]);
    if (url.origin === JF) return json({ Items: [{ Type: "Movie", Id: "jm", UserData: { PlayCount: 1 } }], TotalRecordCount: 1 });
    throw new Error(`unexpected ${url}`);
  };
  const result = await refreshUpstreamWatch();
  assert.deepEqual(result.servers.map((s) => [s.source, s.instance, s.ok]), [["plex", "", false], ["plex", "remote", true], ["jellyfin", "", true]]);
  assert.deepEqual(evidence.filter((e) => e.source === "plex").map((e) => [e.serverInstance, e.itemKey]), [["remote", "999"]]);
  assert.equal(status("plex", "remote").matched, 1, "999 IS in the remote server's library");
  assert.deepEqual(evidence.filter((e) => e.source === "jellyfin").map((e) => e.itemKey), ["jm"]);
});

// ── a named server removed while its refresh is in flight (R2-nw#4) ─────────

// What /api/admin/media-instances' removal transaction does to a slug's
// upstream state: the registry entry goes, its status row and evidence too.
function removeRemote() {
  settings.set("plexInstances", JSON.stringify([]));
  settings.delete("plexRemoteServerUrl");
  settings.delete("plexRemoteAdminToken");
  settings.delete("upstreamWatch:status:plex:remote");
  evidence = evidence.filter((e) => !(e.source === "plex" && e.serverInstance === "remote"));
}

test("a named server removed WHILE it is being read writes neither evidence nor a status afterwards (R2-nw#4)", async () => {
  configurePlex("remote", PLEX_REMOTE);
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  evidence = [oldRow("plex", "remote")];
  respond = (url) => {
    if (url.origin === PLEX_REMOTE) {
      removeRemote(); // the removal commits mid-walk
      return plexPage([{ type: "movie", ratingKey: "999", viewedAt: secs(ago(2)) }]);
    }
    throw new Error(`unexpected ${url}`);
  };
  const result = await refreshUpstreamWatch();
  assert.deepEqual(result.servers.map((s) => [s.source, s.instance]), [], "the removed server is skipped, not reported");
  assert.deepEqual(evidence.filter((e) => e.serverInstance === "remote"), [], "no evidence re-created for the removed slug");
  assert.equal(settings.get("upstreamWatch:status:plex:remote"), undefined, "no status re-created for the removed slug");
  assert.ok(txLog.every((t) => t.ops.every((op) => !op.includes("NOT FOR UPDATE"))), "the registry row is LOCKED, not just read");
  assert.ok(txLog.some((t) => t.ops[0] === "lock plexInstances"), "the evidence replace checked the registry first");
});

test("a named server whose read FAILS while it is removed records no failure status for the removed slug (R2-nw#4)", async () => {
  configurePlex("remote", PLEX_REMOTE);
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  respond = (url) => {
    if (url.origin === PLEX_REMOTE) {
      removeRemote();
      return new Response("down", { status: 404 });
    }
    throw new Error(`unexpected ${url}`);
  };
  await refreshUpstreamWatch();
  assert.equal(settings.get("upstreamWatch:status:plex:remote"), undefined);
});

test("a removal landing between the evidence replace and the status write leaves no status either (R2-nw#4)", async () => {
  configurePlex("remote", PLEX_REMOTE);
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  let locks = 0;
  onRegistryLock = () => {
    // The 2nd lock is the status write's: the removal committed just before it
    // (and deleted the evidence the replace had written).
    if (++locks === 2) removeRemote();
  };
  respond = (url) => {
    if (url.origin === PLEX_REMOTE) return plexPage([{ type: "movie", ratingKey: "999", viewedAt: secs(ago(2)) }]);
    throw new Error(`unexpected ${url}`);
  };
  await refreshUpstreamWatch();
  assert.equal(locks, 2);
  assert.equal(settings.get("upstreamWatch:status:plex:remote"), undefined, "the status write re-checked the registry under its lock");
});

test("a named server still registered is refreshed exactly as before, status included (R2-nw#4)", async () => {
  configurePlex("remote", PLEX_REMOTE);
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  respond = (url) => {
    if (url.origin === PLEX_REMOTE) return plexPage([{ type: "movie", ratingKey: "999", viewedAt: secs(ago(2)) }]);
    throw new Error(`unexpected ${url}`);
  };
  const result = await refreshUpstreamWatch();
  assert.deepEqual(result.servers.map((s) => [s.instance, s.ok]), [["remote", true]]);
  assert.equal(status("plex", "remote").ok, true);
  assert.deepEqual(evidence.filter((e) => e.serverInstance === "remote").map((e) => e.itemKey), ["999"]);
});

test("the instance removal writes the registry row FIRST in its transaction — the lock the refresh orders on (R2-nw#4)", () => {
  const src = readFileSync(new URL("../src/app/api/admin/media-instances/route.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("await prisma.$transaction(async (tx) => {"));
  const firstWrite = body.match(/await tx\.[a-zA-Z]+\.[a-zA-Z]+\(\{\s*where: \{ key: ([a-zA-Z.]+) \}/);
  assert.ok(firstWrite, "the transaction's first statement is a keyed Setting write");
  assert.equal(firstWrite[1], "registryWrite.key");
  const registry = body.indexOf("where: { key: registryWrite.key }");
  const evidenceDelete = body.indexOf("tx.upstreamWatchEvidence.deleteMany");
  assert.ok(registry >= 0 && evidenceDelete > registry, "the registry write precedes the slug's evidence delete");
});

// ── 4: abort ─────────────────────────────────────────────────────────────────

test("an abort mid-fetch returns aborted WITHOUT writing that server (no rows, no status) and reaches no later server", async () => {
  configurePlex();
  configureJellyfin();
  evidence = [oldRow("plex", "")];
  const controller = new AbortController();
  respond = (url) => {
    if (url.origin === PLEX) {
      controller.abort(new Error("lock timeout"));
      return plexPage(plexHistory());
    }
    throw new Error(`a later server was reached after the abort: ${url}`);
  };
  const result = await refreshUpstreamWatch({ signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.deepEqual(result.servers, []);
  assert.equal(txLog.length, 0);
  assert.deepEqual(evidence, [oldRow("plex", "")]);
  assert.deepEqual(statusWrites, [], "not even a status row for the server in progress");
  assert.ok(!calls.some((c) => c.origin === JF), "Jellyfin is never contacted");
});

test("an abort between Jellyfin users stops the walk and writes nothing", async () => {
  configureJellyfin();
  const controller = new AbortController();
  const users = Array.from({ length: 8 }, (_, i) => ({ Id: `u${i}`, Name: `User ${i}` }));
  let itemCalls = 0;
  respond = (url) => {
    if (url.pathname === "/Users") return json(users);
    itemCalls++;
    if (itemCalls === 2) controller.abort();
    return json({ Items: [{ Type: "Movie", Id: `m${itemCalls}` }], TotalRecordCount: 1 });
  };
  const result = await refreshUpstreamWatch({ signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(txLog.length, 0);
  assert.deepEqual(statusWrites, []);
  assert.ok(itemCalls < users.length * 2, `the walk kept going after the abort (${itemCalls} item fetches)`);
});

test("an already-aborted signal does nothing at all", async () => {
  configurePlex();
  const controller = new AbortController();
  controller.abort();
  const result = await refreshUpstreamWatch({ signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(statusWrites, []);
});

// ── 5: never writes play history ─────────────────────────────────────────────

test("the job never calls a PlayHistory/ActiveSession write (runtime: every write stub throws and records)", async () => {
  configurePlex();
  configureJellyfin();
  plays = [{ source: "plex", serverInstance: "", completed: true, startedAt: ago(1), sourceItemId: "100" }];
  respond = (url) => {
    if (url.origin === PLEX) return plexPage(plexHistory());
    if (url.pathname === "/Users") return json([{ Id: "u1", Name: "One" }]);
    return json({ Items: [{ Type: "Movie", Id: "jm" }], TotalRecordCount: 1 });
  };
  const result = await refreshUpstreamWatch();
  assert.ok(result.servers.every((s) => s.ok), JSON.stringify(result.servers));
  assert.deepEqual(forbidden, []);
});

test("the job never calls a PlayHistory/ActiveSession write (structural: no such call in the source)", () => {
  const src = readFileSync(new URL("../src/lib/upstream-watch-data.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /playHistory\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/);
  assert.doesNotMatch(src, /activeSession\./);
  assert.doesNotMatch(src, /recordCompletedSession/);
});

// ── 6: unconfigured ──────────────────────────────────────────────────────────

test("an unconfigured server is skipped: no fetch, no status row, not in the result", async () => {
  settings.set("plexServerUrl", PLEX); // no token
  settings.set("jellyfinUrl", JF); // no api key
  const result = await refreshUpstreamWatch();
  assert.deepEqual(result, { servers: [], aborted: false });
  assert.deepEqual(calls, []);
  assert.deepEqual(statusWrites, []);
});

// ── Jellyfin ─────────────────────────────────────────────────────────────────

test("jellyfin: every user × {IsPlayed, IsResumable}; one item in both lists is ONE use for that user; users sum; episodes land on (SeriesId, season)", async () => {
  configureJellyfin();
  const rewatchedAt = ago(1);
  jfLib = [
    { mediaType: "MOVIE", serverInstance: "", jellyfinItemId: "jm1", jellyfinItemIds: [] },
    { mediaType: "TV", serverInstance: "", jellyfinItemId: null, jellyfinItemIds: ["js1"] },
  ];
  const lists: Record<string, unknown[]> = {
    "u1|IsPlayed": [
      { Type: "Movie", Id: "jm1", UserData: { PlayCount: 2, LastPlayedDate: ago(3).toISOString() } },
      { Type: "Episode", Id: "je1", SeriesId: "js1", ParentIndexNumber: 1, UserData: { PlayCount: 1 } },
    ],
    // jm1 again (being re-watched): the same user's same item — not a third play.
    "u1|IsResumable": [
      { Type: "Movie", Id: "jm1", UserData: { PlayCount: 2, LastPlayedDate: rewatchedAt.toISOString() } },
      { Type: "Episode", Id: "je2", SeriesId: "js1", ParentIndexNumber: 1, UserData: { PlayCount: 0 } },
    ],
    "u2|IsPlayed": [{ Type: "Movie", Id: "jm1", UserData: { PlayCount: 1, LastPlayedDate: ago(9).toISOString() } }],
    "u2|IsResumable": [],
  };
  respond = (url) => {
    if (url.pathname === "/Users") return json([{ Id: "u1", Name: "One" }, { Id: "u2", Name: "Two" }]);
    // GET /Items?userId= — the non-legacy form of /Users/{userId}/Items (same handler).
    assert.equal(url.pathname, "/Items", `a per-user read on the non-legacy route: ${url}`);
    const userId = url.searchParams.get("userId");
    assert.ok(userId, `a per-user read names its user: ${url}`);
    const items = lists[`${userId}|${url.searchParams.get("Filters")}`];
    assert.ok(items, `unexpected list ${url}`);
    return json({ Items: items, TotalRecordCount: items.length });
  };
  plays = [
    { source: "jellyfin", serverInstance: "", completed: true, startedAt: ago(3), sourceItemId: "jm1" },
    { source: "jellyfin", serverInstance: "", completed: true, startedAt: ago(4), sourceItemId: "je1" },
    { source: "jellyfin", serverInstance: "", completed: true, startedAt: ago(5), sourceItemId: "jx" },
    { source: "jellyfin", serverInstance: "", completed: true, startedAt: ago(100), sourceItemId: "jold" }, // outside 90 days
  ];
  const result = await refreshUpstreamWatch();
  const filters = calls
    .filter((c) => c.path !== "/Users")
    .map((c) => `${c.path}?userId=${c.params.get("userId")}&Filters=${c.params.get("Filters")}`)
    .sort();
  assert.deepEqual(filters, [
    "/Items?userId=u1&Filters=IsPlayed",
    "/Items?userId=u1&Filters=IsResumable",
    "/Items?userId=u2&Filters=IsPlayed",
    "/Items?userId=u2&Filters=IsResumable",
  ]);

  const rows = new Map(evidence.map((e) => [`${e.itemKey}/${e.seasonNumber}`, e]));
  assert.deepEqual([...rows.keys()].sort(), ["jm1/-1", "js1/1"]);
  assert.equal(rows.get("jm1/-1")!.playCount, 3, "u1's played+resumable copy is max(2,2), plus u2's 1");
  assert.deepEqual(rows.get("jm1/-1")!.lastPlayedAt, rewatchedAt, "the latest date across users and lists");
  assert.equal(rows.get("js1/1")!.playCount, 2, "a resumable episode with PlayCount 0 counts as one use");
  const s = status("jellyfin", "");
  assert.deepEqual([s.ok, s.entries, s.matched, s.samples, s.agreed], [true, 5, 2, 3, 2]);
  const gte = (historyWheres[0].startedAt as { gte: Date }).gte;
  assert.ok(Math.abs(gte.getTime() - ago(90).getTime()) < 5_000, "no floor for Jellyfin: the full 90-day window");
  assert.equal(result.servers[0].health, "ok");
});

test("jellyfin: a 200 with NO users is a failure, not an empty snapshot — the previous rows survive", async () => {
  configureJellyfin();
  evidence = [oldRow("jellyfin", "")];
  respond = (url) => {
    if (url.pathname === "/Users") return json([]);
    throw new Error(`unexpected ${url}`);
  };
  const result = await refreshUpstreamWatch();
  assert.equal(result.servers[0].ok, false);
  assert.equal(result.servers[0].error, "the server returned no users");
  assert.deepEqual(evidence, [oldRow("jellyfin", "")]);
  assert.equal(txLog.length, 0);
});

test("jellyfin: ONE user's list failing fails the whole server (a snapshot missing a user drops their evidence)", async () => {
  configureJellyfin();
  evidence = [oldRow("jellyfin", "")];
  respond = (url) => {
    if (url.pathname === "/Users") return json([{ Id: "u1", Name: "One" }, { Id: "u2", Name: "Two" }]);
    if (url.pathname === "/Items" && url.searchParams.get("userId") === "u2") return new Response("forbidden", { status: 403 });
    return json({ Items: [{ Type: "Movie", Id: "jm" }], TotalRecordCount: 1 });
  };
  const result = await refreshUpstreamWatch();
  assert.equal(result.servers[0].ok, false);
  assert.equal(result.servers[0].error, "HTTP 403");
  assert.deepEqual(evidence, [oldRow("jellyfin", "")]);
});

// ── 7: the self-check ────────────────────────────────────────────────────────

test("records that match NO library title read as failed health and are warned once (a broken parser is loud)", async () => {
  configurePlex();
  plexLib = []; // nothing on this server's shelf matches
  respond = () => plexPage(plexHistory());
  const first = await refreshUpstreamWatch();
  assert.equal(first.servers[0].ok, true, "the fetch itself worked and the snapshot is written");
  assert.equal(first.servers[0].health, "failed");
  assert.equal(upstreamRefreshProblems(first), 1);
  await refreshUpstreamWatch();
  assert.equal(warns.filter((w) => w.includes("none matched a library title")).length, 1);
});

test("fewer than half of Summonarr's own completed plays found upstream reads as unreliable", async () => {
  configurePlex();
  respond = () => plexPage(plexHistory());
  plays = Array.from({ length: 25 }, (_, i) => ({
    source: "plex", serverInstance: "", completed: true, startedAt: ago(2), sourceItemId: i < 3 ? ["100", "501", "502"][i] : `missing-${i}`,
  }));
  const result = await refreshUpstreamWatch();
  assert.equal(result.servers[0].samples, 25);
  assert.equal(result.servers[0].agreed, 3);
  assert.equal(result.servers[0].health, "unreliable");
  assert.equal(warns.filter((w) => w.includes("fewer than half")).length, 1);
});

test("a failed status write never throws out of the job — the snapshot is still written", async () => {
  configurePlex();
  settingUpsertFails = true;
  respond = () => plexPage(plexHistory());
  const result = await refreshUpstreamWatch();
  assert.equal(result.servers[0].ok, true);
  assert.equal(evidence.length, 4);
  assert.ok(warns.some((w) => w.includes("could not record the refresh status")));
});

// ── an empty answer from a server Summonarr saw completed plays on ───────────

test("an EMPTY answer while Summonarr recorded completed plays here keeps the previous rows and fails the server", async () => {
  configurePlex();
  evidence = [oldRow("plex", "")];
  const prevFetched = ago(1).toISOString();
  settings.set("upstreamWatch:status:plex:", JSON.stringify({
    fetchedAt: prevFetched, attemptedAt: prevFetched, ok: true, entries: 7, matched: 6, samples: 4, agreed: 4, error: null,
  }));
  respond = () => plexPage([]);
  plays = [{ source: "plex", serverInstance: "", completed: true, startedAt: ago(3), sourceItemId: "100" }];
  const result = await refreshUpstreamWatch();
  assert.equal(txLog.length, 0, "an empty degraded read never replaces the snapshot");
  assert.deepEqual(evidence, [oldRow("plex", "")]);
  const s = status("plex", "");
  assert.equal(s.ok, false);
  assert.equal(s.error, "the server returned no watch records");
  assert.equal(s.fetchedAt, prevFetched, "the previous snapshot's date is kept with its rows");
  assert.equal(result.servers[0].health, "failed");
  assert.equal(upstreamRefreshProblems(result), 1, "the run is degraded");
});

test("an empty answer with NO recorded completed plays is still a valid (empty) snapshot", async () => {
  configurePlex();
  evidence = [oldRow("plex", "")];
  respond = () => plexPage([]);
  const result = await refreshUpstreamWatch();
  assert.equal(txLog.length, 1);
  assert.deepEqual(evidence, []);
  assert.equal(result.servers[0].ok, true);
  assert.equal(result.servers[0].health, "ok");
});

// ── the per-server run budget ────────────────────────────────────────────────

// A bounded test: a regression that drops the per-server budget walks forever,
// and must FAIL here rather than hang the suite.
test("a server that outlasts its share of the run budget is recorded 'timed out', keeps its rows, and the NEXT server still runs", { timeout: 10_000 }, async () => {
  configurePlex();
  configureJellyfin();
  evidence = [oldRow("plex", ""), oldRow("jellyfin", "")];
  jfLib = [{ mediaType: "MOVIE", serverInstance: "", jellyfinItemId: "jm", jellyfinItemIds: [] }];
  let plexPages = 0;
  respond = async (url) => {
    if (url.origin === PLEX) {
      plexPages++;
      // A history that never ends: always another page, a little later.
      await new Promise((r) => setTimeout(r, 5));
      return json({ MediaContainer: { Metadata: [{ type: "movie", ratingKey: "100", viewedAt: secs(ago(1)) }], totalSize: 1e9, size: 1 } });
    }
    if (url.pathname === "/Users") return json([{ Id: "u1", Name: "One" }]);
    return json({ Items: [{ Type: "Movie", Id: "jm" }], TotalRecordCount: 1 });
  };
  const started = Date.now();
  const result = await refreshUpstreamWatch({ runBudgetMs: 300 });
  assert.ok(Date.now() - started < 5_000, "the budget bounded the walk");
  assert.ok(plexPages > 1, "the Plex walk really was cut short mid-walk");
  assert.equal(result.aborted, false, "a budget expiry is a failed server, never a lock abort");
  assert.deepEqual(result.servers.map((s) => [s.source, s.ok, s.error]), [["plex", false, "timed out"], ["jellyfin", true, null]]);
  assert.deepEqual(evidence.filter((e) => e.source === "plex"), [oldRow("plex", "")], "the partial Plex walk is never written");
  assert.deepEqual(evidence.filter((e) => e.source === "jellyfin").map((e) => e.itemKey), ["jm"], "Jellyfin was refreshed");
  assert.equal(upstreamRefreshProblems(result), 1);
});

test("the budget is not pre-split evenly: the first server may use all of it but a small reserve per later server (R2-nw#1)", () => {
  const MIN = 60_000;
  // Production: 25 minutes, one Plex + one Jellyfin. An even split gave Plex 12.5.
  const reserve2 = upstreamServerReserve(UPSTREAM_RUN_BUDGET_MS, 2);
  assert.equal(reserve2, UPSTREAM_SERVER_RESERVE_MS);
  assert.equal(upstreamServerShare(UPSTREAM_RUN_BUDGET_MS, 0, 2, reserve2), 22 * MIN);
  // The last server gets everything left.
  assert.equal(upstreamServerShare(7 * MIN, 1, 2, reserve2), 7 * MIN);
  // Two Plex + one Jellyfin: the first gets 19 minutes, not 8.3.
  const reserve3 = upstreamServerReserve(UPSTREAM_RUN_BUDGET_MS, 3);
  assert.equal(upstreamServerShare(UPSTREAM_RUN_BUDGET_MS, 0, 3, reserve3), 19 * MIN);
  // A lone server keeps the whole budget; a tiny budget scales the reserve so
  // the first server still gets at least half.
  assert.equal(upstreamServerReserve(UPSTREAM_RUN_BUDGET_MS, 1), 0);
  assert.equal(upstreamServerReserve(300, 2), 75);
  assert.ok(upstreamServerShare(300, 0, 2, upstreamServerReserve(300, 2)) >= 150);
  assert.equal(upstreamServerShare(10, 0, 3, 100), 0, "never negative");
});

test("a first server that needs MORE than an even share (but less than budget minus the reserve) still finishes, and so does the next (R2-nw#1)", { timeout: 15_000 }, async () => {
  configurePlex();
  configureJellyfin();
  evidence = [oldRow("plex", ""), oldRow("jellyfin", "")];
  jfLib = [{ mediaType: "MOVIE", serverInstance: "", jellyfinItemId: "jm", jellyfinItemIds: [] }];
  // Budget 4.4 s over two servers: reserve 1.1 s, so Plex may spend ~3.3 s; an
  // even split would have cut it at 2.2 s. The walk takes ~2.6 s: 50 pages of 50 ms.
  const PAGES = 50;
  let plexPages = 0;
  respond = async (url) => {
    if (url.origin === PLEX) {
      plexPages++;
      await new Promise((r) => setTimeout(r, 50));
      return json({ MediaContainer: { Metadata: [{ type: "movie", ratingKey: "100", viewedAt: secs(ago(1)) }], totalSize: PAGES, size: 1 } });
    }
    if (url.pathname === "/Users") return json([{ Id: "u1", Name: "One" }]);
    return json({ Items: [{ Type: "Movie", Id: "jm" }], TotalRecordCount: 1 });
  };
  const result = await refreshUpstreamWatch({ runBudgetMs: 4_400 });
  assert.equal(plexPages, PAGES, "the whole Plex history was read");
  assert.deepEqual(result.servers.map((s) => [s.source, s.ok, s.error]), [["plex", true, null], ["jellyfin", true, null]]);
  assert.equal(upstreamRefreshProblems(result), 0);
});

// ── a TRUNCATED read and episodes with no show id (audit C159 / C160) ────────

test("a Plex history cut off at its read cap is stored truncated: health 'incomplete', the run degraded, warned ONCE (C159)", async () => {
  configurePlex();
  respond = () => plexPage(plexHistory());
  // Cap 3: the 4th watch record (502) exists past it — the oldest records are unread.
  const first = await refreshUpstreamWatch({ plexMaxItems: 3 });
  const s = status("plex", "");
  assert.equal(s.ok, true, "every record it holds is real, so the partial snapshot IS written");
  assert.equal(s.truncated, true, "the status must say so — otherwise it reads 'ok'");
  assert.equal(first.servers[0].health, "incomplete");
  assert.equal(upstreamRefreshProblems(first), 1, "the cron degrades on it");
  assert.equal(warns.filter((w) => w.includes("read cap")).length, 1);
  await refreshUpstreamWatch({ plexMaxItems: 3 });
  assert.equal(warns.filter((w) => w.includes("read cap")).length, 1, "an unchanged condition is not re-logged (7b)");

  // A complete read clears it.
  const full = await refreshUpstreamWatch();
  assert.equal(status("plex", "").truncated, false);
  assert.equal(full.servers[0].health, "ok");
  assert.equal(upstreamRefreshProblems(full), 0);
});

test("a failed refresh carries the previous snapshot's truncated flag — its rows are still the partial ones (C159)", async () => {
  configurePlex();
  settings.set("upstreamWatch:status:plex:", JSON.stringify({
    fetchedAt: ago(1).toISOString(), attemptedAt: ago(1).toISOString(), ok: true, entries: 7, matched: 6, samples: 0, agreed: 0, error: null, truncated: true,
  }));
  respond = () => new Response("nope", { status: 401 });
  await refreshUpstreamWatch();
  assert.equal(status("plex", "").truncated, true);
});

test("episodes whose show id can't be read are counted: most of them unplaced reads 'failed' on a MIXED server, warned once (C160)", async () => {
  configurePlex();
  const episodes = Array.from({ length: 25 }, (_, i) => ({
    type: "episode", ratingKey: String(600 + i), grandparentKey: "/not/a/metadata/path", parentIndex: 1, index: i + 1, viewedAt: secs(ago(3)), accountID: 1,
  }));
  // The movie matches the library, so `matched` alone would read this server healthy.
  respond = () => plexPage([{ type: "movie", ratingKey: "100", viewedAt: secs(ago(2)), accountID: 1 }, ...episodes]);
  const result = await refreshUpstreamWatch();
  const s = status("plex", "");
  assert.equal(s.matched, 1);
  assert.equal(s.episodeRecords, 25, "counted from the parsed records, not the aggregated rows (which drop them)");
  assert.equal(s.unplacedEpisodes, 25);
  assert.equal(result.servers[0].health, "failed");
  assert.equal(upstreamRefreshProblems(result), 1);
  assert.equal(warns.filter((w) => w.includes("no show id")).length, 1, "its own message, not 'none matched a library title'");
  assert.equal(warns.filter((w) => w.includes("none matched")).length, 0);
});

test("the default history's episodes all carry a show id: nothing unplaced (C160)", async () => {
  configurePlex();
  respond = () => plexPage(plexHistory());
  await refreshUpstreamWatch();
  const s = status("plex", "");
  assert.equal(s.episodeRecords, 2);
  assert.equal(s.unplacedEpisodes, 0);
});
