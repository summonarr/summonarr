// Route-level unit tests for the SYNC ORCHESTRATOR — src/app/api/sync/route.ts,
// the external-cron / admin-"Sync" entry point. It is the single POST that takes
// advisory lock 2000, runs the whole availability pipeline under
// withCronRunRecording, and writes the LIBRARY_SYNC audit row.
//
// Division of labour (this file pins ORCHESTRATION contracts only — it does NOT
// re-test the per-source library-write mechanics):
//   - tests/sync-routes.test.mts OWNS the per-source /api/sync/{plex,jellyfin}
//     routes: the { full:true } body flag, recentOnly vs full replace, field
//     mapping, the ratingKey-scoped stale-mapping clear, unconfigured→400 /
//     unreachable→502. The orchestrator drives the SAME library-write shapes, so
//     here we only assert the orchestrator's OWN contracts around them.
//   - tests/notify-available.test.mts OWNS claimAvailableNotificationWinners'
//     internals (the exact UPDATE … RETURNING statement + winner filter). Here we
//     pin the orchestrator's USE of the CAS — that it is invoked, and that the
//     shared-state effect (exactly-once) holds across the Plex + Jellyfin passes.
//   - tests/cron-auth.test.mts OWNS isCronAuthorized / withCronRunRecording /
//     batchCreateMany. Here we pin only that the route funnels through them.
//   - tests/advisory-lock.test.mts OWNS withAdvisoryLock's control flow. Here we
//     pin the orchestrator's lock-id 2000 usage + the busy (already-running) gate.
//
// Headline pins (their failure messages name the guardrail):
//   - GUARDRAIL 13 / body-ignored: the orchestrator route does NOT read the
//     request body — it ALWAYS does a full wholesale library replace. A
//     { recentOnly:true } / { full:false } body must NOT downgrade it to
//     insert-only; the unconditional plex/jellyfinLibraryItem.deleteMany still runs.
//   - GUARDRAIL 15 / snapshot-once: the `stillPending` MediaRequest snapshot
//     (status IN PENDING/APPROVED) is queried EXACTLY ONCE and reused by BOTH the
//     Plex and Jellyfin marking passes — never once-per-source.
//   - GUARDRAIL 14 / exactly-once: a request whose media appears in BOTH Plex and
//     Jellyfin in one run fires the "now available" notification EXACTLY ONCE. The
//     notifiedAvailable compare-and-swap (claimAvailableNotificationWinners) is the
//     mechanism — never a plain updateMany.
//
// No DB / network / DNS:
//   - globalThis.prisma is pre-seeded with a recording fake BEFORE the module
//     graph loads (the sync-routes / cron-auth / poster-cache idiom). The fake
//     MODELS the notifiedAvailable/status state machine so the $queryRaw CAS
//     behaves like real Postgres UPDATE … RETURNING across the two source passes —
//     this is what makes the guardrail-14 exactly-once observable.
//   - The top-level withAdvisoryLock uses a raw `pg` Client (NOT prisma), so
//     Client.prototype is monkey-patched (the advisory-lock.test.mts seam):
//     lock 2000 acquires; lock 2009 (download-policies) reports BUSY so
//     syncDownloadPolicies is skipped and no Jellyfin /Users fetch is needed.
//   - Plex/Jellyfin servers are RFC1918 IP literals so safeFetchAdminConfigured's
//     SSRF stack short-circuits DNS (isIP). Radarr/Sonarr are enabled-but-
//     UNCONFIGURED (no Setting rows) so getSyncableArrInstances returns [] — the
//     wanted-sync runs its empty transaction (giving us the 1001,* advisory-lock
//     to observe for sequencing) but issues zero arr fetches. Discord/push/email
//     channels are unconfigured, so the notify fan-out is a no-op — the winners it
//     receives are observed through the UNCONDITIONAL in-app notification.createMany.
//   - Admin sessions are REAL jose JWTs against in-memory AuthSession/User rows.
//
// Erasable-TS only; node:assert/strict; guardrail 7 console capture (warn/error).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";

// ── env FIRST (prisma.ts pulls token-crypto; session reads NEXTAUTH_SECRET) ──
process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "sync-orch-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000"; // unprefixed cookie name + session trusted origin
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5432/db"; // Client.prototype is stubbed; never dialed
const CRON_SECRET = "sync-orch-cron-secret-0123456789abcdef"; // ≥32 chars, boot-shaped
process.env.CRON_SECRET = CRON_SECRET;

// ── console capture (guardrail 7: warn/error only) ──────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── pg Client prototype stub (the withAdvisoryLock seam) ────────────────────
// withAdvisoryLock news up its OWN `new Client(...)`; connect/query/end are
// prototype methods, so patching them exercises the REAL lock control flow with
// zero network. lockAcquire decides pg_try_advisory_lock's result per lock id.
type PgResult = { rows: unknown[] };
const pgLockCalls: Array<{ op: "try" | "unlock"; lockId: number }> = [];
// Default: everything acquires EXCEPT 2009 (the download-policies sub-lock) —
// reporting it busy makes the orchestrator skip syncDownloadPolicies via onBusy,
// so no Jellyfin /Users fetch is needed. Overridden per-test for the busy gate.
let lockAcquire: (lockId: number) => boolean = (id) => id !== 2009;
const pgProto = Client.prototype as unknown as {
  connect: () => Promise<void>;
  query: (text: string, values?: unknown[]) => Promise<PgResult>;
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
  return { rows: [] }; // SET statement_timeout / idle_in_transaction_session_timeout
};
pgProto.end = async () => {};

// ── scripted fetch (Plex/Jellyfin only; RFC1918 literals, no DNS) ───────────
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

// ── MediaRequest store: MODELS the notifiedAvailable/status state machine ───
type MediaType = "MOVIE" | "TV";
type ReqStatus = "PENDING" | "APPROVED" | "AVAILABLE" | "DECLINED";
type ReqRow = {
  id: string; tmdbId: number; mediaType: MediaType; arrInstance: string;
  requestedBy: string; title: string; posterPath: string | null;
  status: ReqStatus; notifiedAvailable: boolean;
  pendingNotifyAt: Date | null; availableAt: Date | null;
  qualityProfileId: number | null; createdAt: Date; lastArrPushAt: Date | null; tvdbId: number | null;
};
const requests = new Map<string, ReqRow>();
function seedRequest(r: Partial<ReqRow> & { id: string; tmdbId: number; mediaType: MediaType; requestedBy: string; status: ReqStatus }): void {
  requests.set(r.id, {
    arrInstance: "", title: `title-${r.id}`, posterPath: null, notifiedAvailable: false,
    pendingNotifyAt: null, availableAt: null, qualityProfileId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"), lastArrPushAt: null, tvdbId: null,
    ...r,
  });
}

type ReqWhere = {
  id?: { in: string[] };
  status?: ReqStatus | { in?: ReqStatus[]; not?: ReqStatus };
  notifiedAvailable?: boolean;
  OR?: Array<{ lastArrPushAt?: null | { lte?: Date } }>;
};
function reqMatches(row: ReqRow, where: ReqWhere | undefined): boolean {
  if (!where) return true;
  if (where.id?.in && !where.id.in.includes(row.id)) return false;
  if (where.status !== undefined) {
    if (typeof where.status === "string") {
      if (row.status !== where.status) return false;
    } else {
      if (where.status.in && !where.status.in.includes(row.status)) return false;
      if (where.status.not !== undefined && row.status === where.status.not) return false;
    }
  }
  if (where.notifiedAvailable !== undefined && row.notifiedAvailable !== where.notifiedAvailable) return false;
  if (where.OR) {
    const any = where.OR.some((c) => {
      if (c.lastArrPushAt === null) return row.lastArrPushAt === null;
      if (c.lastArrPushAt?.lte) return row.lastArrPushAt !== null && row.lastArrPushAt <= c.lastArrPushAt.lte;
      return true;
    });
    if (!any) return false;
  }
  return true;
}

// ── other in-memory stores ───────────────────────────────────────────────────
type UserRow = {
  id: string; role: string; permissions: bigint; mediaServer: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
  email: string | null; notificationEmail: string | null;
  emailOnAvailable: boolean; discordId: string | null; pushOnAvailable: boolean;
};
const usersById = new Map<string, UserRow>();
function defaultUser(id: string): UserRow {
  return {
    id, role: "USER", permissions: 0n, mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: null, notificationEmail: null, emailOnAvailable: false, discordId: null, pushOnAvailable: false,
  };
}
const sessionRows = new Set<string>();
const settings = new Map<string, string>();

// ── recorders ─────────────────────────────────────────────────────────────
const settingUpserts: Array<{ key: string; value: string }> = [];
const auditRows: Array<Record<string, unknown>> = [];
const notificationCreateManyData: Array<Record<string, unknown>> = [];
const tmdbCacheDeleteManyCalls: unknown[] = [];
const mediaRequestFindManyWheres: Array<ReqWhere | undefined> = [];
const mediaRequestUpdateManyCalls: Array<{ where?: ReqWhere; data: Record<string, unknown> }> = [];
type CasCall = { mode: "markAvailable" | "requireAvailable" | "plain"; ids: string[]; winners: string[] };
const casCalls: CasCall[] = [];

type Op = { model: string; method: string; args: unknown };
type TxRecord = { ops: Op[]; timeout: number | undefined; failed: boolean };
const transactions: TxRecord[] = [];
const execRawOrder: string[] = []; // ordered advisory-lock $executeRaw SQL across ALL txs (sequencing pin)
let failCreateManyOnModel: string | null = null;

function recordingDelegate(rec: TxRecord, model: string) {
  return {
    deleteMany: async (args?: unknown) => {
      rec.ops.push({ model, method: "deleteMany", args: args ?? null });
      return { count: 0 };
    },
    createMany: async (args: { data: unknown[]; skipDuplicates?: boolean }) => {
      rec.ops.push({ model, method: "createMany", args });
      if (failCreateManyOnModel === model) throw new Error(`${model} insert exploded (unit test)`);
      return { count: args.data.length };
    },
  };
}

const fakePrisma = {
  mediaRequest: {
    findMany: async (args: { where?: ReqWhere }) => {
      mediaRequestFindManyWheres.push(args?.where);
      return [...requests.values()].filter((r) => reqMatches(r, args?.where)).map((r) => ({ ...r }));
    },
    updateMany: async (args: { where?: ReqWhere; data: Record<string, unknown> }) => {
      mediaRequestUpdateManyCalls.push(args);
      let count = 0;
      for (const r of requests.values()) {
        if (reqMatches(r, args.where)) { Object.assign(r, args.data); count++; }
      }
      return { count };
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = requests.get(args.where.id);
      if (r) Object.assign(r, args.data);
      return r ? { ...r } : {};
    },
  },
  // The compare-and-swap behind guardrail 14. claimAvailableNotificationWinners
  // issues exactly one UPDATE … RETURNING; we replay its semantics against the
  // shared request store so a row already flipped by the Plex pass yields NO
  // winner in the Jellyfin pass — the real exactly-once mechanism.
  $queryRaw: async (query: { sql: string; values: unknown[] }) => {
    const sql = query.sql;
    const ids = (query.values ?? []).map(String);
    const mode: CasCall["mode"] = sql.includes("IN ('PENDING', 'APPROVED')")
      ? "markAvailable"
      : sql.includes(`AND "status" = 'AVAILABLE'`)
      ? "requireAvailable"
      : "plain";
    const winners: string[] = [];
    for (const id of ids) {
      const row = requests.get(id);
      if (!row) continue;
      if (row.notifiedAvailable !== false) continue; // CAS predicate: notifiedAvailable=false
      if (mode === "markAvailable" && !(row.status === "PENDING" || row.status === "APPROVED")) continue;
      if (mode === "requireAvailable" && row.status !== "AVAILABLE") continue;
      row.notifiedAvailable = true;
      if (mode === "markAvailable") { row.status = "AVAILABLE"; row.availableAt = new Date(); }
      winners.push(id);
    }
    casCalls.push({ mode, ids, winners });
    return winners.map((id) => ({ id }));
  },
  $executeRaw: async () => 0, // orchestrator never calls this at top level; defensive
  setting: {
    findUnique: async (args: { where: { key: string } }) => {
      const v = settings.get(args.where.key);
      return v === undefined ? null : { key: args.where.key, value: v };
    },
    findMany: async (args: { where: { key: { in: string[] } } }) => {
      const keys = args.where.key.in;
      return keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) as string }));
    },
    upsert: async (args: { where: { key: string }; create: { key: string; value: string } }) => {
      settingUpserts.push({ key: args.where.key, value: args.create.value });
      settings.set(args.where.key, args.create.value);
      return args.create;
    },
    deleteMany: async () => ({ count: 0 }),
  },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
    findMany: async (args: { where?: { id?: { in: string[] } } }) => {
      const ids = args?.where?.id?.in;
      if (!ids) return []; // email-normalize / any non-id query resolves empty
      return ids.map((id) => ({ ...(usersById.get(id) ?? defaultUser(id)) }));
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
    create: async (args: { data: Record<string, unknown> }) => { auditRows.push(args.data); return args.data; },
  },
  notification: {
    createMany: async (args: { data: Record<string, unknown>[] }) => {
      notificationCreateManyData.push(...args.data);
      return { count: args.data.length };
    },
  },
  pushSubscription: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
  radarrAvailableItem: { findMany: async () => [] },
  radarrWantedItem: { findMany: async () => [] },
  sonarrAvailableItem: { findMany: async () => [] },
  sonarrWantedItem: { findMany: async () => [] },
  plexLibraryItem: { findMany: async () => [] }, // dedupe path (no ratingKey conflation in these fixtures)
  tmdbCache: {
    deleteMany: async (args: unknown) => { tmdbCacheDeleteManyCalls.push(args); return { count: 0 }; },
  },
  deletionVote: { deleteMany: async () => ({ count: 0 }) },
  mediaServerUser: { findMany: async () => [], upsert: async () => ({}), updateMany: async () => ({ count: 0 }) },
  $transaction: async (arg: unknown, opts?: { timeout?: number }) => {
    if (typeof arg === "function") {
      const rec: TxRecord = { ops: [], timeout: opts?.timeout, failed: false };
      transactions.push(rec);
      const tx = {
        $executeRaw: async (strings: TemplateStringsArray) => {
          const sqlText = strings.join("?");
          rec.ops.push({ model: "$executeRaw", method: "raw", args: sqlText });
          execRawOrder.push(sqlText);
          return 0;
        },
        radarrWantedItem: recordingDelegate(rec, "radarrWantedItem"),
        radarrAvailableItem: recordingDelegate(rec, "radarrAvailableItem"),
        sonarrWantedItem: recordingDelegate(rec, "sonarrWantedItem"),
        sonarrAvailableItem: recordingDelegate(rec, "sonarrAvailableItem"),
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
    return Promise.all(arg as Promise<unknown>[]); // clearDeletionVotesForTmdbs' array form
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── dynamic imports (env/global stubs must precede the module graph) ─────────
const { NextRequest } = await import("next/server");
const { POST } = await import("../src/app/api/sync/route.ts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");

type Req = InstanceType<typeof NextRequest>;

// ── fixtures ─────────────────────────────────────────────────────────────────
const PLEX_BASE = "http://10.77.0.1:32400"; // RFC1918 literal: admin SSRF mode, no DNS
const JF_BASE = "http://10.77.0.2:8096";
const PLEX_ORIGIN = new URL(PLEX_BASE).origin;
const COOKIE = getSessionCookieName();
const AS_CRON = { authorization: `Bearer ${CRON_SECRET}` };

function syncReq(opts: { headers?: Record<string, string>; body?: string } = {}): Req {
  return new NextRequest("http://localhost:3000/api/sync", {
    method: "POST",
    headers: opts.headers,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
}

function configureBothServers(): void {
  settings.set("plexServerUrl", PLEX_BASE);
  settings.set("plexAdminToken", "plex-admin-token-1");
  settings.set("jellyfinUrl", JF_BASE);
  settings.set("jellyfinApiKey", "jf-api-key-1");
}

// Plex: one movie section; the listed tmdbIds become movie rows. No show
// section, so the TV + episode passes fetch nothing (getPlexTVEpisodes no-ops).
function plexResponder(movieTmdbIds: number[]): (url: URL) => Response {
  return (url) => {
    if (url.pathname === "/library/sections") {
      return okJson({ MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie" }] } });
    }
    if (url.pathname === "/library/sections/1/all") {
      return okJson({
        MediaContainer: {
          totalSize: movieTmdbIds.length,
          Metadata: movieTmdbIds.map((id) => ({ ratingKey: `rk${id}`, type: "movie", title: `Movie ${id}`, Guid: [{ id: `tmdb://${id}` }] })),
        },
      });
    }
    throw new Error(`unexpected Plex fetch ${url.pathname}`);
  };
}
// Jellyfin: the listed tmdbIds become movie rows; the Series pass returns empty
// (getJellyfinTVEpisodes no-ops on an empty series map).
function jellyfinResponder(movieTmdbIds: number[]): (url: URL) => Response {
  return (url) => {
    if (url.pathname === "/Items" && url.searchParams.get("IncludeItemTypes") === "Movie") {
      return okJson({
        Items: movieTmdbIds.map((id) => ({ Id: `jf-${id}`, Name: `Movie ${id}`, ProviderIds: { Tmdb: String(id) } })),
        TotalRecordCount: movieTmdbIds.length,
      });
    }
    if (url.pathname === "/Items" && url.searchParams.get("IncludeItemTypes") === "Series") {
      return okJson({ Items: [], TotalRecordCount: 0 });
    }
    throw new Error(`unexpected Jellyfin fetch ${url.pathname}`);
  };
}
function bothServersRespond(plexMovies: number[], jfMovies: number[]): (url: URL) => Response {
  const p = plexResponder(plexMovies);
  const j = jellyfinResponder(jfMovies);
  return (url) => (url.origin === PLEX_ORIGIN ? p(url) : j(url));
}

let sessionSeq = 0;
async function mintSession(role: string): Promise<{ userId: string; token: string }> {
  sessionSeq++;
  const userId = `orch-user-${sessionSeq}`;
  const sessionId = `orch-sess-${sessionSeq}`;
  usersById.set(userId, { ...defaultUser(userId), role, email: "admin@example.com" });
  sessionRows.add(sessionId);
  const token = await signSessionJwt(
    { id: userId, role, permissions: "0", provider: "credentials", sessionId, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
    { expiresInSeconds: 7_200 },
  );
  return { userId, token };
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
// Let the route's void/fire-and-forget tails (notification.createMany,
// clearDeletionVotes, notify fan-out, void logAudit) settle before asserting.
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise<void>((r) => setImmediate(r));
}

// A transaction that touched a specific library model (isolates the library
// write from the arr wanted-sync txs and the episode-cache txs).
function txTouching(model: string): TxRecord[] {
  return transactions.filter((t) => t.ops.some((o) => o.model === model));
}
function firstExecRawIndex(needle: string): number {
  return execRawOrder.findIndex((s) => s.includes(needle));
}
function notifiedTmdbIds(): number[] {
  return notificationCreateManyData.map((d) => d.tmdbId as number);
}

beforeEach(() => {
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  transactions.length = 0;
  execRawOrder.length = 0;
  settingUpserts.length = 0;
  auditRows.length = 0;
  notificationCreateManyData.length = 0;
  tmdbCacheDeleteManyCalls.length = 0;
  mediaRequestFindManyWheres.length = 0;
  mediaRequestUpdateManyCalls.length = 0;
  casCalls.length = 0;
  pgLockCalls.length = 0;
  requests.clear();
  usersById.clear();
  sessionRows.clear();
  settings.clear();
  failCreateManyOnModel = null;
  lockAcquire = (id) => id !== 2009; // 2009 busy ⇒ syncDownloadPolicies skipped
  respond = (url) => { throw new Error(`unexpected fetch ${url} — script a responder for this test`); };
  invalidateFeatureFlagCache(); // module-global 10s flag cache — reset between tests
});

// ═══════════════════════════════════════════════════════════════════════════
// Auth — the route funnels through isCronAuthorized (guardrail 6)
// ═══════════════════════════════════════════════════════════════════════════

test("unauthenticated POST → 403 before any advisory lock, fetch, or library write", async () => {
  configureBothServers();
  const res = await POST(syncReq()); // no Authorization, no cookie
  assert.equal(res.status, 403);
  assert.deepEqual(await bodyOf(res), { error: "Forbidden" });
  await settle();
  assert.equal(pgLockCalls.length, 0, "the auth gate must run before withAdvisoryLock takes lock 2000");
  assert.equal(fetchCalls.length, 0, "no upstream fetch for an unauthorized caller");
  assert.equal(transactions.length, 0, "no DB transaction for an unauthorized caller");
});

test("a wrong Bearer secret → 403 with zero work (compare internals owned by cron-auth tests)", async () => {
  configureBothServers();
  const res = await POST(syncReq({ headers: { authorization: "Bearer not-the-cron-secret-0123456789abcd" } }));
  assert.equal(res.status, 403);
  await settle();
  assert.equal(pgLockCalls.length, 0);
  assert.equal(fetchCalls.length, 0);
});

test("Bearer CRON_SECRET authorizes and drives the full pipeline (library writes + purge)", async () => {
  configureBothServers();
  respond = bothServersRespond([550], [550]);
  const res = await POST(syncReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  await settle();
  // The run reached the library-replace stage for both sources and the tail purge.
  assert.equal(txTouching("plexLibraryItem").length, 1, "authorized run must replace the Plex library");
  assert.equal(txTouching("jellyfinLibraryItem").length, 1, "authorized run must replace the Jellyfin library");
  assert.equal(tmdbCacheDeleteManyCalls.length, 1);
  // A CRON_SECRET run has no session to attribute — no LIBRARY_SYNC audit row.
  assert.equal(auditRows.length, 0);
});

test("an ADMIN cookie session authorizes + attributes the LIBRARY_SYNC audit row; a USER session is 403", async () => {
  configureBothServers();
  respond = bothServersRespond([550], [550]);
  seedRequest({ id: "req-a", tmdbId: 550, mediaType: "MOVIE", requestedBy: "orch-user-req", status: "PENDING" });

  const admin = await mintSession("ADMIN");
  const res = await POST(syncReq({
    headers: { cookie: `${COOKIE}=${admin.token}`, origin: "http://localhost:3000" }, // isCronAuthorized enforces same-origin for sessions
  }));
  assert.equal(res.status, 200);
  await settle();
  assert.equal(auditRows.length, 1, "an admin-triggered run must write the LIBRARY_SYNC audit row");
  assert.equal(auditRows[0].action, "LIBRARY_SYNC");
  assert.equal(auditRows[0].target, "sync:full");
  assert.equal(auditRows[0].userId, admin.userId);
  const details = JSON.parse(auditRows[0].details as string) as Record<string, number>;
  assert.equal(details.plexMarked, 1);
  assert.equal(details.jellyfinMarked, 1);
  assert.ok("durationMs" in details);

  // A plain USER session cannot drive the orchestrator.
  const user = await mintSession("USER");
  const denied = await POST(syncReq({ headers: { cookie: `${COOKIE}=${user.token}`, origin: "http://localhost:3000" } }));
  assert.equal(denied.status, 403);
  await settle();
  assert.equal(auditRows.length, 1, "the denied USER run must not add an audit row");
});

// ═══════════════════════════════════════════════════════════════════════════
// GUARDRAIL 13 — the orchestrator IGNORES the request body (always full replace)
// ═══════════════════════════════════════════════════════════════════════════

test("guardrail 13: a { recentOnly } / { full:false } / empty body never downgrades the FULL wholesale library replace", async () => {
  for (const body of [JSON.stringify({ recentOnly: true }), JSON.stringify({ full: false }), JSON.stringify({})]) {
    // per-body reset of the run recorders (stores stay; no requests seeded)
    fetchCalls.length = 0;
    transactions.length = 0;
    settings.clear();
    configureBothServers();
    respond = bothServersRespond([700], [700]);

    const res = await POST(syncReq({ headers: AS_CRON, body }));
    assert.equal(res.status, 200, `body ${body}: authorized full run`);
    await settle();

    const plexTx = txTouching("plexLibraryItem");
    const jfTx = txTouching("jellyfinLibraryItem");
    assert.equal(plexTx.length, 1, `body ${body}: exactly one Plex library transaction`);
    assert.equal(jfTx.length, 1, `body ${body}: exactly one Jellyfin library transaction`);

    // The FULL-replace signature: an UNCONDITIONAL deleteMany (args === null, i.e.
    // no where filter) inside the same tx as the repopulate. recentOnly would be
    // insert-only. The body must not have changed this.
    const plexDeletes = plexTx[0].ops.filter((o) => o.model === "plexLibraryItem" && o.method === "deleteMany");
    const jfDeletes = jfTx[0].ops.filter((o) => o.model === "jellyfinLibraryItem" && o.method === "deleteMany");
    assert.deepEqual(
      plexDeletes.map((d) => d.args),
      [null],
      `guardrail 13: body ${body} must NOT downgrade to insert-only — the orchestrator ignores the body and always issues the unconditional Plex library replace`,
    );
    assert.deepEqual(
      jfDeletes.map((d) => d.args),
      [null],
      `guardrail 13: body ${body} must NOT downgrade to insert-only — the orchestrator ignores the body and always issues the unconditional Jellyfin library replace`,
    );
    // And it repopulates inside the SAME transaction (full-replace atomicity).
    assert.ok(plexTx[0].ops.some((o) => o.model === "plexLibraryItem" && o.method === "createMany"));
    assert.ok(jfTx[0].ops.some((o) => o.model === "jellyfinLibraryItem" && o.method === "createMany"));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GUARDRAIL 15 — the stillPending snapshot is taken ONCE and reused
// ═══════════════════════════════════════════════════════════════════════════

test("guardrail 15: the stillPending snapshot (status IN PENDING/APPROVED) is queried EXACTLY ONCE per run", async () => {
  configureBothServers();
  respond = bothServersRespond([100], [200]);
  seedRequest({ id: "req-plex", tmdbId: 100, mediaType: "MOVIE", requestedBy: "u-plex", status: "PENDING" });
  seedRequest({ id: "req-jf", tmdbId: 200, mediaType: "MOVIE", requestedBy: "u-jf", status: "PENDING" });

  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  const stillPendingQueries = mediaRequestFindManyWheres.filter(
    (w) =>
      w?.status && typeof w.status === "object" && Array.isArray(w.status.in) &&
      w.status.in.length === 2 && w.status.in.includes("PENDING") && w.status.in.includes("APPROVED") &&
      !w.id, // the snapshot query is unscoped by id (freshRows re-fetch IS id-scoped)
  );
  assert.equal(
    stillPendingQueries.length,
    1,
    "guardrail 15: the shared stillPending snapshot must be taken ONCE and reused across both source passes — a per-source re-query would make this 2",
  );
});

test("guardrail 15: the single stillPending snapshot feeds BOTH the Plex and Jellyfin marking passes", async () => {
  configureBothServers();
  respond = bothServersRespond([100], [200]); // disjoint: 100 only in Plex, 200 only in Jellyfin
  seedRequest({ id: "req-plex", tmdbId: 100, mediaType: "MOVIE", requestedBy: "u-plex", status: "PENDING" });
  seedRequest({ id: "req-jf", tmdbId: 200, mediaType: "MOVIE", requestedBy: "u-jf", status: "PENDING" });

  const res = await POST(syncReq({ headers: AS_CRON }));
  const b = await bodyOf(res);
  await settle();

  // Each source marked ITS request from the one shared snapshot.
  assert.equal(b.plexMarked, 1, "guardrail 15: the Plex pass marked its request off the shared snapshot");
  assert.equal(b.jellyfinMarked, 1, "guardrail 15: the Jellyfin pass marked its request off the SAME shared snapshot");
  assert.equal(requests.get("req-plex")?.status, "AVAILABLE");
  assert.equal(requests.get("req-jf")?.status, "AVAILABLE");
});

// ═══════════════════════════════════════════════════════════════════════════
// GUARDRAIL 14 — one request in BOTH libraries notifies EXACTLY ONCE (the CAS)
// ═══════════════════════════════════════════════════════════════════════════

test("guardrail 14: a request present in BOTH Plex and Jellyfin fires the 'now available' notification EXACTLY ONCE", async () => {
  configureBothServers();
  respond = bothServersRespond([550], [550]); // SAME tmdb in both libraries
  seedRequest({ id: "req-shared", tmdbId: 550, mediaType: "MOVIE", requestedBy: "u-shared", status: "PENDING" });

  const res = await POST(syncReq({ headers: AS_CRON }));
  const b = await bodyOf(res);
  await settle();

  // Both passes matched the request (toMark.length each) …
  assert.equal(b.plexMarked, 1);
  assert.equal(b.jellyfinMarked, 1);

  // … but the notifiedAvailable CAS designated it a winner ONCE — the Jellyfin
  // pass re-reads notifiedAvailable=true and routes it to the non-notifying path.
  const winsForShared = casCalls.filter((c) => c.winners.includes("req-shared")).length;
  assert.equal(
    winsForShared,
    1,
    "guardrail 14: the notifiedAvailable CAS must claim the shared request as a winner EXACTLY ONCE across the Plex + Jellyfin passes",
  );

  // The in-app inbox fan-out (unconditional; the observable of the notify fan-out)
  // received the winner exactly once — no duplicate 'now available' notification.
  const sharedNotifies = notifiedTmdbIds().filter((id) => id === 550).length;
  assert.equal(
    sharedNotifies,
    1,
    "guardrail 14: exactly one 'now available' notification must reach the fan-out for a title present in both libraries",
  );
  assert.equal(requests.get("req-shared")?.notifiedAvailable, true);
});

test("guardrail 14: notifiedAvailable is flipped ONLY by the claim CAS (UPDATE … RETURNING), never a plain updateMany", async () => {
  configureBothServers();
  respond = bothServersRespond([550], [550]);
  seedRequest({ id: "req-shared", tmdbId: 550, mediaType: "MOVIE", requestedBy: "u-shared", status: "PENDING" });

  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  // The winner claim ran in markAvailable mode (status flip + PENDING/APPROVED guard).
  assert.ok(
    casCalls.some((c) => c.mode === "markAvailable" && c.winners.includes("req-shared")),
    "guardrail 14: the AVAILABLE transition must go through the markAvailable CAS",
  );
  // No plain updateMany may ever set notifiedAvailable — that would bypass the
  // exactly-once compare-and-swap.
  const sneaky = mediaRequestUpdateManyCalls.filter((c) => "notifiedAvailable" in (c.data ?? {}));
  assert.deepEqual(
    sneaky,
    [],
    "guardrail 14: notifiedAvailable must never be written by a plain mediaRequest.updateMany — only the CAS may flip it",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Sequencing + Promise.allSettled isolation
// ═══════════════════════════════════════════════════════════════════════════

test("a Plex fetch failure does NOT sink the Jellyfin pass (Promise.allSettled isolation)", async () => {
  configureBothServers();
  respond = (url) =>
    url.origin === PLEX_ORIGIN ? new Response("boom", { status: 500 }) : jellyfinResponder([200])(url);
  seedRequest({ id: "req-jf", tmdbId: 200, mediaType: "MOVIE", requestedBy: "u-jf", status: "PENDING" });

  const res = await POST(syncReq({ headers: AS_CRON }));
  const b = await bodyOf(res);
  await settle();

  // The whole run still succeeds (200 + degraded), Jellyfin still wrote + marked.
  assert.equal(res.status, 200);
  assert.equal(txTouching("plexLibraryItem").length, 0, "the failed Plex pass must not open a library write");
  assert.equal(txTouching("jellyfinLibraryItem").length, 1, "the Jellyfin pass completes despite Plex failing");
  assert.equal(b.plexMarked, 0);
  assert.equal(b.jellyfinMarked, 1);
  assert.deepEqual(b.failedSources, ["plex"]);
  assert.equal(res.headers.get("x-cron-degraded"), "plex");
  assert.equal(requests.get("req-jf")?.status, "AVAILABLE");
});

test("a Jellyfin fetch failure does NOT sink the Plex pass (symmetric isolation)", async () => {
  configureBothServers();
  respond = (url) =>
    url.origin === PLEX_ORIGIN ? plexResponder([100])(url) : new Response("nope", { status: 401 });
  seedRequest({ id: "req-plex", tmdbId: 100, mediaType: "MOVIE", requestedBy: "u-plex", status: "PENDING" });

  const res = await POST(syncReq({ headers: AS_CRON }));
  const b = await bodyOf(res);
  await settle();

  assert.equal(res.status, 200);
  assert.equal(txTouching("jellyfinLibraryItem").length, 0, "the failed Jellyfin pass must not open a library write");
  assert.equal(txTouching("plexLibraryItem").length, 1, "the Plex pass completes despite Jellyfin failing");
  assert.equal(b.plexMarked, 1);
  assert.equal(b.jellyfinMarked, 0);
  assert.deepEqual(b.failedSources, ["jellyfin"]);
  assert.equal(requests.get("req-plex")?.status, "AVAILABLE");
});

test("the Radarr + Sonarr wanted refreshes run sequentially and BOTH precede the concurrent library passes", async () => {
  configureBothServers();
  respond = bothServersRespond([550], [550]);

  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  const radarr = firstExecRawIndex("pg_advisory_xact_lock(1001, 1)");
  const sonarr = firstExecRawIndex("pg_advisory_xact_lock(1001, 2)");
  const plexLib = firstExecRawIndex("pg_advisory_xact_lock(2001, 1)");
  const jfLib = firstExecRawIndex("pg_advisory_xact_lock(2001, 2)");
  for (const [label, idx] of [["radarr", radarr], ["sonarr", sonarr], ["plexLib", plexLib], ["jfLib", jfLib]] as const) {
    assert.ok(idx >= 0, `expected the ${label} advisory-lock transaction to run`);
  }
  // Radarr is awaited before Sonarr (sequential to each other) …
  assert.ok(radarr < sonarr, "the Radarr wanted-sync must precede the Sonarr wanted-sync (they are sequential)");
  // … and both wanted-syncs precede the Plex + Jellyfin library replaces.
  assert.ok(sonarr < plexLib && sonarr < jfLib, "both arr wanted-syncs must precede the library passes");
  assert.ok(radarr < plexLib && radarr < jfLib, "both arr wanted-syncs must precede the library passes");
});

// ═══════════════════════════════════════════════════════════════════════════
// Tail: expired-TmdbCache purge
// ═══════════════════════════════════════════════════════════════════════════

test("the expired-TmdbCache purge fires near the end (deleteMany where expiresAt < now)", async () => {
  configureBothServers();
  respond = bothServersRespond([550], [550]);

  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  assert.equal(tmdbCacheDeleteManyCalls.length, 1, "one expired-cache purge per run");
  const arg = tmdbCacheDeleteManyCalls[0] as { where?: { expiresAt?: { lt?: Date } } };
  assert.ok(arg.where?.expiresAt?.lt instanceof Date, "the purge must scope to expiresAt < now, not wipe the whole cache");
});

// ═══════════════════════════════════════════════════════════════════════════
// Advisory lock 2000 — taken; a second concurrent run is gated
// ═══════════════════════════════════════════════════════════════════════════

test("advisory lock 2000 is acquired and released around a normal run", async () => {
  configureBothServers();
  respond = bothServersRespond([550], [550]);

  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  assert.ok(pgLockCalls.some((c) => c.op === "try" && c.lockId === 2000), "the orchestrator must take advisory lock 2000");
  assert.ok(pgLockCalls.some((c) => c.op === "unlock" && c.lockId === 2000), "advisory lock 2000 must be released in the finally");
});

test("a second concurrent run (lock 2000 busy) is gated: skipped:true, no fetch, no library write", async () => {
  configureBothServers();
  respond = bothServersRespond([550], [550]);
  lockAcquire = (id) => (id === 2000 ? false : true); // another run holds lock 2000

  const res = await POST(syncReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), { skipped: true, reason: "sync already running" });
  await settle();

  // The busy fast-path runs onBusy() only: work never starts.
  assert.ok(pgLockCalls.some((c) => c.op === "try" && c.lockId === 2000));
  assert.ok(!pgLockCalls.some((c) => c.op === "unlock" && c.lockId === 2000), "a lock never held is never unlocked");
  assert.equal(fetchCalls.length, 0, "the gated run must not fetch any library");
  assert.equal(transactions.length, 0, "the gated run must not open any transaction");
  assert.equal(casCalls.length, 0, "the gated run must not touch the notification CAS");
});
