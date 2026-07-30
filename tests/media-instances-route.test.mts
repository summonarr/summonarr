// Route-level unit tests for the admin media-instance API
// (src/app/api/admin/media-instances/route.ts): the GET view and the POST that
// saves the Plex/Jellyfin instance registry, writes each instance's connection
// Setting rows, and — the reason this file exists — CLEANS UP after an instance
// the admin removed.
//
// ── THE HEADLINE: removing an instance used to orphan its library rows ───────
// Availability readers are UNSCOPED unions: plex-availability.ts /
// jellyfin-availability.ts do a findMany on { mediaType, tmdbId: { in } } with no
// serverInstance filter and then a Set.has. No sync path ever targets a
// de-registered slug again (the per-source routes are ""-scoped; the orchestrator
// loops only REGISTERED instances). So a PlexLibraryItem/JellyfinLibraryItem row
// left behind by a removal makes that server's entire catalogue read
// "In Plex"/"In Jellyfin" FOREVER — across discovery cards, the request POST's
// already-available rejection, issues, votes, the Discord bot and admin stats —
// with nothing left that could ever retry the cleanup. Hence the pins below:
// the deletes happen, they are SCOPED to the removed slug, and they commit in
// the SAME transaction as the registry write (a registry that says "gone" plus
// rows that say "present" is exactly the permanent-orphan state).
//
// The destructive cleanup is also where the data-loss guardrails bite, so each
// gets its own pin:
//   - guardrail 28: MediaServerUser is SOFT-deleted (active:false), never hard-
//     deleted — PlayHistory/ActiveSession FK it onDelete: Restrict, so a delete
//     would throw on any row holding history.
//   - guardrail 19: PlayHistory is not touched AT ALL. The live poller is its
//     sole writer; nothing can rebuild it.
//   - guardrail 23: no try/catch inside the transaction (a failing write must
//     propagate and roll the whole thing back) — pinned via the rollback test.
//   - guardrail 26: the audit write is post-commit and swallowing.
//
// ── Division of labour (owned elsewhere; NOT re-pinned here) ─────────────────
//   - tests/media-instance-registry.test.mts OWNS getMediaInstances /
//     isMediaInstanceConfigured / the registry JSON normalization.
//   - tests/media-instances.test.mts OWNS the Setting-key derivation.
//   - tests/api-auth.test.mts OWNS the withAuth/withAdmin matrix; we spot-check
//     that withAdmin fronts both handlers.
//   - tests/plex.test.mts OWNS pingPlexToken/getPlexMachineId themselves; here we
//     pin only how the connection test COMBINES them.
//
// No DB, no network, no DNS: globalThis.prisma is a recording fake seeded BEFORE
// the module graph loads (the settings-route.test.mts idiom), every prisma op is
// journaled with the transaction it ran in, fetch is scripted per test, the
// media-server URLs are RFC1918 IP literals (safeFetchAdminConfigured's SSRF
// stack short-circuits on isIP, no lookup) and dns.lookup is stubbed for the
// plex.tv hop. Admin sessions are REAL jose JWTs over in-memory AuthSession/User
// rows; bearer transport skips the UA-fingerprint check and the sliding cookie.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto at load
process.env.NEXTAUTH_SECRET = "media-instances-route-test-secret-0123456789";
process.env.AUTH_URL = "http://localhost:3000"; // unprefixed cookie name + trusted origin
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning

// ── DNS stub (see tests/trakt.test.mts for the rationale) ───────────────────
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture (guardrail 7: warn/error only) ──────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch (connection-test paths only) ─────────────────────────────
const fetchUrls: string[] = [];
let respond: (url: URL) => Response | Promise<Response> = (url) => {
  throw new Error(`unexpected fetch ${url} — script a responder for this test`);
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchUrls.push(url.origin + url.pathname);
  return respond(url);
}) as typeof fetch;

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ── recording fake prisma, seeded on globalThis before the module graph ─────
// Every op is journaled with the id of the transaction it ran in (null = the
// top-level client), which is what lets the tests assert that the registry write
// and ALL of the cleanup share ONE transaction.
type Where = Record<string, unknown> | undefined;
type Op = { txId: number | null; model: string; op: string; where: Where; data?: unknown };
const ops: Op[] = [];
let txSeq = 0;
const txOptions: Array<{ timeout?: number } | undefined> = [];

const settings = new Map<string, string>();
type LibraryRow = { tmdbId: number; mediaType: string; serverInstance: string };
type SessionRow = { id: string; source: string; serverInstance: string };
type ServerUserRow = { id: string; source: string; serverInstance: string; active: boolean };
let plexLibrary: LibraryRow[] = [];
let jellyfinLibrary: LibraryRow[] = [];
let activeSessions: SessionRow[] = [];
let serverUsers: ServerUserRow[] = [];
const auditRows: Array<Record<string, unknown>> = [];

// Deliberately permissive: a `where` with no keys matches EVERY row, so a
// regression that drops the serverInstance scoping wipes the whole store and the
// "another instance's rows survive" assertions fail loudly.
function whereMatches(row: Record<string, unknown>, where: Where): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
    if (cond !== null && typeof cond === "object" && "in" in (cond as Record<string, unknown>)) {
      if (!(cond as { in: unknown[] }).in.includes(value)) return false;
    } else if (value !== cond) return false;
  }
  return true;
}

type DbUser = {
  id: string; role: string; permissions: bigint; name: string | null; email: string | null;
  mediaServer: string | null; notificationEmail: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
};
const usersById = new Map<string, DbUser>();
const authSessionsById = new Map<string, { userId: string }>();

// Fails the NEXT setting.upsert whose key matches — used to prove the
// transaction rolls back rather than half-applying (guardrail 23).
let failUpsertKey: string | null = null;

function makeClient(txId: number | null) {
  const record = (model: string, op: string, where: Where, data?: unknown) => {
    ops.push({ txId, model, op, where, data });
  };
  const rowDelegate = <T extends Record<string, unknown>>(model: string, store: () => T[], write: (rows: T[]) => void) => ({
    deleteMany: async (args?: { where?: Where }) => {
      record(model, "deleteMany", args?.where);
      const kept = store().filter((r) => !whereMatches(r, args?.where));
      const count = store().length - kept.length;
      write(kept);
      return { count };
    },
    updateMany: async (args: { where?: Where; data: Record<string, unknown> }) => {
      record(model, "updateMany", args.where, args.data);
      let count = 0;
      for (const row of store()) {
        if (whereMatches(row, args.where)) {
          Object.assign(row, args.data);
          count++;
        }
      }
      return { count };
    },
    findMany: async (args?: { where?: Where }) => {
      record(model, "findMany", args?.where);
      return store().filter((r) => whereMatches(r, args?.where));
    },
  });

  return {
    setting: {
      findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
        const only = args?.where?.key?.in;
        const rows = [...settings.entries()].map(([key, value]) => ({ key, value }));
        return only ? rows.filter((r) => only.includes(r.key)) : rows;
      },
      findUnique: async (args: { where: { key: string } }) => {
        const value = settings.get(args.where.key);
        return value === undefined ? null : { key: args.where.key, value };
      },
      upsert: async (args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) => {
        record("setting", "upsert", args.where, args.create.value);
        if (failUpsertKey !== null && args.where.key === failUpsertKey) {
          failUpsertKey = null;
          throw new Error("setting upsert exploded (unit test)");
        }
        settings.set(args.where.key, args.create.value);
        return { key: args.where.key, value: args.create.value };
      },
      deleteMany: async (args: { where: { key: { in: string[] } } }) => {
        record("setting", "deleteMany", args.where);
        let count = 0;
        for (const key of args.where.key.in) {
          if (settings.delete(key)) count++;
        }
        return { count };
      },
    },
    plexLibraryItem: rowDelegate("plexLibraryItem", () => plexLibrary, (r) => { plexLibrary = r; }),
    jellyfinLibraryItem: rowDelegate("jellyfinLibraryItem", () => jellyfinLibrary, (r) => { jellyfinLibrary = r; }),
    activeSession: rowDelegate("activeSession", () => activeSessions, (r) => { activeSessions = r; }),
    mediaServerUser: rowDelegate("mediaServerUser", () => serverUsers, (r) => { serverUsers = r; }),
    // PlayHistory has NO legitimate caller in this route — every op is journaled
    // so the guardrail-19 test can assert the model was never addressed at all.
    playHistory: rowDelegate("playHistory", () => [] as Record<string, unknown>[], () => {}),
    user: {
      findUnique: async (args: { where: { id: string } }) => {
        const u = usersById.get(args.where.id);
        return u ? { ...u } : null;
      },
      update: async () => ({}),
    },
    authSession: {
      findUnique: async (args: { where: { sessionId: string } }) =>
        authSessionsById.has(args.where.sessionId)
          ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
          : null,
      update: async () => ({}), // lastSeenAt fire-and-forget touch
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditRows.push(args.data);
        return args.data;
      },
    },
  };
}

const fakePrisma = {
  ...makeClient(null),
  $transaction: async (arg: unknown, opts?: { timeout?: number }) => {
    txOptions.push(opts);
    if (typeof arg === "function") {
      const id = ++txSeq;
      return (arg as (t: ReturnType<typeof makeClient>) => Promise<unknown>)(makeClient(id));
    }
    return Promise.all(arg as Promise<unknown>[]);
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── dynamic imports (env + globalThis stubs must precede the module graph) ──
const { NextRequest } = await import("next/server");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { BATCH_TX_TIMEOUT } = await import("../src/lib/cron-auth.ts");
const { GET, POST } = await import("../src/app/api/admin/media-instances/route.ts");

type Req = InstanceType<typeof NextRequest>;
const MASK = "••••••••";
const ENDPOINT = "http://localhost:3000/api/admin/media-instances";

// ── fixtures ────────────────────────────────────────────────────────────────
let seq = 0;
async function mintSession(role: string): Promise<{ userId: string; header: Record<string, string> }> {
  seq++;
  const userId = `actor-${seq}`;
  const sessionId = `actor-sess-${seq}`;
  usersById.set(userId, {
    id: userId, role, permissions: 0n, name: `Actor ${seq}`, email: "admin@example.com",
    mediaServer: null, notificationEmail: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
  });
  authSessionsById.set(sessionId, { userId });
  const token = await signSessionJwt(
    { id: userId, role, permissions: "0", provider: "credentials", sessionId, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
    { expiresInSeconds: 7_200 },
  );
  return { userId, header: { authorization: `Bearer ${token}` } };
}

function getReq(headers: Record<string, string> = {}): Req {
  return new NextRequest(ENDPOINT, { method: "GET", headers });
}
function postReq(body: unknown, headers: Record<string, string> = {}): Req {
  return new NextRequest(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// void logAudit(...) is fire-and-forget — drain it before asserting on audit rows.
const flush = async (rounds = 10) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r)); };

const opsFor = (model: string, op?: string) => ops.filter((o) => o.model === model && (op === undefined || o.op === op));
const libSlugs = (rows: LibraryRow[]) => rows.map((r) => r.serverInstance).sort();

// Seeds a "remote" Plex instance: registry entry, connection + ancillary Setting
// rows, and library/session/server-user rows on BOTH the removed slug and
// neighbours (the default instance and a second named one) that must survive.
function seedPlexRemote() {
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }, { slug: "keep", name: "Keep" }]));
  settings.set("plexRemoteServerUrl", "http://10.0.0.5:32400");
  settings.set("plexRemoteAdminToken", "remote-token");
  settings.set("plexRemoteAdminEmail", "remote@example.com");
  settings.set("plexRemoteLibraries", "1,2");
  settings.set("plexRemotePathStripPrefix", "/mnt/remote");
  settings.set("plexRemoteMoviePathStripPrefix", "/mnt/remote/movies");
  settings.set("plexRemoteTvPathStripPrefix", "/mnt/remote/tv");
  settings.set("plexKeepServerUrl", "http://10.0.0.6:32400");
  settings.set("plexKeepAdminToken", "keep-token");

  plexLibrary = [
    { tmdbId: 1, mediaType: "MOVIE", serverInstance: "remote" },
    { tmdbId: 2, mediaType: "TV", serverInstance: "remote" },
    { tmdbId: 3, mediaType: "MOVIE", serverInstance: "" },
    { tmdbId: 4, mediaType: "MOVIE", serverInstance: "keep" },
  ];
  jellyfinLibrary = [
    // Same slug string on the OTHER service — a Plex removal must not touch it.
    { tmdbId: 5, mediaType: "MOVIE", serverInstance: "remote" },
  ];
  activeSessions = [
    { id: "plex:remote:11", source: "plex", serverInstance: "remote" },
    { id: "plex:22", source: "plex", serverInstance: "" },
    { id: "jellyfin:remote:33", source: "jellyfin", serverInstance: "remote" },
  ];
  serverUsers = [
    { id: "su-remote", source: "plex", serverInstance: "remote", active: true },
    { id: "su-default", source: "plex", serverInstance: "", active: true },
    { id: "su-jf-remote", source: "jellyfin", serverInstance: "remote", active: true },
  ];
}

// The manager UI never POSTs the synthesized default ("") entry, so "remove
// remote" is literally "the array no longer contains it".
const removeAll = { service: "plex", instances: [{ slug: "keep", name: "Keep" }] };

beforeEach(() => {
  ops.length = 0;
  txOptions.length = 0;
  fetchUrls.length = 0;
  auditRows.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  plexLibrary = [];
  jellyfinLibrary = [];
  activeSessions = [];
  serverUsers = [];
  failUpsertKey = null;
  respond = (url) => { throw new Error(`unexpected fetch ${url}`); };
});

// ════════════════════════════════════════════════════════════════════════════
// Authorization fronting + input guards (nothing destructive may run first)
// ════════════════════════════════════════════════════════════════════════════

test("GET/POST: no session → 401; a plain USER → 403; the handler body never runs", async () => {
  assert.equal((await GET(getReq(), undefined)).status, 401);
  assert.equal((await POST(postReq(removeAll), undefined)).status, 401);

  const user = await mintSession("USER");
  assert.equal((await GET(getReq(user.header), undefined)).status, 403);
  const res = await POST(postReq(removeAll, user.header), undefined);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Forbidden" });
  assert.equal(ops.filter((o) => o.op !== "findMany" && o.op !== "findUnique").length, 0, "no write may run for an unauthorized caller");
});

test("POST: a missing/malformed `instances` → 400 with ZERO writes — coercing it to [] would read as 'remove every named instance' and delete their libraries", async () => {
  const admin = await mintSession("ADMIN");
  seedPlexRemote();
  for (const body of [{ service: "plex" }, { service: "plex", instances: "remote" }, { service: "plex", instances: null }]) {
    const res = await POST(postReq(body, admin.header), undefined);
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} must be rejected`);
    assert.deepEqual(await res.json(), { error: "instances must be an array" });
  }
  assert.equal(txOptions.length, 0, "the transaction must not even open");
  assert.equal(libSlugs(plexLibrary).length, 4, "not one library row may be deleted by a rejected request");
});

test("POST: an invalid slug → 400 before any write; an unknown service → 400", async () => {
  const admin = await mintSession("ADMIN");
  seedPlexRemote();
  const bad = await POST(postReq({ service: "plex", instances: [{ slug: "Bad Slug" }] }, admin.header), undefined);
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /invalid instance slug/);

  const svc = await POST(postReq({ service: "emby", instances: [] }, admin.header), undefined);
  assert.equal(svc.status, 400);
  assert.deepEqual(await svc.json(), { error: "service must be plex or jellyfin" });
  assert.equal(txOptions.length, 0);
  assert.equal(plexLibrary.length, 4);
});

// ════════════════════════════════════════════════════════════════════════════
// THE HEADLINE — removing an instance cleans up everything it owned, SCOPED
// ════════════════════════════════════════════════════════════════════════════

test("HEADLINE: removing a named Plex instance DELETES its PlexLibraryItem rows, scoped — the default's and another instance's rows survive, and so does the same slug on Jellyfin", async () => {
  const admin = await mintSession("ADMIN");
  seedPlexRemote();
  const res = await POST(postReq(removeAll, admin.header), undefined);
  assert.equal(res.status, 200);

  // The rows are gone: without this delete, plex-availability.ts's unscoped
  // union keeps reporting tmdb 1 + 2 as "In Plex" forever.
  assert.deepEqual(libSlugs(plexLibrary), ["", "keep"], "only the removed slug's rows may be deleted");
  assert.deepEqual(libSlugs(jellyfinLibrary), ["remote"], "a Plex removal must not touch JellyfinLibraryItem");

  // Scoping is asserted on the query too, not just the surviving rows — an
  // unscoped deleteMany would pass a row check only until the fake's store
  // happened to be empty.
  const del = opsFor("plexLibraryItem", "deleteMany");
  assert.equal(del.length, 1);
  assert.deepEqual(del[0].where, { serverInstance: "remote" }, "the library delete MUST be scoped to the removed slug");
  assert.equal(opsFor("jellyfinLibraryItem", "deleteMany").length, 0);
});

test("HEADLINE (jellyfin): removing a named Jellyfin instance deletes JellyfinLibraryItem scoped, and leaves PlexLibraryItem alone", async () => {
  const admin = await mintSession("ADMIN");
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  settings.set("jellyfinRemoteUrl", "http://10.0.0.9:8096");
  settings.set("jellyfinRemoteApiKey", "jf-key");
  jellyfinLibrary = [
    { tmdbId: 1, mediaType: "MOVIE", serverInstance: "remote" },
    { tmdbId: 2, mediaType: "MOVIE", serverInstance: "" },
  ];
  plexLibrary = [{ tmdbId: 1, mediaType: "MOVIE", serverInstance: "remote" }];

  const res = await POST(postReq({ service: "jellyfin", instances: [] }, admin.header), undefined);
  assert.equal(res.status, 200);
  assert.deepEqual(libSlugs(jellyfinLibrary), [""]);
  assert.deepEqual(libSlugs(plexLibrary), ["remote"], "a Jellyfin removal must not touch PlexLibraryItem");
  assert.deepEqual(opsFor("jellyfinLibraryItem", "deleteMany")[0].where, { serverInstance: "remote" });
});

test("GUARDRAIL 28: MediaServerUser is SOFT-deleted (active:false), scoped by source+serverInstance — never hard-deleted", async () => {
  const admin = await mintSession("ADMIN");
  seedPlexRemote();
  assert.equal((await POST(postReq(removeAll, admin.header), undefined)).status, 200);

  assert.equal(
    opsFor("mediaServerUser", "deleteMany").length,
    0,
    "a hard delete would THROW on any row holding PlayHistory/ActiveSession (onDelete: Restrict) and destroy irreplaceable attribution",
  );
  const upd = opsFor("mediaServerUser", "updateMany");
  assert.equal(upd.length, 1);
  assert.deepEqual(upd[0].where, { source: "plex", serverInstance: "remote" });
  assert.deepEqual(upd[0].data, { active: false });

  // The rows still EXIST — their history stays attributed (guardrail 33's rule
  // that usage data outlives a removal).
  assert.deepEqual(serverUsers.map((u) => `${u.id}:${u.active}`).sort(), [
    "su-default:true",
    "su-jf-remote:true",
    "su-remote:false",
  ]);
});

test("GUARDRAIL 19: PlayHistory is never addressed at all — no delete, no update, not even a read", async () => {
  const admin = await mintSession("ADMIN");
  seedPlexRemote();
  assert.equal((await POST(postReq(removeAll, admin.header), undefined)).status, 200);
  assert.deepEqual(opsFor("playHistory"), [], "the live poller is PlayHistory's sole writer — nothing here may touch it");
});

test("ActiveSession rows for the removed slug are deleted, scoped by source+serverInstance", async () => {
  const admin = await mintSession("ADMIN");
  seedPlexRemote();
  assert.equal((await POST(postReq(removeAll, admin.header), undefined)).status, 200);

  const del = opsFor("activeSession", "deleteMany");
  assert.equal(del.length, 1);
  assert.deepEqual(del[0].where, { source: "plex", serverInstance: "remote" });
  assert.deepEqual(
    activeSessions.map((s) => s.id).sort(),
    ["jellyfin:remote:33", "plex:22"],
    "the default instance's session and the same slug on Jellyfin must survive",
  );
});

test("Setting cleanup covers the WHOLE per-instance field union, not just the connection pair", async () => {
  const admin = await mintSession("ADMIN");
  seedPlexRemote();
  assert.equal((await POST(postReq(removeAll, admin.header), undefined)).status, 200);

  const del = opsFor("setting", "deleteMany");
  assert.equal(del.length, 1);
  assert.deepEqual(
    ((del[0].where as { key: { in: string[] } }).key.in).sort(),
    [
      "plexRemoteAdminEmail",
      "plexRemoteAdminToken",
      "plexRemoteLibraries",
      "plexRemoteMoviePathStripPrefix",
      "plexRemotePathStripPrefix",
      "plexRemoteServerUrl",
      "plexRemoteTvPathStripPrefix",
    ],
    "Libraries/*PathStripPrefix must be deleted too — an orphaned row would be silently inherited by a future instance re-created under the same slug",
  );
  for (const key of [...settings.keys()]) {
    assert.ok(!key.startsWith("plexRemote"), `${key} survived the removal`);
  }
  assert.equal(settings.get("plexKeepAdminToken"), "keep-token", "another instance's keys are untouched");
});

test("a slug that COLLIDES with a default-instance key (\"movie\"/\"tv\") never deletes the default server's Settings", async () => {
  // instanceKeySegment capitalizes only the slug's first character, so
  // plexSettingKey("movie", "PathStripPrefix") and
  // plexSettingKey("", "MoviePathStripPrefix") are the SAME string —
  // "plexMoviePathStripPrefix" — and "movie"/"tv" both pass the slug regex.
  // Without the default-key subtraction, removing an instance named "movie"
  // silently deletes the DEFAULT server's movie path-strip prefix, changing
  // its path normalization (bad-matches, the library diff) with no audit line
  // naming the key.
  const admin = await mintSession("ADMIN");
  settings.set("plexInstances", JSON.stringify([{ slug: "movie", name: "Movie Box" }]));
  settings.set("plexMovieServerUrl", "http://10.0.0.9:32400");
  settings.set("plexMovieAdminToken", "movie-token");
  settings.set("plexMoviePathStripPrefix", "/mnt/media/movies"); // the DEFAULT instance's key
  settings.set("plexTvPathStripPrefix", "/mnt/media/tv");

  const res = await POST(postReq({ service: "plex", instances: [] }, admin.header), undefined);
  assert.equal(res.status, 200);

  const del = opsFor("setting", "deleteMany");
  const deleted = (del[0].where as { key: { in: string[] } }).key.in;
  assert.ok(
    !deleted.includes("plexMoviePathStripPrefix"),
    "the default server's movie strip prefix must never be in the removal key set",
  );
  assert.equal(
    settings.get("plexMoviePathStripPrefix"),
    "/mnt/media/movies",
    "the default instance's Setting survives the collision",
  );
  assert.equal(settings.get("plexTvPathStripPrefix"), "/mnt/media/tv");
  // The instance's own non-colliding keys are still cleaned up.
  assert.equal(settings.get("plexMovieServerUrl"), undefined);
  assert.equal(settings.get("plexMovieAdminToken"), undefined);
});

test("ONE transaction: the registry write AND every cleanup op share a single tx, opened with BATCH_TX_TIMEOUT", async () => {
  const admin = await mintSession("ADMIN");
  seedPlexRemote();
  assert.equal((await POST(postReq(removeAll, admin.header), undefined)).status, 200);

  assert.equal(txOptions.length, 1, "exactly one transaction");
  assert.equal(txOptions[0]?.timeout, BATCH_TX_TIMEOUT, "a library deleteMany can span 25k+ rows");

  const registryUpsert = opsFor("setting", "upsert").find((o) => (o.where as { key: string }).key === "plexInstances");
  assert.ok(registryUpsert, "the registry JSON must be written");
  const txId = registryUpsert.txId;
  assert.ok(txId !== null, "the registry write must be INSIDE the transaction");

  // If the registry commits and a delete doesn't, the slug is deregistered with
  // its rows still present and nothing will ever retry — permanent orphans.
  const cleanup = [
    ...opsFor("setting", "deleteMany"),
    ...opsFor("plexLibraryItem", "deleteMany"),
    ...opsFor("activeSession", "deleteMany"),
    ...opsFor("mediaServerUser", "updateMany"),
  ];
  assert.equal(cleanup.length, 4, "all four cleanup ops ran");
  for (const op of cleanup) {
    assert.equal(op.txId, txId, `${op.model}.${op.op} must run in the same transaction as the registry write`);
  }
});

test("GUARDRAIL 23: a failing write inside the transaction PROPAGATES — the cleanup never runs and nothing is audited as success", async () => {
  const admin = await mintSession("ADMIN");
  seedPlexRemote();
  failUpsertKey = "plexInstances"; // the very first in-tx write blows up

  // The fake has no rollback machinery, so what's pinned is the shape that makes
  // a real rollback possible: the error escapes the callback (a caught-and-
  // ignored one would leave Postgres's tx aborted while the route answered 200,
  // silently discarding every earlier write) and no later op is attempted.
  await assert.rejects(
    () => POST(postReq(removeAll, admin.header), undefined),
    /setting upsert exploded/,
  );
  await flush();
  assert.deepEqual(libSlugs(plexLibrary), ["", "keep", "remote", "remote"], "no library row may be destroyed by a failed save");
  assert.equal(opsFor("plexLibraryItem", "deleteMany").length, 0, "the cleanup must not run after a failed registry write");
  assert.deepEqual(auditRows, [], "a failed operation must not be audited as a success");
});

test("removal is audited post-commit with the slugs and row counts destroyed (guardrail 26: logAudit, never logAuditOrFail)", async () => {
  const admin = await mintSession("ADMIN");
  seedPlexRemote();
  assert.equal((await POST(postReq(removeAll, admin.header), undefined)).status, 200);
  await flush();

  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, "SETTINGS_CHANGE");
  assert.equal(auditRows[0].target, "media-instances:plex");
  const details = JSON.parse(String(auditRows[0].details)) as {
    removed: string[];
    removedCounts: Record<string, { libraryItems: number; activeSessions: number; serverUsersDisabled: number }>;
  };
  assert.deepEqual(details.removed, ["remote"]);
  assert.deepEqual(details.removedCounts.remote, { libraryItems: 2, activeSessions: 1, serverUsersDisabled: 1 });
});

test("a save that removes NOTHING performs no cleanup at all (the default instance is never a removal candidate)", async () => {
  const admin = await mintSession("ADMIN");
  seedPlexRemote();
  const res = await POST(
    postReq({ service: "plex", instances: [{ slug: "remote", name: "Remote" }, { slug: "keep", name: "Keep" }] }, admin.header),
    undefined,
  );
  assert.equal(res.status, 200);
  assert.equal(opsFor("plexLibraryItem", "deleteMany").length, 0);
  assert.equal(opsFor("activeSession", "deleteMany").length, 0);
  assert.equal(opsFor("mediaServerUser", "updateMany").length, 0);
  assert.equal(opsFor("setting", "deleteMany").length, 0);
  assert.deepEqual(libSlugs(plexLibrary), ["", "keep", "remote", "remote"]);
});

// ════════════════════════════════════════════════════════════════════════════
// Connection-field writes: the mask sentinel, and guardrail 7a
// ════════════════════════════════════════════════════════════════════════════

test("an untouched secret sent back as the mask sentinel is SKIPPED, not written; a real value is stored as RAW PLAINTEXT (guardrail 7a)", async () => {
  const admin = await mintSession("ADMIN");
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  settings.set("plexRemoteAdminToken", "original-secret");

  const res = await POST(
    postReq(
      {
        service: "plex",
        instances: [
          { slug: "remote", name: "Remote", serverUrl: "  http://10.0.0.5:32400  ", adminToken: MASK, adminEmail: " a@b.co " },
          { slug: "fresh", name: "Fresh", adminToken: "brand-new-secret" },
        ],
      },
      admin.header,
    ),
    undefined,
  );
  assert.equal(res.status, 200);

  const upserted = (key: string) => opsFor("setting", "upsert").filter((o) => (o.where as { key: string }).key === key);
  assert.equal(upserted("plexRemoteAdminToken").length, 0, "the mask sentinel must never reach the DB");
  assert.equal(settings.get("plexRemoteAdminToken"), "original-secret", "the stored secret survives an unedited save");
  assert.equal(settings.get("plexRemoteServerUrl"), "http://10.0.0.5:32400", "URL/email values are trimmed");
  assert.equal(settings.get("plexRemoteAdminEmail"), "a@b.co");
  assert.equal(upserted("plexFreshAdminToken")[0]?.data, "brand-new-secret");
  assert.ok(
    !String(settings.get("plexFreshAdminToken")).startsWith("enc:v1:"),
    "the Prisma extension is the sole encryptor — a route-level encryptToken would double-wrap (guardrail 7a)",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TASK 2 — restrictSignIn on the Jellyfin instance payload
// Wire contract the settings UI depends on:
//   GET  → jellyfin[].restrictSignIn: boolean (absent row ⇒ true, fail-closed)
//   POST → { restrictSignIn?: boolean } writes "true"/"false"; omitted ⇒ untouched
// ════════════════════════════════════════════════════════════════════════════

test("restrictSignIn round-trip: POST writes \"true\"/\"false\", GET reports the boolean, and an absent row defaults to TRUE (fail-closed, matching isJellyfinSignInAllowed)", async () => {
  const admin = await mintSession("ADMIN");
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));

  // No jellyfinRemoteRestrictSignIn row yet — a named instance is fail-closed by
  // default, exactly like the default instance, so the UI must render "on".
  const initial = (await (await GET(getReq(admin.header), undefined)).json()) as {
    jellyfin: Array<{ slug: string; restrictSignIn: boolean }>;
  };
  assert.deepEqual(
    initial.jellyfin.map((i) => [i.slug, i.restrictSignIn]),
    [["", true], ["remote", true]],
    "an absent Setting row must read as restricted, never as false",
  );

  // Turn it off for the named instance. Before this route wrote the key, NOTHING
  // could: /api/settings drops unknown keys with a silent 200, and its static
  // ALLOWED_KEYS list cannot enumerate admin-defined slugs — so named Jellyfin
  // instances were permanently fail-closed.
  const off = await POST(
    postReq({ service: "jellyfin", instances: [{ slug: "remote", name: "Remote", restrictSignIn: false }] }, admin.header),
    undefined,
  );
  assert.equal(off.status, 200);
  assert.equal(settings.get("jellyfinRemoteRestrictSignIn"), "false", "the Setting value is the string auth.ts parses");
  assert.deepEqual(
    ((await off.json()) as { instances: Array<{ slug: string; restrictSignIn: boolean }> }).instances.map((i) => [i.slug, i.restrictSignIn]),
    [["", true], ["remote", false]],
    "the POST response carries the same view shape as GET",
  );

  // Omitting the field leaves the stored value alone (it is not a tri-state the
  // UI has to resend).
  const untouched = await POST(
    postReq({ service: "jellyfin", instances: [{ slug: "remote", name: "Remote", url: "http://10.0.0.9:8096" }] }, admin.header),
    undefined,
  );
  assert.equal(untouched.status, 200);
  assert.equal(settings.get("jellyfinRemoteRestrictSignIn"), "false", "an omitted restrictSignIn must not reset the toggle");

  // And back on.
  await POST(postReq({ service: "jellyfin", instances: [{ slug: "remote", restrictSignIn: true }] }, admin.header), undefined);
  assert.equal(settings.get("jellyfinRemoteRestrictSignIn"), "true");
});

test("removing a Jellyfin instance also deletes its RestrictSignIn row (the widened field union)", async () => {
  const admin = await mintSession("ADMIN");
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  settings.set("jellyfinRemoteRestrictSignIn", "false");
  settings.set("jellyfinRemoteUrl", "http://10.0.0.9:8096");

  assert.equal((await POST(postReq({ service: "jellyfin", instances: [] }, admin.header), undefined)).status, 200);
  assert.equal(
    settings.has("jellyfinRemoteRestrictSignIn"),
    false,
    "a surviving 'false' row would silently disable sign-in restriction on a future instance with the same slug",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// `restricted` — the per-server VISIBILITY flag (per-user media-server grants)
// Wire contract the instances manager depends on, for BOTH services:
//   GET  → <service>[].restricted: boolean (registry metadata, not a Setting)
//   POST → { restricted?: boolean } persists into the registry JSON
// The manager round-trips the GET view straight back through POST, so an
// unechoed or undefaulted field silently CLEARS the flag on the next save —
// which un-gates a private server's whole library for every user at once.
// ════════════════════════════════════════════════════════════════════════════

test("restricted round-trip: POST persists it into the registry, GET echoes it for both services, and re-POSTing the GET view unchanged does NOT clear it", async () => {
  const admin = await mintSession("ADMIN");

  for (const service of ["plex", "jellyfin"] as const) {
    const on = await POST(
      postReq({ service, instances: [{ slug: "remote", name: "Remote", restricted: true }, { slug: "open", name: "Open" }] }, admin.header),
      undefined,
    );
    assert.equal(on.status, 200);
    assert.deepEqual(
      ((await on.json()) as { instances: Array<{ slug: string; restricted: boolean }> }).instances.map((i) => [i.slug, i.restricted]),
      [["", false], ["remote", true], ["open", false]],
      `${service}: the POST response view must carry restricted, and an omitted field must default to open`,
    );

    // The flag lives in the registry JSON, NOT in a Setting row of its own —
    // nothing would ever clean up a stray per-instance key on removal.
    assert.deepEqual(
      JSON.parse(settings.get(service === "plex" ? "plexInstances" : "jellyfinInstances")!),
      [{ slug: "remote", name: "Remote", restricted: true }, { slug: "open", name: "Open", restricted: false }],
    );

    const view = (await (await GET(getReq(admin.header), undefined)).json()) as Record<string, Array<{ slug: string; name: string; restricted: boolean }>>;
    assert.deepEqual(
      view[service].map((i) => [i.slug, i.restricted]),
      [["", false], ["remote", true], ["open", false]],
      `${service}: GET must echo restricted — the manager reads this straight into its draft`,
    );

    // THE REGRESSION: feed the GET view back verbatim, exactly as the manager's
    // save() does for an admin who only edited the display name. Before the
    // route round-tripped the field, this save dropped it and the server went
    // public.
    const resave = await POST(
      postReq({ service, instances: view[service].filter((i) => i.slug !== "").map((i) => ({ slug: i.slug, name: i.name, restricted: i.restricted })) }, admin.header),
      undefined,
    );
    assert.equal(resave.status, 200);
    assert.deepEqual(
      ((await resave.json()) as { instances: Array<{ slug: string; restricted: boolean }> }).instances.map((i) => [i.slug, i.restricted]),
      [["", false], ["remote", true], ["open", false]],
      `${service}: an unedited round-trip must not un-restrict the server`,
    );

    // And explicitly off again.
    await POST(postReq({ service, instances: [{ slug: "remote", name: "Remote", restricted: false }] }, admin.header), undefined);
    assert.deepEqual(JSON.parse(settings.get(service === "plex" ? "plexInstances" : "jellyfinInstances")!), [
      { slug: "remote", name: "Remote", restricted: false },
    ]);
    settings.clear();
  }
});

test("the DEFAULT (\"\") instance can never be restricted, even if a client asks — it is synthesized, and a restricted default would blank the library on a single-server install", async () => {
  const admin = await mintSession("ADMIN");
  const res = await POST(
    postReq({ service: "plex", instances: [{ slug: "", name: "Default", restricted: true }, { slug: "remote", restricted: true }] }, admin.header),
    undefined,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(
    JSON.parse(settings.get("plexInstances")!),
    [{ slug: "remote", name: "remote", restricted: true }],
    "the \"\" entry must never reach the registry — it would shadow defaultInstanceConfig()",
  );
  assert.deepEqual(
    ((await res.json()) as { instances: Array<{ slug: string; restricted: boolean }> }).instances.map((i) => [i.slug, i.restricted]),
    [["", false], ["remote", true]],
  );
});

test("restricted is coerced strictly (=== true) — a hand-edited \"true\"/1 in the payload reads as OPEN, never as restricted", async () => {
  const admin = await mintSession("ADMIN");
  const res = await POST(
    postReq(
      { service: "jellyfin", instances: [{ slug: "a", restricted: "true" }, { slug: "b", restricted: 1 }, { slug: "c", restricted: true }] },
      admin.header,
    ),
    undefined,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(
    ((await res.json()) as { instances: Array<{ slug: string; restricted: boolean }> }).instances.map((i) => [i.slug, i.restricted]),
    [["", false], ["a", false], ["b", false], ["c", true]],
    "truthiness would let a malformed value silently gate a server nobody has been granted",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TASK 3 — the Plex connection test must probe the entered ServerUrl
// ════════════════════════════════════════════════════════════════════════════

test("Plex connection test: a valid token but an UNREACHABLE ServerUrl reports failure — pingPlexToken alone never touches the URL", async () => {
  const admin = await mintSession("ADMIN");
  respond = (url) => {
    if (url.hostname === "plex.tv") return okJson({ ok: true }); // token is genuinely valid
    if (url.hostname === "10.0.0.5") return new Response("nope", { status: 500 }); // wrong/unreachable server
    throw new Error(`unexpected fetch ${url}`);
  };
  const res = await POST(
    postReq(
      { service: "plex", instances: [{ slug: "remote", name: "Remote", serverUrl: "http://10.0.0.5:32400", adminToken: "tok" }] },
      admin.header,
    ),
    undefined,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { testResults: Record<string, { ok?: boolean; error?: string }> };
  assert.deepEqual(
    body.testResults.remote,
    { error: "Plex server unreachable" },
    "a token-only check reported {ok:true} here, so the UI said 'Connected' for a server it had never contacted",
  );
  assert.ok(fetchUrls.includes("http://10.0.0.5:32400/identity"), "the entered ServerUrl must actually be probed");
});

test("Plex connection test: token + reachable server → ok; an invalid token fails EARLY with its own message and no server probe", async () => {
  const admin = await mintSession("ADMIN");
  respond = (url) => {
    if (url.hostname === "plex.tv") return okJson({ ok: true });
    if (url.hostname === "10.0.0.5") return okJson({ MediaContainer: { machineIdentifier: "machine-abc" } });
    throw new Error(`unexpected fetch ${url}`);
  };
  const good = await POST(
    postReq({ service: "plex", instances: [{ slug: "remote", serverUrl: "http://10.0.0.5:32400", adminToken: "tok" }] }, admin.header),
    undefined,
  );
  assert.deepEqual(((await good.json()) as { testResults: Record<string, unknown> }).testResults.remote, { ok: true });

  fetchUrls.length = 0;
  respond = (url) => {
    if (url.hostname === "plex.tv") return new Response("unauthorized", { status: 401 });
    throw new Error(`unexpected fetch ${url}`);
  };
  const bad = await POST(
    postReq({ service: "plex", instances: [{ slug: "remote", serverUrl: "http://10.0.0.5:32400", adminToken: "tok" }] }, admin.header),
    undefined,
  );
  assert.deepEqual(
    ((await bad.json()) as { testResults: Record<string, unknown> }).testResults.remote,
    { error: "Plex token check failed" },
    "a bad token keeps its own distinct message",
  );
  assert.deepEqual(fetchUrls.filter((u) => u.includes("10.0.0.5")), [], "no point probing the server with a token plex.tv rejected");
});
