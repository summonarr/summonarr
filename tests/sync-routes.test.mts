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
// Top-level (non-tx) $executeRaw statements — the plex route's show file-path
// patch (patchPlexShowFilePaths) issues ONE VALUES-joined UPDATE per chunk here.
const rawStatements: Array<{ sql: string; values: unknown[] }> = [];
let failCreateManyOn: string | null = null; // tx model whose createMany should throw

const settings = new Map<string, string>();
// Opt-in fixtures for the marking / notify pass. Empty by default so every existing
// test keeps the "notify path never runs" guarantee above.
interface PendingRequest {
  id: string; tmdbId: number; mediaType: "MOVIE" | "TV"; requestedBy: string;
  title: string; posterPath: string | null; notifiedAvailable: boolean;
}
interface RequesterRow {
  id: string; role: string; permissions: bigint; mediaServerGrants: unknown; mediaServer: string | null;
  // Optional so the existing visibility fixtures stay untouched: absent ⇒ active.
  deactivatedAt?: Date | null;
}
let pendingRequests: PendingRequest[] = [];
let requesterRows: RequesterRow[] = [];
let casCalls = 0;
// Ids the notifiedAvailable CAS should report as winners. Default [] — every
// existing test keeps the "nothing was claimed, so the notify path stops here"
// behaviour it was written against.
let casWinnerIds: string[] = [];
const requestUpdateManys: unknown[] = [];
// clearDeletionVotesForTmdbs' two writes + the in-app inbox fan-out. All three
// are only reachable once the CAS actually returns a winner.
const deletionVoteDeleteWheres: Array<Record<string, unknown> | undefined> = [];
const settingDeleteManyWheres: Array<Record<string, unknown> | undefined> = [];
const notificationCreateManyData: Array<Record<string, unknown>> = [];

const settingUpserts: Array<{ key: string; value: string }> = [];
const auditRows: Array<Record<string, unknown>> = [];
const existingPlexByType = new Map<string, number[]>();
const existingJellyfinByType = new Map<string, number[]>();
const plexFindManyWheres: Array<Record<string, unknown>> = []; // every plexLibraryItem.findMany where (dedupe + recentOnly reads)

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
    // Reached only once a claim produces deliverable winners: the Discord and
    // push channels batch-read their config through it, and both short-circuit
    // on the empty result an unconfigured harness gives them.
    findMany: async (args: { where: { key: { in: string[] } } }) =>
      args.where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) as string })),
    deleteMany: async (args?: { where?: Record<string, unknown> }) => {
      settingDeleteManyWheres.push(args?.where);
      return { count: 0 };
    },
  },
  deletionVote: {
    deleteMany: async (args?: { where?: Record<string, unknown> }) => {
      deletionVoteDeleteWheres.push(args?.where);
      return { count: 0 };
    },
  },
  notification: {
    createMany: async (args: { data: Record<string, unknown>[] }) => {
      notificationCreateManyData.push(...args.data);
      return { count: args.data.length };
    },
  },
  // Never reached with push unconfigured (pushContext() returns null first), but
  // stubbed so a regression surfaces as an assertion rather than a TypeError
  // swallowed by the channel's own try/catch.
  pushSubscription: { findMany: async () => [] },
  plexLibraryItem: {
    findMany: async (args: FindManyByTmdbArgs) => {
      plexFindManyWheres.push(args.where as Record<string, unknown>);
      return existingRowsFor(existingPlexByType, args);
    },
  },
  jellyfinLibraryItem: {
    findMany: async (args: FindManyByTmdbArgs) => existingRowsFor(existingJellyfinByType, args),
  },
  mediaRequest: {
    findMany: async () => pendingRequests.map((r) => ({ ...r })),
    updateMany: async (args: unknown) => {
      requestUpdateManys.push(args);
      return { count: 0 };
    },
  },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
    findMany: async (args: { where?: { id?: { in?: string[] }; deactivatedAt?: unknown } }) => {
      const want = args?.where?.id?.in;
      if (!want) return [];
      const rows = requesterRows.filter((u) => want.includes(u.id));
      // claimAvailableNotifications asks for the DISABLED subset so it can drop
      // those recipients. Honour the predicate — answering with every id would
      // read as "everyone is disabled" and silently suppress every notification.
      if (args?.where?.deactivatedAt !== undefined) {
        return rows.filter((u) => u.deactivatedAt != null).map((u) => ({ id: u.id }));
      }
      return rows.map((u) => ({ ...u }));
    },
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
  // The notification CAS (claimAvailableNotificationWinners) is raw SQL. With no
  // pending requests it must never fire, and throwing keeps that guarantee for every
  // fixture that does not opt in. The visibility tests below DO seed pending
  // requests, so there the call is counted instead — reaching the CAS at all is the
  // failure those tests are looking for.
  $queryRaw: async () => {
    if (pendingRequests.length === 0) {
      throw new Error("unexpected prisma.$queryRaw — the notify path must not run in these tests");
    }
    casCalls++;
    return casWinnerIds.map((id) => ({ id }));
  },
  $executeRaw: async (query: { sql: string; values: unknown[] }) => {
    rawStatements.push({ sql: query.sql, values: query.values ?? [] });
    return 0;
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
// One TMDB-identified Series (plus its single episode) so the episode-cache
// fire-and-forget has real work to do: getJellyfinTVEpisodes short-circuits on an
// empty series map, so a movies-only fixture would report "zero Episode fetches"
// no matter what the route does.
function jellyfinSeriesResponder(): (url: URL) => Response {
  return (url) => {
    if (url.pathname !== "/Items") throw new Error(`unexpected Jellyfin fetch ${url}`);
    switch (url.searchParams.get("IncludeItemTypes")) {
      case "Movie":
        return okJson({ Items: [], TotalRecordCount: 0 });
      case "Series":
        return okJson({
          Items: [{ Id: "jf-show-1", Name: "Show One", ProviderIds: { Tmdb: "1399" } }],
          TotalRecordCount: 1,
        });
      case "Episode":
        return okJson({
          Items: [{ SeriesId: "jf-show-1", ParentIndexNumber: 1, IndexNumber: 1 }],
          TotalRecordCount: 1,
        });
      default:
        throw new Error(`unexpected Jellyfin fetch ${url}`);
    }
  };
}
const episodeFetches = () =>
  fetchCalls.filter((c) => c.url.pathname === "/Items" && c.url.searchParams.get("IncludeItemTypes") === "Episode");

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
  // serverInstance is part of every row pin: the deletes on these routes are scoped
  // to the instance, so a row written without it lands on the DEFAULT server and
  // silently relocates a named server's whole library.
  tmdbId: 603, serverInstance: "", mediaType: "MOVIE", filePath: "/data/movies/one.mkv", plexRatingKey: "rk603",
  title: "Evil Movie One", year: "1999", overview: "A hacker learns the truth.",
  contentRating: "R", addedAt: new Date(1_700_000_000 * 1000),
};
const PLEX_ROW_604 = {
  tmdbId: 604, serverInstance: "", mediaType: "MOVIE", filePath: null, plexRatingKey: "rk604",
  title: "Two", year: null, overview: null, contentRating: null, addedAt: null,
};

const JF_ITEM_FULL = {
  Id: "jf-550", Name: "Fight <b>Club</b>", Path: "/media/movies/fc.mkv", ProductionYear: 1999,
  Overview: "Rules apply.", OfficialRating: "R", CommunityRating: 8.8,
  DateCreated: "2026-07-01T00:00:00.000Z", ProviderIds: { Tmdb: "550" },
};
const JF_ITEM_MIN = { Id: "jf-551", Name: "Second", ProviderIds: { Tmdb: "551" } };
// jellyfinItemIds carries EVERY id the title occupies, the stored one included
// (guardrail 37) — a single-copy item is therefore a one-element array, not [].
const JF_ROW_550 = {
  tmdbId: 550, serverInstance: "", mediaType: "MOVIE", filePath: "/media/movies/fc.mkv", jellyfinItemId: "jf-550",
  jellyfinItemIds: ["jf-550"],
  title: "Fight bClub/b", year: "1999", overview: "Rules apply.", contentRating: "R",
  communityRating: 8.8, addedAt: new Date("2026-07-01T00:00:00.000Z"),
};
const JF_ROW_551 = {
  tmdbId: 551, serverInstance: "", mediaType: "MOVIE", filePath: null, jellyfinItemId: "jf-551",
  jellyfinItemIds: ["jf-551"],
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
  rawStatements.length = 0;
  settingUpserts.length = 0;
  auditRows.length = 0;
  settings.clear();
  existingPlexByType.clear();
  existingJellyfinByType.clear();
  plexFindManyWheres.length = 0;
  failCreateManyOn = null;
  pendingRequests = [];
  requesterRows = [];
  requestUpdateManys.length = 0;
  casCalls = 0;
  casWinnerIds = [];
  deletionVoteDeleteWheres.length = 0;
  settingDeleteManyWheres.length = 0;
  notificationCreateManyData.length = 0;
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
    // Default-instance-scoped (multi-server, Phase 2): this route only syncs the
    // default ("") Plex server, so its full replace must leave any named
    // instance's rows alone — an unscoped delete would wipe them.
    { model: "plexLibraryItem", method: "deleteMany", args: { where: { mediaType: "MOVIE", serverInstance: "" } } },
    { model: "plexLibraryItem", method: "deleteMany", args: { where: { mediaType: "TV", serverInstance: "" } } },
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
  // batch's ratingKeys AND to the default instance (ratingKeys are server-local
  // integers, so a named instance can legitimately hold the same key for a
  // different title). Any wholesale (mediaType-scoped or unscoped) deleteMany
  // here is the library-nuking bug the guardrail exists to prevent.
  const deletes = opsFor("plexLibraryItem", "deleteMany");
  assert.deepEqual(
    deletes.map((d) => d.args),
    [{ where: { serverInstance: "", plexRatingKey: { in: ["rk604"] } } }],
    "guardrail 13 violated: the Plex recentOnly path may only clear stale mappings for the " +
      "incoming batch's ratingKeys (default instance only) — any other deleteMany nukes the library when the window is empty",
  );
});

test("a named instance resyncs ITS OWN rows: config, selection and every delete follow the slug", async () => {
  configurePlex();
  settings.set("plexRemoteServerUrl", PLEX_BASE);
  settings.set("plexRemoteAdminToken", "plex-admin-token-remote");
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  // A REAL Plex metadata item: tmdbId is carried in Guid, so a bare
  // `{ tmdbId, ratingKey }` parses to nothing and the library comes back empty.
  // The delete assertions below pass either way (a full replace deletes
  // unconditionally), so an empty fixture silently made this test weaker than it
  // reads — the insert assertions are what require real rows.
  respond = plexMovieResponder([
    { ratingKey: "rk700", type: "movie", title: "Seven Hundred", Guid: [{ id: "tmdb://700" }] },
  ]);

  const res = await postPlexSync(plexReq({ headers: AS_CRON, body: JSON.stringify({ full: true, instance: "remote" }) }));
  assert.equal(res.status, 200);
  await settleFireAndForget();

  // Every scoped write must name the instance being resynced. A delete that
  // still said "" would wipe the DEFAULT server's library on a resync the admin
  // aimed at a different server entirely.
  const deletes = opsFor("plexLibraryItem", "deleteMany");
  assert.ok(deletes.length > 0, "a full resync must delete before repopulating");
  for (const d of deletes) {
    const where = (d.args as { where?: { serverInstance?: unknown } }).where ?? {};
    assert.equal(where.serverInstance, "remote", `a delete escaped the instance scope: ${JSON.stringify(where)}`);
  }

  // ...and so must every INSERTED row. Scoped deletes with UNSCOPED inserts is
  // strictly worse than doing neither: the named server's rows are deleted and
  // re-created under the schema default "", relocating its entire library onto the
  // DEFAULT server — which un-restricts a restricted server (slug "" is visible to
  // everyone) and drops its server-local ratingKeys into the default's namespace.
  const creates = opsFor("plexLibraryItem", "createMany");
  assert.ok(creates.length > 0, "a full resync must repopulate");
  for (const c of creates) {
    for (const row of (c.args as { data: Array<{ serverInstance?: unknown }> }).data) {
      assert.equal(row.serverInstance, "remote", `an inserted row escaped the instance scope: ${JSON.stringify(row)}`);
    }
  }
});

test("a malformed instance slug is REJECTED, never coerced to the default", async () => {
  // Coercion would aim a destructive scoped delete at the default server on a
  // request that named something else — the worst possible reading of bad input.
  configurePlex();
  respond = plexMovieResponder([]);
  const res = await postPlexSync(plexReq({ headers: AS_CRON, body: JSON.stringify({ full: true, instance: "../../etc" }) }));
  assert.equal(res.status, 400);
  const deletes = opsFor("plexLibraryItem", "deleteMany");
  assert.equal(deletes.length, 0, "a rejected request must not have deleted anything");
});

test("with a SECOND Plex server registered, a resync leaves the shared TVEpisodeCache alone", async () => {
  // TVEpisodeCache has no serverInstance: every Plex server shares one
  // `source: "plex"` namespace. This route used to delete that namespace
  // unscoped and repopulate from one server, destroying every other server's
  // episode rows until the next orchestrator run. It can only own the cache when
  // it is the only Plex server.
  configurePlex();
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  respond = plexMovieResponder([{ tmdbId: 700, ratingKey: "rk700" }]);

  const res = await postPlexSync(plexReq({ headers: AS_CRON, body: JSON.stringify({ full: true }) }));
  assert.equal(res.status, 200);
  await settleFireAndForget();

  const episodeOps = transactions.flatMap((t) => t.ops).filter((o) => o.model === "tVEpisodeCache");
  assert.deepEqual(episodeOps, [], "the shared episode cache must not be touched while another Plex server exists");
});

test("as the ONLY Plex server it still rewrites the episode cache — single-server behaviour is unchanged", async () => {
  configurePlex();
  respond = plexMovieResponder([{ tmdbId: 700, ratingKey: "rk700" }]);

  const res = await postPlexSync(plexReq({ headers: AS_CRON, body: JSON.stringify({ full: true }) }));
  assert.equal(res.status, 200);
  await settleFireAndForget();

  assert.ok(
    transactions.flatMap((t) => t.ops).some((o) => o.model === "tVEpisodeCache" && o.method === "deleteMany"),
    "a lone Plex server must still maintain the episode cache, exactly as before",
  );
});

// One movie section (empty) + one show section with TMDB-identified shows
// whose type=4 episode listing carries on-disk files — the data the full
// path's skipShowFilePaths patch runs on.
function plexShowResponder(shows: Array<{ ratingKey: string; tmdbId: number; file: string }>): (url: URL) => Response {
  return (url) => {
    if (url.pathname === "/library/sections") {
      return okJson({ MediaContainer: { Directory: [
        { key: "1", title: "Movies", type: "movie" },
        { key: "2", title: "TV", type: "show" },
      ] } });
    }
    if (url.pathname === "/library/sections/1/all") return okJson({ MediaContainer: { totalSize: 0, Metadata: [] } });
    if (url.pathname === "/library/sections/2/all" && url.searchParams.get("type") === "2") {
      return okJson({ MediaContainer: {
        totalSize: shows.length,
        Metadata: shows.map((s) => ({ ratingKey: s.ratingKey, type: "show", title: `Show ${s.tmdbId}`, Guid: [{ id: `tmdb://${s.tmdbId}` }] })),
      } });
    }
    if (url.pathname === "/library/sections/2/all" && url.searchParams.get("type") === "4") {
      return okJson({ MediaContainer: {
        totalSize: shows.length,
        Metadata: shows.map((s) => ({ grandparentRatingKey: s.ratingKey, parentIndex: 1, index: 1, Media: [{ Part: [{ file: s.file }] }] })),
      } });
    }
    throw new Error(`unexpected Plex fetch ${url}`);
  };
}

test("plex { full: true } show file-path patch: ONE VALUES-joined UPDATE for every show (never one updateMany per show), default-instance-scoped and filePath-IS-NULL-guarded", async () => {
  configurePlex();
  respond = plexShowResponder([
    { ratingKey: "show-a", tmdbId: 1399, file: "/tv/a/s01e01.mkv" },
    { ratingKey: "show-b", tmdbId: 1400, file: "/tv/b/s01e01.mkv" },
  ]);

  const res = await postPlexSync(plexReq({ headers: AS_CRON, body: JSON.stringify({ full: true }) }));
  assert.equal(res.status, 200);
  await settleFireAndForget();

  // The full replace wrote the show rows pathless (skipShowFilePaths on the
  // lone-server full path) …
  const tvRows = opsFor("plexLibraryItem", "createMany")
    .flatMap((o) => (o.args as { data: Array<{ mediaType: string; plexRatingKey: string; filePath: string | null }> }).data)
    .filter((r) => r.mediaType === "TV");
  assert.deepEqual(tvRows.map((r) => [r.plexRatingKey, r.filePath]).sort(), [["show-a", null], ["show-b", null]]);
  // … and the patch that follows the episode walk is ONE statement, not a
  // per-show updateMany loop inside a BATCH_TX_TIMEOUT transaction.
  assert.deepEqual(opsFor("plexLibraryItem", "updateMany"), [], "never one updateMany per show");
  const patches = rawStatements.filter((r) => r.sql.includes('UPDATE "PlexLibraryItem"'));
  assert.equal(patches.length, 1, "one VALUES-joined UPDATE for the whole instance");
  const [patch] = patches;
  assert.ok(patch.sql.includes('"filePath" IS NULL'), "the concurrent-writer no-op guard must survive");
  assert.ok(patch.sql.includes('"serverInstance" = '), "must stay instance-scoped");
  assert.ok(patch.values.includes(""), "the default instance's slug is bound");
  for (const v of ["show-a", "show-b", "/tv/a/s01e01.mkv", "/tv/b/s01e01.mkv"]) assert.ok(patch.values.includes(v), `${v} bound`);
});

test("with a SECOND Jellyfin server registered, a resync leaves the shared TVEpisodeCache alone — and never walks the Episode list", async () => {
  // Same shared-namespace reasoning as the Plex twin above. The ownership check
  // has to run BEFORE the fetch, not inside the .then(): deciding afterwards
  // page-walked every Episode in the library against the upstream server and then
  // discarded the whole result.
  configureJellyfin();
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  respond = jellyfinSeriesResponder();

  const res = await postJellyfinSync(jfReq({ headers: AS_CRON, body: JSON.stringify({ full: true }) }));
  assert.equal(res.status, 200);
  await settleFireAndForget();

  const episodeOps = transactions.flatMap((t) => t.ops).filter((o) => o.model === "tVEpisodeCache");
  assert.deepEqual(episodeOps, [], "the shared episode cache must not be touched while another Jellyfin server exists");
  assert.equal(
    episodeFetches().length,
    0,
    "a resync that cannot own the episode cache must not pay for the library-wide Episode walk",
  );
});

test("as the ONLY Jellyfin server it still walks episodes and rewrites the cache — single-server behaviour is unchanged", async () => {
  configureJellyfin();
  respond = jellyfinSeriesResponder();

  const res = await postJellyfinSync(jfReq({ headers: AS_CRON, body: JSON.stringify({ full: true }) }));
  assert.equal(res.status, 200);
  await settleFireAndForget();

  assert.equal(episodeFetches().length, 1, "a lone Jellyfin server must still walk the Episode list");
  assert.ok(
    transactions.flatMap((t) => t.ops).some((o) => o.model === "tVEpisodeCache" && o.method === "deleteMany"),
    "a lone Jellyfin server must still maintain the episode cache, exactly as before",
  );
});

test("jellyfin recentOnly with a small windowed series set fetches episodes PER SERIES (ParentId-scoped), never the library-wide walk", async () => {
  // getJellyfinTVEpisodes page-walks EVERY Episode in the library and filters
  // client-side — the right shape for a full sync, but the 2h recentOnly window
  // typically holds 1-2 shows, so the walk cost scaled with the whole library to
  // rewrite a couple of rows. At ≤50 windowed series the route fetches each
  // series' episodes directly instead (the fix-match pattern).
  configureJellyfin();
  respond = jellyfinSeriesResponder();

  const res = await postJellyfinSync(jfReq({ headers: AS_CRON })); // no body ⇒ recentOnly
  assert.equal(res.status, 200);
  await settleFireAndForget();

  const eps = episodeFetches();
  assert.equal(eps.length, 1, "one windowed series ⇒ exactly one episode fetch");
  assert.equal(
    eps[0].url.searchParams.get("ParentId"),
    "jf-show-1",
    "the episode fetch must be ParentId-scoped to the windowed series, not a library-wide Episode walk",
  );

  // The downstream write contract is unchanged: tmdbId-scoped delete + insert.
  const epOps = transactions.flatMap((t) => t.ops).filter((o) => o.model === "tVEpisodeCache");
  assert.deepEqual(
    epOps.map((o) => ({ method: o.method, args: o.args })),
    [
      { method: "deleteMany", args: { where: { source: "jellyfin", tmdbId: { in: [1399] } } } },
      { method: "createMany", args: { data: [{ source: "jellyfin", tmdbId: 1399, seasonNumber: 1, episodeNumber: 1 }], skipDuplicates: true } },
    ],
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

// guardrail 37. The same title in two libraries on one server collapses to one
// row — @@id([tmdbId, mediaType, serverInstance]) allows no more — but the
// losing copy's item id must still be PERSISTED, or the poller can't attribute a
// watch of it and the episodes filed under it drop out of TVEpisodeCache.
test("guardrail 37: a title in two Jellyfin libraries writes ONE row carrying BOTH item ids", async () => {
  configureJellyfin();
  respond = jellyfinMovieResponder([
    // Newest first on purpose — arrival order must not decide the winner.
    { Id: "jf-dup-new", Name: "Dup", ProviderIds: { Tmdb: "552" }, DateCreated: "2026-08-01T00:00:00.000Z" },
    { Id: "jf-dup-old", Name: "Dup", ProviderIds: { Tmdb: "552" }, DateCreated: "2026-01-01T00:00:00.000Z" },
  ]);
  const res = await postJellyfinSync(jfReq({ headers: AS_CRON, body: JSON.stringify({ full: true }) }));
  assert.equal(res.status, 200);
  await settleFireAndForget();

  const rows = opsFor("jellyfinLibraryItem", "createMany")
    .flatMap((c) => (c.args as { data: Array<Record<string, unknown>> }).data);
  assert.equal(rows.length, 1, "one row per (tmdbId, mediaType, serverInstance) — the collapse itself is correct");
  assert.equal(rows[0].jellyfinItemId, "jf-dup-new", "the newest copy is the canonical stored id");
  assert.deepEqual(
    rows[0].jellyfinItemIds,
    ["jf-dup-new", "jf-dup-old"],
    "both ids persist, stored id first — dropping the loser is what made its watches unattributable",
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
    // Default-instance-scoped (multi-server, Phase 1 fix): this route only syncs
    // the default ("") Jellyfin server, so its full replace must leave any named
    // instance's rows alone — the pre-fix unscoped deleteMany wiped them and
    // repopulated only the default's (availability flicker until the next
    // orchestrator run). Still an unconditional delete of that instance's rows,
    // inside the same tx as the repopulate.
    { model: "jellyfinLibraryItem", method: "deleteMany", args: { where: { serverInstance: "" } } },
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
    if (url.origin === PLEX_BASE) return new Response("gone", { status: 404 }); // 404 not 500 — 5xx pays the real retry backoff
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

// ── multi-server safety: the per-source routes are default-instance-only ────
// Named additional Plex/Jellyfin instances sync exclusively via the /api/sync
// orchestrator's per-instance fan-out; these routes touch ONLY the default ("")
// instance's rows, so an admin Resync can never clobber a named instance.

test("multi-server safety: BOTH routes' full-replace deletes are scoped to the default instance — a named instance's rows survive the admin Resync", async () => {
  configurePlex();
  configureJellyfin();
  respond = (url) =>
    url.origin === PLEX_BASE ? plexMovieResponder([PLEX_ITEM_MIN])(url) : jellyfinMovieResponder([JF_ITEM_MIN])(url);

  const plexRes = await postPlexSync(plexReq({ headers: AS_CRON, body: JSON.stringify({ full: true }) }));
  assert.equal(plexRes.status, 200);
  const jfRes = await postJellyfinSync(jfReq({ headers: AS_CRON, body: JSON.stringify({ full: true }) }));
  assert.equal(jfRes.status, 200);
  await settleFireAndForget();

  for (const model of LIBRARY_MODELS) {
    const deletes = opsFor(model, "deleteMany");
    assert.ok(deletes.length > 0, `${model}: the full path must still delete + repopulate (guardrail 13's full-replace leg)`);
    for (const d of deletes) {
      assert.equal(
        (d.args as { where?: { serverInstance?: string } } | null)?.where?.serverInstance,
        "",
        `${model}: every full-replace delete must be scoped to the DEFAULT instance — an unscoped ` +
          "delete wipes every named instance's rows and repopulates only the default's",
      );
    }
  }
});

test("multi-server safety: the plex dedupe clone's prior-mapping lookup is default-instance-scoped (agreement with the orchestrator's dedupe)", async () => {
  configurePlex();
  // ONE item carrying TWO tmdb guids — genuine conflation within the batch — so
  // the clone's prior-mapping DB read fires. full:true keeps that read the ONLY
  // plexLibraryItem.findMany (recentOnly's already-present check would add more).
  respond = plexMovieResponder([
    { ratingKey: "rk-dup", type: "movie", title: "Conflated", Guid: [{ id: "tmdb://601" }, { id: "tmdb://602" }] },
  ]);
  const res = await postPlexSync(plexReq({ headers: AS_CRON, body: JSON.stringify({ full: true }) }));
  assert.equal(res.status, 200);
  await settleFireAndForget();

  assert.deepEqual(
    plexFindManyWheres,
    [{ mediaType: "MOVIE", serverInstance: "", tmdbId: { in: [601, 602] } }],
    "the conflated-ratingKey read must consult only the default instance's rows — ratingKeys are " +
      "small server-local integers, so an unscoped read could import a named instance's mapping " +
      "and wrongly drop this server's row",
  );
  // No prior mapping ⇒ keep the first occurrence: only tmdb 601 is inserted.
  const creates = opsFor("plexLibraryItem", "createMany");
  assert.equal(creates.length, 1);
  assert.deepEqual(
    (creates[0].args as { data: Array<{ tmdbId: number }> }).data.map((r) => r.tmdbId),
    [601],
  );
});

// ── restricted-server visibility gate (guardrail 35) ────────────────────────

const REMOTE_MOVIE = { ratingKey: "rk700", type: "movie", title: "Seven Hundred", Guid: [{ id: "tmdb://700" }] };
function pendingFor(userId: string): PendingRequest {
  return { id: "req-1", tmdbId: 700, mediaType: "MOVIE", requestedBy: userId, title: "Seven Hundred", posterPath: null, notifiedAvailable: false };
}
function configureRestrictedRemote(): void {
  configurePlex();
  settings.set("plexRemoteServerUrl", PLEX_BASE);
  settings.set("plexRemoteAdminToken", "plex-admin-token-remote");
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote", restricted: true }]));
  respond = plexMovieResponder([REMOTE_MOVIE]);
}
async function resyncRemote(): Promise<Response> {
  const res = await postPlexSync(plexReq({ headers: AS_CRON, body: JSON.stringify({ full: true, instance: "remote" }) }));
  await settleFireAndForget();
  return res;
}

test("a RESTRICTED server does NOT flip or notify a requester holding no grant, and never burns the once-only claim", async () => {
  // This route resyncs whichever server the body names, so a restricted one can now
  // reach the marking pass — which had no visibility term. An ungranted requester was
  // told a title on a server they cannot see was ready to watch, the row went
  // permanently AVAILABLE while every read path still rendered it unavailable, and
  // the notifiedAvailable claim was burned so the legitimate later notification could
  // never fire.
  configureRestrictedRemote();
  pendingRequests = [pendingFor("u1")];
  requesterRows = [{ id: "u1", role: "USER", permissions: 0n, mediaServerGrants: {}, mediaServer: null }];

  assert.equal((await resyncRemote()).status, 200);

  assert.equal(casCalls, 0, "the CAS must never see a request the requester cannot see the server for");
  assert.equal(requestUpdateManys.length, 0, "no AVAILABLE flip for an invisible server");
});

test("the SAME restricted server still notifies a requester who HAS the grant", async () => {
  // The counterpart: without it, a gate that denied everyone would pass the test above.
  configureRestrictedRemote();
  pendingRequests = [pendingFor("u2")];
  requesterRows = [{
    id: "u2", role: "USER", permissions: 0n,
    mediaServerGrants: { plex: { remote: { view: true } } }, mediaServer: null,
  }];

  assert.equal((await resyncRemote()).status, 200);

  assert.equal(casCalls, 1, "a granted requester must reach the notification CAS exactly once");
});

test("a legacy ADMIN row whose permissions column was never seeded is NOT denied", async () => {
  // `permissions` is @default(0) and only seeded by a manual one-shot script, so an
  // upgraded deployment can hold role="ADMIN" with permissions=0. Reading the raw
  // column here would deny the ADMIN short-circuit that every READ path grants (they
  // all go through effectivePermissions), stranding the operator's own requests as
  // PENDING while the UI insists the title is available.
  configureRestrictedRemote();
  pendingRequests = [pendingFor("admin1")];
  requesterRows = [{ id: "admin1", role: "ADMIN", permissions: 0n, mediaServerGrants: {}, mediaServer: null }];

  assert.equal((await resyncRemote()).status, 200);

  assert.equal(casCalls, 1, "an unseeded ADMIN must still be notified");
});

test("an UNRESTRICTED named server notifies everyone — the gate costs nothing when nothing is restricted", async () => {
  configurePlex();
  settings.set("plexRemoteServerUrl", PLEX_BASE);
  settings.set("plexRemoteAdminToken", "plex-admin-token-remote");
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }])); // no `restricted`
  respond = plexMovieResponder([REMOTE_MOVIE]);
  pendingRequests = [pendingFor("u3")];
  requesterRows = [{ id: "u3", role: "USER", permissions: 0n, mediaServerGrants: {}, mediaServer: null }];

  assert.equal((await resyncRemote()).status, 200);

  assert.equal(casCalls, 1, "an unrestricted server is visible to everyone");
});

// ── a DEACTIVATED requester (guardrail 33 on top of guardrail 14) ───────────
//
// The sibling of the orchestrator pin in tests/sync-orchestrator-route.test.mts.
// claimAvailableNotifications returns `claimed` (every row the CAS really
// flipped) and `deliverable` (`claimed` minus DISABLED requesters — account
// removal disables rather than scrubs, so a removed user keeps a live email
// address and push subscriptions). Only the four DELIVERY channels may key off
// `deliverable`; the deletion-vote wipe and the pendingNotifyAt disarm are
// consequences of the TRANSITION and must key off `claimed`, because the claim is
// BURNED on the way past — AVAILABLE is terminal — so a consequence skipped here
// is skipped forever, not deferred.
//
// Both requesters ride the same run and the same CAS call; the only difference is
// `deactivatedAt`. That keeps the "no notification" assertion honest — the active
// requester's notification has to land in the very same array.

test("a DEACTIVATED requester's winner still wipes stale deletion votes and disarms pendingNotifyAt — only the notification is withheld", async () => {
  configurePlex();
  respond = plexMovieResponder([
    { ratingKey: "rk700", type: "movie", title: "Seven Hundred", Guid: [{ id: "tmdb://700" }] },
    { ratingKey: "rk701", type: "movie", title: "Seven Oh One", Guid: [{ id: "tmdb://701" }] },
  ]);
  pendingRequests = [
    { id: "req-disabled", tmdbId: 700, mediaType: "MOVIE", requestedBy: "u-disabled", title: "Seven Hundred", posterPath: null, notifiedAvailable: false },
    { id: "req-active", tmdbId: 701, mediaType: "MOVIE", requestedBy: "u-active", title: "Seven Oh One", posterPath: null, notifiedAvailable: false },
  ];
  requesterRows = [
    { id: "u-disabled", role: "USER", permissions: 0n, mediaServerGrants: {}, mediaServer: null, deactivatedAt: new Date("2026-02-01T00:00:00.000Z") },
    { id: "u-active", role: "USER", permissions: 0n, mediaServerGrants: {}, mediaServer: null },
  ];
  casWinnerIds = ["req-disabled", "req-active"]; // the CAS flipped BOTH rows

  const res = await postPlexSync(plexReq({ headers: AS_CRON, body: JSON.stringify({ full: true }) }));
  assert.equal(res.status, 200);
  await settleFireAndForget();

  assert.equal(casCalls, 1, "one markAvailable claim covering both requests");

  // THE DEFECT THIS PINS: the wipe follows the CAS winners, so it carries the
  // disabled requester's tmdbId too. Keyed off `deliverable` it would carry 701
  // alone, and 700's stale "delete this" votes would outlive the re-add forever.
  assert.deepEqual(
    deletionVoteDeleteWheres,
    [{ tmdbId: { in: [700, 701] }, mediaType: "MOVIE" }],
    "the deletion-vote wipe must follow `claimed` — the disabled requester's row went AVAILABLE too " +
      "and its claim is already burned, so no later run would ever clear its votes",
  );
  assert.deepEqual(
    settingDeleteManyWheres,
    [{ key: { in: ["deletionVoteNotified:700:MOVIE", "deletionVoteNotified:701:MOVIE"] } }],
    "and so must the per-item deletionVoteNotified: re-arm key",
  );

  // One post-claim disarm naming BOTH winners.
  assert.deepEqual(
    requestUpdateManys,
    [{ where: { id: { in: ["req-disabled", "req-active"] } }, data: { pendingNotifyAt: null } }],
    "the 90s still-pending backstop must be disarmed on every row that went AVAILABLE",
  );

  // …and the half that must NOT happen. The active requester is the inline
  // control: without them this would also pass on a run that notified nobody.
  assert.deepEqual(
    notificationCreateManyData.map((d) => d.userId),
    ["u-active"],
    "guardrail 33: a disabled account keeps a live email address and push subscriptions — the claim " +
      "is burned but the delivery is suppressed",
  );
  assert.deepEqual(errors, [], "no channel blew up on the way through");
});
