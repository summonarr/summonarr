// Route-level unit tests for the five uncovered TRaSH Guides admin routes:
//   GET  /api/admin/trash-guides/status
//   GET  /api/admin/trash-guides/spec/[id]
//   POST /api/admin/trash-guides/refresh
//   POST /api/admin/trash-guides/apply
//   GET/POST /api/admin/trash-guides/starter-pack
//
// These are the routes that REWRITE an operator's Radarr/Sonarr custom formats
// and quality profiles, so the guards are about not clobbering someone's setup:
//
//   1. THE STARTER PACK APPLIES ONLY CURATED ENTRIES. resolveStarterPack returns
//      the four `recommended: true` items AND every other profile/naming/size
//      spec in the catalog (the GET picker needs both). The POST filters on
//      `item.recommended` — filtering on `i.spec` alone, which is the obvious
//      shortening, would push the ENTIRE TRaSH catalog to Radarr/Sonarr and
//      overwrite the operator's existing profiles. The in-code comment names
//      this exact trap, and it is the headline test here.
//   2. THE FEATURE KILL-SWITCH GATES THE WRITE ROUTES, NOT THE READS. apply,
//      refresh and starter-pack POST all 403 when trashGuidesEnabled is off
//      (parity with the nightly cron); status, spec and starter-pack GET stay
//      open because they are read-only previews.
//   3. AN INVALID INSTANCE SLUG IS REJECTED, NEVER SILENTLY ROUTED TO THE
//      DEFAULT — a UI bug must not rewrite the WRONG Radarr/Sonarr instance
//      (guardrail 32). "hd" is the legacy spelling of the default and still maps
//      to "".
//   4. ALL THREE WRITE ROUTES SHARE TRASH_SYNC_LOCK_ID with /api/cron/trash-sync,
//      so an admin click during the nightly sync can't interleave two catalogs'
//      worth of writes at the arr servers.
//   5. THE RATE LIMITS ARE EQUAL ACROSS THE THREE. starter-pack POST performs the
//      same class of arr writes as apply, so it must not be a lighter-gated way
//      to trigger the same burst.
//   6. A MISSING SCHEMA DEGRADES, NOT 500s. The read routes turn a "relation does
//      not exist" into a schemaDiagnostic hint so a pre-migration deployment gets
//      an actionable message instead of a stack trace.
//
// Harness: real withAdmin-wrapped handlers, genuine signed session JWTs, a
// synthetic Next request scope, in-memory prisma stubs, and a monkey-patched
// `pg` Client.prototype for the advisory lock. applySpecs is observed through
// the `trashSpec.findMany({ where: { id: { in: … } } })` it issues first — that
// id list IS the set being pushed to the arr servers. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "pg";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "admin-trash-guides-secret-0123456789ab";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5432/db";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// GitHub (catalog pull) is the only outbound reach; keep it failing so
// refreshCatalog exercises its error path without any real network.
const fetchCalls: URL[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  return new Response(JSON.stringify({ message: "unavailable" }), {
    status: 503, headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;

// ── pg Client prototype stub (the withAdvisoryLock seam) ─────────────────────
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

const cjsRequire = createRequire(import.meta.url);
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { STARTER_PACK } = await import("../src/lib/trash-recommendations.ts");
const AL = await import("../src/lib/advisory-lock.ts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// The id list applySpecs asked for — i.e. exactly what would be pushed to arr.
function appliedSpecIds(): string[][] {
  return opsOf("trashSpec.findMany")
    .map((o) => (o.args as { where?: { id?: { in?: string[] } } }).where?.id?.in)
    .filter((x): x is string[] => Array.isArray(x));
}

// ── auth fixture ─────────────────────────────────────────────────────────────
const sessionUsers = new Map<string, Record<string, unknown>>();
const sessionRows = new Set<string>();
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => sessionUsers.get(args.where.id) ?? null,
  update: async () => ({}),
});

let seq = 0;
async function mintSession(opts: { role?: string; permissions?: bigint } = {}): Promise<string> {
  seq++;
  const userId = `admin-${seq}`;
  const sessionId = `sess-${seq}`;
  const role = opts.role ?? "ADMIN";
  const permissions = (opts.permissions ?? Permission.ADMIN).toString();
  sessionUsers.set(userId, {
    id: userId, name: `Admin ${seq}`, role, permissions: BigInt(permissions),
    mediaServer: null, sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: `admin-${seq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

// ── TrashSpec store ──────────────────────────────────────────────────────────
type Spec = {
  id: string; service: string; kind: string; trashId: string; name: string;
  payload: unknown; upstreamSha: string | null; fetchedAt: Date;
};
let specs: Spec[] = [];
// When set, every trashSpec read throws it — used for the missing-schema path.
let specReadThrows: Error | null = null;

function schemaError(): Error {
  const e = new Error('relation "public"."TrashSpec" does not exist');
  (e as { code?: string }).code = "42P01";
  return e;
}

shadowPrismaModel(prisma, "trashSpec", {
  findMany: async (args: { where?: Record<string, unknown>; include?: unknown; select?: unknown; orderBy?: unknown } = {}) => {
    rec("trashSpec.findMany", { where: args.where });
    if (specReadThrows) throw specReadThrows;
    const w = args.where ?? {};
    let rows = [...specs];
    const idFilter = w.id as { in?: string[]; notIn?: string[] } | undefined;
    if (idFilter?.in) rows = rows.filter((s) => idFilter.in!.includes(s.id));
    if (idFilter?.notIn) rows = rows.filter((s) => !idFilter.notIn!.includes(s.id));
    if (w.service) rows = rows.filter((s) => s.service === w.service);
    const kind = w.kind as string | { in?: string[] } | undefined;
    if (typeof kind === "string") rows = rows.filter((s) => s.kind === kind);
    else if (kind?.in) rows = rows.filter((s) => kind.in!.includes(s.kind));
    return rows.map((s) => ({ ...s, applications: [] }));
  },
  findFirst: async (args: { where?: Record<string, unknown> } = {}) => {
    rec("trashSpec.findFirst", args.where);
    if (specReadThrows) throw specReadThrows;
    const w = args.where ?? {};
    const hit = specs.find((s) => {
      if (w.service && s.service !== w.service) return false;
      if (w.kind && s.kind !== w.kind) return false;
      if (w.trashId && s.trashId !== w.trashId) return false;
      const nameFilter = w.name as { equals?: string; contains?: string } | undefined;
      if (nameFilter?.equals && s.name.toLowerCase() !== nameFilter.equals.toLowerCase()) return false;
      if (nameFilter?.contains && !s.name.toLowerCase().includes(nameFilter.contains.toLowerCase())) return false;
      return true;
    });
    // Callers pass include: { applications: … } and read applications[0], so the
    // relation has to be present or the read throws on undefined.
    return hit ? { ...hit, applications: [] } : null;
  },
  findUnique: async (args: { where: { id: string } }) => {
    rec("trashSpec.findUnique", args.where);
    if (specReadThrows) throw specReadThrows;
    const s = specs.find((x) => x.id === args.where.id);
    return s ? { ...s, applications: [] } : null;
  },
  count: async () => specs.length,
  groupBy: async () => [],
  upsert: async (args: unknown) => { rec("trashSpec.upsert", args); return {}; },
  createMany: async (args: unknown) => { rec("trashSpec.createMany", args); return { count: 0 }; },
  updateMany: async (args: unknown) => { rec("trashSpec.updateMany", args); return { count: 0 }; },
  deleteMany: async (args: unknown) => { rec("trashSpec.deleteMany", args); return { count: 0 }; },
});

shadowPrismaModel(prisma, "trashApplication", {
  findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
  count: async () => 0,
  create: async (args: unknown) => { rec("trashApplication.create", args); return { id: "app-1" }; },
  update: async (args: unknown) => { rec("trashApplication.update", args); return { id: "app-1" }; },
  upsert: async (args: unknown) => { rec("trashApplication.upsert", args); return { id: "app-1" }; },
  updateMany: async (args: unknown) => { rec("trashApplication.updateMany", args); return { count: 0 }; },
  deleteMany: async (args: unknown) => { rec("trashApplication.deleteMany", args); return { count: 0 }; },
});

const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
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

shadowPrismaModel(prisma, "auditLog", { create: async (args: unknown) => { rec("auditLog.create", args); return { id: "a1" }; } });
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma));

const status = await import("../src/app/api/admin/trash-guides/status/route.ts");
const specDetail = await import("../src/app/api/admin/trash-guides/spec/[id]/route.ts");
const refresh = await import("../src/app/api/admin/trash-guides/refresh/route.ts");
const apply = await import("../src/app/api/admin/trash-guides/apply/route.ts");
const starterPack = await import("../src/app/api/admin/trash-guides/starter-pack/route.ts");

// ── scope ────────────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/admin-trash.test", forceStatic: false, dynamicShouldError: false,
    afterContext: { after: () => {} },
  };
  const reqHeaders = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

function mk(path: string, token: string | null, init: { method: string; body?: string; query?: string }) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.cookie = `${COOKIE}=${token}`;
  const r = new NextRequest(`http://localhost:3000${path}${init.query ?? ""}`, {
    method: init.method,
    headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  // refresh branches on content-length to decide whether to parse a body.
  if (init.body !== undefined) r.headers.set("content-length", String(Buffer.byteLength(init.body)));
  return r;
}

const getStatus = (t: string | null, q = "?service=radarr") =>
  inScope(() => status.GET(mk("/api/admin/trash-guides/status", t, { method: "GET", query: q }), undefined));
const getSpec = (t: string | null, id: string, q = "") =>
  inScope(() => specDetail.GET(mk(`/api/admin/trash-guides/spec/${id}`, t, { method: "GET", query: q }), { params: Promise.resolve({ id }) }));
const postRefresh = (t: string | null, body?: string) =>
  inScope(() => refresh.POST(mk("/api/admin/trash-guides/refresh", t, { method: "POST", body }), undefined));
const postApply = (t: string | null, body: unknown, raw?: string) =>
  inScope(() => apply.POST(mk("/api/admin/trash-guides/apply", t, { method: "POST", body: raw ?? JSON.stringify(body) }), undefined));
const getStarter = (t: string | null) =>
  inScope(() => starterPack.GET(mk("/api/admin/trash-guides/starter-pack", t, { method: "GET" }), undefined));
const postStarter = (t: string | null) =>
  inScope(() => starterPack.POST(mk("/api/admin/trash-guides/starter-pack", t, { method: "POST" }), undefined));

function spec(over: Partial<Spec> & { id: string }): Spec {
  return {
    service: "RADARR", kind: "QUALITY_PROFILE", trashId: `trash-${over.id}`,
    name: `Spec ${over.id}`, payload: {}, upstreamSha: null, fetchedAt: new Date(), ...over,
  };
}

// Seed a spec row for each curated STARTER_PACK entry so resolveStarterPack
// resolves all four, plus some NON-curated catalog specs.
function seedStarterPackSpecs(): void {
  // resolveCurated walks trashId → slug → exact name → partial name, so the
  // seeded row has to carry whichever of those the entry actually declares.
  specs = STARTER_PACK.map((item, i) =>
    spec({
      id: `curated-${i}`,
      service: item.service,
      kind: item.kind,
      trashId: item.match?.trashId ?? item.match?.slug ?? `slug-${i}`,
      name: item.match?.name ?? `Curated ${i}`,
    }),
  );
  specs.push(
    spec({ id: "other-1", service: "RADARR", kind: "QUALITY_PROFILE", trashId: "x1", name: "Operator's Own Profile" }),
    spec({ id: "other-2", service: "SONARR", kind: "QUALITY_SIZE", trashId: "x2", name: "Custom Sizes" }),
  );
}

beforeEach(() => {
  ops = [];
  specs = [];
  specReadThrows = null;
  pgLockCalls = [];
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  settings.set("trashGuidesEnabled", "true");
  // applySpecs resolves a Radarr/Sonarr connection before it does anything; with
  // none configured it THROWS rather than returning a per-spec failure. RFC1918
  // literals so the SSRF stack short-circuits DNS; the scripted fetch then 503s,
  // which is the per-spec failure path we actually want to exercise.
  settings.set("radarrUrl", "http://10.0.0.11:7878");
  settings.set("radarrApiKey", "radarr-key");
  settings.set("radarr4kUrl", "http://10.0.0.12:7878");
  settings.set("radarr4kApiKey", "radarr-4k-key");
  settings.set("sonarrUrl", "http://10.0.0.13:8989");
  settings.set("sonarrApiKey", "sonarr-key");
  settings.set("sonarr4kUrl", "http://10.0.0.14:8989");
  settings.set("sonarr4kApiKey", "sonarr-4k-key");
  invalidateFeatureFlagCache();
  lockAcquire = () => true;
});

const WRITE_ROUTES = [
  { name: "refresh", call: (t: string | null) => postRefresh(t) },
  { name: "apply", call: (t: string | null) => postApply(t, { specIds: ["curated-0"] }) },
  { name: "starter-pack POST", call: (t: string | null) => postStarter(t) },
] as const;

// ── gating ───────────────────────────────────────────────────────────────────

test("every trash-guides route refuses an anonymous caller with 401", async () => {
  assert.equal((await getStatus(null)).status, 401);
  assert.equal((await getSpec(null, "s1")).status, 401);
  assert.equal((await postRefresh(null)).status, 401);
  assert.equal((await postApply(null, { specIds: [] })).status, 401);
  assert.equal((await getStarter(null)).status, 401);
  assert.equal((await postStarter(null)).status, 401);
});

test("a plain USER is 403 everywhere and reaches no lock", async () => {
  const t = await mintSession({ role: "USER", permissions: 0n });
  assert.equal((await getStatus(t)).status, 403);
  assert.equal((await getSpec(t, "s1")).status, 403);
  assert.equal((await postRefresh(t)).status, 403);
  assert.equal((await postApply(t, { specIds: [] })).status, 403);
  assert.equal((await getStarter(t)).status, 403);
  assert.equal((await postStarter(t)).status, 403);
  assert.deepEqual(pgLockCalls, []);
});

test("an ISSUE_ADMIN is refused — these are withAdmin", async () => {
  const t = await mintSession({ role: "ISSUE_ADMIN", permissions: Permission.MANAGE_ISSUES });
  assert.equal((await getStatus(t)).status, 403);
  assert.equal((await postApply(t, { specIds: [] })).status, 403);
});

// ── 2: the feature kill-switch gates writes, not reads ───────────────────────

for (const r of WRITE_ROUTES) {
  test(`${r.name} is 403 when trashGuidesEnabled is off, and takes no lock`, async () => {
    // Parity with the nightly cron: a disabled integration must not still rewrite
    // Radarr/Sonarr custom formats and quality profiles.
    settings.set("trashGuidesEnabled", "false");
    invalidateFeatureFlagCache();
    const t = await mintSession();
    const res = await r.call(t);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /disabled/i);
    assert.deepEqual(pgLockCalls, [], `${r.name} took a lock while disabled`);
  });
}

test("the READ routes stay open when the integration is disabled", async () => {
  // They are read-only previews; blocking them would leave an operator unable to
  // see what is configured while the switch is off.
  settings.set("trashGuidesEnabled", "false");
  invalidateFeatureFlagCache();
  const t = await mintSession();
  seedStarterPackSpecs();
  assert.equal((await getStatus(t)).status, 200);
  assert.equal((await getStarter(t)).status, 200);
});

test("the kill-switch is a strict 'true' comparison", async () => {
  const t = await mintSession();
  for (const v of ["1", "yes", "TRUE", "on", ""]) {
    settings.set("trashGuidesEnabled", v);
    invalidateFeatureFlagCache();
    assert.equal((await postApply(t, { specIds: ["curated-0"] })).status, 403, `"${v}" must not enable writes`);
  }
});

// ── 1: the starter pack applies ONLY curated entries ─────────────────────────

test("starter-pack POST applies ONLY the curated entries, never the whole catalog", async () => {
  // The trap the in-code comment names: resolveStarterPack also returns every
  // non-curated profile/naming/size spec for the GET picker, so filtering on
  // `i.spec` instead of `i.item.recommended` would push the ENTIRE TRaSH catalog
  // and overwrite the operator's existing profiles.
  const t = await mintSession();
  seedStarterPackSpecs();
  const res = await postStarter(t);
  assert.equal(res.status, 200);

  const applied = appliedSpecIds().flat();
  assert.ok(applied.length > 0, "nothing was applied at all");
  assert.ok(!applied.includes("other-1"), "a non-curated catalog spec was applied");
  assert.ok(!applied.includes("other-2"), "a non-curated catalog spec was applied");
  for (const id of applied) {
    assert.ok(id.startsWith("curated-"), `unexpected spec applied: ${id}`);
  }
});

test("starter-pack GET returns BOTH curated and non-curated entries for the picker", async () => {
  const t = await mintSession();
  seedStarterPackSpecs();
  const body = await (await getStarter(t)).json();
  const recommended = body.items.filter((i: { item: { recommended: boolean } }) => i.item.recommended);
  const others = body.items.filter((i: { item: { recommended: boolean } }) => !i.item.recommended);
  assert.equal(recommended.length, STARTER_PACK.length);
  assert.ok(others.length >= 2, "the picker should also list non-curated specs");
});

test("starter-pack GET is read-only — it applies nothing and takes no lock", async () => {
  const t = await mintSession();
  seedStarterPackSpecs();
  await getStarter(t);
  assert.deepEqual(pgLockCalls, []);
  assert.equal(opsOf("auditLog.create").length, 0);
});

test("starter-pack POST reports curated entries that have no matching spec as missing", async () => {
  const t = await mintSession();
  specs = []; // nothing in the catalog resolves
  const body = await (await postStarter(t)).json();
  assert.equal(body.ok, false, "an unresolved curated entry means the pack did not fully apply");
  assert.equal(body.missing.length, STARTER_PACK.length);
});

test("starter-pack POST with nothing resolvable applies nothing at all", async () => {
  const t = await mintSession();
  specs = [];
  await postStarter(t);
  assert.deepEqual(appliedSpecIds().flat(), []);
});

// ── 3: instance-slug validation ──────────────────────────────────────────────

for (const bad of ["Bad Slug", "UPPER", "with/slash", "a".repeat(64)]) {
  test(`apply rejects the invalid instance slug ${JSON.stringify(bad)} rather than routing to the default`, async () => {
    // A UI bug must not rewrite the WRONG Radarr/Sonarr instance.
    const t = await mintSession();
    const res = await postApply(t, { specIds: ["curated-0"], variant: bad });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "Invalid instance");
    assert.deepEqual(pgLockCalls, [], "an invalid slug must not reach the lock");
  });

  test(`status rejects the invalid instance slug ${JSON.stringify(bad)}`, async () => {
    const t = await mintSession();
    assert.equal((await getStatus(t, `?service=radarr&variant=${encodeURIComponent(bad)}`)).status, 400);
  });
}

test("the legacy 'hd' spelling maps to the default instance on every route that takes one", async () => {
  const t = await mintSession();
  specs = [spec({ id: "s1" })];
  assert.equal((await getStatus(t, "?service=radarr&variant=hd")).status, 200);
  assert.equal((await getSpec(t, "s1", "?variant=hd")).status, 200);
  assert.equal((await postApply(t, { specIds: [], variant: "hd" })).status, 200);
});

test("a named instance slug is accepted", async () => {
  const t = await mintSession();
  assert.equal((await getStatus(t, "?service=radarr&variant=anime")).status, 200);
  assert.equal((await postApply(t, { specIds: [], variant: "anime" })).status, 200);
});

test("apply trims surrounding whitespace from the variant before validating", async () => {
  const t = await mintSession();
  assert.equal((await postApply(t, { specIds: [], variant: "  4k  " })).status, 200);
});

// ── 4: the shared advisory lock ──────────────────────────────────────────────

for (const r of WRITE_ROUTES) {
  test(`${r.name} takes TRASH_SYNC_LOCK_ID — the same lock as the nightly cron`, async () => {
    const t = await mintSession();
    seedStarterPackSpecs();
    await r.call(t);
    assert.ok(
      pgLockCalls.some((c) => c.op === "try" && c.lockId === AL.TRASH_SYNC_LOCK_ID),
      `${r.name} never took the trash sync lock`,
    );
  });

  test(`${r.name} answers 409 with Retry-After when the lock is busy`, async () => {
    const t = await mintSession();
    lockAcquire = () => false;
    const res = await r.call(t);
    assert.equal(res.status, 409);
    assert.equal(res.headers.get("Retry-After"), "30");
    assert.equal((await res.json()).ok, false);
  });

  test(`${r.name} applies nothing when the lock is busy`, async () => {
    const t = await mintSession();
    seedStarterPackSpecs();
    lockAcquire = () => false;
    await r.call(t);
    assert.deepEqual(appliedSpecIds().flat(), [], `${r.name} wrote while the cron sync held the lock`);
  });

  test(`${r.name} releases the lock on the happy path`, async () => {
    const t = await mintSession();
    seedStarterPackSpecs();
    await r.call(t);
    const unlocks = pgLockCalls.filter((c) => c.op === "unlock" && c.lockId === AL.TRASH_SYNC_LOCK_ID);
    assert.equal(unlocks.length, 1, `${r.name} leaked the trash sync lock`);
  });
}

// ── 5: equal rate limits across the write routes ─────────────────────────────

for (const r of WRITE_ROUTES) {
  test(`${r.name} is rate-limited to 10 per window per admin`, async () => {
    // starter-pack POST performs the same class of arr writes as apply, so it
    // must not be a lighter-gated way to trigger the same burst.
    const t = await mintSession();
    seedStarterPackSpecs();
    for (let i = 0; i < 10; i++) {
      const res = await r.call(t);
      assert.notEqual(res.status, 429, `${r.name} call ${i + 1} should pass`);
    }
    assert.equal((await r.call(t)).status, 429);
  });

  test(`${r.name}'s rate limit is per admin`, async () => {
    const a = await mintSession();
    seedStarterPackSpecs();
    for (let i = 0; i < 11; i++) await r.call(a);
    assert.equal((await r.call(a)).status, 429);
    const b = await mintSession();
    assert.notEqual((await r.call(b)).status, 429);
  });
}

// ── apply: body validation ───────────────────────────────────────────────────

for (const [label, body] of [
  ["a missing specIds", {}],
  ["specIds as a string", { specIds: "curated-0" }],
  ["specIds containing a number", { specIds: ["a", 1] }],
  ["specIds containing null", { specIds: [null] }],
  ["specIds as an object", { specIds: {} }],
] as const) {
  test(`apply with ${label} is 400 and applies nothing`, async () => {
    const t = await mintSession();
    const res = await postApply(t, body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "specIds must be string[]");
    assert.deepEqual(pgLockCalls, []);
  });
}

test("apply with an empty specIds list is an accepted no-op that takes no lock", async () => {
  const t = await mintSession();
  const res = await postApply(t, { specIds: [] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, results: [] });
  assert.deepEqual(pgLockCalls, [], "an empty apply need not serialize against the cron");
});

test("apply caps the batch at 500 specs", async () => {
  const t = await mintSession();
  const res = await postApply(t, { specIds: Array.from({ length: 501 }, (_, i) => `s${i}`) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /batches of 500/);
  assert.deepEqual(pgLockCalls, []);
});

test("apply accepts exactly 500 specs", async () => {
  const t = await mintSession();
  const res = await postApply(t, { specIds: Array.from({ length: 500 }, (_, i) => `s${i}`) });
  assert.equal(res.status, 200);
});

test("apply rejects a malformed body with 400, and an oversized one with a cap (guardrail 30)", async () => {
  const t = await mintSession();
  assert.equal((await postApply(t, undefined, "{nope")).status, 400);
  const huge = JSON.stringify({ specIds: [`${"z".repeat(40_000)}`] });
  const res = await postApply(t, undefined, huge);
  assert.ok(res.status === 400 || res.status === 413);
});

test("apply audits the spec ids and the target instance", async () => {
  const t = await mintSession();
  specs = [spec({ id: "curated-0" })];
  await postApply(t, { specIds: ["curated-0"], variant: "4k" });
  const data = (opsOf("auditLog.create")[0].args as { data: { action: string; target: string; details: string } }).data;
  assert.equal(data.action, "SETTINGS_CHANGE");
  assert.equal(data.target, "trash:apply");
  const details = JSON.parse(data.details);
  assert.equal(details.variant, "4k");
  assert.deepEqual(details.specIds, ["curated-0"]);
});

// ── refresh: optional body, loud on malformed ────────────────────────────────

test("refresh accepts a missing body (the UI's 'refresh both' sends none)", async () => {
  const t = await mintSession();
  const res = await postRefresh(t);
  assert.notEqual(res.status, 400);
});

test("refresh rejects a MALFORMED body loudly rather than silently refreshing both", async () => {
  // A typo would otherwise fall through to "refresh both" without the operator
  // ever learning their request was ignored.
  const t = await mintSession();
  const res = await postRefresh(t, "{not json");
  assert.equal(res.status, 400);
});

for (const bad of ["plex", "RADARR", "", 1, null]) {
  test(`refresh rejects service ${JSON.stringify(bad)}`, async () => {
    const t = await mintSession();
    const res = await postRefresh(t, JSON.stringify({ service: bad }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /radarr.*sonarr/);
  });
}

test("refresh accepts an explicit single service", async () => {
  const t = await mintSession();
  for (const service of ["radarr", "sonarr"]) {
    const res = await postRefresh(t, JSON.stringify({ service }));
    assert.notEqual(res.status, 400, `service ${service} should be accepted`);
  }
});

test("refresh reports upstream failures without throwing", async () => {
  // GitHub is scripted to 503 throughout this file, so the catalog pull fails.
  const t = await mintSession();
  const res = await postRefresh(t);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.errors.length > 0);
});

test("refresh audits even when the upstream pull failed", async () => {
  const t = await mintSession();
  await postRefresh(t);
  const created = opsOf("auditLog.create");
  assert.equal(created.length, 1);
  assert.equal((created[0].args as { data: { target: string } }).data.target, "trash:refresh");
});

const isTreeFetch = (u: URL) => u.hostname === "api.github.com" && /\/git\/trees\/master/.test(u.pathname);

test("'refresh both' pulls the ~573 KB GitHub tree ONCE and shares it across both services", async () => {
  // The recursive tree is identical for RADARR and SONARR; the route used to
  // call refreshCatalog(service) with no prefetched tree, so the UI's default
  // bodiless POST fetched it back-to-back — 2x transfer and 2x against the
  // GitHub rate budget for one click. The cron already shared one tree.
  const t = await mintSession();
  const res = await postRefresh(t);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(fetchCalls.filter(isTreeFetch).length, 1);
  // A tree-fetch failure still fails EVERY requested service, one line each,
  // so the operator sees both services reported rather than a silent skip.
  assert.deepEqual(
    body.errors.map((e: string) => e.split(":")[0]),
    ["RADARR", "SONARR"],
  );
  for (const e of body.errors as string[]) assert.match(e, /GitHub tree fetch failed/);
});

test("an explicit single-service refresh fetches the tree once and reports one error", async () => {
  const t = await mintSession();
  const res = await postRefresh(t, JSON.stringify({ service: "radarr" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(fetchCalls.filter(isTreeFetch).length, 1);
  assert.deepEqual(body.errors.map((e: string) => e.split(":")[0]), ["RADARR"]);
});

// ── status / spec detail ─────────────────────────────────────────────────────

for (const bad of [undefined, "plex", "RADARR", ""]) {
  test(`status rejects service ${JSON.stringify(bad)}`, async () => {
    const t = await mintSession();
    const q = bad === undefined ? "" : `?service=${encodeURIComponent(bad)}`;
    const res = await getStatus(t, q);
    assert.equal(res.status, 400);
  });
}

test("status lists the catalog for the requested service", async () => {
  const t = await mintSession();
  specs = [spec({ id: "s1", service: "RADARR" }), spec({ id: "s2", service: "SONARR" })];
  const body = await (await getStatus(t, "?service=radarr")).json();
  assert.equal(body.service, "RADARR");
  assert.equal(body.variant, "");
  assert.ok(Array.isArray(body.specs));
});

test("spec detail 404s an unknown id", async () => {
  const t = await mintSession();
  assert.equal((await getSpec(t, "nope")).status, 404);
});

test("spec detail returns the row for a known id", async () => {
  const t = await mintSession();
  specs = [spec({ id: "s1", name: "HD Bluray + WEB" })];
  const res = await getSpec(t, "s1");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, "HD Bluray + WEB");
});

// ── 6: a missing schema degrades rather than 500ing ──────────────────────────

test("status turns a missing TrashSpec table into an actionable hint, not a 500", async () => {
  const t = await mintSession();
  specReadThrows = schemaError();
  const res = await getStatus(t);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.specs, []);
  assert.match(body.schemaDiagnostic, /prisma db push/);
});

test("starter-pack GET degrades the same way, still listing the curated entries", async () => {
  const t = await mintSession();
  specReadThrows = schemaError();
  const res = await getStarter(t);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.schemaDiagnostic, /prisma db push/);
  assert.equal(body.items.length, STARTER_PACK.length, "the curated list should still render");
  for (const i of body.items) assert.equal(i.spec, null);
});

test("starter-pack POST maps a missing schema to 409 with the hint, not a bare 500", async () => {
  const t = await mintSession();
  specReadThrows = schemaError();
  const res = await postStarter(t);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.schemaDiagnostic, /prisma db push/);
});

test("a NON-schema read failure is still a 500 rather than being disguised as a hint", async () => {
  const t = await mintSession();
  specReadThrows = new Error("connection terminated unexpectedly");
  const res = await getStatus(t);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.ok(!body.schemaDiagnostic, "a generic failure must not claim the schema is missing");
});
