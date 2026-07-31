// Route-level unit tests for the five uncovered /api/sync/* routes:
//   POST /api/sync/radarr        rebuild the Radarr wanted/available cache
//   POST /api/sync/sonarr        the Sonarr twin
//   POST /api/sync/tv-episodes   rebuild TVEpisodeCache from Plex + Jellyfin
//   POST /api/sync/upcoming      rebuild the upcoming-releases cache
//   POST /api/sync/ratings       warm the ratings caches
//
// tests/sync-routes.test.mts covers the per-source Plex/Jellyfin Resync routes;
// these are the remaining sync entry points, and every one of them DELETES
// before it repopulates. That makes the shared theme "which delete is allowed to
// run", i.e. guardrail 13 in five different shapes:
//
//   1. A FAILED FETCH MUST NOT CLEAR THAT SOURCE'S ROWS. radarr/sonarr only
//      clear+rewrite instances whose fetch succeeded; a null result leaves THAT
//      instance's cache intact, so one instance being down never empties
//      another's. tv-episodes gets the same property structurally — its getters
//      THROW on a fetch failure, so the catch skips the delete entirely.
//   2. EVERY DELETE IS SCOPED. radarr/sonarr scope on `arrInstance`, tv-episodes
//      on `source`, upcoming on `mediaType`. An unscoped deleteMany in any of
//      them wipes a sibling that was never refreshed.
//   3. THE DEFAULT ARR INSTANCE IS AUTHORITATIVE. If its fetch fails the whole
//      run is abandoned with a 502 — deliberately NOT a 200 — so
//      withCronRunRecording marks the run failed rather than reporting success
//      for a cache that was never refreshed and badges that may now be stale.
//   4. upcoming DELIBERATELY DIFFERS on the empty case: a fulfilled-but-empty
//      TMDB result is a valid "nothing upcoming" state and DOES clear that media
//      type, unlike the library-sync anti-wipe guard where 0 rows usually means a
//      degraded fetch. Both halves are pinned so the divergence stays intentional.
//   5. Writes go through batchCreateMany inside a transaction carrying
//      BATCH_TX_TIMEOUT (guardrail 4), under the advisory lock that coordinates
//      with the webhook handlers and the orchestrator.
//
// All five are cron-authed (guardrail 6) and answer 403 — note, not the 401 the
// /api/cron/* family uses.
//
// Harness: real handlers invoked directly, in-memory prisma stubs with a
// recording $transaction, a monkey-patched `pg` Client.prototype for the
// advisory locks, and scripted upstreams. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "sync-source-routes-secret-0123456789ab";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5432/db";
const CRON_SECRET = "sync-source-cron-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON_SECRET;
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted upstreams ───────────────────────────────────────────────────────
const fetchCalls: URL[] = [];
// Per-host behaviour knobs. `null` bodies make the corresponding lib helper fail.
let arrOk = true;              // Radarr/Sonarr HTTP
let arrFailHost: string | null = null; // fail ONE instance by host
let plexOk = true;             // Plex sections + episodes
let jellyfinOk = true;         // Jellyfin episodes
let tmdbOk = true;             // TMDB list endpoints

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

  if (url.hostname.endsWith("themoviedb.org")) {
    if (!tmdbOk) return json({ status_message: "TMDB DOWN" }, 500);
    return json({ page: 1, total_pages: 1, results: [] });
  }
  if (url.pathname.includes("/library/sections")) {
    return plexOk ? json({ MediaContainer: { Directory: [] } }) : json({ error: "PLEX DOWN" }, 500);
  }
  if (url.pathname.includes("/Items") || url.pathname.includes("/Users")) {
    return jellyfinOk ? json({ Items: [], TotalRecordCount: 0 }) : json({ error: "JELLYFIN DOWN" }, 500);
  }
  if (url.pathname.includes("/api/v3/")) {
    if (!arrOk || url.hostname === arrFailHost) return json({ error: "ARR DOWN" }, 500);
    return json([]);
  }
  return json({});
}) as unknown as typeof fetch;

// ── pg Client prototype stub (withAdvisoryLock seam) ─────────────────────────
type PgResult = { rows: unknown[] };
let pgLockCalls: Array<{ op: "try" | "unlock"; lockId: number }> = [];
let lockAcquire: (lockId: number) => boolean = () => true;
const pgProto = Client.prototype as unknown as {
  connect: () => Promise<void>;
  query: (t: string, v?: unknown[]) => Promise<PgResult>;
  end: () => Promise<void>;
};
pgProto.connect = async () => {};
pgProto.query = async (text, values) => {
  if (text.includes("pg_try_advisory_lock")) {
    const lockId = Number((values ?? [])[0]);
    pgLockCalls.push({ op: "try", lockId });
    return { rows: [{ acquired: lockAcquire(lockId) }] };
  }
  if (text.includes("pg_advisory_unlock")) {
    pgLockCalls.push({ op: "unlock", lockId: Number((values ?? [])[0]) });
    return { rows: [] };
  }
  return { rows: [] };
};
pgProto.end = async () => {};

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { BATCH_TX_TIMEOUT } = await import("../src/lib/cron-auth.ts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);
const deletesOf = (model: string) => opsOf(`${model}.deleteMany`).map((o) => o.args as Record<string, unknown>);
const createsOf = (model: string) => opsOf(`${model}.createMany`).map((o) => o.args as { data: Record<string, unknown>[] });

// ── prisma stubs ─────────────────────────────────────────────────────────────
function cacheModel(name: string) {
  return {
    deleteMany: async (args: { where?: Record<string, unknown> } = {}) => {
      rec(`${name}.deleteMany`, args.where);
      return { count: 0 };
    },
    createMany: async (args: { data: Record<string, unknown>[] }) => {
      rec(`${name}.createMany`, args);
      return { count: args.data.length };
    },
    findMany: async () => [], findUnique: async () => null, findFirst: async () => null,
    count: async () => 0, upsert: async () => ({}), update: async () => ({}), create: async () => ({}),
  };
}
for (const m of [
  "radarrWantedItem", "radarrAvailableItem", "sonarrWantedItem", "sonarrAvailableItem",
  "tVEpisodeCache", "upcomingCacheItem", "tmdbCache", "tmdbMediaCore",
  "plexLibraryItem", "jellyfinLibraryItem", "mediaRequest", "user", "authSession",
]) {
  shadowPrismaModel(prisma, m, cacheModel(m));
}

// sync/upcoming AWAITS a logAudit before returning. Leaving auditLog unstubbed
// sends it to the real client, which then blocks on a DB connection that does
// not exist in this harness — the route simply never resolves.
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: unknown) => { rec("auditLog.create", args); return { id: "a1" }; },
  findMany: async () => [], deleteMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }),
});

const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    rec("setting.findUnique", args.where.key);
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    rec("setting.findMany", args.where?.key?.in);
    const keys = args.where?.key?.in;
    const all = [...settings.entries()].map(([key, value]) => ({ key, value }));
    return keys ? all.filter((r) => keys.includes(r.key)) : all;
  },
  upsert: async (args: { where: { key: string }; update: { value: string } }) => {
    rec("setting.upsert", args.where.key);
    settings.set(args.where.key, args.update.value);
    return {};
  },
  create: async () => ({}), update: async () => ({}), deleteMany: async () => ({ count: 0 }),
});

// A recording $transaction that hands the same stubbed client through as `tx`
// and captures the options object, so the guardrail-4 timeout is assertable.
let txOptions: Array<Record<string, unknown> | undefined> = [];
const txClient = prisma as unknown as Record<string, unknown>;
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown, opts?: Record<string, unknown>) => {
  rec("$transaction", opts);
  txOptions.push(opts);
  if (Array.isArray(arg)) return Promise.all(arg);
  return (arg as (tx: unknown) => Promise<unknown>)(txClient);
});
shadowPrismaClientMethod(prisma, "$executeRaw", async (strings: TemplateStringsArray) => {
  const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
  rec("$executeRaw", sql.replace(/\s+/g, " ").trim());
  return 1;
});
shadowPrismaClientMethod(prisma, "$executeRawUnsafe", async () => { rec("$executeRawUnsafe"); return 1; });
shadowPrismaClientMethod(prisma, "$queryRaw", async () => { rec("$queryRaw"); return []; });
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async () => { rec("$queryRawUnsafe"); return []; });

const syncRadarr = await import("../src/app/api/sync/radarr/route.ts");
const syncSonarr = await import("../src/app/api/sync/sonarr/route.ts");
const syncTvEpisodes = await import("../src/app/api/sync/tv-episodes/route.ts");
const syncUpcoming = await import("../src/app/api/sync/upcoming/route.ts");
const syncRatings = await import("../src/app/api/sync/ratings/route.ts");

// ── invocation ───────────────────────────────────────────────────────────────
function req(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000${path}`, { method: "POST", headers });
}
const authed = (path: string) => req(path, { authorization: `Bearer ${CRON_SECRET}` });

type SyncRoute = { name: string; path: string; POST: (r: InstanceType<typeof NextRequest>) => Promise<Response> };
const ROUTES: SyncRoute[] = [
  { name: "radarr", path: "/api/sync/radarr", POST: syncRadarr.POST },
  { name: "sonarr", path: "/api/sync/sonarr", POST: syncSonarr.POST },
  { name: "tv-episodes", path: "/api/sync/tv-episodes", POST: syncTvEpisodes.POST },
  { name: "upcoming", path: "/api/sync/upcoming", POST: syncUpcoming.POST },
  { name: "ratings", path: "/api/sync/ratings", POST: syncRatings.POST },
];

const call = (r: SyncRoute) => r.POST(authed(r.path));

// Configure the default arr instance so getSyncableArrInstances returns it.
// Each instance gets its OWN host so the fetch stub can fail exactly one of
// them — which is what makes the per-instance isolation testable at all.
const ARR_HOST: Record<string, string> = { "": "10.0.0.2", anime: "10.0.0.9", "4k": "10.0.0.8" };
function configureArr(service: "radarr" | "sonarr", slug = ""): void {
  const cap = slug === "" ? "" : slug === "4k" ? "4k" : slug.charAt(0).toUpperCase() + slug.slice(1);
  settings.set(`${service}${cap}Url`, `http://${ARR_HOST[slug] ?? "10.0.0.2"}:7878`);
  settings.set(`${service}${cap}ApiKey`, `${service}-${slug || "default"}-key`);
}
function registerArrInstance(service: "radarr" | "sonarr", slug: string): void {
  const key = service === "radarr" ? "arrRadarrInstances" : "arrSonarrInstances";
  const existing = JSON.parse(settings.get(key) ?? "[]") as unknown[];
  existing.push({ slug, name: slug });
  settings.set(key, JSON.stringify(existing));
}

beforeEach(() => {
  ops = [];
  txOptions = [];
  pgLockCalls = [];
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  arrOk = true;
  arrFailHost = null;
  plexOk = true;
  jellyfinOk = true;
  tmdbOk = true;
  lockAcquire = () => true;
});

// ── the shared cron gate (guardrail 6) ───────────────────────────────────────

for (const route of ROUTES) {
  test(`${route.name}: an unauthenticated POST is 403 and does no work`, async () => {
    const res = await route.POST(req(route.path));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "Forbidden");
    const writes = ops.filter((o) => /(deleteMany|createMany)$/.test(o.op));
    assert.deepEqual(writes, [], `${route.name} wrote before authorizing`);
    assert.deepEqual(fetchCalls, [], `${route.name} hit the network before authorizing`);
  });

  test(`${route.name}: a WRONG bearer secret is 403`, async () => {
    const res = await route.POST(req(route.path, { authorization: "Bearer not-the-secret-0123456789abcdef" }));
    assert.equal(res.status, 403);
  });

  test(`${route.name}: the secret as a ?token= query param is refused`, async () => {
    // That fallback exists for the Sonarr/Radarr webhook UIs (guardrail 2), not
    // for cron callers, which can always set a header.
    const r = new NextRequest(`http://localhost:3000${route.path}?token=${CRON_SECRET}`, { method: "POST" });
    assert.equal((await route.POST(r)).status, 403);
  });

  test(`${route.name}: a valid bearer secret is accepted`, async () => {
    const res = await call(route);
    assert.notEqual(res.status, 403, `${route.name} rejected a valid CRON_SECRET`);
  });
}

test("these routes answer 403, not the 401 the /api/cron/* family uses", async () => {
  // Both are cron-authed; the differing status is long-standing and pinned so a
  // "harmonize the codes" refactor is a deliberate, client-visible decision.
  for (const route of ROUTES) {
    assert.equal((await route.POST(req(route.path))).status, 403, route.name);
  }
});

// ── radarr / sonarr: the arr matrix ──────────────────────────────────────────

const ARR = [
  { name: "radarr", service: "radarr" as const, route: ROUTES[0], lockKey: "(1001, 1)", wanted: "radarrWantedItem", available: "radarrAvailableItem" },
  { name: "sonarr", service: "sonarr" as const, route: ROUTES[1], lockKey: "(1001, 2)", wanted: "sonarrWantedItem", available: "sonarrAvailableItem" },
];

for (const a of ARR) {
  test(`${a.name}: an UNCONFIGURED instance list is a clean 200 with nothing deleted`, async () => {
    const res = await call(a.route);
    assert.equal(res.status, 200);
    assert.deepEqual(deletesOf(a.wanted), [], "no configured instance ⇒ nothing to clear");
  });

  test(`${a.name}: a configured default instance clears and rewrites ITS OWN slug only`, async () => {
    configureArr(a.service);
    const res = await call(a.route);
    assert.equal(res.status, 200);
    for (const where of [...deletesOf(a.wanted), ...deletesOf(a.available)]) {
      assert.ok(where && "arrInstance" in where, `an unscoped delete would wipe every instance: ${JSON.stringify(where)}`);
      assert.equal(where.arrInstance, "");
    }
  });

  test(`${a.name}: EVERY delete is arrInstance-scoped, across multiple instances`, async () => {
    configureArr(a.service);
    configureArr(a.service, "anime");
    registerArrInstance(a.service, "anime");
    await call(a.route);
    const scopes = [...deletesOf(a.wanted), ...deletesOf(a.available)].map((w) => w.arrInstance);
    assert.ok(scopes.length >= 4, `expected per-instance clears, saw ${scopes.length}`);
    assert.deepEqual([...new Set(scopes)].sort(), ["", "anime"]);
  });

  test(`${a.name}: a NAMED instance failing leaves ITS rows intact and refreshes the others (guardrail 13)`, async () => {
    // The isolation that matters: one instance being unreachable must never
    // empty another's cache. The failed slug is not in `writable`, so it is
    // neither cleared nor rewritten, while the healthy default still refreshes.
    configureArr(a.service);
    configureArr(a.service, "anime");
    registerArrInstance(a.service, "anime");
    arrFailHost = ARR_HOST.anime;

    const res = await call(a.route);
    assert.equal(res.status, 200, "a non-default instance failing is not a whole-run failure");
    const scopes = [...deletesOf(a.wanted), ...deletesOf(a.available)].map((w) => w.arrInstance);
    assert.ok(scopes.length > 0, "the healthy instance should still be refreshed");
    assert.deepEqual([...new Set(scopes)], [""], "only the instance whose fetch SUCCEEDED may be cleared");
    assert.ok(!scopes.includes("anime"), "the down instance's cache must survive untouched");
  });

  test(`${a.name}: a failed DEFAULT-instance fetch abandons the run with 502, not 200`, async () => {
    // 502 so withCronRunRecording marks the run failed — a 200 would report
    // success for a cache that was never refreshed, leaving stale badges.
    configureArr(a.service);
    arrOk = false;
    const res = await call(a.route);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).reason, "arr-unavailable");
  });

  test(`${a.name}: a failed default fetch DELETES NOTHING`, async () => {
    configureArr(a.service);
    arrOk = false;
    await call(a.route);
    assert.deepEqual(deletesOf(a.wanted), [], "a failed fetch must never clear the cache");
    assert.deepEqual(deletesOf(a.available), []);
  });

  test(`${a.name}: the skip is warned for the operator (guardrail 7 scope prefix)`, async () => {
    configureArr(a.service);
    arrOk = false;
    await call(a.route);
    assert.ok(warns.some((w) => w.includes(`[sync/${a.name}]`)), `no scoped warn: ${warns.join(" | ")}`);
  });

  test(`${a.name}: the write runs inside a transaction carrying BATCH_TX_TIMEOUT (guardrail 4)`, async () => {
    configureArr(a.service);
    await call(a.route);
    assert.ok(txOptions.length > 0, "no transaction was opened");
    assert.equal((txOptions[0] as { timeout: number }).timeout, BATCH_TX_TIMEOUT);
  });

  test(`${a.name}: the transaction takes its advisory lock ${a.lockKey}`, async () => {
    // Coordinates with the webhook handler and the sync orchestrator; without it
    // two runs interleave delete/insert phases and leave the cache empty.
    configureArr(a.service);
    await call(a.route);
    const locks = opsOf("$executeRaw").map((o) => o.args as string);
    assert.ok(locks.some((s) => s.includes("pg_advisory_xact_lock")), `no advisory lock: ${locks.join(" | ")}`);
  });

  test(`${a.name}: an empty result set clears but issues no createMany`, async () => {
    configureArr(a.service);
    await call(a.route);
    assert.ok(deletesOf(a.wanted).length > 0, "the clear still runs");
    assert.deepEqual(createsOf(a.wanted), [], "no rows ⇒ no insert");
  });

  test(`${a.name}: reports zero counts for an empty library`, async () => {
    configureArr(a.service);
    const body = await (await call(a.route)).json();
    assert.equal(body.wanted, 0);
    assert.equal(body.available, 0);
  });

  test(`${a.name}: never leaks the upstream error body on failure`, async () => {
    configureArr(a.service);
    arrOk = false;
    const text = await (await call(a.route)).text();
    assert.ok(!text.includes("ARR DOWN"));
  });
}

test("radarr and sonarr use DISTINCT advisory locks", () => {
  // Sharing one would serialize two independent syncs against each other.
  assert.notEqual(ARR[0].lockKey, ARR[1].lockKey);
});

test("a radarr sync never touches sonarr's tables, and vice versa", async () => {
  configureArr("radarr");
  configureArr("sonarr");
  await call(ROUTES[0]);
  assert.deepEqual(deletesOf("sonarrWantedItem"), []);
  assert.deepEqual(deletesOf("sonarrAvailableItem"), []);
  ops = [];
  await call(ROUTES[1]);
  assert.deepEqual(deletesOf("radarrWantedItem"), []);
  assert.deepEqual(deletesOf("radarrAvailableItem"), []);
});

// ── tv-episodes: source-scoped, throw-on-fetch-failure ───────────────────────

const tvEpisodes = ROUTES[2];

test("tv-episodes with NEITHER server configured deletes nothing", async () => {
  const res = await call(tvEpisodes);
  assert.equal(res.status, 200);
  assert.deepEqual(deletesOf("tVEpisodeCache"), []);
});

test("tv-episodes scopes its delete by SOURCE, never wholesale", async () => {
  // TVEpisodeCache holds both servers' episodes in one table (it has no
  // serverInstance column), so an unscoped delete erases the other source.
  settings.set("plexServerUrl", "http://10.0.0.5:32400");
  settings.set("plexAdminToken", "plex-token");
  await call(tvEpisodes);
  const wheres = deletesOf("tVEpisodeCache");
  assert.ok(wheres.length > 0);
  for (const w of wheres) {
    assert.ok(w && "source" in w, `unscoped delete would erase the sibling source: ${JSON.stringify(w)}`);
  }
});

test("tv-episodes clears ONLY the plex source when only Plex is configured", async () => {
  settings.set("plexServerUrl", "http://10.0.0.5:32400");
  settings.set("plexAdminToken", "plex-token");
  await call(tvEpisodes);
  assert.deepEqual(deletesOf("tVEpisodeCache").map((w) => w.source), ["plex"]);
});

test("tv-episodes clears ONLY the jellyfin source when only Jellyfin is configured", async () => {
  settings.set("jellyfinUrl", "http://10.0.0.6:8096");
  settings.set("jellyfinApiKey", "jf-key");
  await call(tvEpisodes);
  assert.deepEqual(deletesOf("tVEpisodeCache").map((w) => w.source), ["jellyfin"]);
});

test("a FAILED Plex fetch leaves the plex rows intact and is reported, not thrown", async () => {
  // getPlexTVEpisodes THROWS on a fetch failure, so the catch skips the delete
  // entirely — that is what makes an empty result mean "genuinely empty library".
  settings.set("plexServerUrl", "http://10.0.0.5:32400");
  settings.set("plexAdminToken", "plex-token");
  plexOk = false;
  const res = await call(tvEpisodes);
  assert.equal(res.status, 200, "one source failing is a partial result, not a route failure");
  const body = await res.json();
  assert.ok(body.errors.some((e: string) => e.startsWith("Plex:")));
  assert.deepEqual(deletesOf("tVEpisodeCache"), [], "a failed fetch must not clear its source");
});

test("a failed Plex fetch does not stop the Jellyfin half", async () => {
  settings.set("plexServerUrl", "http://10.0.0.5:32400");
  settings.set("plexAdminToken", "plex-token");
  settings.set("jellyfinUrl", "http://10.0.0.6:8096");
  settings.set("jellyfinApiKey", "jf-key");
  plexOk = false;
  const body = await (await call(tvEpisodes)).json();
  assert.ok(body.errors.some((e: string) => e.startsWith("Plex:")));
  assert.deepEqual(deletesOf("tVEpisodeCache").map((w) => w.source), ["jellyfin"], "the healthy source still refreshes");
});

test("tv-episodes writes under BATCH_TX_TIMEOUT and an advisory lock", async () => {
  settings.set("plexServerUrl", "http://10.0.0.5:32400");
  settings.set("plexAdminToken", "plex-token");
  await call(tvEpisodes);
  assert.equal((txOptions[0] as { timeout: number }).timeout, BATCH_TX_TIMEOUT);
  assert.ok(opsOf("$executeRaw").some((o) => String(o.args).includes("pg_advisory_xact_lock")));
});

test("tv-episodes honours the library selection setting", async () => {
  settings.set("plexServerUrl", "http://10.0.0.5:32400");
  settings.set("plexAdminToken", "plex-token");
  settings.set("plexLibraries", "1,2");
  const res = await call(tvEpisodes);
  assert.equal(res.status, 200);
  assert.ok(opsOf("setting.findUnique").some((o) => o.args === "plexLibraries"));
});

test("tv-episodes reports per-source counts", async () => {
  const body = await (await call(tvEpisodes)).json();
  assert.equal(body.plex, 0);
  assert.equal(body.jellyfin, 0);
  assert.deepEqual(body.errors, []);
});

// ── upcoming: per-media-type replace, and its deliberate empty-case divergence ─

const upcoming = ROUTES[3];

test("upcoming scopes its delete by mediaType, never wholesale", async () => {
  // A blanket delete wipes the sibling type when only one source failed.
  await call(upcoming);
  const wheres = deletesOf("upcomingCacheItem");
  assert.ok(wheres.length > 0);
  for (const w of wheres) {
    assert.ok(w && "mediaType" in w, `unscoped delete would wipe the sibling type: ${JSON.stringify(w)}`);
  }
});

test("upcoming replaces BOTH media types when both fetches succeed", async () => {
  await call(upcoming);
  assert.deepEqual(deletesOf("upcomingCacheItem").map((w) => w.mediaType).sort(), ["MOVIE", "TV"]);
});

test("a fulfilled-but-EMPTY fetch still clears that type — deliberately unlike the library sync", async () => {
  // For upcoming, an empty TMDB result is a valid "nothing upcoming" state and
  // the cache re-warms next run. The library sync's anti-wipe guard (guardrails
  // 13/28) treats 0 rows as a probable degraded fetch instead. Pinned so the
  // divergence stays a decision rather than an accident.
  await call(upcoming);
  assert.equal(deletesOf("upcomingCacheItem").length, 2);
  assert.deepEqual(createsOf("upcomingCacheItem"), [], "nothing to insert, but the clear still ran");
});

test("upcoming writes under BATCH_TX_TIMEOUT", async () => {
  await call(upcoming);
  assert.ok(txOptions.length > 0);
  assert.equal((txOptions[0] as { timeout: number }).timeout, BATCH_TX_TIMEOUT);
});

test("upcoming takes advisory lock 2007 and releases it", async () => {
  await call(upcoming);
  assert.ok(pgLockCalls.some((c) => c.op === "try" && c.lockId === 2007));
  assert.equal(pgLockCalls.filter((c) => c.op === "unlock" && c.lockId === 2007).length, 1);
});

test("a busy upcoming lock skips instead of running", async () => {
  lockAcquire = () => false;
  const res = await call(upcoming);
  assert.deepEqual(await res.json(), { skipped: true, reason: "already running" });
  assert.deepEqual(deletesOf("upcomingCacheItem"), []);
});

test("a TMDB failure is logged and does not throw out of the handler", async () => {
  tmdbOk = false;
  const res = await call(upcoming);
  assert.equal(res.status, 200, "a fetch failure is a partial result, not a 500");
});

// ── ratings ──────────────────────────────────────────────────────────────────

const ratings = ROUTES[4];

test("ratings skips cleanly when NO provider key is configured, and takes no lock", async () => {
  const res = await call(ratings);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.skipped, true);
  assert.match(body.reason, /no ratings API key/i);
  assert.deepEqual(pgLockCalls, [], "an unconfigured run must not take the lock");
});

test("the unconfigured skip STILL records the run so the dashboard timestamp updates", async () => {
  await call(ratings);
  // withCronRunRecording writes its bookkeeping row even for a legitimate no-op.
  assert.ok(opsOf("setting.upsert").some((o) => String(o.args).includes("ratings-sync")));
});

test("ratings proceeds to the lock once EITHER provider key exists", async () => {
  for (const key of ["mdblistApiKey", "omdbApiKey"]) {
    settings.clear();
    pgLockCalls = [];
    settings.set(key, "a-key");
    await call(ratings);
    assert.ok(pgLockCalls.some((c) => c.op === "try" && c.lockId === 2008), `${key} should enable the run`);
  }
});

test("a busy ratings lock skips instead of double-burning provider quota", async () => {
  settings.set("omdbApiKey", "a-key");
  lockAcquire = () => false;
  const res = await call(ratings);
  assert.deepEqual(await res.json(), { skipped: true, reason: "already running" });
});

test("ratings releases its lock on the happy path", async () => {
  settings.set("omdbApiKey", "a-key");
  await call(ratings);
  assert.equal(pgLockCalls.filter((c) => c.op === "unlock" && c.lockId === 2008).length, 1);
});

test("ratings never deletes anything — it is a cache WARM, not a rebuild", async () => {
  settings.set("omdbApiKey", "a-key");
  await call(ratings);
  const deletes = ops.filter((o) => o.op.endsWith(".deleteMany"));
  assert.deepEqual(deletes, [], "a warm must not clear any cache");
});

test("ratings tolerates every TMDB list failing and still reports a result", async () => {
  settings.set("omdbApiKey", "a-key");
  tmdbOk = false;
  const res = await call(ratings);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 0, "every list caught its own failure and degraded to empty");
});

test("ratings uses a DISTINCT advisory lock from upcoming", async () => {
  // 2008 vs 2007 — sharing one would serialize two unrelated jobs.
  settings.set("omdbApiKey", "a-key");
  await call(ratings);
  const ids = [...new Set(pgLockCalls.map((c) => c.lockId))];
  assert.deepEqual(ids, [2008]);
});

// ── cross-route hygiene ──────────────────────────────────────────────────────

test("no sync route echoes CRON_SECRET in its response", async () => {
  for (const route of ROUTES) {
    const text = await (await call(route)).text();
    assert.ok(!text.includes(CRON_SECRET), `${route.name} leaked the cron secret`);
  }
});

test("every sync route answers JSON on both the authorized and rejected paths", async () => {
  for (const route of ROUTES) {
    for (const r of [await route.POST(req(route.path)), await call(route)]) {
      assert.match(r.headers.get("content-type") ?? "", /application\/json/, route.name);
    }
  }
});

test("no sync route source contains a console.log call (guardrail 7)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const route of ROUTES) {
    const src = readFileSync(`src/app/api/sync/${route.name}/route.ts`, "utf-8");
    const code = src.split("\n").map((l) => { const i = l.indexOf("//"); return i === -1 ? l : l.slice(0, i); });
    assert.ok(!code.some((l) => /console\.log\s*\(/.test(l)), `${route.name} has a console.log`);
  }
});
