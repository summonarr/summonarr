// Route-level unit tests for the per-source library sync routes —
// src/app/api/sync/plex/route.ts and src/app/api/sync/jellyfin/route.ts (the
// admin "Resync" buttons + docker cron targets). Division of labour:
//   - tests/cron-auth.test.mts OWNS isCronAuthorized's Bearer internals,
//     batchCreateMany chunking, and withCronRunRecording's ok-derivation.
//     This file pins only the routes' USE of them: the auth gate runs BEFORE
//     any body read / fetch / DB write, the admin-session path (which
//     cron-auth.test can't exercise offline) actually authorizes, and each
//     route records its cron ledger under its own target name.
//   - tests/plex.test.mts + tests/jellyfin.test.mts OWN the library fetch
//     layers (paging, header pins, field mapping edge cases). Here the fetch is
//     scripted with minimal 1–2 item payloads only to observe what the ROUTE
//     does with the result.
// What THIS file pins — the guardrail-13 contract above all:
//   - `{ "full": true }` is the ONLY body that selects the full-replace path
//     (recentOnly = rawBody.full !== true): full drives Plex /all + a wholesale
//     deleteMany, recentOnly drives Plex /recentlyAdded + Jellyfin's ~2h
//     MinDateLastSaved window (RECENT_WINDOW_MS) and is INSERT-ONLY — any
//     library-table deleteMany on the recentOnly path beyond Plex's
//     ratingKey-scoped stale-mapping clear fails these tests loudly, because an
//     empty window would otherwise nuke the whole library;
//   - full-replace atomicity: the deleteMany and the batchCreateMany repopulate
//     run inside ONE $transaction callback (with the advisory lock and
//     BATCH_TX_TIMEOUT), so a failed insert propagates and rolls the delete
//     back instead of leaving the library empty behind a 2xx;
//   - unconfigured source → 400 with zero fetches; unreachable source → 502
//     with the library untouched; malformed/non-boolean bodies fall back to
//     recentOnly via readJsonCappedOr (guardrail 30's tolerant reader).
//
// No DB and no network: globalThis.prisma is pre-seeded with a recording fake
// BEFORE the module graph loads (the tests/cron-auth.test.mts /
// tests/poster-cache.test.mts idiom), fetch is scripted per test, and the
// server base URLs are RFC1918 IP literals so safeFetchAdminConfigured's SSRF
// stack (allowPrivate=true, isIP short-circuit) needs no DNS stub. Admin
// sessions are REAL jose JWTs against in-memory AuthSession/User rows.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "sync-routes-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000"; // unprefixed cookie name + session trusted origin
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
const CRON_SECRET = "sync-routes-cron-secret-0123456789abcdef"; // ≥32 chars, boot-shaped
process.env.CRON_SECRET = CRON_SECRET;

// ── console capture (guardrail 7: warn/error only, [scope]-prefixed) ────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch ──────────────────────────────────────────────────────────
type FetchCall = { url: URL; method: string };
const fetchCalls: FetchCall[] = [];
let respond: (url: URL) => Response | Promise<Response> = (url) => {
  throw new Error(`unexpected fetch ${url} — script a responder for this test`);
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  fetchCalls.push({ url, method: init?.method ?? "GET" });
  return respond(url);
}) as typeof fetch;

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ── recording fake prisma, seeded on globalThis BEFORE the module graph ─────
type Op = { model: string; method: string; args: unknown };
type TxRecord = { ops: Op[]; timeout: number | undefined; failed: boolean };
const transactions: TxRecord[] = [];
let failCreateManyOn: string | null = null; // tx model whose createMany should throw

const settings = new Map<string, string>();
const settingUpserts: Array<{ key: string; value: string }> = [];
const auditRows: Array<Record<string, unknown>> = [];
const existingPlexByType = new Map<string, number[]>();
const existingJellyfinByType = new Map<string, number[]>();

// verifyAndRefreshSession's DB surface for the admin-session tests (the
// api-auth.test.mts fixture shape — claims always mirror the row, no rotation).
type DbUser = {
  role: string; permissions: bigint; mediaServer: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
  email: string | null; notificationEmail: string | null;
};
const usersById = new Map<string, DbUser>();
const sessionRows = new Set<string>();

type FindManyByTmdbArgs = { where: { mediaType?: string; tmdbId?: { in: number[] } } };
function existingRowsFor(store: Map<string, number[]>, args: FindManyByTmdbArgs) {
  const inList = args.where.tmdbId?.in ?? [];
  const known = store.get(args.where.mediaType ?? "") ?? [];
  return known.filter((id) => inList.includes(id)).map((tmdbId) => ({ tmdbId }));
}

function recordingDelegate(rec: TxRecord, model: string) {
  return {
    deleteMany: async (args?: unknown) => {
      rec.ops.push({ model, method: "deleteMany", args: args ?? null });
      return { count: 0 };
    },
    createMany: async (args: { data: unknown[]; skipDuplicates?: boolean }) => {
      rec.ops.push({ model, method: "createMany", args });
      if (failCreateManyOn === model) throw new Error(`${model} insert exploded (unit test)`);
      return { count: args.data.length };
    },
  };
}

const fakePrisma = {
  setting: {
    findUnique: async (args: { where: { key: string } }) => {
      const value = settings.get(args.where.key);
      return value === undefined ? null : { key: args.where.key, value };
    },
    upsert: async (args: { where: { key: string }; create: { key: string; value: string } }) => {
      settingUpserts.push({ key: args.where.key, value: args.create.value });
      settings.set(args.where.key, args.create.value);
      return args.create;
    },
  },
  plexLibraryItem: {
    findMany: async (args: FindManyByTmdbArgs) => existingRowsFor(existingPlexByType, args),
  },
  jellyfinLibraryItem: {
    findMany: async (args: FindManyByTmdbArgs) => existingRowsFor(existingJellyfinByType, args),
  },
  mediaRequest: { findMany: async () => [] },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
    findMany: async () => [],
    update: async () => ({}),
  },
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) =>
      sessionRows.has(args.where.sessionId)
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
  // The notification CAS (claimAvailableNotificationWinners) must never fire in
  // these fixtures — mediaRequest.findMany returns no pending requests.
  $queryRaw: async () => {
    throw new Error("unexpected prisma.$queryRaw — the notify path must not run in these tests");
  },
  $transaction: async (arg: unknown, opts?: { timeout?: number }) => {
    if (typeof arg === "function") {
      const rec: TxRecord = { ops: [], timeout: opts?.timeout, failed: false };
      transactions.push(rec);
      const tx = {
        $executeRaw: async (strings: TemplateStringsArray, ..._values: unknown[]) => {
          rec.ops.push({ model: "$executeRaw", method: "raw", args: strings.join("?") });
          return 0;
        },
        plexLibraryItem: recordingDelegate(rec, "plexLibraryItem"),
        jellyfinLibraryItem: recordingDelegate(rec, "jellyfinLibraryItem"),
        tVEpisodeCache: recordingDelegate(rec, "tVEpisodeCache"),
      };
      try {
        return await (arg as (t: unknown) => Promise<unknown>)(tx);
      } catch (err) {
        rec.failed = true;
        throw err;
      }
    }
    return Promise.all(arg as Promise<unknown>[]);
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// Dynamic imports so the env/global stubs above genuinely precede the module
// graph (static imports would hoist past them).
const { NextRequest } = await import("next/server");
const { BATCH_TX_TIMEOUT, parseCronLastRun } = await import("../src/lib/cron-auth.ts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { POST: postPlexSync } = await import("../src/app/api/sync/plex/route.ts");
const { POST: postJellyfinSync } = await import("../src/app/api/sync/jellyfin/route.ts");

type Req = InstanceType<typeof NextRequest>;

// ── fixtures ────────────────────────────────────────────────────────────────
const COOKIE = getSessionCookieName(); // "summonarr-session" under the http AUTH_URL
const PLEX_BASE = "http://10.77.0.1:32400"; // RFC1918 literal: admin SSRF mode, no DNS
const JF_BASE = "http://10.77.0.2:8096";
const AS_CRON = { authorization: `Bearer ${CRON_SECRET}` };

function syncReq(path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Req {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: opts.headers,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
}
const plexReq = (opts: { headers?: Record<string, string>; body?: string } = {}) =>
  syncReq("/api/sync/plex", opts);
const jfReq = (opts: { headers?: Record<string, string>; body?: string } = {}) =>
  syncReq("/api/sync/jellyfin", opts);

function configurePlex(): void {
  settings.set("plexServerUrl", PLEX_BASE);
  settings.set("plexAdminToken", "plex-admin-token-1");
}
function configureJellyfin(): void {
  settings.set("jellyfinUrl", JF_BASE);
  settings.set("jellyfinApiKey", "jf-api-key-1");
}

let seq = 0;
async function mintSession(role: string): Promise<{ userId: string; token: string }> {
  seq++;
  const userId = `sync-user-${seq}`;
  const sessionId = `sync-sess-${seq}`;
  usersById.set(userId, {
    role, permissions: 0n, mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: "admin@example.com", notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const token = await signSessionJwt(
    {
      id: userId, role, permissions: "0", provider: "credentials", sessionId,
      expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    },
    { expiresInSeconds: 7_200 },
  );
  return { userId, token };
}

// Minimal one-section movie library. No show sections, so the TV fetch and the
// episode-cache fire-and-forget resolve without extra requests, keeping the
// library write the only interesting output.
function plexMovieResponder(items: unknown[]): (url: URL) => Response {
  return (url) => {
    if (url.pathname === "/library/sections") {
      return okJson({ MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie" }] } });
    }
    if (url.pathname === "/library/sections/1/recentlyAdded" || url.pathname === "/library/sections/1/all") {
      return okJson({ MediaContainer: { totalSize: items.length, Metadata: items } });
    }
    throw new Error(`unexpected Plex fetch ${url}`);
  };
}
function jellyfinMovieResponder(items: unknown[]): (url: URL) => Response {
  return (url) => {
    if (url.pathname === "/Items" && url.searchParams.get("IncludeItemTypes") === "Movie") {
      return okJson({ Items: items, TotalRecordCount: items.length });
    }
    if (url.pathname === "/Items" && url.searchParams.get("IncludeItemTypes") === "Series") {
      return okJson({ Items: [], TotalRecordCount: 0 });
    }
    throw new Error(`unexpected Jellyfin fetch ${url}`);
  };
}

// Wire payloads + the exact rows the route must derive from them (including the
// sanitizeStr `<>`-strip and the epoch-seconds → Date conversion).
const PLEX_ITEM_FULL = {
  ratingKey: "rk603", type: "movie", title: "Evil <Movie> One", year: 1999,
  summary: "A hacker learns the truth.", contentRating: "R", addedAt: 1_700_000_000,
  Guid: [{ id: "tmdb://603" }],
  Media: [{ Part: [{ file: "/data/movies/one.mkv" }] }],
};
const PLEX_ITEM_MIN = { ratingKey: "rk604", type: "movie", title: "Two", Guid: [{ id: "tmdb://604" }] };
const PLEX_ROW_603 = {
  tmdbId: 603, mediaType: "MOVIE", filePath: "/data/movies/one.mkv", plexRatingKey: "rk603",
  title: "Evil Movie One", year: "1999", overview: "A hacker learns the truth.",
  contentRating: "R", addedAt: new Date(1_700_000_000 * 1000),
};
const PLEX_ROW_604 = {
  tmdbId: 604, mediaType: "MOVIE", filePath: null, plexRatingKey: "rk604",
  title: "Two", year: null, overview: null, contentRating: null, addedAt: null,
};

const JF_ITEM_FULL = {
  Id: "jf-550", Name: "Fight <b>Club</b>", Path: "/media/movies/fc.mkv", ProductionYear: 1999,
  Overview: "Rules apply.", OfficialRating: "R", CommunityRating: 8.8,
  DateCreated: "2026-07-01T00:00:00.000Z", ProviderIds: { Tmdb: "550" },
};
const JF_ITEM_MIN = { Id: "jf-551", Name: "Second", ProviderIds: { Tmdb: "551" } };
const JF_ROW_550 = {
  tmdbId: 550, mediaType: "MOVIE", filePath: "/media/movies/fc.mkv", jellyfinItemId: "jf-550",
  title: "Fight bClub/b", year: "1999", overview: "Rules apply.", contentRating: "R",
  communityRating: 8.8, addedAt: new Date("2026-07-01T00:00:00.000Z"),
};
const JF_ROW_551 = {
  tmdbId: 551, mediaType: "MOVIE", filePath: null, jellyfinItemId: "jf-551",
  title: "Second", year: null, overview: null, contentRating: null,
  communityRating: null, addedAt: null,
};

// ── assertion helpers ───────────────────────────────────────────────────────
const LIBRARY_MODELS = ["plexLibraryItem", "jellyfinLibraryItem"] as const;

function opsFor(model: string, method?: string): Op[] {
  return transactions
    .flatMap((t) => t.ops)
    .filter((o) => o.model === model && (method === undefined || o.method === method));
}

// The transaction that touched a library table (the episode-cache
// fire-and-forget writes only tVEpisodeCache, so this filter isolates the
// library write cleanly).
function libraryTx(model: (typeof LIBRARY_MODELS)[number]): TxRecord {
  const matches = transactions.filter((t) => t.ops.some((o) => o.model === model));
  assert.equal(matches.length, 1, `expected exactly one ${model} transaction, saw ${matches.length}`);
  return matches[0];
}

function assertNoLibraryDeletes(model: (typeof LIBRARY_MODELS)[number]): void {
  assert.equal(
    opsFor(model, "deleteMany").length,
    0,
    `guardrail 13 violated: the recentOnly path issued a ${model}.deleteMany — recentOnly is ` +
      "insert-only, and a delete here nukes the whole library whenever the 2h window is empty",
  );
}

function ledgerFor(target: string): ReturnType<typeof parseCronLastRun> {
  const write = settingUpserts.filter((u) => u.key === `cron:lastRun:${target}`).at(-1);
  return write ? parseCronLastRun(write.value) : null;
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// Let the episode-cache fire-and-forget (and void logAudit) settle before
// assertions / the next test's reset — the route deliberately does not await
// them.
async function settleFireAndForget(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  transactions.length = 0;
  settingUpserts.length = 0;
  auditRows.length = 0;
  settings.clear();
  existingPlexByType.clear();
  existingJellyfinByType.clear();
  failCreateManyOn = null;
  respond = (url) => {
    throw new Error(`unexpected fetch ${url} — script a responder for this test`);
  };
});

// ── auth gating (guardrail 6: the routes funnel through isCronAuthorized) ───

test("unauthenticated POST → 403 Forbidden before any body read, fetch, DB write, or ledger record", async () => {
  for (const [label, post] of [["plex", postPlexSync], ["jellyfin", postJellyfinSync]] as const) {
    const res = await post(label === "plex" ? plexReq() : jfReq());
    assert.equal(res.status, 403, `${label}: unauthenticated must be 403`);
    assert.deepEqual(await bodyOf(res), { error: "Forbidden" });
  }
  await settleFireAndForget();
  assert.equal(fetchCalls.length, 0, "the auth gate must run before any upstream fetch");
  assert.equal(transactions.length, 0, "no DB transaction may run for an unauthorized caller");
  assert.equal(settingUpserts.length, 0, "withCronRunRecording must not be entered pre-auth (no ledger row)");
  assert.equal(auditRows.length, 0);
});

test("a wrong bearer secret → 403 with zero fetches (route wiring; compare internals owned by cron-auth tests)", async () => {
  const headers = { authorization: "Bearer definitely-not-the-cron-secret-0123456789" };
  for (const [label, post] of [["plex", postPlexSync], ["jellyfin", postJellyfinSync]] as const) {
    const res = await post(label === "plex" ? plexReq({ headers }) : jfReq({ headers }));
    assert.equal(res.status, 403, `${label}: a wrong secret must fail closed`);
  }
  assert.equal(fetchCalls.length, 0);
  assert.equal(transactions.length, 0);
});

test("Bearer CRON_SECRET authorizes; an unconfigured source then 400s with zero fetches and an ok:false ledger row", async () => {
  // No plexServerUrl/jellyfinUrl Settings at all. 400 (not 403) proves the auth
  // gate opened; the config guard must reject before any upstream request.
  const plexRes = await postPlexSync(plexReq({ headers: AS_CRON }));
  assert.equal(plexRes.status, 400);
  assert.deepEqual(await bodyOf(plexRes), { error: "Plex server not configured" });

  const jfRes = await postJellyfinSync(jfReq({ headers: AS_CRON }));
  assert.equal(jfRes.status, 400);
  assert.deepEqual(await bodyOf(jfRes), { error: "Jellyfin server not configured" });

  await settleFireAndForget();
  assert.equal(fetchCalls.length, 0, "an unconfigured source must never be fetched");
  assert.equal(transactions.length, 0);
  // The routes' withCronRunRecording targets are pinned here: per-route ledger
  // keys, recording the 400 as a failed run (status >= 400 ⇒ ok:false).
  assert.equal(ledgerFor("plex-sync")?.ok, false);
  assert.equal(ledgerFor("jellyfin-sync")?.ok, false);
});

test("an ADMIN cookie session (DB-checked, same-origin) authorizes and attributes a LIBRARY_SYNC audit row; a USER session cannot sync", async () => {
  configurePlex();
  respond = plexMovieResponder([PLEX_ITEM_FULL, PLEX_ITEM_MIN]);
  const admin = await mintSession("ADMIN");
  const adminHeaders = {
    cookie: `${COOKIE}=${admin.token}`,
    origin: "http://localhost:3000", // isCronAuthorized's admin path enforces same-origin
  };
  const res = await postPlexSync(plexReq({ headers: adminHeaders, body: JSON.stringify({ full: true }) }));
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), {
    scanned: { movies: 2, tv: 0 },
    checked: 0,
    marked: 0,
    full: true,
  });
  await settleFireAndForget();
  assert.equal(auditRows.length, 1, "an admin-triggered sync must write the LIBRARY_SYNC audit row");
  assert.equal(auditRows[0].action, "LIBRARY_SYNC");
  assert.equal(auditRows[0].target, "sync:plex");
  assert.equal(auditRows[0].userId, admin.userId);

  // A plain USER session must not drive a sync — 403, no further audit.
  const user = await mintSession("USER");
  const denied = await postPlexSync(
    plexReq({ headers: { cookie: `${COOKIE}=${user.token}`, origin: "http://localhost:3000" } }),
  );
  assert.equal(denied.status, 403);
  await settleFireAndForget();
  assert.equal(auditRows.length, 1);
});

// ── guardrail 13: the { full: true } body flag and its two write modes ──────

test("plex { full: true } → /all fetch and a full replace: deleteMany + repopulate INSIDE ONE transaction with BATCH_TX_TIMEOUT", async () => {
  configurePlex();
  respond = plexMovieResponder([PLEX_ITEM_FULL, PLEX_ITEM_MIN]);
  const res = await postPlexSync(plexReq({ headers: AS_CRON, body: JSON.stringify({ full: true }) }));
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), { scanned: { movies: 2, tv: 0 }, checked: 0, marked: 0, full: true });
  await settleFireAndForget();

  // The full flag reaches the fetch layer: the movie page is /all, never the
  // recentOnly /recentlyAdded window. Exactly two requests — one sections
  // listing, one movie page (the pre-fetched sections list is reused by the TV
  // and episode passes, which have no show sections to visit).
  const paths = fetchCalls.map((c) => c.url.pathname);
  assert.equal(fetchCalls.length, 2);
  assert.ok(paths.includes("/library/sections/1/all"), "full sync must page the /all listing");
  assert.ok(!paths.some((p) => p.includes("recentlyAdded")), "full sync must not use /recentlyAdded");

  // Atomicity structure (guardrail 13): the wholesale delete and the repopulate
  // share one $transaction callback under the Plex advisory lock — if the
  // insert fails, Postgres rolls the delete back and the library survives.
  const tx = libraryTx("plexLibraryItem");
  assert.equal(tx.timeout, BATCH_TX_TIMEOUT, "library-sized writes must pass BATCH_TX_TIMEOUT (guardrail 4)");
  assert.equal(BATCH_TX_TIMEOUT, 30_000);
  assert.deepEqual(tx.ops, [
    { model: "$executeRaw", method: "raw", args: "SELECT pg_advisory_xact_lock(2001, 1)" },
    { model: "plexLibraryItem", method: "deleteMany", args: { where: { mediaType: "MOVIE" } } },
    { model: "plexLibraryItem", method: "deleteMany", args: { where: { mediaType: "TV" } } },
    {
      model: "plexLibraryItem",
      method: "createMany",
      // Field mapping pinned: tmdb guid → tmdbId, sanitizeStr strips <>, year
      // stringified, addedAt epoch-seconds → Date, absent fields → null.
      args: { data: [PLEX_ROW_603, PLEX_ROW_604], skipDuplicates: true },
    },
  ]);

  assert.ok(settings.has("lastPlexSyncSucceededAt"), "success must stamp the orchestrator-staleness marker");
  assert.equal(ledgerFor("plex-sync")?.ok, true);
  assert.equal(auditRows.length, 0, "a CRON_SECRET run has no session to attribute — no audit row");
});

test("plex bodyless POST is recentOnly: /recentlyAdded fetch, insert-only of NEW tmdbIds, and ONLY the ratingKey-scoped stale-mapping clear", async () => {
  configurePlex();
  existingPlexByType.set("MOVIE", [603]); // tmdb 603 already in the library
  respond = plexMovieResponder([PLEX_ITEM_FULL, PLEX_ITEM_MIN]);
  const res = await postPlexSync(plexReq({ headers: AS_CRON })); // no body ⇒ recentOnly
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), { scanned: { movies: 2, tv: 0 }, checked: 0, marked: 0, full: false });
  await settleFireAndForget();

  const paths = fetchCalls.map((c) => c.url.pathname);
  assert.ok(paths.includes("/library/sections/1/recentlyAdded"), "recentOnly must page /recentlyAdded");
  assert.ok(!paths.includes("/library/sections/1/all"), "recentOnly must not page the full /all listing");

  // Insert-only: the already-present tmdbId is filtered out, so only 604 is
  // inserted (skipDuplicates on, per batchCreateMany).
  const creates = opsFor("plexLibraryItem", "createMany");
  assert.deepEqual(
    creates.map((c) => c.args),
    [{ data: [PLEX_ROW_604], skipDuplicates: true }],
    "recentOnly must insert only rows whose tmdbId is not already in the library",
  );

  // Guardrail 13: the ONLY delete the Plex recentOnly path may issue is the
  // stale plexRatingKey→tmdbId mapping clear, scoped to EXACTLY the incoming
  // batch's ratingKeys. Any wholesale (mediaType-scoped or unscoped) deleteMany
  // here is the library-nuking bug the guardrail exists to prevent.
  const deletes = opsFor("plexLibraryItem", "deleteMany");
  assert.deepEqual(
    deletes.map((d) => d.args),
    [{ where: { plexRatingKey: { in: ["rk604"] } } }],
    "guardrail 13 violated: the Plex recentOnly path may only clear stale mappings for the " +
      "incoming batch's ratingKeys — any other deleteMany nukes the library when the window is empty",
  );
});

test("the full flag is strictly boolean true: a truthy non-true value and a malformed body both fall back to recentOnly", async () => {
  configurePlex();
  respond = plexMovieResponder([]);

  // rawBody.full !== true — the string "yes" must NOT select the full path.
  const truthy = await postPlexSync(plexReq({ headers: AS_CRON, body: JSON.stringify({ full: "yes" }) }));
  assert.equal(truthy.status, 200);
  assert.equal((await bodyOf(truthy)).full, false);

  // readJsonCappedOr tolerance (guardrail 30): malformed JSON is a valid
  // "no options" request, not a 400 — and it lands on the SAFE (recentOnly)
  // side, never on the full-replace side.
  const malformed = await postPlexSync(plexReq({ headers: AS_CRON, body: "{{{not json" }));
  assert.equal(malformed.status, 200);
  assert.equal((await bodyOf(malformed)).full, false);

  await settleFireAndForget();
  const paths = fetchCalls.map((c) => c.url.pathname);
  assert.equal(paths.filter((p) => p === "/library/sections/1/recentlyAdded").length, 2);
  assert.ok(!paths.includes("/library/sections/1/all"));
});

test("guardrail 13: an EMPTY recentOnly window deletes NOTHING on either source (the nuke guard)", async () => {
  configurePlex();
  configureJellyfin();
  respond = (url) =>
    url.origin === PLEX_BASE ? plexMovieResponder([])(url) : jellyfinMovieResponder([])(url);

  const plexRes = await postPlexSync(plexReq({ headers: AS_CRON }));
  assert.deepEqual(await bodyOf(plexRes), { scanned: { movies: 0, tv: 0 }, checked: 0, marked: 0, full: false });
  const jfRes = await postJellyfinSync(jfReq({ headers: AS_CRON }));
  assert.deepEqual(await bodyOf(jfRes), { scanned: { movies: 0, tv: 0 }, checked: 0, marked: 0, full: false });
  await settleFireAndForget();

  // The single most important property of the recentOnly contract: an empty
  // 2h window is a NO-OP on the library tables, never a wipe.
  assertNoLibraryDeletes("plexLibraryItem");
  assertNoLibraryDeletes("jellyfinLibraryItem");
  for (const model of LIBRARY_MODELS) {
    assert.equal(opsFor(model, "createMany").length, 0, `${model}: nothing to insert from an empty window`);
  }
});

// ── the Jellyfin recentOnly window and full replace ─────────────────────────

test("jellyfin recentOnly rides a ~2h MinDateLastSaved window (RECENT_WINDOW_MS) and is insert-only — zero deleteMany", async () => {
  configureJellyfin();
  existingJellyfinByType.set("MOVIE", [550]); // tmdb 550 already in the library
  respond = jellyfinMovieResponder([JF_ITEM_FULL, JF_ITEM_MIN]);
  const before = Date.now();
  const res = await postJellyfinSync(jfReq({ headers: AS_CRON }));
  const after = Date.now();
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), { scanned: { movies: 2, tv: 0 }, checked: 0, marked: 0, full: false });
  await settleFireAndForget();

  // The 2-hour window (intentionally wider than the 1h sync interval so one
  // missed run is survivable) must reach the wire as MinDateLastSaved.
  const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;
  const movieFetch = fetchCalls.find(
    (c) => c.url.pathname === "/Items" && c.url.searchParams.get("IncludeItemTypes") === "Movie",
  );
  assert.ok(movieFetch, "expected a Movie /Items fetch");
  const minDateParam = movieFetch.url.searchParams.get("MinDateLastSaved");
  assert.ok(minDateParam, "recentOnly must send the MinDateLastSaved window");
  const minDateMs = Date.parse(minDateParam);
  assert.ok(
    minDateMs >= before - RECENT_WINDOW_MS && minDateMs <= after - RECENT_WINDOW_MS,
    `MinDateLastSaved must sit exactly RECENT_WINDOW_MS (2h) in the past — got ${minDateParam}`,
  );

  // Guardrail 13: the Jellyfin recentOnly path has NO delete of any kind.
  assertNoLibraryDeletes("jellyfinLibraryItem");
  const creates = opsFor("jellyfinLibraryItem", "createMany");
  assert.deepEqual(
    creates.map((c) => c.args),
    [{ data: [JF_ROW_551], skipDuplicates: true }],
    "recentOnly must insert only the NEW tmdbId, with skipDuplicates on",
  );
});

test("jellyfin { full: true } → NO MinDateLastSaved; wholesale deleteMany + repopulate share one BATCH_TX_TIMEOUT transaction", async () => {
  configureJellyfin();
  respond = jellyfinMovieResponder([JF_ITEM_FULL, JF_ITEM_MIN]);
  const res = await postJellyfinSync(jfReq({ headers: AS_CRON, body: JSON.stringify({ full: true }) }));
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), { scanned: { movies: 2, tv: 0 }, checked: 0, marked: 0, full: true });
  await settleFireAndForget();

  const movieFetch = fetchCalls.find(
    (c) => c.url.pathname === "/Items" && c.url.searchParams.get("IncludeItemTypes") === "Movie",
  );
  assert.ok(movieFetch);
  assert.equal(
    movieFetch.url.searchParams.get("MinDateLastSaved"),
    null,
    "a full sync must fetch the WHOLE library — no recentOnly window param",
  );

  const tx = libraryTx("jellyfinLibraryItem");
  assert.equal(tx.timeout, BATCH_TX_TIMEOUT);
  assert.deepEqual(tx.ops, [
    { model: "$executeRaw", method: "raw", args: "SELECT pg_advisory_xact_lock(2001, 2)" },
    // Unscoped deleteMany (args null = called with no filter): the full path
    // replaces the whole table — inside the same tx as the repopulate.
    { model: "jellyfinLibraryItem", method: "deleteMany", args: null },
    {
      model: "jellyfinLibraryItem",
      method: "createMany",
      args: { data: [JF_ROW_550, JF_ROW_551], skipDuplicates: true },
    },
  ]);
  assert.ok(settings.has("lastJellyfinSyncSucceededAt"));
  assert.equal(ledgerFor("jellyfin-sync")?.ok, true);
});

// ── failure paths ───────────────────────────────────────────────────────────

test("an unreachable source → 502, the library untouched (zero transactions), and an ok:false ledger row", async () => {
  configurePlex();
  configureJellyfin();
  respond = (url) => {
    if (url.origin === PLEX_BASE) return new Response("boom", { status: 500 });
    // 401 fast-fails jellyfin's fetchPage on the first attempt (no retry loop).
    return new Response("unauthorized", { status: 401 });
  };

  const plexRes = await postPlexSync(plexReq({ headers: AS_CRON, body: JSON.stringify({ full: true }) }));
  assert.equal(plexRes.status, 502);
  assert.deepEqual(await bodyOf(plexRes), { error: "Could not reach Plex server" });

  const jfRes = await postJellyfinSync(jfReq({ headers: AS_CRON, body: JSON.stringify({ full: true }) }));
  assert.equal(jfRes.status, 502);
  assert.deepEqual(await bodyOf(jfRes), { error: "Could not reach Jellyfin server" });

  await settleFireAndForget();
  // The fetch precedes every write: a failed FULL sync must return before any
  // deleteMany can run, so the existing library rows survive the outage.
  assert.equal(transactions.length, 0, "a failed library fetch must not open any write transaction");
  assert.ok(errors.some((e) => e.includes("[sync/plex] Failed to fetch library:")));
  assert.ok(errors.some((e) => e.includes("[sync/jellyfin] Failed to fetch library:")));
  assert.equal(ledgerFor("plex-sync")?.ok, false);
  assert.equal(ledgerFor("jellyfin-sync")?.ok, false);
  assert.ok(!settings.has("lastPlexSyncSucceededAt"), "a failed run must not stamp last-success");
  assert.ok(!settings.has("lastJellyfinSyncSucceededAt"));
});

test("a failed full-replace insert propagates out of the SHARED transaction (rollback covers the delete) and records ok:false", async () => {
  configureJellyfin();
  respond = jellyfinMovieResponder([JF_ITEM_MIN]);
  failCreateManyOn = "jellyfinLibraryItem";

  // The throw must escape the route (withCronRunRecording rethrows after the
  // ledger write) — swallowing it inside the tx would commit the delete with
  // nothing repopulated (guardrail 23's failure mode).
  await assert.rejects(
    postJellyfinSync(jfReq({ headers: AS_CRON, body: JSON.stringify({ full: true }) })),
    /jellyfinLibraryItem insert exploded/,
  );
  await settleFireAndForget();

  // Code-structure pin for guardrail 13's atomicity leg: the wholesale delete
  // and the failed repopulate sit in the SAME transaction callback, so the
  // real Postgres rollback discards the delete when the insert throws.
  const tx = libraryTx("jellyfinLibraryItem");
  assert.equal(tx.failed, true);
  const methods = tx.ops.filter((o) => o.model === "jellyfinLibraryItem").map((o) => o.method);
  assert.deepEqual(
    methods,
    ["deleteMany", "createMany"],
    "the deleteMany and the failing createMany must share one $transaction callback — " +
      "splitting them would leave the library deleted with nothing repopulated",
  );
  assert.equal(ledgerFor("jellyfin-sync")?.ok, false);
});
