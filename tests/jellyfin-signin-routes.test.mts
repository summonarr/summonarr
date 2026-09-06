// Route-level unit tests for the three Jellyfin sign-in surfaces, added for
// Phase 1.5 (multi-server instance selection). Scope is deliberately narrow:
// the underlying membership/restrict-sign-in gate logic (per-instance
// scoping, the returning-user bypass staying global) is already pinned at the
// auth.ts unit level in auth.test.mts — this file only pins the ROUTE wiring
// around it:
//
//   POST /api/auth/sign-in/jellyfin — body.instance must be a well-formed slug
//   (a mis-cased "Remote" 400s, because it derives the same Setting keys as
//   "remote" but a different membership bucket) and must name a server with a
//   configured URL (an unregistered/unconfigured slug 503s before any fetch);
//   omitting it keeps signing into the default instance for old clients; a
//   configured NAMED instance signs in end to end against THAT instance's own
//   server.
//
//   POST /api/auth/jellyfin/quickconnect (initiate) — an invalid instance
//   slug is rejected before any fetch; a rate-limited caller is refused
//   BEFORE the Setting read (the limiter bounds anonymous DB load, not only
//   the outbound Jellyfin call). GET (poll) carries the same order pin.
//
//   POST /api/auth/sign-in/jellyfin-quickconnect (finalize) — the
//   SECURITY-CRITICAL pin: the instance used is whatever the INITIATE step
//   stamped into the signed flow cookie, never a client-supplied body field.
//   A request presenting a valid cookie for "remote" alongside a spoofed
//   body.instance naming the (unconfigured) default must still succeed
//   against "remote" — proving the cookie wins.
//
// No DB or network by default: globalThis.prisma is pre-seeded with an
// in-memory fake BEFORE the module graph loads (the auth.test.mts /
// poster-cache.test idiom), and globalThis.fetch throws unless a test scripts
// a responder. TRUST_PROXY is unset, so rate-limit buckets are per-UA-hash —
// every request gets a fresh User-Agent so no test can starve another's bucket.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "jf-signin-routes-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
delete process.env.TRUST_PROXY;
delete process.env.TRUSTED_PROXY_HOPS;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── in-memory DB state ──────────────────────────────────────────────────────
type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  permissions: bigint;
  jellyfinUserId: string | null;
  mediaServer: string | null;
  deactivatedAt: Date | null;
};
type MsuRow = { id: string; source: string; serverInstance: string; sourceUserId: string; active: boolean };
type AuthSessionRow = {
  sessionId: string;
  userId: string;
  deviceType: string | null;
  deviceLabel: string | null;
  ipAddress: string | null;
  expiresAt: Date;
  createdAt: Date;
  lastSeenAt: Date;
};

const settings = new Map<string, string>();
// Counts every setting.findUnique so a test can pin that a request rejected by
// the rate limiter never reached the DB at all.
let settingReads = 0;
const users: UserRow[] = [];
const mediaServerUsers: MsuRow[] = [];
const authSessions = new Map<string, AuthSessionRow>();
const auditRows: Array<Record<string, unknown>> = [];
let userSeq = 0;

function applySelect(row: Record<string, unknown>, select?: Record<string, boolean>): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) if (select[key]) out[key] = row[key];
  return out;
}

type UserWhere = { id?: string; jellyfinUserId?: string; role?: string };
function findUserRow(where: UserWhere): UserRow | undefined {
  return users.find((u) =>
    where.id !== undefined ? u.id === where.id
    : where.jellyfinUserId !== undefined ? u.jellyfinUserId === where.jellyfinUserId
    : false,
  );
}

const models = {
  setting: {
    findUnique: async (args: { where: { key: string } }) => {
      settingReads++;
      const v = settings.get(args.where.key);
      return v === undefined ? null : { key: args.where.key, value: v };
    },
    findMany: async (args: { where?: { key?: { in?: string[] } } }) => {
      const keys = args.where?.key?.in ?? [...settings.keys()];
      return keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! }));
    },
  },
  user: {
    findUnique: async (args: { where: UserWhere; select?: Record<string, boolean> }) => {
      const row = findUserRow(args.where);
      return row ? applySelect(row as unknown as Record<string, unknown>, args.select) : null;
    },
    findFirst: async (args: { where?: { role?: string }; select?: Record<string, boolean> }) => {
      const row = users.find((u) => (args.where?.role === undefined ? true : u.role === args.where.role));
      return row ? applySelect(row as unknown as Record<string, unknown>, args.select) : null;
    },
    create: async (args: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
      const d = args.data;
      const row: UserRow = {
        id: (d.id as string | undefined) ?? `u-auto-${++userSeq}`,
        email: d.email as string,
        name: (d.name as string | null | undefined) ?? null,
        role: (d.role as string | undefined) ?? "USER",
        permissions: (d.permissions as bigint | undefined) ?? 0n,
        jellyfinUserId: (d.jellyfinUserId as string | undefined) ?? null,
        mediaServer: null,
        deactivatedAt: null,
      };
      users.push(row);
      return applySelect(row as unknown as Record<string, unknown>, args.select);
    },
    update: async (args: { where: UserWhere; data: Record<string, unknown>; select?: Record<string, boolean> }) => {
      const row = findUserRow(args.where);
      if (!row) throw new Error("user.update: row not found");
      Object.assign(row, args.data);
      return applySelect(row as unknown as Record<string, unknown>, args.select);
    },
    updateMany: async (args: { where: UserWhere; data: Record<string, unknown> }) => {
      const row = findUserRow(args.where);
      if (row) Object.assign(row, args.data);
      return { count: row ? 1 : 0 };
    },
  },
  mediaServerUser: {
    findFirst: async (args: {
      where?: { source?: string; serverInstance?: string; sourceUserId?: string; active?: boolean };
      select?: Record<string, boolean>;
    }) => {
      const w = args.where ?? {};
      const row = mediaServerUsers.find(
        (m) =>
          (w.source === undefined || m.source === w.source) &&
          (w.serverInstance === undefined || m.serverInstance === w.serverInstance) &&
          (w.sourceUserId === undefined || m.sourceUserId === w.sourceUserId) &&
          (w.active === undefined || m.active === w.active),
      );
      return row ? applySelect(row as unknown as Record<string, unknown>, args.select) : null;
    },
  },
  authSession: {
    upsert: async (args: { where: { sessionId: string }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
      const existing = authSessions.get(args.where.sessionId);
      if (existing) {
        Object.assign(existing, args.update);
        return { ...existing };
      }
      const row: AuthSessionRow = {
        deviceType: null,
        deviceLabel: null,
        ipAddress: null,
        createdAt: new Date(),
        lastSeenAt: new Date(),
        ...(args.create as Partial<AuthSessionRow> & { sessionId: string; userId: string; expiresAt: Date }),
      };
      authSessions.set(row.sessionId, row);
      return { ...row };
    },
  },
  auditLog: {
    create: async (args: { data: Record<string, unknown> }) => {
      auditRows.push(args.data);
      return { id: auditRows.length, ...args.data };
    },
  },
};

const txFacade = {
  ...models,
  $executeRawUnsafe: async (..._args: unknown[]) => 0,
};

const fakePrisma = {
  ...models,
  $transaction: async (fn: unknown) => {
    if (typeof fn === "function") return (fn as (tx: typeof txFacade) => Promise<unknown>)(txFacade);
    return Promise.all(fn as Promise<unknown>[]);
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── scripted fetch ──────────────────────────────────────────────────────────
type FetchCall = { url: URL; init?: RequestInit };
const fetchCalls: FetchCall[] = [];
let respond: (url: URL, init?: RequestInit) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch — script a responder for this test");
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  fetchCalls.push({ url, init });
  return respond(url, init);
}) as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ── module under test (dynamic: stubs must precede load) ────────────────────
const { NextRequest } = await import("next/server");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { POST: jellyfinSignInPost } = await import("../src/app/api/auth/sign-in/jellyfin/route.ts");
const { POST: jellyfinQcSignInPost } = await import("../src/app/api/auth/sign-in/jellyfin-quickconnect/route.ts");
const { POST: qcInitiatePost, GET: qcPollGet } = await import("../src/app/api/auth/jellyfin/quickconnect/route.ts");

type Req = InstanceType<typeof NextRequest>;

const COOKIE = getSessionCookieName();

let uaSeq = 0;
function uniqueUa(): string {
  uaSeq++;
  return `Mozilla/5.0 (Test) unit-test/${uaSeq}`;
}

function jsonReq(url: string, body: unknown, extraHeaders: Record<string, string> = {}): Req {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": uniqueUa(), ...extraHeaders },
    body: JSON.stringify(body),
  });
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  settings.clear();
  settings.set("setup_completed_at", "2026-01-01T00:00:00.000Z"); // skip first-admin bootstrap entirely
  users.length = 0;
  mediaServerUsers.length = 0;
  authSessions.clear();
  auditRows.length = 0;
  userSeq = 0;
  settingReads = 0;
  warns.length = 0;
  errors.length = 0;
  fetchCalls.length = 0;
  respond = () => {
    throw new Error("unexpected fetch — script a responder for this test");
  };
});

// ── POST /api/auth/sign-in/jellyfin ─────────────────────────────────────────

test("sign-in/jellyfin: an unregistered instance is refused (503) before any fetch", async () => {
  const res = await jellyfinSignInPost(
    jsonReq("http://localhost:3000/api/auth/sign-in/jellyfin", { username: "u", password: "pw", instance: "bogus" }),
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await bodyOf(res), { error: "Jellyfin sign-in is not configured for this server" });
  assert.equal(fetchCalls.length, 0, "an unconfigured instance must be rejected before contacting any server");
});

test("sign-in/jellyfin: an INVALID instance slug is rejected (400) before any fetch", async () => {
  // Not merely cosmetic: instanceKeySegment upper-cases the FIRST character
  // only, so "Remote" derives the very same jellyfinRemoteUrl/ApiKey config as
  // "remote" and would sail past the configured-URL gate — and then the
  // membership lookup downstream queries serverInstance "Remote", which matches
  // no MediaServerUser row, refusing a legitimate first-time user of that
  // server. Fails closed, but wrongly. Every sibling instance-consuming route
  // (QuickConnect initiate, both terminate routes, the fix-match trio) validates.
  settings.set("jellyfinRemoteUrl", "http://10.20.0.3:8096");
  mediaServerUsers.push({ id: "msu-case", source: "jellyfin", serverInstance: "remote", sourceUserId: "jf-case-1", active: true });

  const res = await jellyfinSignInPost(
    jsonReq("http://localhost:3000/api/auth/sign-in/jellyfin", { username: "u", password: "pw", instance: "Remote" }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await bodyOf(res), { error: "Invalid server" });
  assert.equal(fetchCalls.length, 0, "an invalid slug must be rejected before contacting any server");
});

test("sign-in/jellyfin: omitting instance signs into the DEFAULT server (backward compatible with pre-Phase-1.5 clients)", async () => {
  // No API key at all — sign-in itself has never needed one; only the
  // best-effort email backfill in findOrCreateJellyfinUser does, and it's
  // absent here, so that branch is skipped entirely.
  settings.set("jellyfinUrl", "http://10.20.0.2:8096");
  mediaServerUsers.push({ id: "msu-default", source: "jellyfin", serverInstance: "", sourceUserId: "jf-default-1", active: true });
  respond = (url) => {
    if (url.pathname === "/Users/AuthenticateByName") {
      return jsonResponse({ User: { Id: "jf-default-1", Name: "Default User" } });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  const res = await jellyfinSignInPost(
    jsonReq("http://localhost:3000/api/auth/sign-in/jellyfin", { username: "default", password: "pw" }),
  );
  assert.equal(res.status, 200);
  const body = await bodyOf(res);
  assert.equal(body.ok, true);
  assert.equal((body.user as Record<string, unknown>).mediaServer, "jellyfin");
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=`)));
});

test("sign-in/jellyfin: a configured NAMED instance signs in end-to-end, against THAT instance's own server", async () => {
  // The default is intentionally left unconfigured — proves the request
  // really goes to "remote", not a hardcoded default fallback. Only the
  // connection URL is set (no registry entry, no API key needed either) —
  // the route's gate is URL-only, matching sign-in's actual requirements.
  settings.set("jellyfinRemoteUrl", "http://10.20.0.3:8096");
  mediaServerUsers.push({ id: "msu-remote", source: "jellyfin", serverInstance: "remote", sourceUserId: "jf-remote-1", active: true });
  respond = (url) => {
    if (url.origin !== "http://10.20.0.3:8096") throw new Error(`unexpected fetch origin ${url.origin}`);
    if (url.pathname === "/Users/AuthenticateByName") {
      return jsonResponse({ User: { Id: "jf-remote-1", Name: "Remote User" } });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  const res = await jellyfinSignInPost(
    jsonReq("http://localhost:3000/api/auth/sign-in/jellyfin", { username: "remoteuser", password: "pw", instance: "remote" }),
  );
  assert.equal(res.status, 200);
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=`)), "a successful sign-in must set the session cookie");
});

test("sign-in/jellyfin: an instance with NO API key configured still accepts sign-in — the gate is URL-only, not getSyncableMediaInstances", async () => {
  // Regression pin: getSyncableMediaInstances requires BOTH url+apiKey per
  // instance, but sign-in itself has never needed the key (only the
  // best-effort email backfill does). Gating sign-in on the syncable list
  // would 503 a deployment that could sign in just fine pre-Phase-1.5.
  settings.set("jellyfinRemoteUrl", "http://10.20.0.5:8096");
  // No jellyfinRemoteApiKey set anywhere — deliberately.
  mediaServerUsers.push({ id: "msu-nokey", source: "jellyfin", serverInstance: "remote", sourceUserId: "jf-nokey-1", active: true });
  respond = (url) => {
    if (url.pathname === "/Users/AuthenticateByName") {
      return jsonResponse({ User: { Id: "jf-nokey-1", Name: "No Key User" } });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  const res = await jellyfinSignInPost(
    jsonReq("http://localhost:3000/api/auth/sign-in/jellyfin", { username: "nokey", password: "pw", instance: "remote" }),
  );
  assert.equal(res.status, 200, "an API key is not required for sign-in to a configured instance");
});

// ── QuickConnect: cookie-pinned instance (security-critical) ───────────────

test("QuickConnect initiate: an invalid instance slug is rejected (400) before any fetch", async () => {
  const res = await qcInitiatePost(
    new NextRequest("http://localhost:3000/api/auth/jellyfin/quickconnect?instance=Bogus", { method: "POST" }),
  );
  assert.equal(res.status, 400);
  assert.equal(fetchCalls.length, 0);
});

test("QuickConnect initiate: a rate-limited caller is refused (429) BEFORE the Setting read", async () => {
  // The route used to read the jellyfin<Instance>Url Setting first and only
  // then consult the per-IP limiter, so an anonymous caller cost one DB
  // round-trip per request regardless of the 10/min budget — the limiter only
  // bounded the outbound Jellyfin call. Siblings (setup-status,
  // machine-session, jellyfin/servers) limit first for exactly this reason.
  settings.set("jellyfinRemoteUrl", "http://10.20.0.6:8096");
  respond = (url) => {
    if (url.pathname === "/QuickConnect/Initiate") {
      return jsonResponse({ Secret: "qc-secret-rl-test", Code: "RL0001" });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  // TRUST_PROXY is unset → the bucket is per-UA-hash, so ONE fixed UA (fresh
  // to this test) is one caller.
  const ua = uniqueUa();
  const initiate = () =>
    qcInitiatePost(
      new NextRequest("http://localhost:3000/api/auth/jellyfin/quickconnect?instance=remote", {
        method: "POST",
        headers: { "user-agent": ua },
      }),
    );

  for (let i = 0; i < 10; i++) {
    const res = await initiate();
    assert.equal(res.status, 200, `initiate #${i + 1} is within the 10/min budget`);
  }
  assert.equal(settingReads, 10, "each in-budget initiate reads the instance URL once");

  const readsBefore = settingReads;
  const fetchesBefore = fetchCalls.length;
  const res = await initiate();
  assert.equal(res.status, 429);
  assert.equal(settingReads, readsBefore, "a rate-limited initiate must not touch the Setting table");
  assert.equal(fetchCalls.length, fetchesBefore, "a rate-limited initiate must not contact Jellyfin");
});

test("QuickConnect poll: a rate-limited caller is refused (429) BEFORE the Setting read", async () => {
  // GET twin of the pin above. Each poll carries a DISTINCT secret so only the
  // per-IP limiter (60/min) can fire — the per-secret limiter (30/min) never
  // sees a repeat.
  settings.set("jellyfinRemoteUrl", "http://10.20.0.7:8096");
  respond = (url) => {
    if (url.pathname === "/QuickConnect/Connect") {
      return jsonResponse({ Authenticated: false });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  const ua = uniqueUa();
  const poll = (i: number) =>
    qcPollGet(
      new NextRequest(`http://localhost:3000/api/auth/jellyfin/quickconnect?instance=remote&secret=rl-secret-${i}`, {
        method: "GET",
        headers: { "user-agent": ua },
      }),
    );

  for (let i = 0; i < 60; i++) {
    const res = await poll(i);
    assert.equal(res.status, 200, `poll #${i + 1} is within the 60/min budget`);
  }
  assert.equal(settingReads, 60, "each in-budget poll reads the instance URL once");

  const readsBefore = settingReads;
  const fetchesBefore = fetchCalls.length;
  const res = await poll(60);
  assert.equal(res.status, 429);
  assert.equal(settingReads, readsBefore, "a rate-limited poll must not touch the Setting table");
  assert.equal(fetchCalls.length, fetchesBefore, "a rate-limited poll must not contact Jellyfin");
});

test("QuickConnect finalize trusts ONLY the cookie-pinned instance — a spoofed body.instance naming an unconfigured server is ignored", async () => {
  // Only "remote" is configured; the default is deliberately left unconfigured
  // so that IF the finalize route ever regressed to trusting body.instance
  // instead of the cookie, this request would 401 against the (unconfigured)
  // default instead of succeeding against "remote".
  settings.set("jellyfinRemoteUrl", "http://10.20.0.4:8096");
  mediaServerUsers.push({ id: "msu-qc", source: "jellyfin", serverInstance: "remote", sourceUserId: "jf-qc-1", active: true });

  respond = (url) => {
    if (url.pathname === "/QuickConnect/Initiate") {
      return jsonResponse({ Secret: "qc-secret-pin-test", Code: "ABC123" });
    }
    if (url.pathname === "/Users/AuthenticateWithQuickConnect") {
      return jsonResponse({ User: { Id: "jf-qc-1", Name: "QC Pin User" } });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  const initiateRes = await qcInitiatePost(
    new NextRequest("http://localhost:3000/api/auth/jellyfin/quickconnect?instance=remote", {
      method: "POST",
      headers: { "user-agent": uniqueUa() },
    }),
  );
  assert.equal(initiateRes.status, 200);
  const setCookie = initiateRes.headers.getSetCookie().find((c) => c.startsWith("summonarr-qc-flow="));
  assert.ok(setCookie, "initiate must set the QC flow cookie");
  const cookieValue = setCookie.split(";")[0];

  // Finalize: the cookie says "remote", but the JSON body lies and claims the
  // default ("") instance — an unconfigured server.
  const finalizeRes = await jellyfinQcSignInPost(
    jsonReq(
      "http://localhost:3000/api/auth/sign-in/jellyfin-quickconnect",
      { secret: "qc-secret-pin-test", instance: "" },
      { cookie: cookieValue },
    ),
  );
  assert.equal(finalizeRes.status, 200, "finalize must use the cookie's pinned instance, not the spoofed body field");
  const body = await bodyOf(finalizeRes);
  assert.equal(body.ok, true);
});

test("QuickConnect finalize: no flow cookie at all is refused (400), regardless of a body.instance", async () => {
  const res = await jellyfinQcSignInPost(
    jsonReq("http://localhost:3000/api/auth/sign-in/jellyfin-quickconnect", { secret: "some-secret", instance: "remote" }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await bodyOf(res), { error: "QuickConnect flow expired" });
});
