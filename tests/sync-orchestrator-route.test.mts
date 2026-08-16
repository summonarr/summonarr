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
import { readFileSync } from "node:fs";
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
  // The multi-server per-user visibility grant blob (User.mediaServerGrants, a
  // nullable Json column). null ⇒ no grant ⇒ restricted instances are invisible.
  mediaServerGrants: unknown;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
  email: string | null; notificationEmail: string | null;
  emailOnAvailable: boolean; discordId: string | null; pushOnAvailable: boolean;
};
const usersById = new Map<string, UserRow>();
function defaultUser(id: string): UserRow {
  return {
    id, role: "USER", permissions: 0n, mediaServer: null, mediaServerGrants: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: null, notificationEmail: null, emailOnAvailable: false, discordId: null, pushOnAvailable: false,
  };
}
const sessionRows = new Set<string>();
const settings = new Map<string, string>();

// ── recorders ─────────────────────────────────────────────────────────────
const settingUpserts: Array<{ key: string; value: string }> = [];
// The create-only staleness baseline: a configured source that has NEVER synced clean has
// no marker row, so the 24h stale window has no origin and the notify fallback can never
// engage. Recorded separately from upserts — a seed must never masquerade as a success.
const settingCreateManyData: Array<{ key: string; value: string }> = [];
const auditRows: Array<Record<string, unknown>> = [];
const notificationCreateManyData: Array<Record<string, unknown>> = [];
const tmdbCacheDeleteManyCalls: unknown[] = [];
const mediaRequestFindManyWheres: Array<ReqWhere | undefined> = [];
const plexLibraryItemFindManyWheres: Array<Record<string, unknown> | undefined> = []; // the dedupe prior-mapping lookup
// Slugs whose PRESERVED library rows survive from an earlier run (guardrail 35 keeps the
// rows of a registered-but-unconfigured server). The demote guard probes for exactly
// these: a slug with rows this run never consulted vetoes the demote, one with none —
// e.g. a default that was never configured at all — does not.
const preservedRowSlugs = { plexLibraryItem: new Set<string>(), jellyfinLibraryItem: new Set<string>() };
const preservedRowFindFirsts: Array<{ model: string; slugs: string[] | undefined }> = [];
function preservedRowHit(model: "plexLibraryItem" | "jellyfinLibraryItem", slugs: string[] | undefined) {
  preservedRowFindFirsts.push({ model, slugs });
  const hit = (slugs ?? []).some((s) => preservedRowSlugs[model].has(s));
  return hit ? { tmdbId: 1 } : null;
}
// The de-registered-instance sweep runs OUTSIDE any transaction (top-level
// prisma), so its deletes land here rather than in the TxRecord journal.
const orphanSweepDeletes: Array<{ model: string; where: Record<string, unknown> | undefined }> = [];
const mediaRequestUpdateManyCalls: Array<{ where?: ReqWhere; data: Record<string, unknown> }> = [];
// Every user.findMany, with its select — the grants gate must ride the requester
// query the marking/notify passes ALREADY issue (extra columns, not an extra
// round-trip), so the count of requester-shaped reads is itself a pin.
const userFindManyCalls: Array<{ where?: Record<string, unknown>; select?: Record<string, unknown> }> = [];
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
    createMany: async (args: { data: Array<{ key: string; value: string }>; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const row of args.data) {
        settingCreateManyData.push(row);
        if (args.skipDuplicates && settings.has(row.key)) continue; // ON CONFLICT DO NOTHING
        settings.set(row.key, row.value);
        count++;
      }
      return { count };
    },
    deleteMany: async () => ({ count: 0 }),
  },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
    findMany: async (args: { where?: { id?: { in: string[] }; deactivatedAt?: unknown }; select?: Record<string, unknown> }) => {
      userFindManyCalls.push({ where: args?.where, select: args?.select });
      const ids = args?.where?.id?.in;
      if (!ids) return []; // email-normalize / any non-id query resolves empty
      const rows = ids.map((id) => ({ ...(usersById.get(id) ?? defaultUser(id)) }));
      // claimAvailableNotificationWinners asks for the DISABLED subset so it can
      // drop those recipients from the fan-out. Honour the predicate — returning
      // every id here would read as "everyone is disabled" and silently suppress
      // the notification this file exists to pin.
      if (args?.where?.deactivatedAt !== undefined) {
        return rows.filter((u) => (u as { deactivatedAt?: Date | null }).deactivatedAt != null);
      }
      return rows;
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
  plexLibraryItem: {
    // The dedupe prior-mapping lookup. Wheres are recorded so the instance-scoping
    // pin can assert the read carries serverInstance; no fixture seeds prior
    // mappings, so conflation resolves via the keep-first-occurrence branch.
    findMany: async (args?: { where?: Record<string, unknown> }) => {
      plexLibraryItemFindManyWheres.push(args?.where);
      return [];
    },
    // The demote guard's "does this registered-but-unconfigured slug ACTUALLY still hold
    // preserved rows?" probe. Answers from preservedRowSlugs so a never-configured
    // instance (no rows) is distinguishable from one whose token an admin cleared.
    findFirst: async (args?: { where?: { serverInstance?: { in?: string[] } } }) =>
      preservedRowHit("plexLibraryItem", args?.where?.serverInstance?.in),
    // The end-of-run sweep for de-registered instances (top-level, not in a tx).
    deleteMany: async (args?: { where?: Record<string, unknown> }) => {
      orphanSweepDeletes.push({ model: "plexLibraryItem", where: args?.where });
      return { count: 0 };
    },
  },
  jellyfinLibraryItem: {
    findFirst: async (args?: { where?: { serverInstance?: { in?: string[] } } }) =>
      preservedRowHit("jellyfinLibraryItem", args?.where?.serverInstance?.in),
    deleteMany: async (args?: { where?: Record<string, unknown> }) => {
      orphanSweepDeletes.push({ model: "jellyfinLibraryItem", where: args?.where });
      return { count: 0 };
    },
  },
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
// RFC1918 literal like the others: admin-configured SSRF mode, no DNS lookup.
const RADARR_BASE = "http://10.77.0.3:7878";
const RADARR_ORIGIN = new URL(RADARR_BASE).origin;
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
// ── Radarr fixture ──────────────────────────────────────────────────────────
// The AVAILABLE -> APPROVED demote is gated on the integration being enabled AND this
// run having refreshed the REQUEST'S OWN instance (radarrSyncedSlugs). With no Radarr
// configured, getSyncableArrInstances returns nothing, that set stays empty, and the
// demote short-circuits before any library logic runs — which is why this suite could
// not reach the demote path at all until now.
function configureRadarr(): void {
  settings.set("radarrUrl", RADARR_BASE);
  settings.set("radarrApiKey", "radarr-api-key");
}

// Answers the one endpoint getRadarrWantedTmdbIds hits. `tmdbIds` are the movies Radarr
// knows about; anything absent is genuinely not in Radarr, which is the precondition for
// a demote (the request is neither in an arr nor in a library the requester can see).
function radarrResponder(tmdbIds: number[] = []): (url: URL) => Response {
  return (url) => {
    if (url.pathname === "/api/v3/movie") {
      return okJson(tmdbIds.map((tmdbId) => ({ tmdbId, hasFile: true })));
    }
    throw new Error(`unexpected Radarr fetch ${url.href}`);
  };
}

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
  settingCreateManyData.length = 0;
  preservedRowSlugs.plexLibraryItem.clear();
  preservedRowSlugs.jellyfinLibraryItem.clear();
  preservedRowFindFirsts.length = 0;
  auditRows.length = 0;
  notificationCreateManyData.length = 0;
  tmdbCacheDeleteManyCalls.length = 0;
  mediaRequestFindManyWheres.length = 0;
  mediaRequestUpdateManyCalls.length = 0;
  userFindManyCalls.length = 0;
  plexLibraryItemFindManyWheres.length = 0;
  orphanSweepDeletes.length = 0;
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
  assert.equal(tmdbCacheDeleteManyCalls.length, 3, "the tail purge is three passes: everything else now, ratings and :details each on their own grace");
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

    // The FULL-replace signature. Both sources' deletes are scoped per-instance
    // (serverInstance: "" for the default/only configured server here) rather than
    // table-wide — multi-server support (Phase 1 Jellyfin, Phase 2 Plex) — but each
    // is still an UNCONDITIONAL delete of that instance's rows (no recency/date
    // filter), so recentOnly still can't have downgraded it to insert-only.
    const plexDeletes = plexTx[0].ops.filter((o) => o.model === "plexLibraryItem" && o.method === "deleteMany");
    const jfDeletes = jfTx[0].ops.filter((o) => o.model === "jellyfinLibraryItem" && o.method === "deleteMany");
    assert.deepEqual(
      plexDeletes.map((d) => d.args),
      [{ where: { serverInstance: "" } }],
      `guardrail 13: body ${body} must NOT downgrade to insert-only — the orchestrator ignores the body and always issues the unconditional (per-instance-scoped) Plex library replace`,
    );
    assert.deepEqual(
      jfDeletes.map((d) => d.args),
      [{ where: { serverInstance: "" } }],
      `guardrail 13: body ${body} must NOT downgrade to insert-only — the orchestrator ignores the body and always issues the unconditional (per-instance-scoped) Jellyfin library replace`,
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
// Multi-server Jellyfin (Phase 1) — union-availability + per-instance scoping
// ═══════════════════════════════════════════════════════════════════════════
//
// A second, independently-configured Jellyfin server (media-instance-registry.ts's
// JSON registry + its own jellyfinRemoteUrl/jellyfinRemoteApiKey Settings — see
// media-instances.ts). Unlike the arr instance model, nothing routes a REQUEST
// to a specific Jellyfin server — availability is a union across every
// configured server of a type — so these tests pin that union directly,
// alongside the per-instance-scoped library write it's built on.
const JF_REMOTE_BASE = "http://10.77.0.3:8096";
const JF_REMOTE_ORIGIN = new URL(JF_REMOTE_BASE).origin;

function configureJellyfinMultiServer(): void {
  settings.set("jellyfinUrl", JF_BASE);
  settings.set("jellyfinApiKey", "jf-api-key-default");
  settings.set("jellyfinRemoteUrl", JF_REMOTE_BASE);
  settings.set("jellyfinRemoteApiKey", "jf-api-key-remote");
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
}

// Serves items only for the ONE library id it owns, keyed off the ParentId
// Jellyfin's client sends when a selection is active — so a server asked for
// another server's library id returns nothing, exactly as the real one would.
function jellyfinResponderInLibrary(libraryId: string, movieTmdbIds: number[]): (url: URL) => Response {
  return (url) => {
    if (url.pathname === "/Items" && url.searchParams.get("IncludeItemTypes") === "Movie") {
      const asked = url.searchParams.get("ParentId");
      const items = asked === null || asked === libraryId ? movieTmdbIds : [];
      return okJson({
        Items: items.map((id) => ({ Id: `jf-${id}`, Name: `Movie ${id}`, ProviderIds: { Tmdb: String(id) } })),
        TotalRecordCount: items.length,
      });
    }
    if (url.pathname === "/Items" && url.searchParams.get("IncludeItemTypes") === "Series") {
      return okJson({ Items: [], TotalRecordCount: 0 });
    }
    throw new Error(`unexpected Jellyfin fetch ${url.pathname}`);
  };
}

test("multi-server: each Jellyfin instance filters by ITS OWN library selection, not the default server's", async () => {
  // The Jellyfin half of the same bug. Library ids are GUIDs so they do not
  // collide the way Plex section keys do — the failure is quieter but just as
  // total: the named server is asked for a library id it has never heard of,
  // matches nothing, and its scoped full-replace wipes its rows.
  configureJellyfinMultiServer();
  settings.set("jellyfinLibraries", "lib-default");
  settings.set("jellyfinRemoteLibraries", "lib-remote");
  const defaultResponder = jellyfinResponderInLibrary("lib-default", [300]);
  const remoteResponder = jellyfinResponderInLibrary("lib-remote", [400]);
  respond = (url) => (url.origin === JF_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));

  seedRequest({ id: "jf-default-only", tmdbId: 300, mediaType: "MOVIE", requestedBy: "u1", status: "PENDING" });
  seedRequest({ id: "jf-remote-only", tmdbId: 400, mediaType: "MOVIE", requestedBy: "u2", status: "PENDING" });

  const res = await POST(syncReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  await settle();

  assert.equal(requests.get("jf-default-only")?.status, "AVAILABLE", "the default server's own selection still works");
  assert.equal(
    requests.get("jf-remote-only")?.status,
    "AVAILABLE",
    "the named server was asked for the DEFAULT server's library id, matched nothing, and contributed no availability",
  );
});

test("multi-server: a request is marked AVAILABLE via the UNION of two independently-configured Jellyfin instances' libraries", async () => {
  configureJellyfinMultiServer();
  // Disjoint libraries — no overlap — so a match can only come from the UNION,
  // never from either instance's map alone.
  const defaultResponder = jellyfinResponder([300]);
  const remoteResponder = jellyfinResponder([400]);
  respond = (url) => (url.origin === JF_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));

  seedRequest({ id: "req-default-only", tmdbId: 300, mediaType: "MOVIE", requestedBy: "u1", status: "PENDING" });
  seedRequest({ id: "req-remote-only", tmdbId: 400, mediaType: "MOVIE", requestedBy: "u2", status: "PENDING" });

  const res = await POST(syncReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  const b = await bodyOf(res);
  await settle();

  assert.equal(
    b.jellyfinMarked,
    2,
    "both requests matched the UNIONED jellyfin availability map — the downstream marking logic never changed, only how the map is populated",
  );
  assert.equal(requests.get("req-default-only")?.status, "AVAILABLE");
  assert.equal(
    requests.get("req-remote-only")?.status,
    "AVAILABLE",
    "a title that exists ONLY on the second, named instance is still marked available — proves the union, not just the default instance's library, backs the decision",
  );
});

test("multi-server: two configured Jellyfin instances each get their OWN serverInstance-scoped deleteMany + createMany — never each other's rows", async () => {
  configureJellyfinMultiServer();
  const defaultResponder = jellyfinResponder([300]);
  const remoteResponder = jellyfinResponder([400]);
  respond = (url) => (url.origin === JF_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));

  const res = await POST(syncReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  await settle();

  const jfTx = txTouching("jellyfinLibraryItem");
  assert.equal(jfTx.length, 1, "both instances' scoped writes land inside ONE shared transaction (one lock acquisition — mirrors the arr instance loop)");

  const deletes = jfTx[0].ops.filter((o) => o.model === "jellyfinLibraryItem" && o.method === "deleteMany");
  assert.equal(deletes.length, 2, "one scoped delete per configured instance — never a single unconditional wipe");
  assert.deepEqual(
    deletes.map((d) => (d.args as { where?: { serverInstance?: string } } | null)?.where?.serverInstance ?? null).sort(),
    ["", "remote"],
    "each delete is scoped to its OWN instance slug",
  );

  const creates = jfTx[0].ops.filter((o) => o.model === "jellyfinLibraryItem" && o.method === "createMany");
  assert.equal(creates.length, 2, "one createMany batch per configured instance");
  for (const c of creates) {
    const rows = (c.args as { data: Array<{ serverInstance: string; tmdbId: number }> }).data;
    assert.ok(rows.length > 0);
    assert.equal(
      new Set(rows.map((r) => r.serverInstance)).size,
      1,
      "every row within ONE instance's createMany batch carries that SAME instance's slug — never a mix",
    );
  }
  const allCreatedRows = creates.flatMap((c) => (c.args as { data: Array<{ serverInstance: string; tmdbId: number }> }).data);
  assert.deepEqual(allCreatedRows.filter((r) => r.serverInstance === "").map((r) => r.tmdbId), [300], "the default instance's row carries ITS OWN library's tmdbId");
  assert.deepEqual(allCreatedRows.filter((r) => r.serverInstance === "remote").map((r) => r.tmdbId), [400], "the named instance's row carries ITS OWN library's tmdbId, never the default's");
});

// ═══════════════════════════════════════════════════════════════════════════
// Multi-server Plex (Phase 2) — union-availability + per-instance scoping
// ═══════════════════════════════════════════════════════════════════════════
//
// The Plex mirror of the Jellyfin block above: a second, independently-
// configured Plex server (media-instance-registry.ts's JSON registry + its own
// plexRemoteServerUrl/plexRemoteAdminToken Settings). Same contract — nothing
// routes a REQUEST to a specific Plex server; availability is a union across
// every configured server of a type, backed by a per-instance-scoped write.
const PLEX_REMOTE_BASE = "http://10.77.0.4:32400";
const PLEX_REMOTE_ORIGIN = new URL(PLEX_REMOTE_BASE).origin;

function configurePlexMultiServer(): void {
  settings.set("plexServerUrl", PLEX_BASE);
  settings.set("plexAdminToken", "plex-admin-token-default");
  settings.set("plexRemoteServerUrl", PLEX_REMOTE_BASE);
  settings.set("plexRemoteAdminToken", "plex-admin-token-remote");
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
}

// Like plexResponder but takes raw /all Metadata items, for fixtures that need
// full control of ratingKey/Guid shapes (the dedupe-scoping pin).
function plexItemsResponder(items: unknown[]): (url: URL) => Response {
  return (url) => {
    if (url.pathname === "/library/sections") {
      return okJson({ MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie" }] } });
    }
    if (url.pathname === "/library/sections/1/all") {
      return okJson({ MediaContainer: { totalSize: items.length, Metadata: items } });
    }
    throw new Error(`unexpected Plex fetch ${url.pathname}`);
  };
}

test("multi-server: a request is marked AVAILABLE via the UNION of two independently-configured Plex instances' libraries", async () => {
  configurePlexMultiServer();
  // Disjoint libraries — no overlap — so a match can only come from the UNION,
  // never from either instance's map alone.
  const defaultResponder = plexResponder([300]);
  const remoteResponder = plexResponder([400]);
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));

  seedRequest({ id: "req-default-only", tmdbId: 300, mediaType: "MOVIE", requestedBy: "u1", status: "PENDING" });
  seedRequest({ id: "req-remote-only", tmdbId: 400, mediaType: "MOVIE", requestedBy: "u2", status: "PENDING" });

  const res = await POST(syncReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  const b = await bodyOf(res);
  await settle();

  assert.equal(
    b.plexMarked,
    2,
    "both requests matched the UNIONED plex availability map — the downstream marking logic never changed, only how the map is populated",
  );
  assert.equal(requests.get("req-default-only")?.status, "AVAILABLE");
  assert.equal(
    requests.get("req-remote-only")?.status,
    "AVAILABLE",
    "a title that exists ONLY on the second, named instance is still marked available — proves the union, not just the default instance's library, backs the decision",
  );
});

// Like plexResponder but the section key is caller-chosen, so two servers can
// number their libraries differently — which is the real-world case, since a
// Plex section key is a small integer scoped to one server.
function plexResponderOnSection(sectionKey: string, movieTmdbIds: number[]): (url: URL) => Response {
  return (url) => {
    if (url.pathname === "/library/sections") {
      return okJson({ MediaContainer: { Directory: [{ key: sectionKey, title: "Movies", type: "movie" }] } });
    }
    if (url.pathname === `/library/sections/${sectionKey}/all`) {
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

test("every library-selection lookup in the orchestrator is keyed by an INSTANCE, never a hardcoded default", () => {
  // Four sites read a selection: the Plex and Jellyfin library fetches, and the
  // Plex and Jellyfin TV-episode fetches. The behavioural tests below cover the
  // two library fetches; the episode ones feed TVEpisodeCache, whose per-instance
  // content this harness does not assert, so a revert there survived the suite.
  // Rather than leave half the fix unpinned, require all four to pass a slug —
  // a literal "" would re-apply one server's selection to every server, which is
  // the exact bug.
  const source = readFileSync(new URL("../src/app/api/sync/route.ts", import.meta.url), "utf8");
  const lookups = source.match(/librarySelections\.get\([^)]*\)/g) ?? [];
  assert.equal(lookups.length, 4, "expected exactly the four selection lookups");
  for (const l of lookups) {
    assert.doesNotMatch(l, /SettingKey\(\s*""/, `${l} pins the DEFAULT server's selection onto every instance`);
    assert.match(l, /SettingKey\((instance\.slug|slug)\s*,/, `${l} must key off the instance being synced`);
  }
});

test("multi-server: each Plex instance filters by ITS OWN library selection, not the default server's", async () => {
  // The bug this pins: one shared `plexLibraries` selection was applied to every
  // instance. Section keys are per-server, so the default's "1" names a
  // different library on the remote — the remote's real Movies section (7) was
  // excluded, it contributed nothing, and because each instance's write is a
  // scoped FULL REPLACE its rows were then replaced with nothing. Everything on
  // that server silently read as unavailable.
  configurePlexMultiServer();
  settings.set("plexLibraries", "1");        // the default server's Movies
  settings.set("plexRemoteLibraries", "7");  // the remote's Movies — a different key
  const defaultResponder = plexResponderOnSection("1", [300]);
  const remoteResponder = plexResponderOnSection("7", [400]);
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));

  seedRequest({ id: "req-default-only", tmdbId: 300, mediaType: "MOVIE", requestedBy: "u1", status: "PENDING" });
  seedRequest({ id: "req-remote-only", tmdbId: 400, mediaType: "MOVIE", requestedBy: "u2", status: "PENDING" });

  const res = await POST(syncReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  await settle();

  assert.equal(requests.get("req-default-only")?.status, "AVAILABLE", "the default server's own selection still works");
  assert.equal(
    requests.get("req-remote-only")?.status,
    "AVAILABLE",
    "the named server was filtered by the DEFAULT server's section keys — its real library was excluded and it contributed nothing",
  );
});

test("multi-server: an instance with NO selection syncs all of its libraries rather than inheriting another server's", async () => {
  // A named instance has no selection until an admin makes one, and the safe
  // reading of "unset" is everything — not "whatever the default picked".
  configurePlexMultiServer();
  settings.set("plexLibraries", "1"); // default narrowed; remote left unset
  const defaultResponder = plexResponderOnSection("1", [300]);
  const remoteResponder = plexResponderOnSection("7", [400]);
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));

  seedRequest({ id: "req-remote-unset", tmdbId: 400, mediaType: "MOVIE", requestedBy: "u2", status: "PENDING" });

  const res = await POST(syncReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  await settle();

  assert.equal(
    requests.get("req-remote-unset")?.status,
    "AVAILABLE",
    "an unset selection must mean ALL libraries on that server, not the default's keys",
  );
});

test("multi-server: two configured Plex instances each get their OWN serverInstance-scoped deleteMany + createMany — never each other's rows", async () => {
  configurePlexMultiServer();
  const defaultResponder = plexResponder([300]);
  const remoteResponder = plexResponder([400]);
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));

  const res = await POST(syncReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  await settle();

  const plexTx = txTouching("plexLibraryItem");
  assert.equal(plexTx.length, 1, "both instances' scoped writes land inside ONE shared transaction (one lock acquisition — mirrors the Jellyfin arm)");

  const deletes = plexTx[0].ops.filter((o) => o.model === "plexLibraryItem" && o.method === "deleteMany");
  assert.equal(deletes.length, 2, "one scoped delete per configured instance — never a single unconditional wipe");
  assert.deepEqual(
    deletes.map((d) => (d.args as { where?: { serverInstance?: string } } | null)?.where?.serverInstance ?? null).sort(),
    ["", "remote"],
    "each delete is scoped to its OWN instance slug",
  );

  const creates = plexTx[0].ops.filter((o) => o.model === "plexLibraryItem" && o.method === "createMany");
  assert.equal(creates.length, 2, "one createMany batch per configured instance");
  for (const c of creates) {
    const rows = (c.args as { data: Array<{ serverInstance: string; tmdbId: number }> }).data;
    assert.ok(rows.length > 0);
    assert.equal(
      new Set(rows.map((r) => r.serverInstance)).size,
      1,
      "every row within ONE instance's createMany batch carries that SAME instance's slug — never a mix",
    );
  }
  const allCreatedRows = creates.flatMap((c) => (c.args as { data: Array<{ serverInstance: string; tmdbId: number }> }).data);
  assert.deepEqual(allCreatedRows.filter((r) => r.serverInstance === "").map((r) => r.tmdbId), [300], "the default instance's row carries ITS OWN library's tmdbId");
  assert.deepEqual(allCreatedRows.filter((r) => r.serverInstance === "remote").map((r) => r.tmdbId), [400], "the named instance's row carries ITS OWN library's tmdbId, never the default's");
});

test("multi-server: the conflated-ratingKey dedupe is instance-scoped — the prior-mapping read carries serverInstance, and the SAME ratingKey on two servers is NOT conflation", async () => {
  configurePlexMultiServer();
  // Default instance: ONE item carrying TWO tmdb guids — genuine conflation
  // within that instance's batch (two rows share ratingKey "rk-shared").
  // Remote instance: a single item that happens to reuse the SAME ratingKey —
  // Plex ratingKeys are small server-local integers, so cross-instance equality
  // is routine and legitimate, never conflation.
  const defaultResponder = plexItemsResponder([
    { ratingKey: "rk-shared", type: "movie", title: "Conflated", Guid: [{ id: "tmdb://601" }, { id: "tmdb://602" }] },
  ]);
  const remoteResponder = plexItemsResponder([
    { ratingKey: "rk-shared", type: "movie", title: "Remote Movie", Guid: [{ id: "tmdb://400" }] },
  ]);
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));

  const res = await POST(syncReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  await settle();

  // Exactly ONE prior-mapping lookup fired — for the default instance's conflated
  // MOVIE batch — and it is scoped to THAT instance. An unscoped read could import
  // the remote server's rk-shared→400 mapping and wrongly drop the default's rows.
  assert.deepEqual(
    plexLibraryItemFindManyWheres,
    [{ mediaType: "MOVIE", serverInstance: "", tmdbId: { in: [601, 602] } }],
    "the dedupe's conflated-ratingKey DB read must be scoped to the instance batch being deduped",
  );

  // Dedupe resolved WITHIN the default instance (no prior mapping ⇒ keep first
  // occurrence), while the remote instance's same-ratingKey row survived untouched.
  const plexTx = txTouching("plexLibraryItem");
  assert.equal(plexTx.length, 1);
  const allCreatedRows = plexTx[0].ops
    .filter((o) => o.model === "plexLibraryItem" && o.method === "createMany")
    .flatMap((c) => (c.args as { data: Array<{ serverInstance: string; tmdbId: number; plexRatingKey: string | null }> }).data);
  assert.deepEqual(
    allCreatedRows.filter((r) => r.serverInstance === "").map((r) => r.tmdbId),
    [601],
    "conflation within one instance's batch keeps the first occurrence and drops the second",
  );
  assert.deepEqual(
    allCreatedRows.filter((r) => r.serverInstance === "remote").map((r) => r.tmdbId),
    [400],
    "a cross-instance ratingKey collision is legitimate — the remote row must NOT be deduped away",
  );
  assert.ok(allCreatedRows.every((r) => r.plexRatingKey === "rk-shared"));
});

// ═══════════════════════════════════════════════════════════════════════════
// Per-user media-server VISIBILITY grants — the AVAILABLE flip AND the
// notification are per-requester once an instance is `restricted`
// ═══════════════════════════════════════════════════════════════════════════
//
// Product contract: a request flips to AVAILABLE only when the title sits on a
// server THAT REQUESTER can see, and the notification follows the same gate. A
// requester who cannot see the only server holding the title keeps their request
// OPEN (PENDING/APPROVED) and un-notified, and gets the normal "now available"
// treatment later — when a copy lands somewhere they CAN see, or when the grant
// is issued.
//
// The gate is PRE-CAS by construction (a JS filter over the candidate array,
// before any id reaches claimAvailableNotificationWinners), which is what keeps
// guardrail 14 intact AND leaves the once-only claim UN-BURNED for a gated
// requester — the opposite of notify-available.ts's post-CAS deactivatedAt
// filter, which burns it deliberately.

// A restricted second Plex server: its library counts as availability only for
// users holding mediaServerGrants.plex.remote.view === true.
function configurePlexRestrictedRemote(): void {
  configurePlexMultiServer();
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote", restricted: true }]));
}
function configureJellyfinRestrictedRemote(): void {
  configureJellyfinMultiServer();
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "remote", name: "Remote", restricted: true }]));
}
function seedUser(id: string, grants: unknown): void {
  usersById.set(id, { ...defaultUser(id), mediaServerGrants: grants });
}
const GRANT_PLEX_REMOTE = { plex: { remote: { view: true } } };
const GRANT_JF_REMOTE = { jellyfin: { remote: { view: true } } };
function notifiedUserIds(): string[] {
  return notificationCreateManyData.map((d) => d.userId as string);
}
// The requester reads the marking/notify passes issue — identified by the
// `mediaServer` column, which no other user.findMany in the run selects
// (claimAvailableNotificationWinners' disabled-check and the email-pref fetch
// select different shapes).
function requesterReads(): Array<{ where?: Record<string, unknown>; select?: Record<string, unknown> }> {
  return userFindManyCalls.filter((c) => c.select?.mediaServer === true);
}

test("grants: a requester GRANTED the only instance holding the title flips to AVAILABLE and is notified", async () => {
  configurePlexRestrictedRemote();
  // The title exists ONLY on the restricted "remote" server; the default server's
  // library is empty, so nothing but a grant can make this available.
  const defaultResponder = plexResponder([]);
  const remoteResponder = plexResponder([900]);
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));
  seedUser("u-granted", GRANT_PLEX_REMOTE);
  seedRequest({ id: "req-granted", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-granted", status: "PENDING" });

  const res = await POST(syncReq({ headers: AS_CRON }));
  const b = await bodyOf(res);
  await settle();

  assert.equal(b.plexMarked, 1, "the granted requester's request survives the visibility gate");
  assert.equal(requests.get("req-granted")?.status, "AVAILABLE");
  assert.equal(requests.get("req-granted")?.notifiedAvailable, true);
  assert.deepEqual(notifiedUserIds(), ["u-granted"], "exactly one 'now available' notification, to the granted requester");
});

test("grants: an UNGRANTED requester does NOT flip, is NOT notified, and their claim is left UN-BURNED", async () => {
  configurePlexRestrictedRemote();
  const defaultResponder = plexResponder([]);
  const remoteResponder = plexResponder([900]);
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));
  // Same title, same run, same restricted server — the ONLY difference is the grant.
  seedUser("u-granted", GRANT_PLEX_REMOTE);
  seedUser("u-ungranted", null);
  seedRequest({ id: "req-granted", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-granted", status: "PENDING" });
  seedRequest({ id: "req-ungranted", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-ungranted", status: "APPROVED" });

  const res = await POST(syncReq({ headers: AS_CRON }));
  const b = await bodyOf(res);
  await settle();

  assert.equal(b.plexMarked, 1, "only the granted requester's request is counted as marked");
  assert.equal(requests.get("req-granted")?.status, "AVAILABLE");
  assert.equal(
    requests.get("req-ungranted")?.status,
    "APPROVED",
    "the ungranted requester's request stays OPEN — availability is per-viewer, so an invisible server must not flip it",
  );
  assert.equal(
    requests.get("req-ungranted")?.notifiedAvailable,
    false,
    "the once-only claim must be left UN-BURNED so a later grant can still deliver the notification",
  );
  assert.deepEqual(notifiedUserIds(), ["u-granted"], "the ungranted requester receives no 'now available' notification");
});

test("grants: the gate is PRE-CAS — a gated request id NEVER reaches claimAvailableNotificationWinners", async () => {
  configurePlexRestrictedRemote();
  const defaultResponder = plexResponder([]);
  const remoteResponder = plexResponder([900]);
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));
  seedUser("u-granted", GRANT_PLEX_REMOTE);
  seedUser("u-ungranted", null);
  seedRequest({ id: "req-granted", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-granted", status: "PENDING" });
  seedRequest({ id: "req-ungranted", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-ungranted", status: "PENDING" });

  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  // Structural: the filter runs on the materialised candidate array BEFORE the
  // UPDATE … RETURNING. A post-CAS filter would still suppress the notification
  // but would BURN notifiedAvailable (and flip status), permanently stranding the
  // requester even after a grant — so assert on the CAS inputs, not just outputs.
  assert.ok(casCalls.length > 0, "the granted requester's claim did run (otherwise this pin proves nothing)");
  const casSawGated = casCalls.filter((c) => c.ids.includes("req-ungranted"));
  assert.deepEqual(
    casSawGated,
    [],
    "the visibility gate must be applied BEFORE the CAS — a gated id must never appear in an UPDATE … RETURNING candidate list",
  );
  assert.ok(
    casCalls.some((c) => c.ids.includes("req-granted")),
    "the un-gated requester's id still reaches the CAS unchanged (guardrail 14's exactly-once mechanism is untouched)",
  );
  // No plain updateMany may flip the gated row either (the toMarkOnly / already-
  // notified branches must be gated too, not just the notifying one).
  const flippedGated = mediaRequestUpdateManyCalls.filter(
    (c) => c.where?.id?.in?.includes("req-ungranted") && (c.data ?? {}).status === "AVAILABLE",
  );
  assert.deepEqual(flippedGated, [], "no non-CAS write may flip a gated request to AVAILABLE either");
});

test("grants RECOVERY: the NEXT run flips + notifies once the grant is issued", async () => {
  configurePlexRestrictedRemote();
  const defaultResponder = plexResponder([]);
  const remoteResponder = plexResponder([900]);
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));
  seedUser("u-late", null);
  seedRequest({ id: "req-late", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-late", status: "PENDING" });

  await POST(syncReq({ headers: AS_CRON }));
  await settle();
  assert.equal(requests.get("req-late")?.status, "PENDING", "run 1: no grant, no flip");
  assert.deepEqual(notifiedUserIds(), [], "run 1: no notification");

  // The admin issues the grant; nothing else about the run changes.
  seedUser("u-late", GRANT_PLEX_REMOTE);
  notificationCreateManyData.length = 0;
  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  assert.equal(requests.get("req-late")?.status, "AVAILABLE", "run 2: the grant makes the same library the requester's own");
  assert.equal(requests.get("req-late")?.notifiedAvailable, true);
  assert.deepEqual(
    notifiedUserIds(),
    ["u-late"],
    "run 2 delivers the 'now available' notification — proof run 1 left the once-only claim un-burned",
  );
});

test("grants RECOVERY: the NEXT run flips + notifies once a copy lands on a VISIBLE instance (no grant needed)", async () => {
  configurePlexRestrictedRemote();
  const emptyDefault = plexResponder([]);
  const remoteResponder = plexResponder([900]);
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url) : emptyDefault(url));
  seedUser("u-ungranted", null);
  seedRequest({ id: "req-copy", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-ungranted", status: "PENDING" });

  await POST(syncReq({ headers: AS_CRON }));
  await settle();
  assert.equal(requests.get("req-copy")?.status, "PENDING", "run 1: only the invisible server holds it");

  // The title is now on the DEFAULT server too — visible to everyone by
  // construction (defaultInstanceConfig hard-codes restricted:false).
  const stockedDefault = plexResponder([900]);
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url) : stockedDefault(url));
  notificationCreateManyData.length = 0;
  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  assert.equal(requests.get("req-copy")?.status, "AVAILABLE");
  assert.deepEqual(notifiedUserIds(), ["u-ungranted"], "a copy on a visible server delivers the notification with no grant at all");
});

test("grants: the Jellyfin arm carries its OWN per-instance presence map (not the Plex one, not the union)", async () => {
  configureJellyfinRestrictedRemote();
  const defaultResponder = jellyfinResponder([]);
  const remoteResponder = jellyfinResponder([900]);
  respond = (url) => (url.origin === JF_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));
  seedUser("u-granted", GRANT_JF_REMOTE);
  seedUser("u-ungranted", null);
  // A plex-shaped grant must NOT unlock a jellyfin instance of the same slug —
  // the grant map is keyed by service (see permissions.ts's two-level shape).
  seedUser("u-wrong-service", GRANT_PLEX_REMOTE);
  seedRequest({ id: "req-jf-granted", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-granted", status: "PENDING" });
  seedRequest({ id: "req-jf-ungranted", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-ungranted", status: "PENDING" });
  seedRequest({ id: "req-jf-wrong", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-wrong-service", status: "PENDING" });

  const res = await POST(syncReq({ headers: AS_CRON }));
  const b = await bodyOf(res);
  await settle();

  assert.equal(b.jellyfinMarked, 1);
  assert.equal(requests.get("req-jf-granted")?.status, "AVAILABLE");
  assert.equal(requests.get("req-jf-ungranted")?.status, "PENDING");
  assert.equal(requests.get("req-jf-wrong")?.status, "PENDING", "a plex grant on the same slug must not unlock the jellyfin instance");
  assert.deepEqual(notifiedUserIds(), ["u-granted"]);
});

test("grants: the AVAILABLE-but-unnotified fallback notify is per-viewer too", async () => {
  // The end-of-run fallback (status=AVAILABLE, notifiedAvailable=false) is a
  // SECOND, independent notify gate — rows reach it via the webhook flip or the
  // non-notifying toMarkOnly path, never via markLibraryRequests' claim. Seeded
  // directly here because that is exactly the state those paths leave behind.
  configurePlexRestrictedRemote();
  const defaultResponder = plexResponder([]);
  const remoteResponder = plexResponder([900]);
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));
  seedUser("u-granted", GRANT_PLEX_REMOTE);
  seedUser("u-ungranted", null);
  seedRequest({ id: "av-granted", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-granted", status: "AVAILABLE", notifiedAvailable: false });
  seedRequest({ id: "av-ungranted", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-ungranted", status: "AVAILABLE", notifiedAvailable: false });

  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  assert.equal(requests.get("av-granted")?.notifiedAvailable, true, "the granted viewer's fallback notify fires");
  assert.equal(
    requests.get("av-ungranted")?.notifiedAvailable,
    false,
    "the ungranted viewer is not notified off a server they cannot see — and their claim stays un-burned",
  );
  assert.deepEqual(notifiedUserIds(), ["u-granted"]);
  assert.deepEqual(
    casCalls.filter((c) => c.ids.includes("av-ungranted")),
    [],
    "the fallback's grants filter is pre-CAS as well — a gated id never enters the claim",
  );
});

test("grants: with NO restricted instance configured the run is byte-identical — every requester flips, notifies, and the requester read count is unchanged", async () => {
  // Same two-instance topology and the same title-on-the-named-server-only
  // fixture as the gated tests above; the ONLY difference is restricted:false.
  configurePlexMultiServer(); // registry entry carries no `restricted` field ⇒ open
  const defaultResponder = plexResponder([]);
  const remoteResponder = plexResponder([900]);
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));
  seedUser("u-a", null);
  seedUser("u-b", null);
  seedRequest({ id: "req-a", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-a", status: "PENDING" });
  seedRequest({ id: "req-b", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-b", status: "PENDING" });

  const res = await POST(syncReq({ headers: AS_CRON }));
  const b = await bodyOf(res);
  await settle();

  assert.equal(b.plexMarked, 2, "no instance is restricted ⇒ the union IS the per-user answer ⇒ both requests mark");
  assert.equal(requests.get("req-a")?.status, "AVAILABLE");
  assert.equal(requests.get("req-b")?.status, "AVAILABLE");
  assert.deepEqual(notifiedUserIds().sort(), ["u-a", "u-b"], "both requesters are notified, exactly as before grants existed");
  // The gate must cost NO extra round-trip: the grant columns ride the requester
  // read the marking pass already issued (one per source pass that has work).
  assert.equal(
    requesterReads().length,
    1,
    "exactly one requester read for the one marking pass with candidates — the grants columns are extra COLUMNS, never an extra query",
  );
  assert.deepEqual(
    requesterReads()[0].select,
    { id: true, mediaServer: true, role: true, permissions: true, mediaServerGrants: true },
    "the requester read carries the grant columns alongside the pre-existing mediaServer preference column — `role` included because the gate must resolve effectivePermissions, never the raw column",
  );
});

test("grants: a legacy ADMIN row (role=ADMIN, permissions=0) is gated by its ROLE, not its unseeded permissions column", async () => {
  // `User.permissions` is @default(0) and only seeded by a MANUAL one-shot
  // script, so an upgraded deployment really can hold role="ADMIN" with
  // permissions=0 — every read path handles it via effectivePermissions. If the
  // sync gate passed the raw column instead, the ADMIN short-circuit would miss
  // HERE and only here: the badge would read "available" while the operator's
  // own request stayed PENDING forever, with nothing surfacing the strand.
  configurePlexRestrictedRemote();
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? plexResponder([700])(url) : plexResponder([])(url));
  // Note defaultUser() already carries permissions: 0n — the unseeded state IS
  // this harness's default, which is precisely why an ADMIN-role fixture is the
  // one that exposes a raw-column read.
  usersById.set("u-legacy-admin", { ...defaultUser("u-legacy-admin"), role: "ADMIN" });
  seedRequest({ id: "req-legacy-admin", tmdbId: 700, mediaType: "MOVIE", requestedBy: "u-legacy-admin", status: "PENDING" });

  const res = await POST(syncReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  await settle();

  assert.equal(
    requests.get("req-legacy-admin")?.status,
    "AVAILABLE",
    "an ADMIN sees every instance regardless of grants — resolved from role, since the permissions column was never seeded",
  );
  assert.deepEqual(notifiedUserIds(), ["u-legacy-admin"]);
});

test("grants: requester reads stay BATCHED and constant — never one per requester", async () => {
  // The property is guardrail 31's: no per-requester round-trip. Enforced mode issues a
  // fixed, small number of BATCHED reads — one for the demote pass (which decides per
  // requester whether a title is on a server they can see) and one at the candidate
  // scope for the marking pass, reused for its mediaServer split. What must never
  // happen is the count scaling with the number of requesters, which is what the
  // assertion below actually pins.
  configurePlexRestrictedRemote();
  const defaultResponder = plexResponder([]);
  const remoteResponder = plexResponder([900]);
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url) : defaultResponder(url));
  // SEVERAL distinct requesters: with one, a per-requester round-trip would be
  // indistinguishable from a batched read, so the count alone would prove nothing.
  const statuses = ["PENDING", "APPROVED", "AVAILABLE"] as const;
  for (let i = 0; i < 12; i++) {
    const u = `u-${i}`;
    seedUser(u, GRANT_PLEX_REMOTE);
    seedRequest({ id: `req-${i}`, tmdbId: 900, mediaType: "MOVIE", requestedBy: u, status: statuses[i % 3] });
  }

  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  // 12 distinct requesters. The reads are bounded by the number of PASSES (the demote,
  // plus one candidate-scope load per marking source, reused for that source's
  // mediaServer split) — never by how many requesters there are. A per-requester
  // round-trip would be at least 12.
  const reads = requesterReads().length;
  assert.ok(reads <= 3, `12 requesters must not mean 12 reads — expected at most 3 batched, got ${reads}`);
});

test("multi-server PARTIAL failure: one instance's library fetch failing preserves its rows, suppresses the success stamp, and vetoes the whole-table episode rewrite", async () => {
  configurePlexMultiServer();
  // The named instance is down; the default is healthy. Every safeguard must
  // treat this run's union as an INCOMPLETE picture.
  const defaultResponder = plexResponder([300]);
  // 404 not 500 — a 5xx sleeps through the Plex page walk's real retry backoff
  // (see the isolation test above).
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? new Response("gone", { status: 404 }) : defaultResponder(url));

  const res = await POST(syncReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  const b = await bodyOf(res);
  await settle();

  // (a) Only the healthy instance's scoped delete+rewrite ran — the failed
  // instance never entered `writable`, so its existing library rows survive
  // the run untouched (guardrail 13 per instance).
  const plexTx = txTouching("plexLibraryItem");
  assert.equal(plexTx.length, 1);
  const deletes = plexTx[0].ops.filter((o) => o.model === "plexLibraryItem" && o.method === "deleteMany");
  assert.deepEqual(
    deletes.map((d) => (d.args as { where?: { serverInstance?: string } } | null)?.where?.serverInstance ?? null),
    [""],
    "only the healthy (default) instance is deleted+rewritten; the down instance's rows must survive its outage",
  );

  // (b) THE load-bearing pin: the whole-table TVEpisodeCache rewrite must NOT
  // run on an incomplete union. TVEpisodeCache has no serverInstance column, so
  // a rewrite here would deleteMany({source:"plex"}) — wiping the DOWN server's
  // episode rows — and reinsert only the healthy server's. The gate's
  // `writable.length === fetched.length` term is what this asserts: an instance
  // whose LIBRARY fetch failed never got an episode fetch at all, which the
  // episode loop's own allEpisodesFetched flag cannot see.
  assert.equal(
    txTouching("tVEpisodeCache").length,
    0,
    "a library-fetch failure on ANY instance must veto the all-or-nothing episode rewrite",
  );

  // (c) The run is not stamped clean and the source is reported degraded —
  // plexSyncSucceeded requires EVERY configured instance's fetch to succeed.
  assert.ok(
    !settingUpserts.some((u) => u.key === "lastPlexSyncSucceededAt"),
    "a partial run must not stamp lastPlexSyncSucceededAt",
  );
  assert.deepEqual(b.failedSources, ["plex"]);
});

test("de-registered instances are swept: the sweep targets exactly the slugs NOT in the registry, scoped per service", async () => {
  // The orchestrator captures its instance list before a multi-minute library
  // walk, so a removal landing mid-run can be re-inserted by the write that
  // follows — and once the slug is de-registered nothing ever targets it
  // again, so the rows would read "in library" forever. Re-reading the
  // registry after the writes closes that window in the same run, and also
  // repairs rows orphaned by a release predating the removal cleanup.
  configurePlexMultiServer();
  respond = (url) => (url.origin === PLEX_REMOTE_ORIGIN ? plexResponder([400])(url) : plexResponder([300])(url));

  const res = await POST(syncReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  await settle();

  const plexSweep = orphanSweepDeletes.filter((d) => d.model === "plexLibraryItem");
  assert.equal(plexSweep.length, 1, "exactly one sweep per service, after the library writes");
  assert.deepEqual(
    plexSweep[0].where,
    { serverInstance: { notIn: ["", "remote"] } },
    "the sweep spares every REGISTERED slug and targets the rest — a notIn over the registry, never a blanket delete",
  );
  const jfSweep = orphanSweepDeletes.filter((d) => d.model === "jellyfinLibraryItem");
  assert.equal(jfSweep.length, 1);
  assert.deepEqual(
    jfSweep[0].where,
    { serverInstance: { notIn: [""] } },
    "each service sweeps against its OWN registry — a Plex slug must not spare a Jellyfin row or vice versa",
  );
});

test("the sweep spares a REGISTERED but unconfigured instance — an admin mid-edit must not lose their library", async () => {
  // getSyncableMediaInstances (what the sync arms fan out over) requires BOTH
  // connection fields; getMediaInstances (what the sweep reads) requires only
  // registration. That difference is the whole safety margin: an instance
  // whose token is momentarily blank still appears in the registry, so its
  // rows survive exactly as a failed instance's rows do.
  settings.set("plexServerUrl", PLEX_BASE);
  settings.set("plexAdminToken", "plex-admin-token-default");
  settings.set("plexInstances", JSON.stringify([{ slug: "halfway", name: "Halfway" }]));
  settings.set("plexRemoteServerUrl", PLEX_REMOTE_BASE); // a DIFFERENT slug's keys — "halfway" has none
  respond = plexResponder([300]);

  const res = await POST(syncReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  await settle();

  const plexSweep = orphanSweepDeletes.filter((d) => d.model === "plexLibraryItem");
  assert.deepEqual(
    plexSweep[0].where,
    { serverInstance: { notIn: ["", "halfway"] } },
    "an unconfigured-but-registered slug is spared; only de-registration sweeps rows",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Sequencing + Promise.allSettled isolation
// ═══════════════════════════════════════════════════════════════════════════

test("a Plex fetch failure does NOT sink the Jellyfin pass (Promise.allSettled isolation)", async () => {
  configureBothServers();
  // 404, not 500: the Plex page walk retries 5xx with ~12s of REAL backoff
  // (pinned with mocked timers in tests/plex.test.mts) — a persistent 500 here
  // still passes but sleeps through every retry on each run. A non-429 4xx
  // fast-fails, which is all this isolation pin needs.
  respond = (url) =>
    url.origin === PLEX_ORIGIN ? new Response("gone", { status: 404 }) : jellyfinResponder([200])(url);
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

  type PurgeArg = {
    where?: {
      expiresAt?: { lt?: Date };
      NOT?: { OR?: Array<{ key?: { startsWith?: string } }> };
      OR?: Array<{ key?: { startsWith?: string } }>;
    };
  };
  assert.equal(tmdbCacheDeleteManyCalls.length, 3, "three purge passes per run");
  const [general, ratings, details] = tmdbCacheDeleteManyCalls as PurgeArg[];
  assert.ok(general.where?.expiresAt?.lt instanceof Date, "the purge must scope to expiresAt < now, not wipe the whole cache");

  // The ratings namespaces AND the :details blobs are serve-stale surfaces:
  // getCacheStale/getCacheStaleMany never delete an expired row because it is
  // still a HIT. This purge was the only thing deleting them, one SYNC_INTERVAL
  // after expiry — so a provider outage lost the badges (and the dashboard/
  // carry-forward readers lost their blobs) entirely. Each namespace is excluded
  // from the immediate pass and reaped on its own grace instead.
  // Nested under OR deliberately: the shapes are mutually exclusive, so a bare
  // `NOT: [a, b]` would be a silent no-op if a list-NOT compiles to NOT(a AND b).
  assert.deepEqual(
    general.where?.NOT,
    { OR: [
      { key: { startsWith: "mdblist:tmdb:" } },
      { key: { startsWith: "omdb:tmdb:" } },
      { key: { startsWith: "movie:", endsWith: ":details" } },
      { key: { startsWith: "tv:", endsWith: ":details" } },
    ] },
    "the immediate purge must spare every serve-stale namespace",
  );
  assert.deepEqual(
    details.where?.OR,
    [
      { key: { startsWith: "movie:", endsWith: ":details" } },
      { key: { startsWith: "tv:", endsWith: ":details" } },
    ],
    "the :details grace pass targets exactly the details blobs — endsWith-pinned, so credits/suggestions/seasons and the :missing tombstones still expire immediately",
  );
  assert.deepEqual(
    ratings.where?.OR,
    [{ key: { startsWith: "mdblist:tmdb:" } }, { key: { startsWith: "omdb:tmdb:" } }],
    "the ratings grace purge targets exactly those namespaces — `:tmdb:` scoped, so the list caches still expire immediately",
  );
  const graceCutoff = ratings.where?.expiresAt?.lt as Date;
  assert.ok(graceCutoff instanceof Date, "the grace purge is still expiry-scoped, never a blanket delete");
  assert.ok(
    Date.now() - graceCutoff.getTime() >= 29 * 24 * 60 * 60 * 1000,
    "the ratings grace must be far wider than one sync interval, or serve-stale is still collapsed",
  );
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

// ── the AVAILABLE -> APPROVED demote is a PER-REQUESTER decision ────────────

test("demote: an AVAILABLE request reverts when its only holder is a restricted server the requester cannot see", async () => {
  // The demote used to read the GLOBAL library union, so a restricted server the
  // requester holds no grant for still counted as "present" and kept the request
  // AVAILABLE — for a copy they cannot watch, and which every read path has always
  // rendered as unavailable. It asks per requester now, the same way the marking pass
  // decides whether to flip a request TO available in the first place.
  configurePlexRestrictedRemote();
  configureRadarr();
  const defaultResponder = plexResponder([]);
  const remoteResponder = plexResponder([900]);
  const radarr = radarrResponder([]); // Radarr does not know this movie
  respond = (url) =>
    url.origin === RADARR_ORIGIN ? radarr(url)
      : url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url)
        : defaultResponder(url);

  seedUser("u-ungranted", {});
  seedRequest({ id: "req-ungranted", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-ungranted", status: "AVAILABLE" });

  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  assert.equal(
    requests.get("req-ungranted")?.status,
    "APPROVED",
    "a title held only by a server this requester cannot see is not available TO THEM",
  );
});

test("demote: the SAME title stays AVAILABLE for a requester who holds the grant", async () => {
  // The counterpart. Without it a demote that fired for everyone would satisfy the test
  // above, so this is what stops the per-requester gate becoming a blanket revert.
  configurePlexRestrictedRemote();
  configureRadarr();
  const defaultResponder = plexResponder([]);
  const remoteResponder = plexResponder([900]);
  const radarr = radarrResponder([]);
  respond = (url) =>
    url.origin === RADARR_ORIGIN ? radarr(url)
      : url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url)
        : defaultResponder(url);

  seedUser("u-granted", GRANT_PLEX_REMOTE);
  seedRequest({ id: "req-granted", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-granted", status: "AVAILABLE" });

  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  assert.equal(requests.get("req-granted")?.status, "AVAILABLE", "a granted requester keeps their availability");
});

test("demote: a service with NOTHING configured must not look like an incomplete union", async () => {
  // getMediaInstances always synthesizes the default instance, so an unconfigured
  // service reads as 1 registered vs 0 syncable. Without the in-use term on that check,
  // the "registered but unconfigured, can't prove absence" guard fired on every
  // deployment not running BOTH Plex and Jellyfin — silently disabling demotes for
  // almost everyone. This pins that a Plex-only deployment still demotes.
  configurePlexRestrictedRemote(); // Plex configured; Jellyfin entirely absent
  configureRadarr();
  const defaultResponder = plexResponder([]);
  const remoteResponder = plexResponder([900]);
  const radarr = radarrResponder([]);
  respond = (url) =>
    url.origin === RADARR_ORIGIN ? radarr(url)
      : url.origin === PLEX_REMOTE_ORIGIN ? remoteResponder(url)
        : defaultResponder(url);

  seedUser("u-nojf", {});
  seedRequest({ id: "req-nojf", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-nojf", status: "AVAILABLE" });

  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  assert.equal(requests.get("req-nojf")?.status, "APPROVED", "an unconfigured Jellyfin must not veto Plex-based demotes");
});

test("demote: a NAMED-only Plex deployment still demotes — the synthesized default holds no rows, so absence IS provable", async () => {
  // getMediaInstances always synthesizes the default, so an operator who uses Plex
  // exclusively through a named instance and never fills in the legacy default's
  // connection fields reads as 2 registered vs 1 syncable on EVERY run. A raw count
  // comparison made that permanently "incomplete" and vetoed every demote forever — yet
  // the guard's rationale ("its preserved rows are not in this run's union") is vacuous
  // for a server that was never configured: it has no rows.
  settings.set("plexRemoteServerUrl", PLEX_REMOTE_BASE);
  settings.set("plexRemoteAdminToken", "plex-admin-token-remote");
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  configureRadarr();
  const radarr = radarrResponder([]);
  const remoteResponder = plexResponder([]); // the remote no longer holds it either
  respond = (url) => (url.origin === RADARR_ORIGIN ? radarr(url) : remoteResponder(url));

  seedRequest({ id: "req-named-only", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-named", status: "AVAILABLE" });

  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  assert.deepEqual(
    preservedRowFindFirsts.filter((p) => p.model === "plexLibraryItem").map((p) => p.slugs),
    [[""]],
    "the veto probes exactly the registered-but-unsyncable slugs — here the never-configured default",
  );
  assert.equal(
    requests.get("req-named-only")?.status,
    "APPROVED",
    "a never-configured default instance holds no preserved rows and must not disable demotes",
  );
});

test("demote: a registered instance that still HOLDS preserved rows does veto the demote", async () => {
  // The counterpart, and the intent this must not regress: an admin who clears a
  // configured server's token drops it out of this run's union while guardrail 35
  // deliberately preserves its rows. A title living only there reads as absent from data
  // never consulted, so the demote stays off.
  settings.set("plexRemoteServerUrl", PLEX_REMOTE_BASE);
  settings.set("plexRemoteAdminToken", "plex-admin-token-remote");
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }, { slug: "attic", name: "Attic" }]));
  preservedRowSlugs.plexLibraryItem.add("attic"); // registered, token cleared, rows survive
  configureRadarr();
  const radarr = radarrResponder([]);
  const remoteResponder = plexResponder([]);
  respond = (url) => (url.origin === RADARR_ORIGIN ? radarr(url) : remoteResponder(url));

  seedRequest({ id: "req-attic", tmdbId: 900, mediaType: "MOVIE", requestedBy: "u-attic", status: "AVAILABLE" });

  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  assert.equal(
    requests.get("req-attic")?.status,
    "AVAILABLE",
    "we cannot prove absence from a server whose preserved rows this run never consulted",
  );
  assert.ok(
    warns.some((w) => w.includes("skipping AVAILABLE->APPROVED demotes")),
    "the veto is announced, naming how many servers are in that state",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale-sync notify fallback — a source that has NEVER synced clean
// ═══════════════════════════════════════════════════════════════════════════

test("a configured source that has NEVER synced clean gets a create-only staleness baseline", async () => {
  // The 24h fallback ("treat a long-broken source's data as valid so the OTHER source can
  // satisfy the notify gate alone") keys off lastPlexSyncSucceededAt, which is stamped
  // ONLY on a clean run. Without a baseline a source that was never healthy has no row at
  // all, so the window has no origin, *Stale is false forever, and every user pinned to
  // that source is starved permanently — the exact failure the fallback exists to prevent.
  configureBothServers();
  // 404 not 500 — a 5xx pays the Plex page walk's real retry backoff (see the isolation test above).
  respond = (url) =>
    (url.origin === PLEX_ORIGIN ? new Response("gone", { status: 404 }) : jellyfinResponder([550])(url));
  seedRequest({ id: "req-avail", tmdbId: 550, mediaType: "MOVIE", requestedBy: "u-avail", status: "AVAILABLE" });

  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  assert.deepEqual(
    settingCreateManyData.map((r) => r.key),
    ["lastPlexSyncSucceededAt"],
    "only the failing source with no marker is seeded; a source that synced clean is stamped by its own upsert",
  );
  assert.ok(
    !settingUpserts.some((u) => u.key === "lastPlexSyncSucceededAt"),
    "the baseline is a create-only seed — a failed run must never look like a success",
  );
  assert.ok(
    settings.has("lastJellyfinSyncSucceededAt"),
    "the healthy source is stamped normally",
  );
});

test("the staleness baseline never overwrites a real success stamp, and is not seeded on a clean run", async () => {
  // skipDuplicates is what makes the seed idempotent: a source that succeeded hours ago
  // and is failing now keeps its true last-success timestamp, so the 24h window is
  // measured from when it was actually healthy.
  configureBothServers();
  const realSuccess = String(Date.now() - 6 * 60 * 60 * 1000);
  settings.set("lastPlexSyncSucceededAt", realSuccess);
  // 404 not 500 — a 5xx pays the Plex page walk's real retry backoff (see the isolation test above).
  respond = (url) =>
    (url.origin === PLEX_ORIGIN ? new Response("gone", { status: 404 }) : jellyfinResponder([550])(url));
  seedRequest({ id: "req-avail", tmdbId: 550, mediaType: "MOVIE", requestedBy: "u-avail", status: "AVAILABLE" });

  await POST(syncReq({ headers: AS_CRON }));
  await settle();

  assert.equal(settings.get("lastPlexSyncSucceededAt"), realSuccess, "an existing success stamp survives the seed");

  // A run where both sources sync clean seeds nothing at all.
  settingCreateManyData.length = 0;
  settings.clear();
  configureBothServers();
  respond = bothServersRespond([550], [550]);
  await POST(syncReq({ headers: AS_CRON }));
  await settle();
  assert.deepEqual(settingCreateManyData, [], "a clean run seeds no baseline");
});

// ═══════════════════════════════════════════════════════════════════════════
// skippedSources — "never attempted" is not "failed"
// ═══════════════════════════════════════════════════════════════════════════

// Why this field has to exist at all: plexMarked/jellyfinMarked are initialised
// to 0 and always serialized, so "this deployment has no Jellyfin" and "Jellyfin
// is configured and matched nothing" arrive at a client byte-identical. With no
// way to ask the server, every admin sync control instead probed the per-source
// routes and read their `400 {"error":"… not configured"}` as a failure — which
// is why a single-server deployment saw a red error on every click while its one
// configured server had synced perfectly.
test("skippedSources names the media server that is NOT configured, and failedSources stays empty", async () => {
  // Plex only — the shape of the overwhelming majority of real deployments.
  settings.set("plexServerUrl", PLEX_BASE);
  settings.set("plexAdminToken", "plex-admin-token-1");
  respond = plexResponder([100]);
  seedRequest({ id: "req-p", tmdbId: 100, mediaType: "MOVIE", requestedBy: "u-p", status: "PENDING" });

  const res = await POST(syncReq({ headers: AS_CRON }));
  const b = await bodyOf(res);
  await settle();

  assert.equal(res.status, 200);
  const skipped = (b.skippedSources ?? []) as string[];
  assert.ok(skipped.includes("jellyfin"), "an unconfigured Jellyfin is reported as skipped");
  assert.ok(!skipped.includes("plex"), "a configured Plex is NOT skipped");
  // The distinction the whole field exists for: skipped is not failed.
  assert.equal(b.failedSources, undefined, "nothing FAILED — the run was clean");
  assert.equal(b.error, undefined, "and therefore no degraded error string");
  assert.equal(res.headers.get("x-cron-degraded"), null);
  assert.equal(b.plexMarked, 1, "the configured server still did its work");
  assert.equal(requests.get("req-p")?.status, "AVAILABLE");
});

test("a CONFIGURED server that fails is reported as failed, never as skipped", async () => {
  // The counterpart, and the reason a client cannot just treat both lists alike:
  // suppressing not-configured must not also suppress a real outage. Wave 8 made
  // exactly that mistake in SyncButton — it stopped reading the Jellyfin channel
  // at all, so a genuine 502 became "Up to date".
  configureBothServers();
  respond = (url) =>
    url.origin === PLEX_ORIGIN ? plexResponder([100])(url) : new Response("nope", { status: 401 });

  const res = await POST(syncReq({ headers: AS_CRON }));
  const b = await bodyOf(res);
  await settle();

  assert.deepEqual(b.failedSources, ["jellyfin"], "configured + broken ⇒ failed");
  assert.ok(
    !((b.skippedSources ?? []) as string[]).includes("jellyfin"),
    "a configured server must never appear as skipped — that would hide the outage",
  );
});

test("a configured media server never appears in skippedSources, and *arr uses synced-slugs not the flag", async () => {
  // The arr half is a deliberate asymmetry worth pinning: radarrEnabled means
  // "the step did not blow up", and an enabled-but-unconfigured Radarr still
  // sets radarrSyncSucceeded while refreshing nothing. So the predicate keys on
  // the synced-slug set instead — otherwise an install with no *arr at all
  // would report them as neither skipped nor failed, i.e. as working.
  configureBothServers();
  respond = bothServersRespond([100], [200]);

  const res = await POST(syncReq({ headers: AS_CRON }));
  const b = await bodyOf(res);
  await settle();

  const skipped = (b.skippedSources ?? []) as string[];
  assert.ok(!skipped.includes("plex"), "a configured Plex is never skipped");
  assert.ok(!skipped.includes("jellyfin"), "a configured Jellyfin is never skipped");
  assert.deepEqual(
    skipped.sort(),
    ["radarr", "sonarr"],
    "no *arr is configured in this harness, so both are skipped — proving the list is derived " +
      "from what was actually there to sync, not from the enabled flag",
  );
  assert.equal(b.failedSources, undefined, "and nothing failed");
});
