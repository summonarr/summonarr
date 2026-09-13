// Route-level unit tests for the Sonarr/Radarr webhook handlers
// (src/app/api/webhooks/{radarr,sonarr}/route.ts) — the two routes share one
// code path (secret resolution → auth → body caps → replay digest → event
// dispatch), so the shared behavior is exercised on radarr and the sonarr file
// adds only its per-service specifics (tvdb/tmdb series mapping, the tvdb-keyed
// one-shot marker, its own Test message). What these tests pin:
//
//  - Guardrail 2 (webhook auth): the presented token is compared against every
//    per-instance secret via the SHA-256 + timingSafeEqual compare, and BOTH
//    transports authenticate — `Authorization: Bearer <secret>` AND the
//    `?token=<secret>` query fallback (load-bearing: the Radarr/Sonarr webhook
//    UIs have no header field). A Bearer-shaped header takes precedence and is
//    never rescued by a valid query token; a non-Bearer Authorization value
//    falls through to the query token. Absent/wrong/empty credentials → 401
//    with nothing recorded. The legacy shared `webhookSecret` remains the
//    DEFAULT instance's fallback secret — and only the default's.
//  - Guardrail 32 (secret-as-discriminator): with default + "4k" + a named
//    "anime" instance carrying distinct WebhookSecret settings, the matching
//    secret selects the firing arrInstance, observable through the where/data
//    shapes of every write: MediaRequest flips, wanted-cache eviction, the
//    manual-interaction one-shot key, IssueGrab claiming, and the Download
//    verify call all scope to the matched instance (a "4k" webhook never flips
//    a default-instance request). Equal-secret misconfig resolves to default.
//  - Event handling: Download flips APPROVED→AVAILABLE (one UPDATE covers both
//    availableAt branches, pendingNotifyAt cleared, PENDING/DECLINED untouched) under the
//    per-service advisory lock; the payload's id is verified against the arr's
//    own API first. Radarr is tri-state (false → flip refused, true/null →
//    proceed). Sonarr (guardrail 14a) flips ONLY on a confirmed-COMPLETE series
//    — every aired regular-season episode on disk, specials excluded — answers
//    an in-progress import with {skipped, reason:"incomplete"} while still
//    scheduling the library scan, refuses the forgery shapes (absent /
//    ids-disagree), and DEFERS an unverifiable verdict (no optimistic flip): the
//    after() task re-verifies once the scan settles and flips then.
//    Test short-circuits before the replay digest; Grab/unknown events are
//    acknowledged-but-skipped (and still replay-recorded); malformed and
//    non-object JSON → 400; oversized bodies → 413 (header fast-path before
//    auth, post-read cap after); per-IP rate limit → 429.
//  - Replay interplay (digest INTERNALS are owned by tests/
//    webhook-replay.test.mts — here only that the route calls record/clear at
//    the right times): a second identical delivery 409s, a handler failure
//    rolls the digest back so the source-side retry can land, and a success
//    never clears it.
//
// NOT covered here: arrSettingKey derivation (tests/arr-instances.test.mts owns
// it; this file consumes it to seed Setting keys), digest construction (see
// above), the deferred after() notification bodies (captured but not executed
// — scheduleLibraryScan opens a real 15s debounce timer chain, so running a
// Download task would stall the file; the ONE exception is the Sonarr
// deferred-verify test, which runs its task under node:test's mock timers and
// ticks the debounce by hand; the ManualInteraction after() tasks ARE executed,
// they short-circuit safely on empty subscriptions), and
// resolveSingleTvdbToTmdb's deferred wanted eviction (reachable only through a
// findFirst-miss/updateMany-hit DB race a consistent in-memory table cannot
// produce).
//
// Harness notes: Next's after() throws outside a request scope, so every POST
// runs inside workAsyncStorage.run() with a minimal store whose afterContext
// captures the scheduled tasks, nested in workUnitAsyncStorage.run() with a
// type:"request"/phase:"render" store — since Next 16.3 after() requires BOTH
// stores and hands the work-unit store to afterContext.after() so the real
// AfterContext can flip its phase to "after" when the tasks run (the recording
// stub here ignores it). No headers()/cookies() are sealed in: the webhook
// handlers read everything off the NextRequest they are passed and never call
// those (globalThis.AsyncLocalStorage must be installed BEFORE next/server
// loads — createAsyncLocalStorage falls back to a throwing fake otherwise).
// No DB or network: the prisma model delegates are shadowed
// in-memory (tests/_helpers.mts), fetch is scripted (default: refuse), and the
// configured arr URLs use loopback IP literals so safeFetchAdminConfigured
// (allowPrivate=true) never performs a DNS lookup. Math.random is pinned so the
// replay cache's 1-in-100 cleanup lottery stays silent.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
// Silence rate-limit's module-load warning AND make getClientIp trust
// X-Forwarded-For, so each test gets its own rate-limit bucket.
process.env.TRUST_PROXY = "true";

// Next's createAsyncLocalStorage() captures globalThis.AsyncLocalStorage at
// module load; without it after() is backed by a throwing FakeAsyncLocalStorage.
(globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage =
  AsyncLocalStorage;

// Scripted fetch: default refuses (the arr verify helpers catch, warn, and
// return null → the route proceeds optimistically). Tests that exercise the
// authoritative-verify path install a handler.
type FetchCall = { url: string; init: RequestInit | undefined };
const fetchCalls: FetchCall[] = [];
let fetchHandler: (url: string) => Response | Promise<Response> = () => {
  throw new Error("scripted network refusal");
};
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  fetchCalls.push({ url, init });
  return fetchHandler(url);
}) as typeof fetch;

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Pin the replay cache's 1-in-100 cleanup lottery shut (0.5 < 0.01 is false).
Math.random = () => 0.5;

// Dynamic imports so the env/global stubs above genuinely precede the module
// graph (static imports would hoist — the api-auth.test pattern).
const { NextRequest } = await import("next/server");
const { workAsyncStorage } = await import(
  "../node_modules/next/dist/server/app-render/work-async-storage.external.js"
);
const { workUnitAsyncStorage } = await import(
  "../node_modules/next/dist/server/app-render/work-unit-async-storage.external.js"
);
const { Prisma } = await import("@/generated/prisma");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { arrSettingKey } = await import("../src/lib/arr-instances.ts");
const { POST: radarrPOST } = await import("../src/app/api/webhooks/radarr/route.ts");
const { POST: sonarrPOST } = await import("../src/app/api/webhooks/sonarr/route.ts");

type Req = InstanceType<typeof NextRequest>;

// ── in-memory DB state ──────────────────────────────────────────────────────

function p2002(): InstanceType<typeof Prisma.PrismaClientKnownRequestError> {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "0.0.0-test",
    meta: { target: ["digest"] },
  });
}
function p2025(): InstanceType<typeof Prisma.PrismaClientKnownRequestError> {
  return new Prisma.PrismaClientKnownRequestError("Record to delete does not exist.", {
    code: "P2025",
    clientVersion: "0.0.0-test",
  });
}

// Minimal where-matcher for the operator shapes the routes actually use
// (equality, null, { not: null }, { in: [...] }). Unknown operators throw so a
// future route change can't silently mismatch against the stub.
function rowMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [field, cond] of Object.entries(where)) {
    const v = row[field];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c) {
        if (!(c.in as unknown[]).includes(v)) return false;
        continue;
      }
      if ("not" in c) {
        if (c.not === null ? v === null : v === c.not) return false;
        continue;
      }
      throw new Error(`unsupported where operator on ${field}: ${JSON.stringify(cond)}`);
    }
    if (v !== cond) return false;
  }
  return true;
}

// Settings table: Map<key, value>. Serves the instance registry, per-instance
// webhook secrets + connection config, the legacy webhookSecret, feature-flag
// reads, and the manual-interaction one-shot markers.
const settings = new Map<string, string>();
type SettingCreateManyArgs = { data: { key: string; value: string }[]; skipDuplicates?: boolean };
type SettingDeleteManyArgs = {
  where: { key?: { in?: string[]; startsWith?: string }; value?: { lt?: string } };
};
const settingCreateManyCalls: SettingCreateManyArgs[] = [];
const settingDeleteManyCalls: SettingDeleteManyArgs[] = [];

shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) =>
    settings.has(args.where.key) ? { key: args.where.key, value: settings.get(args.where.key)! } : null,
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const keys = args.where?.key?.in;
    const rows: { key: string; value: string }[] = [];
    if (keys) {
      for (const k of keys) if (settings.has(k)) rows.push({ key: k, value: settings.get(k)! });
    } else {
      for (const [key, value] of settings) rows.push({ key, value });
    }
    return rows;
  },
  createMany: async (args: SettingCreateManyArgs) => {
    settingCreateManyCalls.push(args);
    let count = 0;
    for (const row of args.data) {
      if (settings.has(row.key)) {
        if (!args.skipDuplicates) throw p2002();
        continue;
      }
      settings.set(row.key, row.value);
      count++;
    }
    return { count };
  },
  deleteMany: async (args: SettingDeleteManyArgs) => {
    settingDeleteManyCalls.push(args);
    let count = 0;
    for (const [key, value] of [...settings]) {
      const w = args.where;
      if (w.key?.in && !w.key.in.includes(key)) continue;
      if (w.key?.startsWith && !key.startsWith(w.key.startsWith)) continue;
      if (w.value?.lt !== undefined && !(value < w.value.lt)) continue;
      settings.delete(key);
      count++;
    }
    return { count };
  },
});

// Webhook replay table (digest internals owned by tests/webhook-replay.test.mts
// — this stub only mirrors the create-P2002/guarded-updateMany/delete contract
// so the ROUTE's record/409/rollback wiring is observable).
const replayRows = new Map<string, Date>();
const replayCreates: string[] = [];
const replayDeletes: string[] = [];

shadowPrismaModel(prisma, "webhookReplay", {
  create: async (args: { data: { digest: string; expiresAt: Date } }) => {
    replayCreates.push(args.data.digest);
    if (replayRows.has(args.data.digest)) throw p2002();
    replayRows.set(args.data.digest, args.data.expiresAt);
    return args.data;
  },
  updateMany: async (args: {
    where: { digest: string; expiresAt: { lte: Date } };
    data: { expiresAt: Date };
  }) => {
    const expiry = replayRows.get(args.where.digest);
    if (expiry !== undefined && expiry.getTime() <= args.where.expiresAt.lte.getTime()) {
      replayRows.set(args.where.digest, args.data.expiresAt);
      return { count: 1 };
    }
    return { count: 0 };
  },
  delete: async (args: { where: { digest: string } }) => {
    replayDeletes.push(args.where.digest);
    if (!replayRows.has(args.where.digest)) throw p2025();
    replayRows.delete(args.where.digest);
    return { digest: args.where.digest };
  },
  deleteMany: async () => ({ count: 0 }),
});

// MediaRequest table.
type RequestRow = {
  id: string;
  tmdbId: number;
  tvdbId: number | null;
  mediaType: "MOVIE" | "TV";
  arrInstance: string;
  status: string;
  availableAt: Date | null;
  pendingNotifyAt: Date | null;
  notifiedAvailable: boolean;
};
const requests: RequestRow[] = [];
type UpdateManyCall = { where: Record<string, unknown>; data: Record<string, unknown> };
const requestUpdateManyCalls: UpdateManyCall[] = [];

const mediaRequestStub = {
  updateMany: async (args: UpdateManyCall) => {
    requestUpdateManyCalls.push(args);
    let count = 0;
    for (const row of requests) {
      if (!rowMatches(row as unknown as Record<string, unknown>, args.where)) continue;
      Object.assign(row, args.data);
      count++;
    }
    return { count };
  },
  findFirst: async (args: { where: Record<string, unknown> }) => {
    const hit = requests.find((r) => rowMatches(r as unknown as Record<string, unknown>, args.where));
    return hit ? { ...hit } : null;
  },
  findMany: async () => [],
};
shadowPrismaModel(prisma, "mediaRequest", mediaRequestStub);

// Wanted caches: only deleteMany is exercised; capture the scoping.
const radarrWantedDeletes: Record<string, unknown>[] = [];
const sonarrWantedDeletes: Record<string, unknown>[] = [];
const radarrWantedStub = {
  deleteMany: async (args: { where: Record<string, unknown> }) => {
    radarrWantedDeletes.push(args.where);
    return { count: 0 };
  },
};
const sonarrWantedStub = {
  deleteMany: async (args: { where: Record<string, unknown> }) => {
    sonarrWantedDeletes.push(args.where);
    return { count: 0 };
  },
};
shadowPrismaModel(prisma, "radarrWantedItem", radarrWantedStub);
shadowPrismaModel(prisma, "sonarrWantedItem", sonarrWantedStub);

// IssueGrab table.
type GrabRow = {
  id: string;
  tmdbId: number | null;
  tvdbId: number | null;
  mediaType: "MOVIE" | "TV";
  arrInstance: string;
  notifiedAt: Date | null;
  triggeredById: string;
  title: string;
  scope: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  issueId: string;
};
const grabs: GrabRow[] = [];
const grabUpdateManyCalls: UpdateManyCall[] = [];
shadowPrismaModel(prisma, "issueGrab", {
  findMany: async (args: { where: Record<string, unknown> }) =>
    grabs.filter((g) => rowMatches(g as unknown as Record<string, unknown>, args.where)).map((g) => ({ ...g })),
  updateMany: async (args: UpdateManyCall) => {
    grabUpdateManyCalls.push(args);
    let count = 0;
    for (const g of grabs) {
      if (!rowMatches(g as unknown as Record<string, unknown>, args.where)) continue;
      Object.assign(g, args.data);
      count++;
    }
    return { count };
  },
  update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    const g = grabs.find((x) => x.id === args.where.id);
    if (!g) throw p2025();
    Object.assign(g, args.data);
    return { ...g };
  },
});

// Deletion votes (clearDeletionVotesForTmdbs is void-fired post-flip).
const deletionVoteDeletes: Record<string, unknown>[] = [];
shadowPrismaModel(prisma, "deletionVote", {
  deleteMany: async (args: { where: Record<string, unknown> }) => {
    deletionVoteDeletes.push(args.where);
    return { count: 0 };
  },
});

// No push subscriptions: with the push feature flag defaulting ON and no VAPID
// keys, the grab-completed outcome is "skipped-no-subs" (never a network send).
shadowPrismaModel(prisma, "pushSubscription", { findMany: async () => [] });

// $transaction: callback form (the route's advisory-lock txs) runs against the
// shared in-memory delegates; array form (clearDeletionVotesForTmdbs) settles
// the already-started promises. txError makes the next callback-form tx throw
// once — the rollback test's handle.
let txError: Error | null = null;
const executeRawCalls: string[] = [];
const txDelegates = {
  $executeRaw: async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    executeRawCalls.push(strings.join("?"));
    return 0;
  },
  mediaRequest: mediaRequestStub,
  radarrWantedItem: radarrWantedStub,
  sonarrWantedItem: sonarrWantedStub,
};
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => {
  if (typeof arg === "function") {
    if (txError) {
      const err = txError;
      txError = null;
      throw err;
    }
    return (arg as (tx: typeof txDelegates) => Promise<unknown>)(txDelegates);
  }
  return Promise.all(arg as Promise<unknown>[]);
});

// ── fixtures ────────────────────────────────────────────────────────────────

const RADARR_SECRET = "radarr-default-secret";
const RADARR_4K_SECRET = "radarr-fourk-secret";
const RADARR_ANIME_SECRET = "radarr-anime-secret";
const SONARR_SECRET = "sonarr-default-secret";
const SONARR_ANIME_SECRET = "sonarr-anime-secret";

// Radarr: default (secret only — connection unconfigured, so the Download
// verify is indeterminate → optimistic), a CONFIGURED legacy 4K instance
// (loopback IP literal: admin-mode SSRF allows it with no DNS), and a
// registry-defined named instance "anime" (secret only). Sonarr: default +
// "anime" via the registry, neither connection configured (named registry
// instances exist regardless of connection config; the legacy "4k" is
// synthesized only when radarr4kUrl+ApiKey are set).
function seedBaseSettings(): void {
  settings.clear();
  settings.set(arrSettingKey("radarr", "", "WebhookSecret"), RADARR_SECRET);
  settings.set(arrSettingKey("radarr", "4k", "Url"), "http://127.0.0.1:7878");
  settings.set(arrSettingKey("radarr", "4k", "ApiKey"), "radarr-4k-key");
  settings.set(arrSettingKey("radarr", "4k", "WebhookSecret"), RADARR_4K_SECRET);
  settings.set("arrRadarrInstances", JSON.stringify([{ slug: "anime", name: "Anime" }]));
  settings.set(arrSettingKey("radarr", "anime", "WebhookSecret"), RADARR_ANIME_SECRET);
  settings.set(arrSettingKey("sonarr", "", "WebhookSecret"), SONARR_SECRET);
  settings.set("arrSonarrInstances", JSON.stringify([{ slug: "anime", name: "Anime" }]));
  settings.set(arrSettingKey("sonarr", "anime", "WebhookSecret"), SONARR_ANIME_SECRET);
}

let rowSeq = 0;
function seedRequest(overrides: Partial<RequestRow> & { tmdbId: number; mediaType: "MOVIE" | "TV" }): RequestRow {
  const row: RequestRow = {
    id: `req-${++rowSeq}`,
    tvdbId: null,
    arrInstance: "",
    status: "APPROVED",
    availableAt: null,
    pendingNotifyAt: null,
    notifiedAvailable: false,
    ...overrides,
  };
  requests.push(row);
  return row;
}

function seedGrab(overrides: Partial<GrabRow> & { mediaType: "MOVIE" | "TV" }): GrabRow {
  const row: GrabRow = {
    id: `grab-${++rowSeq}`,
    tmdbId: null,
    tvdbId: null,
    arrInstance: "",
    notifiedAt: null,
    triggeredById: "user-1",
    title: "Some Title",
    scope: "ALL",
    seasonNumber: null,
    episodeNumber: null,
    issueId: "issue-1",
    ...overrides,
  };
  grabs.push(row);
  return row;
}

// Unique per-request X-Forwarded-For so tests never share a rate-limit bucket
// (the 429 test passes an explicit shared ip).
let ipSeq = 0;
function webhookReq(
  service: "radarr" | "sonarr",
  opts: {
    token?: string;
    bearer?: string;
    authorization?: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
    ip?: string;
  } = {},
): Req {
  const url = new URL(`http://localhost:3000/api/webhooks/${service}`);
  if (opts.token !== undefined) url.searchParams.set("token", opts.token);
  const headers: Record<string, string> = {
    "x-forwarded-for": opts.ip ?? `203.0.113.${(ipSeq++ % 200) + 1}`,
    ...opts.headers,
  };
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  const body = opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {});
  return new NextRequest(url.toString(), { method: "POST", headers, body });
}

type AfterTask = (() => unknown) | Promise<unknown>;

// Run a route POST inside a work store whose afterContext captures (does not
// execute) the after() tasks, nested in a request-typed work-unit store.
// after() outside BOTH scopes throws in Next 16 (the work-unit half since 16.3).
async function post(
  handler: (req: Req) => Promise<Response>,
  req: Req,
): Promise<{ res: Response; body: Record<string, unknown>; tasks: AfterTask[] }> {
  const tasks: AfterTask[] = [];
  const workStore = { afterContext: { after: (t: AfterTask) => { tasks.push(t); } } };
  const requestStore = { type: "request", phase: "render", usedDynamic: false };
  const res = await workAsyncStorage.run(workStore as never, () =>
    workUnitAsyncStorage.run(requestStore as never, () => handler(req)),
  );
  return { res, body: (await res.json()) as Record<string, unknown>, tasks };
}

async function runTasks(tasks: AfterTask[]): Promise<void> {
  for (const t of tasks) await (typeof t === "function" ? t() : t);
}

const drainMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  warns.length = 0;
  errors.length = 0;
  fetchCalls.length = 0;
  fetchHandler = () => {
    throw new Error("scripted network refusal");
  };
  requests.length = 0;
  grabs.length = 0;
  replayRows.clear();
  replayCreates.length = 0;
  replayDeletes.length = 0;
  settingCreateManyCalls.length = 0;
  settingDeleteManyCalls.length = 0;
  requestUpdateManyCalls.length = 0;
  grabUpdateManyCalls.length = 0;
  radarrWantedDeletes.length = 0;
  sonarrWantedDeletes.length = 0;
  deletionVoteDeletes.length = 0;
  executeRawCalls.length = 0;
  txError = null;
  seedBaseSettings();
});

// ── auth (guardrail 2) ──────────────────────────────────────────────────────

test("radarr: no webhook secret configured anywhere → 401 even with a token", async () => {
  settings.delete(arrSettingKey("radarr", "", "WebhookSecret"));
  settings.delete(arrSettingKey("radarr", "4k", "WebhookSecret"));
  settings.delete(arrSettingKey("radarr", "anime", "WebhookSecret"));
  const { res, body } = await post(radarrPOST, webhookReq("radarr", { token: "anything", body: { eventType: "Test" } }));
  assert.equal(res.status, 401);
  assert.deepEqual(body, { error: "Unauthorized" });
  assert.ok(warns.some((w) => w.includes("[webhook/radarr] secret not configured")));
});

test("radarr: Authorization: Bearer <secret> authenticates (Test event connects)", async () => {
  const { res, body } = await post(
    radarrPOST,
    webhookReq("radarr", { bearer: RADARR_SECRET, body: { eventType: "Test" } }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, message: "Radarr webhook connected" });
});

test("radarr: the ?token= query fallback authenticates — load-bearing, the arr webhook UIs have no header field", async () => {
  const { res, body } = await post(
    radarrPOST,
    webhookReq("radarr", { token: RADARR_SECRET, body: { eventType: "Test" } }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, message: "Radarr webhook connected" });
});

test("radarr: absent, wrong, and empty credentials all → 401; nothing is recorded or written", async () => {
  for (const opts of [
    {}, // no credentials at all
    { token: "not-the-secret" }, // wrong query token
    { bearer: "not-the-secret" }, // wrong bearer
    { token: "" }, // empty token can never match (empty secrets are skipped too)
  ]) {
    const { res, body } = await post(
      radarrPOST,
      webhookReq("radarr", { ...opts, body: { eventType: "Download", movie: { tmdbId: 603, title: "T" } } }),
    );
    assert.equal(res.status, 401, `expected 401 for ${JSON.stringify(opts)}`);
    assert.deepEqual(body, { error: "Unauthorized" });
  }
  assert.equal(replayCreates.length, 0, "an unauthorized delivery must never touch the replay cache");
  assert.equal(requestUpdateManyCalls.length, 0);
  assert.ok(warns.some((w) => w.includes("[webhook/radarr] 401 unauthorized")));
});

test("radarr: a non-Bearer Authorization falls through to ?token=, but a wrong Bearer is never rescued by it", async () => {
  // "Basic ..." is not Bearer-shaped → the query token authenticates.
  const basic = await post(
    radarrPOST,
    webhookReq("radarr", {
      authorization: "Basic dXNlcjpwYXNz",
      token: RADARR_SECRET,
      body: { eventType: "Test" },
    }),
  );
  assert.equal(basic.res.status, 200);

  // A Bearer-shaped header takes precedence: its wrong value 401s even though
  // the query string carries the right secret.
  const wrongBearer = await post(
    radarrPOST,
    webhookReq("radarr", { bearer: "wrong", token: RADARR_SECRET, body: { eventType: "Test" } }),
  );
  assert.equal(wrongBearer.res.status, 401);
});

test("radarr: legacy shared webhookSecret authenticates the DEFAULT instance only", async () => {
  settings.delete(arrSettingKey("radarr", "", "WebhookSecret"));
  settings.set("webhookSecret", "legacy-shared-secret");
  const defaultRow = seedRequest({ tmdbId: 603, mediaType: "MOVIE", arrInstance: "" });
  const animeRow = seedRequest({ tmdbId: 603, mediaType: "MOVIE", arrInstance: "anime" });

  const { res, body } = await post(
    radarrPOST,
    webhookReq("radarr", {
      token: "legacy-shared-secret",
      body: { eventType: "Download", movie: { tmdbId: 603, title: "The Matrix" } },
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, marked: 1 });
  assert.equal(defaultRow.status, "AVAILABLE", "legacy secret must resolve to the default instance");
  assert.equal(animeRow.status, "APPROVED", "a named instance must NOT inherit the legacy fallback");
});

test("radarr: equal-secret collision (misconfig) resolves to the default instance", async () => {
  settings.set(arrSettingKey("radarr", "anime", "WebhookSecret"), RADARR_SECRET);
  const defaultRow = seedRequest({ tmdbId: 603, mediaType: "MOVIE", arrInstance: "" });
  const animeRow = seedRequest({ tmdbId: 603, mediaType: "MOVIE", arrInstance: "anime" });

  const { body } = await post(
    radarrPOST,
    webhookReq("radarr", {
      token: RADARR_SECRET,
      body: { eventType: "Download", movie: { tmdbId: 603, title: "The Matrix" } },
    }),
  );
  assert.deepEqual(body, { ok: true, marked: 1 });
  assert.equal(defaultRow.status, "AVAILABLE");
  assert.equal(animeRow.status, "APPROVED");
});

// ── instance resolution by secret-as-discriminator (guardrail 32) ───────────

test("radarr 4k Download: flips ONLY the 4k request, verified against the 4k instance's own Radarr", async () => {
  const defaultRow = seedRequest({ tmdbId: 603, mediaType: "MOVIE", arrInstance: "" });
  const fourKRow = seedRequest({ tmdbId: 603, mediaType: "MOVIE", arrInstance: "4k" });
  const animeRow = seedRequest({ tmdbId: 603, mediaType: "MOVIE", arrInstance: "anime" });
  // The 4k connection IS configured, so the route verifies against it.
  fetchHandler = () =>
    new Response(JSON.stringify([{ tmdbId: 603, hasFile: true }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const { res, body } = await post(
    radarrPOST,
    webhookReq("radarr", {
      token: RADARR_4K_SECRET,
      body: { eventType: "Download", movie: { tmdbId: 603, title: "The Matrix" } },
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, marked: 1 });

  // The firing secret selected arrInstance "4k": siblings untouched.
  assert.equal(fourKRow.status, "AVAILABLE");
  assert.ok(fourKRow.availableAt instanceof Date);
  assert.equal(fourKRow.pendingNotifyAt, null);
  assert.equal(defaultRow.status, "APPROVED", "a 4k webhook must never flip a default-instance request");
  assert.equal(animeRow.status, "APPROVED");

  // Wanted-cache eviction is scoped to the firing instance.
  assert.deepEqual(radarrWantedDeletes, [{ tmdbId: 603, arrInstance: "4k" }]);

  // The authoritative verify hit the 4K instance's URL with its own API key.
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.startsWith("http://127.0.0.1:7878/api/v3/movie?tmdbId=603"));
  assert.equal(new Headers(fetchCalls[0].init?.headers).get("x-api-key"), "radarr-4k-key");
});

test("radarr anime Download (connection unconfigured): optimistic flip, still scoped to anime, no network", async () => {
  const defaultRow = seedRequest({ tmdbId: 550, mediaType: "MOVIE", arrInstance: "" });
  const animeRow = seedRequest({ tmdbId: 550, mediaType: "MOVIE", arrInstance: "anime" });

  const { body } = await post(
    radarrPOST,
    webhookReq("radarr", {
      token: RADARR_ANIME_SECRET,
      body: { eventType: "Download", movie: { tmdbId: 550, title: "Redline" } },
    }),
  );
  assert.deepEqual(body, { ok: true, marked: 1 });
  assert.equal(animeRow.status, "AVAILABLE");
  assert.equal(defaultRow.status, "APPROVED");
  assert.deepEqual(radarrWantedDeletes, [{ tmdbId: 550, arrInstance: "anime" }]);
  assert.equal(fetchCalls.length, 0, "an unconfigured instance is indeterminate — no live check possible");
});

test("radarr: the same body delivered to two instances is NOT a replay — the digest is keyed on the matched secret", async () => {
  seedRequest({ tmdbId: 550, mediaType: "MOVIE", arrInstance: "" });
  seedRequest({ tmdbId: 550, mediaType: "MOVIE", arrInstance: "anime" });
  const payload = { eventType: "Download", movie: { tmdbId: 550, title: "Redline" } };

  const first = await post(radarrPOST, webhookReq("radarr", { token: RADARR_SECRET, body: payload }));
  assert.equal(first.res.status, 200);
  const second = await post(radarrPOST, webhookReq("radarr", { token: RADARR_ANIME_SECRET, body: payload }));
  assert.equal(second.res.status, 200, "a sibling instance's identical delivery must process, not 409");
});

// ── Download event handling ─────────────────────────────────────────────────

test("radarr Download: one UPDATE flips APPROVED→AVAILABLE on both availableAt branches; PENDING/DECLINED untouched; deferred work scheduled", async () => {
  const fresh = seedRequest({ tmdbId: 603, mediaType: "MOVIE" }); // availableAt null
  const rePush = seedRequest({ tmdbId: 603, mediaType: "MOVIE", availableAt: new Date(1), pendingNotifyAt: new Date(2) });
  const pending = seedRequest({ tmdbId: 603, mediaType: "MOVIE", status: "PENDING" });
  const declined = seedRequest({ tmdbId: 603, mediaType: "MOVIE", status: "DECLINED" });

  const { res, body, tasks } = await post(
    radarrPOST,
    webhookReq("radarr", {
      token: RADARR_SECRET,
      body: { eventType: "Download", movie: { tmdbId: 603, title: "The Matrix" } },
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, marked: 2 });

  for (const row of [fresh, rePush]) {
    assert.equal(row.status, "AVAILABLE");
    assert.ok(row.availableAt instanceof Date && row.availableAt.getTime() > 1000);
    assert.equal(row.pendingNotifyAt, null, "the approve-time 90s backstop must be cleared");
  }
  assert.equal(pending.status, "PENDING", "only APPROVED requests flip on a Download");
  assert.equal(declined.status, "DECLINED");

  // Instance-scoped where-shapes, under the Radarr advisory lock (1001, 1).
  assert.ok(executeRawCalls.some((sql) => sql.includes("pg_advisory_xact_lock(1001, 1)")));
  // One UPDATE flips every APPROVED row regardless of availableAt — the fresh
  // and re-push rows above both flipping (marked: 2) is the behavioural pin.
  const wheres = requestUpdateManyCalls.map((c) => c.where);
  assert.equal(wheres.length, 1, "a Download issues exactly one MediaRequest UPDATE");
  assert.deepEqual(wheres[0], {
    tmdbId: 603, mediaType: "MOVIE", arrInstance: "", status: "APPROVED",
  });
  assert.ok(!("availableAt" in wheres[0]), "one UPDATE covers both availableAt branches");
  assert.deepEqual(radarrWantedDeletes, [{ tmdbId: 603, arrInstance: "" }]);

  // notifiedAvailable is never touched here — the orchestrator CAS (guardrail
  // 14) is the sole authority.
  for (const call of requestUpdateManyCalls) {
    assert.ok(!("notifiedAvailable" in call.data), "the webhook must not write notifiedAvailable");
  }

  // Deferred library-scan/notify work was scheduled via after(); a success
  // never rolls back its replay digest.
  assert.equal(tasks.length, 1);
  assert.equal(replayDeletes.length, 0);

  // The void-fired deletion-vote wipe targeted this title.
  await drainMicrotasks();
  assert.deepEqual(deletionVoteDeletes, [{ tmdbId: { in: [603] }, mediaType: "MOVIE" }]);
});

test("radarr forgery rejection: Radarr reports the movie has NO file → status flip refused", async () => {
  settings.set(arrSettingKey("radarr", "", "Url"), "http://127.0.0.1:7880");
  settings.set(arrSettingKey("radarr", "", "ApiKey"), "radarr-default-key");
  const row = seedRequest({ tmdbId: 603, mediaType: "MOVIE" });
  fetchHandler = () =>
    new Response(JSON.stringify([{ tmdbId: 603, hasFile: false }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const { res, body } = await post(
    radarrPOST,
    webhookReq("radarr", {
      token: RADARR_SECRET,
      body: { eventType: "Download", movie: { tmdbId: 603, title: "Forged" } },
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, skipped: true, reason: "not_downloaded" });
  assert.equal(row.status, "APPROVED", "a Download event Radarr disowns must not flip the request");
  assert.equal(requestUpdateManyCalls.length, 0);
  assert.ok(warns.some((w) => w.includes("not confirmed downloaded in Radarr")));
});

test("radarr verification indeterminate (Radarr unreachable) → proceeds optimistically", async () => {
  settings.set(arrSettingKey("radarr", "", "Url"), "http://127.0.0.1:7880");
  settings.set(arrSettingKey("radarr", "", "ApiKey"), "radarr-default-key");
  const row = seedRequest({ tmdbId: 603, mediaType: "MOVIE" });
  // fetchHandler default: throws → isMovieDownloadedInRadarr warns and returns null.

  const { body } = await post(
    radarrPOST,
    webhookReq("radarr", {
      token: RADARR_SECRET,
      body: { eventType: "Download", movie: { tmdbId: 603, title: "The Matrix" } },
    }),
  );
  assert.deepEqual(body, { ok: true, marked: 1 });
  assert.equal(row.status, "AVAILABLE", "null (unverifiable) proceeds; the periodic sync reconciles");
  assert.ok(warns.some((w) => w.includes("[arr] isMovieDownloadedInRadarr failed:")));
});

test("radarr Download payload validation: non-positive tmdbId → 400; missing movie → acknowledged skip", async () => {
  const bad = await post(
    radarrPOST,
    webhookReq("radarr", { token: RADARR_SECRET, body: { eventType: "Download", movie: { tmdbId: -5, title: "X" } } }),
  );
  assert.equal(bad.res.status, 400);
  assert.deepEqual(bad.body, { error: "Invalid tmdbId" });

  const noMovie = await post(
    radarrPOST,
    webhookReq("radarr", { token: RADARR_SECRET, body: { eventType: "Download" } }),
  );
  assert.equal(noMovie.res.status, 200);
  assert.deepEqual(noMovie.body, { ok: true, skipped: true });
  assert.equal(requestUpdateManyCalls.length, 0);
});

test("radarr Grab/unknown eventType: acknowledged {skipped:true}, no writes — but still replay-recorded", async () => {
  seedRequest({ tmdbId: 603, mediaType: "MOVIE" });
  const payload = { eventType: "Grab", movie: { tmdbId: 603, title: "The Matrix" } };

  const first = await post(radarrPOST, webhookReq("radarr", { token: RADARR_SECRET, body: payload }));
  assert.equal(first.res.status, 200);
  assert.deepEqual(first.body, { ok: true, skipped: true });
  assert.equal(requests[0].status, "APPROVED");
  assert.equal(first.tasks.length, 0, "skipped events schedule no deferred work");
  assert.equal(replayCreates.length, 1, "non-Test events are replay-recorded even when skipped");

  const replay = await post(radarrPOST, webhookReq("radarr", { token: RADARR_SECRET, body: payload }));
  assert.equal(replay.res.status, 409);
  assert.deepEqual(replay.body, { error: "Replayed webhook" });
});

// ── Test events and the replay cache interplay ──────────────────────────────

test("radarr Test event short-circuits BEFORE the replay digest — repeated Test clicks all connect", async () => {
  for (let i = 0; i < 2; i++) {
    const { res, body } = await post(
      radarrPOST,
      webhookReq("radarr", { token: RADARR_SECRET, body: { eventType: "Test" } }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(body, { ok: true, message: "Radarr webhook connected" });
  }
  assert.equal(replayCreates.length, 0, "Test events must never be digest-recorded (second click would 409)");
});

test("radarr replay: an identical Download delivered twice → 409 with no double processing", async () => {
  seedRequest({ tmdbId: 603, mediaType: "MOVIE" });
  const payload = { eventType: "Download", movie: { tmdbId: 603, title: "The Matrix" } };

  const first = await post(radarrPOST, webhookReq("radarr", { token: RADARR_SECRET, body: payload }));
  assert.deepEqual(first.body, { ok: true, marked: 1 });
  const updateCallsAfterFirst = requestUpdateManyCalls.length;

  const second = await post(radarrPOST, webhookReq("radarr", { token: RADARR_SECRET, body: payload }));
  assert.equal(second.res.status, 409);
  assert.deepEqual(second.body, { error: "Replayed webhook" });
  assert.equal(requestUpdateManyCalls.length, updateCallsAfterFirst, "a replay must not re-run the flip");
  assert.equal(second.tasks.length, 0, "a replay must not schedule deferred work");
  assert.equal(replayDeletes.length, 0, "a 409 is not a failure — the digest must survive");
});

test("radarr rollback: a handler failure clears the replay digest so the source-side retry can land", async () => {
  seedRequest({ tmdbId: 603, mediaType: "MOVIE" });
  const payload = { eventType: "Download", movie: { tmdbId: 603, title: "The Matrix" } };

  txError = new Error("db down");
  await assert.rejects(
    post(radarrPOST, webhookReq("radarr", { token: RADARR_SECRET, body: payload })),
    /db down/,
  );
  assert.equal(replayCreates.length, 1);
  assert.equal(replayDeletes.length, 1, "the finally block must roll the digest back on failure");
  assert.equal(replayDeletes[0], replayCreates[0], "clear must target the digest record just wrote");

  // Sonarr/Radarr retry the failed delivery with the same body — it must be
  // treated as a first delivery again.
  const retry = await post(radarrPOST, webhookReq("radarr", { token: RADARR_SECRET, body: payload }));
  assert.equal(retry.res.status, 200);
  assert.deepEqual(retry.body, { ok: true, marked: 1 });
});

// ── ManualInteractionRequired and IssueGrab completion ──────────────────────

test("radarr ManualInteractionRequired: admins alerted once per stuck item, keyed on the firing instance", async () => {
  const first = await post(
    radarrPOST,
    webhookReq("radarr", {
      token: RADARR_4K_SECRET,
      body: { eventType: "ManualInteractionRequired", movie: { tmdbId: 603, title: "The Matrix" }, downloadClient: "sab" },
    }),
  );
  assert.equal(first.res.status, 200);
  assert.deepEqual(first.body, { ok: true, manualInteraction: true });
  assert.equal(first.tasks.length, 1, "a fresh claim schedules the admin push");

  // The one-shot marker is keyed on service + FIRING INSTANCE + stable tmdbId.
  assert.equal(settingCreateManyCalls.length, 1);
  assert.deepEqual(
    settingCreateManyCalls[0].data.map((d) => d.key),
    ["manualInteractionNotified:radarr:4k:603"],
  );
  assert.equal(settingCreateManyCalls[0].skipDuplicates, true);

  // Radarr re-emits the event per queue tick with volatile fields — a new
  // digest, but the same stable key: claimed already ⇒ no second push.
  const dup = await post(
    radarrPOST,
    webhookReq("radarr", {
      token: RADARR_4K_SECRET,
      body: { eventType: "ManualInteractionRequired", movie: { tmdbId: 603, title: "The Matrix" }, downloadClient: "nzbget" },
    }),
  );
  assert.equal(dup.res.status, 200);
  assert.deepEqual(dup.body, { ok: true, manualInteraction: true });
  assert.equal(dup.tasks.length, 0, "a duplicate claim must not schedule another push");

  // No stable id (movie absent) ⇒ no gate: best-effort push fires every time.
  const noId = await post(
    radarrPOST,
    webhookReq("radarr", {
      token: RADARR_4K_SECRET,
      body: { eventType: "ManualInteractionRequired", downloadClient: "sab" },
    }),
  );
  assert.equal(noId.tasks.length, 1);
  assert.equal(settingCreateManyCalls.length, 2, "no stable id ⇒ no one-shot claim row");
});

test("radarr issue-grab completion: CAS-claimed, scoped to the firing instance; a skipped push stays claimed", async () => {
  const defaultGrab = seedGrab({ tmdbId: 603, mediaType: "MOVIE", arrInstance: "" });
  const fourKGrab = seedGrab({ tmdbId: 603, mediaType: "MOVIE", arrInstance: "4k" });

  const { res } = await post(
    radarrPOST,
    webhookReq("radarr", {
      token: RADARR_SECRET,
      body: { eventType: "Download", movie: { tmdbId: 603, title: "The Matrix" } },
    }),
  );
  assert.equal(res.status, 200);

  assert.ok(defaultGrab.notifiedAt instanceof Date, "the default-instance grab must be claimed");
  assert.equal(fourKGrab.notifiedAt, null, "a default Download must never claim a 4k grab");

  // The claim is a CAS: WHERE id + notifiedAt null.
  assert.equal(grabUpdateManyCalls.length, 1);
  assert.deepEqual(grabUpdateManyCalls[0].where, { id: defaultGrab.id, notifiedAt: null });

  // Push has no subscriptions in this harness → "skipped-no-subs": logged, and
  // notifiedAt stays SET (retrying wouldn't help; only "failed" resets it).
  assert.ok(warns.some((w) => w.includes("grab push skipped (skipped-no-subs)")));
  assert.ok(defaultGrab.notifiedAt instanceof Date);
});

// ── body caps, malformed JSON, rate limiting ────────────────────────────────

test("radarr: a declared Content-Length over 1 MB → 413 before auth even runs", async () => {
  const { res, body } = await post(
    radarrPOST,
    webhookReq("radarr", { body: { eventType: "Test" }, headers: { "content-length": "2000000" } }),
  );
  assert.equal(res.status, 413, "the size check must fire before the 401 an unauthenticated call would get");
  assert.deepEqual(body, { error: "Request body too large (max 1MB)" });
});

test("radarr: an oversized actual body without Content-Length → 413 after the read", async () => {
  // NextRequest does not synthesize a Content-Length for string bodies, so the
  // header fast-path passes and the post-read byte check must catch it.
  const { res, body } = await post(
    radarrPOST,
    webhookReq("radarr", { token: RADARR_SECRET, rawBody: "x".repeat(1_048_577) }),
  );
  assert.equal(res.status, 413);
  assert.deepEqual(body, { error: "Payload too large" });
  assert.ok(warns.some((w) => w.includes("413 payload too large bytes=1048577")));
});

test("radarr: malformed and non-object JSON bodies → 400 Invalid JSON (auth runs first)", async () => {
  for (const rawBody of ["{nope", "null", "[1,2]", "42"]) {
    const { res, body } = await post(
      radarrPOST,
      webhookReq("radarr", { token: RADARR_SECRET, rawBody }),
    );
    assert.equal(res.status, 400, `expected 400 for body ${JSON.stringify(rawBody)}`);
    assert.deepEqual(body, { error: "Invalid JSON" });
  }
  assert.equal(replayCreates.length, 0, "an unparseable body must never be digest-recorded");
});

test("radarr: per-IP rate limit — the 601st request inside the window → 429", async () => {
  // 600/min: sized for per-episode Download bursts (a season-pack import fires
  // one event per episode); the bucket still bounds the pre-auth cost per IP.
  const ip = "198.51.100.77";
  for (let i = 0; i < 600; i++) {
    const { res } = await post(radarrPOST, webhookReq("radarr", { ip, body: { eventType: "Test" } }));
    assert.equal(res.status, 401, "unauthenticated calls still consume the bucket");
  }
  const { res, body } = await post(radarrPOST, webhookReq("radarr", { ip, body: { eventType: "Test" } }));
  assert.equal(res.status, 429);
  assert.deepEqual(body, { error: "Too Many Requests" });
});

// ── sonarr specifics ────────────────────────────────────────────────────────

test("sonarr: both transports work on the sibling route; Test event returns the Sonarr message", async () => {
  const viaQuery = await post(
    sonarrPOST,
    webhookReq("sonarr", { token: SONARR_SECRET, body: { eventType: "Test" } }),
  );
  assert.equal(viaQuery.res.status, 200);
  assert.deepEqual(viaQuery.body, { ok: true, message: "Sonarr webhook connected" });

  const viaBearer = await post(
    sonarrPOST,
    webhookReq("sonarr", { bearer: SONARR_SECRET, body: { eventType: "Test" } }),
  );
  assert.equal(viaBearer.res.status, 200);

  const wrong = await post(
    sonarrPOST,
    webhookReq("sonarr", { token: RADARR_SECRET, body: { eventType: "Test" } }),
  );
  assert.equal(wrong.res.status, 401, "a radarr secret must not authenticate the sonarr route");
});

// ── Sonarr fixtures (guardrail 14a) ─────────────────────────────────────────
//
// A Sonarr Download event flips a request only on a CONFIRMED-COMPLETE series,
// so these tests configure the firing instance and script its /api/v3 answers.
// `series` rows are what /api/v3/series?tvdbId= returns; `lookup` is what
// /api/v3/series/lookup?term=tmdb:<id> returns (default: one row carrying the
// requested ids, i.e. Sonarr agrees with the payload); `queue` feeds the
// library-scan gate's /api/v3/queue read.
const SONARR_DEFAULT_URL = "http://127.0.0.1:8989";
const SONARR_ANIME_URL = "http://127.0.0.1:8990";
function configureSonarr(slug: "" | "anime"): void {
  settings.set(arrSettingKey("sonarr", slug, "Url"), slug === "" ? SONARR_DEFAULT_URL : SONARR_ANIME_URL);
  settings.set(arrSettingKey("sonarr", slug, "ApiKey"), slug === "" ? "sonarr-default-key" : "sonarr-anime-key");
}
const season = (seasonNumber: number, episodeFileCount: number, episodeCount: number) =>
  ({ seasonNumber, monitored: seasonNumber > 0, statistics: { episodeFileCount, episodeCount } });
type SonarrScript = {
  series: (url: URL) => unknown;
  lookup?: (url: URL) => unknown;
  queue?: unknown;
};
function scriptSonarr(script: SonarrScript): void {
  fetchHandler = (raw) => {
    const url = new URL(raw);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v3/series/lookup") {
      if (script.lookup) return json(script.lookup(url));
      const term = url.searchParams.get("term") ?? "";
      const tmdbId = Number(term.replace(/^tmdb:/, ""));
      return json([{ tmdbId, tvdbId: LOOKUP_TVDB_FOR[tmdbId] ?? 0 }]);
    }
    if (url.pathname === "/api/v3/series") return json(script.series(url));
    if (url.pathname === "/api/v3/queue") return json(script.queue ?? { records: [], totalRecords: 0 });
    throw new Error(`unexpected Sonarr fetch ${raw}`);
  };
}
// The tmdb→tvdb pairs the default lookup script answers with.
const LOOKUP_TVDB_FOR: Record<number, number> = { 888: 777, 999: 5555, 84503: 332335 };
// A complete series for a given tvdbId (two full regular seasons + specials nobody has).
const completeSeries = (tvdbId: number, tmdbId?: number) => [
  { tvdbId, tmdbId, status: "continuing", seasons: [season(0, 0, 4), season(1, 10, 10), season(2, 10, 10)] },
];

test("sonarr Download by tmdbId: instance-scoped flip + wanted eviction + tvdbId backfill, verified against the FIRING instance's Sonarr", async () => {
  const animeRow = seedRequest({ tmdbId: 888, mediaType: "TV", arrInstance: "anime", tvdbId: null });
  const defaultRow = seedRequest({ tmdbId: 888, mediaType: "TV", arrInstance: "", tvdbId: null });
  configureSonarr("anime");
  scriptSonarr({ series: () => completeSeries(777, 888) });

  const { res, body } = await post(
    sonarrPOST,
    webhookReq("sonarr", {
      bearer: SONARR_ANIME_SECRET,
      body: { eventType: "Download", series: { tvdbId: 777, tmdbId: 888, title: "Frieren" } },
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, marked: 1 });

  assert.equal(animeRow.status, "AVAILABLE");
  assert.ok(animeRow.availableAt instanceof Date);
  assert.equal(animeRow.pendingNotifyAt, null);
  assert.equal(defaultRow.status, "APPROVED", "an anime webhook must never flip a default-instance request");

  // Wanted eviction scoped to the firing instance, under the Sonarr lock (1001, 2).
  assert.deepEqual(sonarrWantedDeletes, [{ tmdbId: 888, arrInstance: "anime" }]);
  assert.ok(executeRawCalls.some((sql) => sql.includes("pg_advisory_xact_lock(1001, 2)")));

  // tvdbId is per-TITLE metadata (identical for the same series on every
  // instance), so the backfill deliberately covers all rows missing it — a
  // later tvdbId-only Download for either instance can then find its request.
  assert.equal(animeRow.tvdbId, 777);
  assert.equal(defaultRow.tvdbId, 777);

  // The verify (tmdb lookup + the tvdbId-filtered library read) hit the ANIME
  // instance's URL with its own key — never the default's.
  assert.equal(fetchCalls.length, 2);
  for (const c of fetchCalls) {
    assert.ok(c.url.startsWith(`${SONARR_ANIME_URL}/api/v3/series`), c.url);
    assert.equal(new Headers(c.init?.headers).get("x-api-key"), "sonarr-anime-key");
  }
  assert.ok(fetchCalls[1].url.includes("tvdbId=777"), "the library read is the cheap ?tvdbId= filter, not a full-library fetch");
});

test("sonarr Download by tvdbId only: the request is matched via tvdbId and the wanted row evicted via ITS tmdbId", async () => {
  const defaultRow = seedRequest({ tmdbId: 999, tvdbId: 5555, mediaType: "TV", arrInstance: "" });
  const animeRow = seedRequest({ tmdbId: 999, tvdbId: 5555, mediaType: "TV", arrInstance: "anime" });
  configureSonarr("");
  scriptSonarr({ series: () => completeSeries(5555) });

  const { res, body } = await post(
    sonarrPOST,
    webhookReq("sonarr", {
      token: SONARR_SECRET,
      // Sonarr omits tmdbId on some events — the tvdb fallback path.
      body: { eventType: "Download", series: { tvdbId: 5555, title: "Dark" } },
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, marked: 1 });
  assert.equal(defaultRow.status, "AVAILABLE");
  assert.equal(animeRow.status, "APPROVED", "the tvdb path is arrInstance-scoped too");
  // No tmdbId in the payload ⇒ no lookup round-trip; just the filtered library read.
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.startsWith(`${SONARR_DEFAULT_URL}/api/v3/series?tvdbId=5555`));

  // The wanted table is tmdbId-keyed: eviction uses the matched request's own
  // tmdbId, scoped to the firing instance.
  assert.deepEqual(sonarrWantedDeletes, [{ tmdbId: 999, arrInstance: "" }]);
  const tvdbWhere = requestUpdateManyCalls.find((c) => "tvdbId" in c.where)?.where;
  assert.deepEqual(tvdbWhere, {
    tvdbId: 5555, mediaType: "TV", arrInstance: "", status: "APPROVED",
  });
});

test("sonarr ManualInteractionRequired: stable key prefers tvdbId, falls back to tmdbId; fresh claim schedules push + marker prune", async () => {
  const first = await post(
    sonarrPOST,
    webhookReq("sonarr", {
      token: SONARR_SECRET,
      body: {
        eventType: "ManualInteractionRequired",
        series: { tvdbId: 42, tmdbId: 43, title: "Severance" },
        episodes: [{ seasonNumber: 1, episodeNumber: 5 }],
        downloadClient: "sab",
      },
    }),
  );
  assert.equal(first.res.status, 200);
  assert.deepEqual(first.body, { ok: true, manualInteraction: true });
  assert.equal(first.tasks.length, 2, "fresh claim schedules the push AND the 30-day marker prune");
  assert.deepEqual(
    settingCreateManyCalls[0].data.map((d) => d.key),
    ["manualInteractionNotified:sonarr::42"],
    "tvdbId is the preferred stable key (default instance ⇒ empty slug segment)",
  );

  // Executing the tasks is safe in this harness (push short-circuits on zero
  // subscriptions) and pins the prune's where-shape: prefix + 30-day ISO cutoff.
  await runTasks(first.tasks);
  const prune = settingDeleteManyCalls.find((c) => c.where.key?.startsWith !== undefined);
  assert.ok(prune, "the marker prune must run on a fresh claim");
  assert.equal(prune.where.key?.startsWith, "manualInteractionNotified:");
  const cutoff = prune.where.value?.lt;
  assert.ok(typeof cutoff === "string" && !Number.isNaN(Date.parse(cutoff)));

  // Same stable series, volatile payload fields changed → already claimed.
  const dup = await post(
    sonarrPOST,
    webhookReq("sonarr", {
      token: SONARR_SECRET,
      body: {
        eventType: "ManualInteractionRequired",
        series: { tvdbId: 42, tmdbId: 43, title: "Severance" },
        episodes: [{ seasonNumber: 1, episodeNumber: 5 }],
        downloadClient: "nzbget",
      },
    }),
  );
  assert.equal(dup.tasks.length, 0);

  // No usable tvdbId → the tmdbId fallback keys a DISTINCT claim.
  const tmdbKeyed = await post(
    sonarrPOST,
    webhookReq("sonarr", {
      token: SONARR_SECRET,
      body: {
        eventType: "ManualInteractionRequired",
        series: { tvdbId: 0, tmdbId: 43, title: "Severance" },
        downloadClient: "sab",
      },
    }),
  );
  assert.equal(tmdbKeyed.tasks.length, 2);
  const lastClaim = settingCreateManyCalls[settingCreateManyCalls.length - 1];
  assert.deepEqual(lastClaim.data.map((d) => d.key), ["manualInteractionNotified:sonarr::43"]);
});

test("sonarr: non-Download events and a Download without series are acknowledged skips with no writes", async () => {
  seedRequest({ tmdbId: 888, tvdbId: 777, mediaType: "TV" });
  const grab = await post(
    sonarrPOST,
    webhookReq("sonarr", {
      token: SONARR_SECRET,
      body: { eventType: "Grab", series: { tvdbId: 777, tmdbId: 888, title: "Frieren" } },
    }),
  );
  assert.equal(grab.res.status, 200);
  assert.deepEqual(grab.body, { ok: true, skipped: true });

  const noSeries = await post(
    sonarrPOST,
    webhookReq("sonarr", { token: SONARR_SECRET, body: { eventType: "Download" } }),
  );
  assert.deepEqual(noSeries.body, { ok: true, skipped: true });

  assert.equal(requests[0].status, "APPROVED");
  assert.equal(requestUpdateManyCalls.length, 0);
  assert.equal(sonarrWantedDeletes.length, 0);
});

// ── Sonarr: guardrail 14a — "ready" means the series is COMPLETE ────────────
//
// Sonarr fires one Download event per EPISODE. Under the old rule a continuing
// series counted as downloaded with any single file, so the first event of a
// 24-episode season pack flipped the request AVAILABLE and told the requester
// it was ready to watch; the claim burned and nothing announced the real
// completion. These pin the new contract end-to-end through the real
// isSeriesDownloadedInSonarr against scripted /api/v3 payloads.

test("sonarr 14a: an in-progress import (3/10 aired episodes) does NOT flip, answers {skipped, reason:incomplete} with the counts, still schedules the library scan, and logs nothing", async () => {
  const row = seedRequest({ tmdbId: 888, tvdbId: 777, mediaType: "TV", arrInstance: "" });
  configureSonarr("");
  scriptSonarr({
    series: () => [{ tvdbId: 777, tmdbId: 888, status: "continuing", seasons: [season(1, 3, 10)] }],
  });

  const { res, body, tasks } = await post(
    sonarrPOST,
    webhookReq("sonarr", {
      token: SONARR_SECRET,
      body: { eventType: "Download", series: { tvdbId: 777, tmdbId: 888, title: "Frieren" }, episodes: [{ seasonNumber: 1, episodeNumber: 3 }] },
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, skipped: true, reason: "incomplete", episodeFileCount: 3, episodeCount: 10 });

  assert.equal(row.status, "APPROVED", "a request must not go AVAILABLE off a partial season");
  assert.equal(row.availableAt, null);
  assert.equal(requestUpdateManyCalls.length, 0, "no status write at all");
  assert.equal(sonarrWantedDeletes.length, 0, "the wanted row stays — the series IS still wanted");
  // The episode landed, so the library scan is still scheduled: Plex/Jellyfin
  // should show the new episode even while the request waits.
  assert.equal(tasks.length, 1, "the deferred library-scan task must be scheduled on the incomplete path");
  // Silent by design (guardrail 7): this is the state of every event but the last.
  assert.ok(!warns.some((w) => w.includes("[webhook/sonarr]")), `unexpected webhook warning: ${warns.join(" | ")}`);
});

test("sonarr 14a: specials are EXCLUDED — a season-0 gap never holds a complete series back, and the series-level block Sonarr ships (which sums season 0) is ignored", async () => {
  const row = seedRequest({ tmdbId: 888, tvdbId: 777, mediaType: "TV", arrInstance: "" });
  configureSonarr("");
  scriptSonarr({
    series: () => [{
      tvdbId: 777, tmdbId: 888, status: "ended",
      // What Sonarr really sends: the series aggregate includes the six missing specials.
      statistics: { episodeFileCount: 20, episodeCount: 26 },
      seasons: [season(0, 0, 6), season(1, 10, 10), season(2, 10, 10)],
    }],
  });

  const { body } = await post(
    sonarrPOST,
    webhookReq("sonarr", { token: SONARR_SECRET, body: { eventType: "Download", series: { tvdbId: 777, tmdbId: 888, title: "Frieren" } } }),
  );
  assert.deepEqual(body, { ok: true, marked: 1 });
  assert.equal(row.status, "AVAILABLE");
});

test("sonarr 14a: a COMPLETE continuing series flips — completeness is about aired episodes, not series status", async () => {
  const row = seedRequest({ tmdbId: 888, tvdbId: 777, mediaType: "TV", arrInstance: "" });
  configureSonarr("");
  scriptSonarr({
    // Season 3 has aired 4 of a planned 12; all 4 are on disk. Sonarr's
    // per-season episodeCount already excludes the unaired 8.
    series: () => [{ tvdbId: 777, tmdbId: 888, status: "continuing", seasons: [season(1, 10, 10), season(2, 10, 10), season(3, 4, 4)] }],
  });

  const { body } = await post(
    sonarrPOST,
    webhookReq("sonarr", { token: SONARR_SECRET, body: { eventType: "Download", series: { tvdbId: 777, tmdbId: 888, title: "Frieren" } } }),
  );
  assert.deepEqual(body, { ok: true, marked: 1 });
  assert.equal(row.status, "AVAILABLE");
});

test("sonarr forgery rejection: Sonarr reports the series ABSENT → flip refused with a warning naming the reason; no scan scheduled", async () => {
  const row = seedRequest({ tmdbId: 888, tvdbId: 777, mediaType: "TV", arrInstance: "" });
  configureSonarr("");
  scriptSonarr({ series: () => [] });

  const { body, tasks } = await post(
    sonarrPOST,
    webhookReq("sonarr", { token: SONARR_SECRET, body: { eventType: "Download", series: { tvdbId: 777, tmdbId: 888, title: "Forged" } } }),
  );
  assert.deepEqual(body, { ok: true, skipped: true, reason: "not_downloaded" });
  assert.equal(row.status, "APPROVED");
  assert.equal(tasks.length, 0, "a disowned event must not trigger a library scan either");
  // The harness joins console.warn args without %s substitution, so the reason
  // arrives as a trailing argument rather than inside the parentheses.
  assert.ok(warns.some((w) => w.includes("not confirmed downloaded in Sonarr") && w.endsWith("absent")), warns.join(" | "));
});

test("sonarr ids-disagree: a lookup row that MATCHES the payload's tmdbId but names another tvdbId is refused (the forgery shape)", async () => {
  const row = seedRequest({ tmdbId: 888, tvdbId: 777, mediaType: "TV", arrInstance: "" });
  configureSonarr("");
  scriptSonarr({
    lookup: () => [{ tmdbId: 888, tvdbId: 99999 }], // Sonarr says tmdb 888 IS tvdb 99999, not the payload's 777
    series: () => completeSeries(777, 888),
  });

  const { body } = await post(
    sonarrPOST,
    webhookReq("sonarr", { token: SONARR_SECRET, body: { eventType: "Download", series: { tvdbId: 777, tmdbId: 888, title: "Paired" } } }),
  );
  assert.deepEqual(body, { ok: true, skipped: true, reason: "not_downloaded" });
  assert.equal(row.status, "APPROVED");
  assert.ok(warns.some((w) => w.includes("payload ids disagree")));
  assert.ok(warns.some((w) => w.includes("not confirmed downloaded in Sonarr") && w.endsWith("ids-disagree")), warns.join(" | "));
});

test("sonarr lone-row regression: a degraded lookup answering ONE row for a DIFFERENT title is ignored, and the genuine event flips on the payload's tvdbId", async () => {
  // Observed live: `term=tmdb:84503` came back as a single row whose tvdbId was
  // 84503 — a different show — and the ids-disagree guard then refused a real
  // Download for tvdbId 332335. pickSeriesByTmdbId must treat that row as no
  // answer, so the verify proceeds on the payload's own tvdbId.
  const row = seedRequest({ tmdbId: 84503, tvdbId: 332335, mediaType: "TV", arrInstance: "" });
  configureSonarr("");
  scriptSonarr({
    lookup: () => [{ tmdbId: 4321, tvdbId: 84503 }],
    series: (url) => (url.searchParams.get("tvdbId") === "332335" ? completeSeries(332335, 84503) : []),
  });

  const { body } = await post(
    sonarrPOST,
    webhookReq("sonarr", { token: SONARR_SECRET, body: { eventType: "Download", series: { tvdbId: 332335, tmdbId: 84503, title: "Real Show" } } }),
  );
  assert.deepEqual(body, { ok: true, marked: 1 });
  assert.equal(row.status, "AVAILABLE");
  assert.ok(!warns.some((w) => w.includes("payload ids disagree")), "a rejected lone row must not be reported as a disagreement");
  assert.ok(fetchCalls.some((c) => c.url.includes("tvdbId=332335")), "the library read used the payload's tvdbId");
});

test("sonarr 14a: an UNVERIFIABLE verdict (Sonarr 503) never flips optimistically — it defers, and the after() task re-verifies once the scan settles and flips then", async () => {
  const row = seedRequest({ tmdbId: 888, tvdbId: 777, mediaType: "TV", arrInstance: "" });
  configureSonarr("");
  // Sonarr 503s the library read on the FIRST verify (it does, under import
  // load), then answers complete on the re-check after the scan has settled.
  let seriesReads = 0;
  fetchHandler = (raw) => {
    const url = new URL(raw);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v3/series/lookup") return json([{ tmdbId: 888, tvdbId: 777 }]);
    if (url.pathname === "/api/v3/series") {
      seriesReads++;
      return seriesReads === 1 ? json({ message: "Service Unavailable" }, 503) : json(completeSeries(777, 888));
    }
    if (url.pathname === "/api/v3/queue") return json({ records: [], totalRecords: 0 });
    throw new Error(`unexpected Sonarr fetch ${raw}`);
  };

  const { res, body, tasks } = await post(
    sonarrPOST,
    webhookReq("sonarr", { token: SONARR_SECRET, body: { eventType: "Download", series: { tvdbId: 777, tmdbId: 888, title: "Frieren" } } }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, deferred: true, reason: "unverified" });
  assert.equal(row.status, "APPROVED", "the old optimistic flip announced an incomplete series as ready off a transient 503");
  assert.equal(requestUpdateManyCalls.length, 0);
  assert.ok(warns.some((w) => w.includes("[arr] isSeriesDownloadedInSonarr failed:")));
  assert.equal(tasks.length, 1, "exactly one deferred task: the scan + re-verify");

  // Run the deferred task. scheduleLibraryScan arms a real 15s debounce timer,
  // so drive it with mock timers: enable BEFORE the task registers its
  // setTimeout, tick the debounce, then let the async chain drain (the scan's
  // queue read answers "empty" above, so no second timer is armed; with no
  // media server configured the scan itself is a no-op).
  const { mock } = await import("node:test");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const running = runTasks(tasks);
    await drainMicrotasks();
    mock.timers.tick(15_000);
    await running;
  } finally {
    mock.timers.reset();
  }

  assert.equal(row.status, "AVAILABLE", "the re-verify confirmed completion and flipped the request from the after() task");
  assert.ok(row.availableAt instanceof Date);
  assert.equal(seriesReads, 2, "one 503'd verify, then exactly one re-check");
  assert.deepEqual(sonarrWantedDeletes, [{ tmdbId: 888, arrInstance: "" }], "the late flip evicts the wanted row like the synchronous one");
});

test("sonarr 14a: an unverifiable verdict whose re-check is STILL incomplete leaves the request to the periodic sync — no flip from the after() task either", async () => {
  const row = seedRequest({ tmdbId: 888, tvdbId: 777, mediaType: "TV", arrInstance: "" });
  configureSonarr("");
  let seriesReads = 0;
  fetchHandler = (raw) => {
    const url = new URL(raw);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v3/series/lookup") return json([{ tmdbId: 888, tvdbId: 777 }]);
    if (url.pathname === "/api/v3/series") {
      seriesReads++;
      return seriesReads === 1
        ? json({ message: "Service Unavailable" }, 503)
        : json([{ tvdbId: 777, tmdbId: 888, status: "continuing", seasons: [season(1, 5, 10)] }]);
    }
    if (url.pathname === "/api/v3/queue") return json({ records: [], totalRecords: 0 });
    throw new Error(`unexpected Sonarr fetch ${raw}`);
  };

  const { body, tasks } = await post(
    sonarrPOST,
    webhookReq("sonarr", { token: SONARR_SECRET, body: { eventType: "Download", series: { tvdbId: 777, tmdbId: 888, title: "Frieren" } } }),
  );
  assert.deepEqual(body, { ok: true, deferred: true, reason: "unverified" });

  const { mock } = await import("node:test");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const running = runTasks(tasks);
    await drainMicrotasks();
    mock.timers.tick(15_000);
    await running;
  } finally {
    mock.timers.reset();
  }

  assert.equal(row.status, "APPROVED");
  assert.equal(requestUpdateManyCalls.length, 0);
  assert.equal(seriesReads, 2, "exactly one re-check, never a retry loop");
});
