// Route-level unit tests for the 5s play-history poller —
// src/app/api/sync/play-history/route.ts (POST). This is the OTHER half of the
// live-session finalize story: plex-events.ts is the real-time SSE writer,
// this route is the polling /status/sessions + /Sessions writer and the
// stall/absence-grace *safety net* beneath it. The two headline pins are
// CLAUDE.md guardrails 20 and 21, restated for the POLLER writer here:
//
//   Guardrail 20 — the stall anchor tracks playhead MOVEMENT, not advance.
//   The poller finalizes a STILL-PLAYING Plex session only when its playhead
//   has been FROZEN (snapshot viewOffset === stored progressMs) for
//   >= PLEX_STALL_THRESHOLD_MS (60s). A session whose playhead MOVED —
//   forward OR backward (a rewind is liveness) — must NOT stall-finalize; it
//   refreshes progressUpdatedAt (`viewOffset !== progressMs`) and updates in
//   place. Regressing the check to a strict `>` advance lets the poller
//   stall-finalize a live, rewinding stream whenever SSE wrote progressMs last.
//   The headline test seeds a frozen ghost and a moving stream side-by-side in
//   ONE snapshot and asserts only the ghost's PlayHistory row lands.
//
//   Guardrail 21 — reanchorActiveSessionsOnBoot() runs at the TOP of
//   syncPlayHistory, BEFORE any ActiveSession read that feeds a stale sweep.
//   The recorded prisma call order proves it: the very first ActiveSession
//   operation of the process is the where-less updateMany({data:{lastSeenAt}}),
//   and it precedes the source:"plex" stale-sweep findMany. The re-anchor is
//   once-guarded per process (play-history memoizes the promise), so this order
//   pin lives on the FIRST full run and later runs assert it does NOT recur.
//
// Also pinned: guardrail 27 (the recentlyFinalized ledger mark goes AFTER the
// recordCompletedSession DB write — a failed write leaves no phantom ledger
// entry, so a later poll can retry); guardrail 19 (the finalize reaches
// recordCompletedSession with the `${sessionKey}:${startedAt}` dedup key +
// skipDuplicates); SESSION_ABSENCE_GRACE_MS (absent past the 60s grace
// finalizes, within it is spared); the create/update/increment wiring for
// new + continuing sessions; auth gating through isCronAuthorized (bearer +
// admin session); and the degraded-source X-Cron-Degraded contract.
//
// Division of labour — this file pins only the ROUTE'S USE of these:
//   - tests/cron-auth.test.mts OWNS isCronAuthorized's bearer/compare internals
//     and withCronRunRecording's ok-derivation.
//   - tests/play-history.test.mts OWNS recordCompletedSession's internals
//     (playDuration math, watched/completed, the dedup key, the CAS delete) and
//     reanchorActiveSessionsOnBoot's once-guard/failure-release. Here they are
//     observed only through the prisma calls the route drives them to issue.
//   - tests/plex-events.test.mts OWNS the SSE writer's guardrail 20/21 pins;
//     this file mirrors its assertion style for the poller half.
//   - tests/rate-limit.test.mts OWNS checkRateLimit; not re-pinned here.
//
// Harness: no DB, network, or DNS. globalThis.prisma is pre-seeded with a
// recording fake + a small stateful ActiveSession store BEFORE the module graph
// loads (the poster-cache/plex-events idiom), so the route AND play-history.ts
// underneath it share one in-memory surface. globalThis.fetch is scripted per
// path (/status/sessions, /Sessions, plex.tv owner, marker metadata). The Plex
// and Jellyfin server URLs are RFC1918 IP literals — safeFetchAdminConfigured
// admits them with allowPrivate=true and (being literals) never resolves DNS;
// dns.lookup is stubbed as belt-and-braces for the plex.tv owner fetch.
//
// The one deliberate fiction (documented at the fake): the route fires
// reconcilePlexEventStream() fire-and-forget on every run. Reconcile shares the
// plexServerUrl/plexAdminToken settings and, satisfied, would open a real SSE
// connection whose 22h recycle timer leaks under the test process AND whose
// bootstrap would double-finalize the very rows this file seeds. Reconcile is
// tested in plex-events.test.mts; here its 2-key settings read is STARVED so it
// early-returns shouldRun=false, keeping this file focused on the poller writer.
// Real timers throughout; every source read is a bounded findMany, so short
// setImmediate drains suffice for the fire-and-forget markers/logAudit tails.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "play-history-route-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000"; // unprefixed cookie name + session trusted origin
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
const CRON_SECRET = "play-history-route-cron-secret-0123456789abcdef"; // >= 32 chars
process.env.CRON_SECRET = CRON_SECRET;
delete process.env.PORT;
delete process.env.BASE_PATH;

// ── real clock captured before any override; row timestamps ride it ─────────
// The poller times stall/absence off `new Date()` (system clock, NOT Date.now),
// so seeded rows MUST be built relative to the REAL clock or the gaps drift.
// Date.now is offset only to expire play-history's 15s settings cache when the
// enable flags change (the play-history.test pattern) — never for row timing.
const realNow = Date.now.bind(Date);
let clockOffsetMs = 0;
Date.now = () => realNow() + clockOffsetMs;
const agoReal = (ms: number): Date => new Date(realNow() - ms);

// ── DNS stub (belt and braces — the plex.tv owner fetch is the only DNS user) ─
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture (guardrail 7: warn/error only, [scope]-prefixed) ────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── recording fake prisma + a stateful ActiveSession store ──────────────────
type DbCall = { model: string; op: string; args: unknown };
const dbCalls: DbCall[] = [];
function rec(model: string, op: string, args: unknown): void {
  dbCalls.push({ model, op, args });
}

interface ActiveRow {
  id: string;
  source: string;
  sessionKey: string;
  startedAt: Date;
  lastSeenAt: Date;
  state: string;
  mediaServerUserId: string;
  serverUsername: string;
  tmdbId: number | null;
  mediaType: string | null;
  title: string;
  year: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  sourceItemId: string | null;
  posterPath: string | null;
  progressPercent: number;
  progressMs: bigint;
  progressUpdatedAt: Date;
  playtimeMs: bigint;
  durationMs: bigint;
  platform: string | null;
  player: string | null;
  device: string | null;
  ipAddress: string | null;
  playMethod: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  bitrate: number | null;
  videoDecision: string | null;
  audioDecision: string | null;
  container: string | null;
  transcodeReason: string | null;
  location: string | null;
  bandwidth: number | null;
  secure: boolean | null;
  relayed: boolean | null;
  introStartMs: number | null;
  introEndMs: number | null;
  creditsStartMs: number | null;
  creditsEndMs: number | null;
}

const activeStore = new Map<string, ActiveRow>();
let playHistoryCreateError: Error | null = null;

// Settings live in two maps to keep the reconcile-starvation fiction honest:
//   - `settings`      : play-history enable flags + thresholds (loadSettings read)
//   - `syncSettings`  : the 4 connection URLs/keys, served ONLY to the route's
//                        4-key SYNC read (the ONE read that includes jellyfinUrl).
//     reconcile's 2-key {plexServerUrl,plexAdminToken} read never sees a url →
//     shouldRun=false → no SSE connection opens.
const settings = new Map<string, string>();
const syncSettings = new Map<string, string>();
const settingUpserts: Array<{ key: string; value: string }> = [];

// verifyAndRefreshSession's DB surface for the admin-session test (the
// sync-routes.test.mts fixture shape).
type DbUser = {
  role: string; permissions: bigint; mediaServer: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
  email: string | null; notificationEmail: string | null;
};
const usersById = new Map<string, DbUser>();
const sessionRows = new Set<string>();

interface ActiveWhere {
  id?: string | { in: string[] };
  source?: string;
  lastSeenAt?: Date | { lt: Date };
  OR?: unknown[];
}
interface FindManyArgs { where?: ActiveWhere; select?: unknown; orderBy?: unknown }
interface UpdateManyArgs { where?: ActiveWhere; data: Record<string, unknown> }
interface DeleteManyArgs { where: ActiveWhere }
interface CreateManyArgs { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }

function matchesFindMany(row: ActiveRow, where?: ActiveWhere): boolean {
  if (!where) return true;
  if (where.OR) return false; // jellyfin (msUser,itemId) fallback — no rows seeded for it
  if (typeof where.id === "object" && "in" in where.id) return where.id.in.includes(row.id);
  if (typeof where.id === "string") return row.id === where.id;
  if (where.source !== undefined && row.source !== where.source) return false;
  if (where.lastSeenAt && typeof where.lastSeenAt === "object" && "lt" in where.lastSeenAt) {
    return row.lastSeenAt.getTime() < where.lastSeenAt.lt.getTime();
  }
  return true;
}

const fakePrisma = {
  setting: {
    findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
      rec("setting", "findMany", args);
      const keys = args?.where?.key?.in ?? [];
      // The route's SYNC read is the ONLY read that asks for jellyfinUrl; only
      // it may see the connection URLs (see the syncSettings comment above).
      const isSyncRead = keys.includes("jellyfinUrl");
      const rows: Array<{ key: string; value: string }> = [];
      for (const k of keys) {
        if (isSyncRead && syncSettings.has(k)) rows.push({ key: k, value: syncSettings.get(k)! });
        else if (settings.has(k)) rows.push({ key: k, value: settings.get(k)! });
      }
      return rows;
    },
    upsert: async (args: { where: { key: string }; create: { key: string; value: string } }) => {
      rec("setting", "upsert", args);
      settingUpserts.push({ key: args.where.key, value: args.create.value });
      settings.set(args.where.key, args.create.value);
      return args.create;
    },
  },
  activeSession: {
    findMany: async (args?: FindManyArgs) => {
      rec("activeSession", "findMany", args);
      return [...activeStore.values()].filter((r) => matchesFindMany(r, args?.where));
    },
    updateMany: async (args: UpdateManyArgs) => {
      rec("activeSession", "updateMany", args);
      if (!args.where) return { count: activeStore.size }; // the where-less boot re-anchor
      const id = typeof args.where.id === "string" ? args.where.id : undefined;
      if (!id) return { count: 0 };
      const row = activeStore.get(id);
      if (!row) return { count: 0 };
      // CAS on lastSeenAt: a stale prefetch loses to a concurrent writer.
      if (args.where.lastSeenAt instanceof Date && row.lastSeenAt.getTime() !== args.where.lastSeenAt.getTime()) {
        return { count: 0 };
      }
      return { count: 1 };
    },
    createMany: async (args: CreateManyArgs) => {
      rec("activeSession", "createMany", args);
      for (const d of args.data) {
        const row = d as unknown as ActiveRow;
        if (!activeStore.has(row.id)) activeStore.set(row.id, row);
      }
      return { count: args.data.length };
    },
    deleteMany: async (args: DeleteManyArgs) => {
      rec("activeSession", "deleteMany", args);
      const id = typeof args.where.id === "string" ? args.where.id : undefined;
      if (id && activeStore.has(id)) {
        const row = activeStore.get(id)!;
        if (!(args.where.lastSeenAt instanceof Date) || row.lastSeenAt.getTime() === args.where.lastSeenAt.getTime()) {
          activeStore.delete(id);
          return { count: 1 };
        }
      }
      return { count: 0 };
    },
  },
  playHistory: {
    createMany: async (args: CreateManyArgs) => {
      // Record only a SUCCESSFUL write so historyRows() reflects rows that
      // actually landed — a throwing createMany writes nothing in a real DB
      // (the guardrail-27 failed-finalize case).
      if (playHistoryCreateError) throw playHistoryCreateError;
      rec("playHistory", "createMany", args);
      return { count: args.data.length };
    },
    findFirst: async (args: unknown) => {
      rec("playHistory", "findFirst", args);
      return null; // no resume-group chaining in these fixtures
    },
    deleteMany: async (args: unknown) => {
      rec("playHistory", "deleteMany", args);
      return { count: 0 };
    },
  },
  plexLibraryItem: {
    findMany: async (args: unknown) => { rec("plexLibraryItem", "findMany", args); return []; },
    findFirst: async (args: unknown) => { rec("plexLibraryItem", "findFirst", args); return null; },
  },
  jellyfinLibraryItem: {
    findMany: async (args: unknown) => { rec("jellyfinLibraryItem", "findMany", args); return []; },
    findFirst: async (args: unknown) => { rec("jellyfinLibraryItem", "findFirst", args); return null; },
  },
  tmdbMediaCore: {
    findMany: async (args: unknown) => { rec("tmdbMediaCore", "findMany", args); return []; },
  },
  tmdbCache: {
    findUnique: async (args: unknown) => { rec("tmdbCache", "findUnique", args); return null; },
    findMany: async (args: unknown) => { rec("tmdbCache", "findMany", args); return []; },
  },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
  },
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) =>
      sessionRows.has(args.where.sessionId)
        ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
        : null,
    update: async () => ({}), // lastSeenAt fire-and-forget touch
  },
  // Retention CAS: INSERT ... ON CONFLICT ... — return 0 (not claimed) so
  // purgeOldHistory never runs (retention is unset in these fixtures anyway).
  $executeRaw: async (strings: TemplateStringsArray, ..._v: unknown[]) => {
    rec("$", "executeRaw", strings.join("?"));
    return 0;
  },
  $queryRaw: async () => {
    throw new Error("unexpected prisma.$queryRaw — no poller path uses it in these tests");
  },
  // resolveMediaServerUser's serialized upsert. The poller passes no email and
  // no serverMachineId, so the tx only takes the advisory lock and upserts.
  $transaction: async (arg: unknown, _opts?: unknown) => {
    if (typeof arg === "function") {
      const tx = {
        $executeRawUnsafe: async (sql: string) => { rec("$", "executeRawUnsafe", sql); return 0; },
        user: { findUnique: async () => null },
        mediaServerUser: {
          findUnique: async () => null,
          upsert: async (a: { create: { source: string; sourceUserId: string } }) => ({
            id: `msu:${a.create.source}:${a.create.sourceUserId}`,
          }),
        },
      };
      return (arg as (t: typeof tx) => Promise<unknown>)(tx);
    }
    return Promise.all(arg as Promise<unknown>[]);
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── scripted fetch: /status/sessions, /Sessions, plex.tv owner, markers ─────
const PLEX_URL = "http://10.66.0.1:32400"; // RFC1918 literal: admin SSRF, no DNS
const JF_URL = "http://10.66.0.2:8096";
type FetchRecord = { url: string; method: string };
const fetchLog: FetchRecord[] = [];
let plexSnapshot: Array<Record<string, unknown>> = [];
let jfSnapshot: Array<Record<string, unknown>> = [];
let plexSessionsStatus = 200;
let jfSessionsStatus = 200;

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  fetchLog.push({ url: String(input), method: init?.method ?? "GET" });
  if (url.hostname === "plex.tv" && url.pathname === "/api/v2/user") {
    return okJson({ id: 9, email: "owner@plex.tv", username: "owner", thumb: "" });
  }
  if (url.pathname === "/status/sessions") {
    return okJson({ MediaContainer: { Metadata: plexSnapshot } }, plexSessionsStatus);
  }
  if (url.pathname.startsWith("/library/metadata/")) {
    return okJson({ MediaContainer: { Metadata: [{}] } }); // no markers → no marker updateMany
  }
  if (url.pathname === "/Sessions") {
    return okJson(jfSnapshot, jfSessionsStatus);
  }
  throw new Error(`unexpected fetch in test: ${String(input)}`);
}) as typeof fetch;

// ── dynamic imports (stubs above genuinely precede the module graph) ────────
const { NextRequest } = await import("next/server");
const { POST } = await import("../src/app/api/sync/play-history/route.ts");
const { PLEX_STALL_THRESHOLD_MS, isPlexSessionRecentlyFinalized, pruneRecentlyFinalized } =
  await import("../src/lib/plex-events.ts");
const { SESSION_ABSENCE_GRACE_MS } = await import("../src/lib/play-history.ts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");

type Req = InstanceType<typeof NextRequest>;
const COOKIE = getSessionCookieName();

// ── request + assertion helpers ─────────────────────────────────────────────
function phReq(opts: { headers?: Record<string, string> } = {}): Req {
  return new NextRequest("http://localhost:3000/api/sync/play-history", {
    method: "POST",
    headers: opts.headers,
  });
}
const AS_CRON = { authorization: `Bearer ${CRON_SECRET}` };

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// Let the route's fire-and-forget tails (reconcile, getPlexMarkers, setPlexReachable)
// settle before assertions — the route deliberately does not await them.
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function activeUpdatesFor(id: string): UpdateManyArgs[] {
  return dbCalls
    .filter((c) => c.model === "activeSession" && c.op === "updateMany" && (c.args as UpdateManyArgs).where?.id === id)
    .map((c) => c.args as UpdateManyArgs);
}
function activeCreatesFor(id: string): Array<Record<string, unknown>> {
  return dbCalls
    .filter((c) => c.model === "activeSession" && c.op === "createMany")
    .flatMap((c) => (c.args as CreateManyArgs).data)
    .filter((d) => d.id === id);
}
function historyRows(): Array<Record<string, unknown>> {
  return dbCalls
    .filter((c) => c.model === "playHistory" && c.op === "createMany")
    .flatMap((c) => (c.args as CreateManyArgs).data);
}
// The where-less lastSeenAt updateMany that reanchorActiveSessionsOnBoot issues.
function reanchorCalls(): DbCall[] {
  return dbCalls.filter(
    (c) => c.model === "activeSession" && c.op === "updateMany" && !(c.args as UpdateManyArgs).where,
  );
}

// ── ActiveSession row factory (every generated scalar; a Plex movie base) ────
function makeRow(sessionKey: string, over: Partial<ActiveRow> = {}): ActiveRow {
  return {
    id: `plex:${sessionKey}`,
    source: "plex",
    sessionKey,
    startedAt: agoReal(2_000_000),
    lastSeenAt: agoReal(30_000),
    state: "playing",
    mediaServerUserId: "msu-1",
    serverUsername: "alice",
    tmdbId: null, // null skips the tmdbCache poster read in recordCompletedSession
    mediaType: null,
    title: "Test Movie",
    year: "2020",
    seasonNumber: null,
    episodeNumber: null,
    episodeTitle: null,
    sourceItemId: null, // null skips the ratingKey-change branch + resume findFirst
    posterPath: null,
    progressPercent: 0,
    progressMs: 100_000n,
    progressUpdatedAt: agoReal(30_000),
    playtimeMs: 600_000n, // >> MIN_PLAY_DURATION_S (90s) so a finalize writes a row
    durationMs: 1_260_000n,
    platform: "Roku",
    player: "Plex for Roku",
    device: "Roku",
    ipAddress: "10.0.0.9",
    playMethod: "DirectPlay",
    videoCodec: "h264",
    audioCodec: "aac",
    resolution: "1080",
    bitrate: 8000,
    videoDecision: "directplay",
    audioDecision: "directplay",
    container: "mkv",
    transcodeReason: null,
    location: "lan",
    bandwidth: 9000,
    secure: true,
    relayed: false,
    introStartMs: null,
    introEndMs: null,
    creditsStartMs: null,
    creditsEndMs: null,
    ...over,
  };
}
function seed(row: ActiveRow): ActiveRow {
  activeStore.set(row.id, row);
  return row;
}

// A raw Plex /status/sessions Metadata entry that getPlexSessions parses into a
// PlexSessionData with the given sessionKey/state/viewOffset. Movie type with a
// tmdb Guid so no episode/library fallback lookups fire.
function plexSnap(
  sessionKey: string,
  opts: { state?: string; viewOffset: number; duration?: number; ratingKey?: string; platform?: string },
): Record<string, unknown> {
  return {
    sessionKey,
    User: { id: `acct-${sessionKey}`, title: "alice", thumb: "" },
    Player: { state: opts.state ?? "playing", platform: opts.platform ?? "Roku", title: "Plex for Roku" },
    type: "movie",
    ratingKey: opts.ratingKey ?? `rk-${sessionKey}`,
    title: "Test Movie",
    year: 2020,
    duration: opts.duration ?? 1_260_000,
    viewOffset: opts.viewOffset,
    Guid: [{ id: "tmdb://550" }],
  };
}

// A raw Jellyfin /Sessions entry parsed into a JellyfinSessionData.
function jfSnap(
  playSessionId: string,
  opts: { itemId?: string; positionTicks: number; durationTicks?: number },
): Record<string, unknown> {
  return {
    Id: playSessionId,
    PlaySessionId: playSessionId,
    UserId: `jf-acct-${playSessionId}`,
    UserName: "bob",
    Client: "Jellyfin Web",
    DeviceName: "Firefox",
    PlayState: { IsPaused: false, PositionTicks: opts.positionTicks, PlayMethod: "DirectPlay" },
    NowPlayingItem: {
      Id: opts.itemId ?? `jf-item-${playSessionId}`,
      Name: "JF Movie",
      Type: "Movie",
      ProductionYear: 2021,
      RunTimeTicks: opts.durationTicks ?? 72_000_000_000,
      ProviderIds: { Tmdb: "551" },
    },
  };
}

// ── config: play history + both sources enabled for the whole file ──────────
// Constant across tests (one loadSettings populates the 15s cache) except the
// disabled test, which flips playHistoryEnabled and busts the cache.
settings.set("playHistoryEnabled", "true");
settings.set("playHistoryPlexEnabled", "true");
settings.set("playHistoryJellyfinEnabled", "true");
syncSettings.set("plexServerUrl", PLEX_URL);
syncSettings.set("plexAdminToken", "plex-admin-token-1");
syncSettings.set("jellyfinUrl", JF_URL);
syncSettings.set("jellyfinApiKey", "jf-api-key-1");

function bustSettingsCache(): void {
  clockOffsetMs += 16_000; // SETTINGS_CACHE_TTL is 15s — expire the cached config
}

let userSeq = 0;
async function mintSession(role: string): Promise<{ userId: string; token: string }> {
  userSeq++;
  const userId = `ph-user-${userSeq}`;
  const sessionId = `ph-sess-${userSeq}`;
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

beforeEach(() => {
  dbCalls.length = 0;
  warns.length = 0;
  // NOTE: `errors` is deliberately never reset — the final test pins the route
  // stays console.error-silent across the whole file (guardrail 7).
  fetchLog.length = 0;
  settingUpserts.length = 0;
  activeStore.clear();
  plexSnapshot = [];
  jfSnapshot = [];
  plexSessionsStatus = 200;
  jfSessionsStatus = 200;
  playHistoryCreateError = null;
  // Clear the process-global recently-finalized ledger so a mark from a prior
  // test can't filter this test's session out of the poll (plex-events pattern).
  pruneRecentlyFinalized(Number.MAX_SAFE_INTEGER);
});

// ═══ Auth gating (guardrail 6 — the route funnels through isCronAuthorized) ══

test("unauthenticated POST → 403 before any fetch, DB write, reanchor, or cron-ledger record", async () => {
  const res = await POST(phReq());
  assert.equal(res.status, 403);
  assert.deepEqual(await bodyOf(res), { error: "Forbidden" });
  await settle();
  assert.equal(fetchLog.length, 0, "the auth gate must run before any upstream fetch");
  assert.equal(dbCalls.length, 0, "no DB call may run for an unauthorized caller");
  assert.equal(reanchorCalls().length, 0, "the boot re-anchor stays unspent — POST 403s before withCronRunRecording");
  assert.equal(settingUpserts.length, 0, "withCronRunRecording is not entered pre-auth (no cron ledger row)");
});

test("a wrong bearer secret → 403 with zero fetches (route wiring; compare internals owned by cron-auth tests)", async () => {
  const res = await POST(phReq({ headers: { authorization: "Bearer not-the-cron-secret-000000000000" } }));
  assert.equal(res.status, 403);
  await settle();
  assert.equal(fetchLog.length, 0);
  assert.equal(dbCalls.length, 0);
});

test("play history disabled → 200 message, no source fetch, and the boot re-anchor is NOT yet spent", async () => {
  settings.set("playHistoryEnabled", "false");
  bustSettingsCache();
  const res = await POST(phReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), { message: "Play history tracking is disabled" });
  await settle();
  // The disabled short-circuit returns BEFORE reanchorActiveSessionsOnBoot and
  // before any /status/sessions or /Sessions fetch.
  assert.equal(reanchorCalls().length, 0, "the disabled early-return must not reach the boot re-anchor");
  assert.ok(!fetchLog.some((f) => f.url.includes("/status/sessions") || f.url.includes("/Sessions")),
    "a disabled route must fetch neither media server");
  // Restore for every subsequent test (constant enabled config).
  settings.set("playHistoryEnabled", "true");
  bustSettingsCache();
});

// ═══ Guardrail 21 — reanchor-before-stale-sweep, on the FIRST full run ══════
// MUST be the first test that reaches a full sync: reanchorActiveSessionsOnBoot
// is once-guarded per process, so it fires exactly once and this is where.

test("GUARDRAIL 21: Bearer authorizes and the boot re-anchor runs (where-less updateMany) BEFORE the source:plex stale-sweep read", async () => {
  seed(makeRow("g21", { lastSeenAt: agoReal(120_000) }));
  plexSnapshot = [plexSnap("g21", { viewOffset: 100_000 })]; // playing, moved → plain update
  const res = await POST(phReq({ headers: AS_CRON }));
  assert.equal(res.status, 200, "Bearer CRON_SECRET must authorize the poller");
  await settle();

  const firstActiveIdx = dbCalls.findIndex((c) => c.model === "activeSession");
  assert.notEqual(firstActiveIdx, -1, "a full run must touch ActiveSession");
  const first = dbCalls[firstActiveIdx];
  assert.equal(
    first.op,
    "updateMany",
    "guardrail 21: the FIRST ActiveSession operation of the process must be the boot re-anchor updateMany — a stale-sweep read before it measures the absence grace off a pre-restart lastSeenAt and finalizes still-playing sessions",
  );
  assert.equal((first.args as UpdateManyArgs).where, undefined, "guardrail 21: the re-anchor covers EVERY row (no where clause)");
  assert.ok((first.args as UpdateManyArgs).data.lastSeenAt instanceof Date, "guardrail 21: the re-anchor stamps lastSeenAt to a fresh Date");

  const plexReadIdx = dbCalls.findIndex(
    (c) => c.model === "activeSession" && c.op === "findMany" && (c.args as FindManyArgs).where?.source === "plex",
  );
  assert.notEqual(plexReadIdx, -1, "syncPlexSessions must read the plex ActiveSession rows for its stale sweep");
  assert.ok(
    firstActiveIdx < plexReadIdx,
    "guardrail 21: reanchorActiveSessionsOnBoot() must complete BEFORE the source:plex stale-sweep read — reordering re-exposes the restart finalize-and-ledger-lock bug",
  );
  assert.equal(reanchorCalls().length, 1, "exactly one boot re-anchor on the first full run");
});

test("an ADMIN cookie session (DB-checked, same-origin) authorizes; a USER session is 403; the boot re-anchor does NOT run again", async () => {
  const admin = await mintSession("ADMIN");
  const res = await POST(phReq({ headers: { cookie: `${COOKIE}=${admin.token}`, origin: "http://localhost:3000" } }));
  assert.equal(res.status, 200, "an active admin session must authorize the poller");
  await settle();
  assert.equal(
    reanchorCalls().length,
    0,
    "guardrail 21: reanchorActiveSessionsOnBoot is once-guarded PER PROCESS — a later run must not re-run it (that would blind the absence grace to real downtime)",
  );

  const user = await mintSession("USER");
  const denied = await POST(phReq({ headers: { cookie: `${COOKIE}=${user.token}`, origin: "http://localhost:3000" } }));
  assert.equal(denied.status, 403, "a plain USER session cannot drive the poller");
});

// ═══ Guardrail 20 — the poller stall detector (playhead MOVEMENT, not advance) ═

test("GUARDRAIL 20: a FROZEN playhead past PLEX_STALL_THRESHOLD_MS stall-finalizes, a MOVING one in the SAME snapshot does NOT", async () => {
  assert.equal(PLEX_STALL_THRESHOLD_MS, 60_000, "the poller imports the 60s stall contract");
  const past = PLEX_STALL_THRESHOLD_MS + 1_000; // 61s: the anchor has aged past the threshold
  // Frozen ghost: viewOffset === stored progressMs, anchor 61s old, playing.
  const frozen = seed(makeRow("g20-frozen", {
    state: "playing", progressMs: 500_000n, progressUpdatedAt: agoReal(past), lastSeenAt: agoReal(past),
  }));
  // Live stream: viewOffset advanced, anchor equally 61s old, playing.
  seed(makeRow("g20-move", {
    state: "playing", progressMs: 500_000n, progressUpdatedAt: agoReal(past), lastSeenAt: agoReal(past),
  }));
  plexSnapshot = [
    plexSnap("g20-frozen", { viewOffset: 500_000 }), // identical → frozen
    plexSnap("g20-move", { viewOffset: 560_000 }), // advanced → moved
  ];

  const res = await POST(phReq({ headers: AS_CRON }));
  assert.equal(res.status, 200);
  await settle();

  // Only the frozen ghost writes a PlayHistory row (guardrail 19 dedup key too).
  const rows = historyRows();
  assert.equal(rows.length, 1, "guardrail 20: exactly ONE finalize — the frozen ghost, never the moving stream");
  assert.equal(
    rows[0].sourceSessionId,
    `g20-frozen:${frozen.startedAt.toISOString()}`,
    "guardrail 19: the finalize reaches recordCompletedSession with the sessionKey:startedAt dedup key",
  );
  assert.equal(isPlexSessionRecentlyFinalized("plex:g20-frozen"), true, "the stall-finalized ghost is ledgered against re-create");
  assert.equal(activeStore.has("plex:g20-frozen"), false, "the ghost's ActiveSession row is CAS-deleted by the finalize");

  // The moving stream is updated in place — NOT finalized, NOT ledgered — and
  // its stall anchor is refreshed because the playhead moved.
  assert.equal(isPlexSessionRecentlyFinalized("plex:g20-move"), false, "guardrail 20: a moving stream must NOT be ledger-locked");
  assert.ok(activeStore.has("plex:g20-move"), "the moving stream's row survives the poll");
  const moveUpd = activeUpdatesFor("plex:g20-move");
  assert.equal(moveUpd.length, 1, "the moving stream takes the update path");
  assert.equal(moveUpd[0].data.progressMs, 560_000n, "the moved playhead is written through");
  assert.ok(
    moveUpd[0].data.progressUpdatedAt instanceof Date,
    "guardrail 20: a moving stream refreshes the stall anchor (progressUpdatedAt) and is spared — the sharper `!==`-vs-`>` distinction is pinned by the backward-seek test below",
  );
});

test("GUARDRAIL 20: a BACKWARD seek is movement — the anchor refreshes and the session is NOT stall-finalized", async () => {
  const past = PLEX_STALL_THRESHOLD_MS + 5_000;
  seed(makeRow("g20-rewind", {
    state: "playing", progressMs: 800_000n, progressUpdatedAt: agoReal(past), lastSeenAt: agoReal(past),
  }));
  // 800000 → 300000 is a 500s rewind (well past the 10s jitter tolerance) so it
  // both counts as movement AND writes through.
  plexSnapshot = [plexSnap("g20-rewind", { viewOffset: 300_000 })];

  await POST(phReq({ headers: AS_CRON }));
  await settle();

  assert.equal(historyRows().length, 0, "guardrail 20: a rewinding stream is live, not a ghost — no finalize");
  assert.equal(isPlexSessionRecentlyFinalized("plex:g20-rewind"), false, "no ledger lock for a rewind");
  const upd = activeUpdatesFor("plex:g20-rewind");
  assert.equal(upd.length, 1);
  assert.equal(upd[0].data.progressMs, 300_000n, "a genuine seek-back is written through");
  assert.ok(
    upd[0].data.progressUpdatedAt instanceof Date,
    "guardrail 20: viewOffset(300000) !== progressMs(800000) is MOVEMENT — a strict `>` advance check would read !moved and stall-finalize this live stream at 60s",
  );
});

test("GUARDRAIL 20: a frozen playhead still WITHIN the 60s threshold updates in place (no stall, no anchor refresh)", async () => {
  seed(makeRow("g20-young", {
    state: "playing", progressMs: 400_000n, progressUpdatedAt: agoReal(30_000), lastSeenAt: agoReal(30_000),
  }));
  plexSnapshot = [plexSnap("g20-young", { viewOffset: 400_000 })]; // frozen, but only 30s old

  await POST(phReq({ headers: AS_CRON }));
  await settle();

  assert.equal(historyRows().length, 0, "a 30s-frozen playhead is under the 60s stall threshold — not a ghost yet");
  assert.ok(activeStore.has("plex:g20-young"), "the row survives");
  const upd = activeUpdatesFor("plex:g20-young");
  assert.equal(upd.length, 1);
  assert.ok(
    !("progressUpdatedAt" in upd[0].data),
    "guardrail 20: an unmoved playhead with no state transition must NOT refresh the anchor — else a genuine ghost never ages to 60s",
  );
});

test("GUARDRAIL 20: a resume (prior paused → now playing) with an unchanged offset skips the stall even with a stale anchor", async () => {
  const past = PLEX_STALL_THRESHOLD_MS + 10_000;
  // Paused for >60s, playhead parked; the first poll after resume sees playing
  // with the SAME viewOffset. The stall check must be suppressed (existing.state
  // was not "playing") and the anchor refreshed off the resume.
  seed(makeRow("g20-resume", {
    state: "paused", progressMs: 250_000n, progressUpdatedAt: agoReal(past), lastSeenAt: agoReal(past),
  }));
  plexSnapshot = [plexSnap("g20-resume", { state: "playing", viewOffset: 250_000 })];

  await POST(phReq({ headers: AS_CRON }));
  await settle();

  assert.equal(historyRows().length, 0, "guardrail 20: a resume after a long pause is not a stall — the pause parked the playhead legitimately");
  assert.equal(isPlexSessionRecentlyFinalized("plex:g20-resume"), false);
  const upd = activeUpdatesFor("plex:g20-resume");
  assert.equal(upd.length, 1);
  assert.equal(upd[0].data.state, "playing");
  assert.ok(
    upd[0].data.progressUpdatedAt instanceof Date,
    "guardrail 20: transitionedToPlaying refreshes the anchor so the next poll measures from the resume, not the pre-pause freeze",
  );
});

// ═══ SESSION_ABSENCE_GRACE_MS — the absence finalize sweep ══════════════════

test("SESSION_ABSENCE_GRACE_MS: a plex row absent past the 60s grace is finalized; one absent within grace is spared", async () => {
  assert.equal(SESSION_ABSENCE_GRACE_MS, 60_000);
  const stale = seed(makeRow("abs-stale", { lastSeenAt: agoReal(SESSION_ABSENCE_GRACE_MS + 5_000) }));
  seed(makeRow("abs-fresh", { lastSeenAt: agoReal(20_000) }));
  plexSnapshot = []; // BOTH absent from the snapshot

  const res = await POST(phReq({ headers: AS_CRON }));
  assert.deepEqual((await bodyOf(res)).plex, { started: 0, updated: 0, ended: 1 });
  await settle();

  const rows = historyRows();
  assert.equal(rows.length, 1, "only the row absent past the grace finalizes");
  assert.equal(
    rows[0].sourceSessionId,
    `abs-stale:${stale.startedAt.toISOString()}`,
    "guardrail 19: the absence finalize keys the PlayHistory row on sessionKey:startedAt",
  );
  assert.equal(isPlexSessionRecentlyFinalized("plex:abs-stale"), true, "the finalized absent row is ledgered");
  assert.equal(activeStore.has("plex:abs-stale"), false, "the finalized row is CAS-deleted");
  assert.equal(isPlexSessionRecentlyFinalized("plex:abs-fresh"), false, "a <60s-absent row must NOT be finalized (one dropped poll is survivable)");
  assert.ok(activeStore.has("plex:abs-fresh"), "the within-grace row is left in place for the next poll");
});

// ═══ Guardrail 27 — ledger mark AFTER the DB write, never before ═════════════

test("GUARDRAIL 27: a failed finalize write leaves the session UN-ledgered (no phantom lock) so a later poll can retry", async () => {
  const past = PLEX_STALL_THRESHOLD_MS + 2_000;
  seed(makeRow("gr27", {
    state: "playing", progressMs: 700_000n, progressUpdatedAt: agoReal(past), lastSeenAt: agoReal(past),
  }));
  plexSnapshot = [plexSnap("gr27", { viewOffset: 700_000 })]; // frozen → would stall-finalize
  playHistoryCreateError = new Error("db down"); // …but the PlayHistory write throws

  const res = await POST(phReq({ headers: AS_CRON }));
  assert.equal(res.status, 200, "a finalize failure must not fail the 5s poll (it warns and moves on)");
  await settle();

  assert.equal(historyRows().length, 0, "no PlayHistory row landed");
  assert.equal(
    isPlexSessionRecentlyFinalized("plex:gr27"),
    false,
    "guardrail 27: the recentlyFinalized mark goes AFTER the recordCompletedSession write — a failed write must not ledger-lock the sessionKey for an hour with no history row",
  );
  assert.ok(activeStore.has("plex:gr27"), "the ActiveSession row survives a failed finalize so the next poll retries");
  assert.ok(
    warns.some((w) => w.includes("[play-history] stall-finalize failed for plex:gr27")),
    "the finalize failure warns with the [play-history] scope",
  );
});

// ═══ New + continuing session wiring ════════════════════════════════════════

test("a brand-new session (no existing row, non-DLNA) is created via createMany({skipDuplicates}) with the mapped fields", async () => {
  plexSnapshot = [plexSnap("new-1", { viewOffset: 42_000, duration: 1_800_000, ratingKey: "rk-new-1" })];
  // activeStore is empty → the create branch.

  const res = await POST(phReq({ headers: AS_CRON }));
  assert.deepEqual((await bodyOf(res)).plex, { started: 1, updated: 0, ended: 0 });
  await settle();

  const created = activeCreatesFor("plex:new-1");
  assert.equal(created.length, 1, "the new session is inserted exactly once");
  const row = created[0];
  assert.equal(row.source, "plex");
  assert.equal(row.sessionKey, "new-1");
  assert.equal(row.state, "playing");
  assert.equal(row.tmdbId, 550, "the tmdb Guid resolves the movie id");
  assert.equal(row.mediaType, "MOVIE");
  assert.equal(row.progressMs, 42_000n, "the create stamps the snapshot viewOffset as progressMs");
  assert.equal(row.durationMs, 1_800_000n);
  assert.equal(row.sourceItemId, "rk-new-1");
  // skipDuplicates on the single-row createMany → INSERT ... ON CONFLICT DO NOTHING.
  const createCall = dbCalls.find(
    (c) => c.model === "activeSession" && c.op === "createMany" && (c.args as CreateManyArgs).data[0].id === "plex:new-1",
  );
  assert.equal((createCall!.args as CreateManyArgs).skipDuplicates, true, "overlapping poll ticks must not reject each other on a duplicate insert");
  assert.equal(historyRows().length, 0, "a fresh session writes no PlayHistory row");
});

test("a continuing playing session accrues a playtimeMs increment and takes the CAS updateMany on (id, lastSeenAt)", async () => {
  // Playing for the last ~40s (lastSeenAt 40s ago) → computePlaytimeIncrement
  // credits ~40s of wall clock; the write is a CAS on the prefetched lastSeenAt.
  const existing = seed(makeRow("cont-1", {
    state: "playing", progressMs: 300_000n, progressUpdatedAt: agoReal(40_000), lastSeenAt: agoReal(40_000),
  }));
  plexSnapshot = [plexSnap("cont-1", { viewOffset: 340_000 })]; // moved → update, not stall

  const res = await POST(phReq({ headers: AS_CRON }));
  assert.deepEqual((await bodyOf(res)).plex, { started: 0, updated: 1, ended: 0 });
  await settle();

  const upd = activeUpdatesFor("plex:cont-1");
  assert.equal(upd.length, 1);
  assert.equal(upd[0].where?.lastSeenAt, existing.lastSeenAt, "the update is a CAS against the lastSeenAt the prefetch read — a racing writer makes it a no-op, not a P2025");
  const inc = (upd[0].data.playtimeMs as { increment?: bigint } | undefined)?.increment;
  assert.ok(typeof inc === "bigint" && inc > 0n, "a playing interval accrues a positive playtimeMs increment");
  assert.ok(inc! >= 39_000n && inc! <= 41_000n, `~40s of playing wall-clock should be credited, got ${inc}`);
  assert.equal(historyRows().length, 0);
});

// ═══ Jellyfin source coverage (the poller drives both) ══════════════════════

test("the jellyfin path also finalizes a session absent past the grace, keyed on its own source", async () => {
  const stale = seed(makeRow("jf-abs", {
    id: "jellyfin:jf-abs", source: "jellyfin", sessionKey: "jf-abs",
    lastSeenAt: agoReal(SESSION_ABSENCE_GRACE_MS + 8_000),
  }));
  // Also seed a plex row present in the plex snapshot so the two source passes
  // don't interfere: the plex row is "seen" and untouched.
  seed(makeRow("jf-guard-plex", { progressMs: 111_000n, progressUpdatedAt: agoReal(10_000), lastSeenAt: agoReal(10_000) }));
  plexSnapshot = [plexSnap("jf-guard-plex", { viewOffset: 120_000 })];
  jfSnapshot = []; // the jellyfin session is absent

  const res = await POST(phReq({ headers: AS_CRON }));
  const body = await bodyOf(res);
  assert.deepEqual(body.jellyfin, { started: 0, updated: 0, ended: 1 }, "the absent jellyfin session finalizes");
  assert.deepEqual(body.plex, { started: 0, updated: 1, ended: 0 }, "the seen plex session just updates");
  await settle();

  assert.ok(
    historyRows().some((r) => r.source === "jellyfin" && r.sourceSessionId === `jf-abs:${stale.startedAt.toISOString()}`),
    "guardrail 19: the jellyfin finalize keys on its own sessionKey:startedAt",
  );
  assert.equal(activeStore.has("jellyfin:jf-abs"), false, "the finalized jellyfin row is deleted");
});

test("a brand-new jellyfin session is created from the /Sessions snapshot", async () => {
  jfSnapshot = [jfSnap("jf-new", { positionTicks: 300_000_000, durationTicks: 72_000_000_000 })]; // 30s of 7200s
  const res = await POST(phReq({ headers: AS_CRON }));
  assert.deepEqual((await bodyOf(res)).jellyfin, { started: 1, updated: 0, ended: 0 });
  await settle();
  const created = activeCreatesFor("jellyfin:jf-new");
  assert.equal(created.length, 1);
  assert.equal(created[0].source, "jellyfin");
  assert.equal(created[0].sessionKey, "jf-new");
  assert.equal(created[0].tmdbId, 551, "the ProviderIds.Tmdb resolves the movie id");
  assert.equal(created[0].progressMs, 30_000n, "positionTicks (100ns) convert to ms");
});

// ═══ Degraded run — a single-source outage stays 200 but flags the ledger ═══

test("a Plex outage sets results.plex.error, stamps X-Cron-Degraded, and stays 200 (the 5s poller must not spam non-2xx)", async () => {
  plexSessionsStatus = 500; // getPlexSessions throws on the non-2xx
  jfSnapshot = []; // jellyfin healthy but idle

  const res = await POST(phReq({ headers: AS_CRON }));
  assert.equal(res.status, 200, "a media-server outage keeps the poll 200 so the entrypoint doesn't reschedule at the 300s retry cadence");
  assert.equal(res.headers.get("X-Cron-Degraded"), "plex", "the degraded source is surfaced to withCronRunRecording (ledger ok:false)");
  const body = await bodyOf(res);
  assert.ok((body.plex as { error?: string }).error, "the failed source records its error");
  assert.ok(body.jellyfin, "the healthy source still reports its counts");
  await settle();
  assert.ok(
    warns.some((w) => w.includes("[play-history] Plex session sync failed:")),
    "the source failure warns with the [play-history] scope",
  );
  // setPlexReachable(false) persists the reachability flip.
  assert.ok(settingUpserts.some((u) => u.key === "plexServerReachable"), "a failed getPlexSessions marks the server unreachable");
});

// ═══ guardrail-7 silence ════════════════════════════════════════════════════
// `errors` is never reset in beforeEach: every path above must have completed
// without a single console.error (the route only console.errors from the 500
// catch, which no test triggers; warns are the sanctioned diagnostics).

test("the route never console.errors across every path exercised in this file (guardrail 7)", () => {
  assert.deepEqual(errors, []);
});
