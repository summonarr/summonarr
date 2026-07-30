// Route-level unit tests for GET /api/config/public — the user-readable slice of
// admin config that native clients use to render parity UI (site title, MOTD,
// donation links, feature flags, the iOS soft-upgrade hint).
//
// The route's whole risk profile is that it is an ALLOWLIST over the `Setting`
// table — the same table that holds every Radarr/Sonarr/Jellyfin API key, the
// webhook secrets and the Plex admin tokens. So the pins are:
//
//   1. THE ALLOWLIST IS THE BOUNDARY. The query must name its keys explicitly,
//      and not one of them may be a key `isSensitiveSettingKey` would encrypt.
//      That check is run against the ACTUAL key list the route sends to Prisma,
//      so adding a secret to PUBLIC_SETTING_KEYS fails here rather than shipping.
//      A blanket read (no `where`, or a `startsWith`) fails too.
//   2. DONATION VALUES ARE HREFS. They are admin-stored but rendered as <a href>
//      by native clients, so each is sanitized through safeExternalHref:
//      javascript:/data:/vbscript: must collapse to null, and so must a bare
//      handle like "@alice" (the native surface renders only the http(s) form).
//   3. recommendedIosBuild IS PRESENCE-KEYED. Clients ask "is there a
//      recommendation?" by testing whether the FIELD EXISTS, so a missing/
//      malformed/zero value must omit the key entirely rather than send null or
//      0 — either of which reads as a real recommendation to a `!= nil` check.
//   4. AUTH. withAuth (guardrail 6a): this is signed-in-only, and a 401 must not
//      carry a config body. It is deliberately NOT public — unlike
//      /api/config/compat, which is the pre-auth probe (guardrail 25).
//
// Harness: the tests/votes-route.test.mts idiom — the real withAuth-wrapped
// handler invoked with a NextRequest carrying a genuine signed session JWT,
// inside a synthetic workAsyncStorage + workUnitAsyncStorage scope, over an
// in-memory `setting` stub. The feature-flag cache is invalidated between tests
// so one case's flags can't leak into the next. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "config-public-route-secret-0123456789abc";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (() => {
  throw new Error("unexpected network call from config/public tests");
}) as unknown as typeof fetch;

console.warn = () => {};
console.error = () => {};

const cjsRequire = createRequire(import.meta.url);
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { isSensitiveSettingKey } = await import("../src/lib/settings-sensitive-keys.ts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// ── auth fixture ─────────────────────────────────────────────────────────────
const usersById = new Map<string, Record<string, unknown>>();
const sessionRows = new Set<string>();

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId)
      ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
      : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => usersById.get(args.where.id) ?? null,
  update: async () => ({}),
});

let seq = 0;
async function mintSession(): Promise<string> {
  seq++;
  const userId = `reader-${seq}`;
  const sessionId = `sess-${seq}`;
  usersById.set(userId, {
    role: "USER",
    permissions: 0n,
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: `reader-${seq}@example.com`,
    notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "USER", permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

const COOKIE = getSessionCookieName();

// ── settings stub ────────────────────────────────────────────────────────────
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    rec("setting.findUnique", args.where.key);
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } }) => {
    rec("setting.findMany", args.where);
    const keys = args.where?.key?.in;
    // A blanket read would be the leak this route's allowlist exists to prevent.
    assert.ok(Array.isArray(keys), "setting.findMany here must name an explicit key allowlist");
    return keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) }));
  },
});

const { GET } = await import("../src/app/api/config/public/route.ts");

// ── synthetic request scope ──────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/config-public.test",
    forceStatic: false,
    dynamicShouldError: false,
    afterContext: { after: () => {} },
  };
  const reqHeaders = new Headers();
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

async function get(token: string | null): Promise<Response> {
  const req = new NextRequest("http://localhost:3000/api/config/public", {
    method: "GET",
    headers: token ? { cookie: `${COOKIE}=${token}` } : {},
  });
  return inScope(() => GET(req, undefined));
}

async function body(): Promise<Record<string, never> & Record<string, unknown>> {
  const res = await get(await mintSession());
  assert.equal(res.status, 200);
  return res.json();
}

// Every key the route actually asked Prisma for, across both reads (the config
// allowlist and the feature-flag read).
function requestedKeys(): string[] {
  return opsOf("setting.findMany").flatMap((o) => (o.args as { key: { in: string[] } }).key.in);
}

beforeEach(() => {
  ops = [];
  settings.clear();
  invalidateFeatureFlagCache();
});

// ── auth ─────────────────────────────────────────────────────────────────────

test("an anonymous request is refused 401", async () => {
  assert.equal((await get(null)).status, 401);
});

test("a 401 carries no config body", async () => {
  settings.set("siteTitle", "Secret Instance Name");
  const res = await get(null);
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.ok(!text.includes("Secret Instance Name"));
});

test("a garbage session cookie is refused rather than served", async () => {
  assert.equal((await get("not-a-jwt")).status, 401);
});

test("a signed-in user is served 200", async () => {
  assert.equal((await get(await mintSession())).status, 200);
});

// ── the allowlist is the boundary ────────────────────────────────────────────

test("the settings read names an explicit key allowlist rather than scanning the table", async () => {
  await body();
  const reads = opsOf("setting.findMany");
  assert.ok(reads.length >= 1);
  for (const r of reads) {
    const where = r.args as { key?: { in?: string[] } };
    assert.ok(Array.isArray(where.key?.in), "every read must be an explicit `key: { in: [...] }`");
    assert.ok(where.key.in.length > 0);
  }
});

test("NOT ONE key this route reads is a sensitive (encrypted) setting", async () => {
  // The load-bearing test: adding an API key / webhook secret / admin token to
  // PUBLIC_SETTING_KEYS fails right here instead of shipping to every client.
  await body();
  const leaked = requestedKeys().filter((k) => isSensitiveSettingKey(k));
  assert.deepEqual(leaked, [], `these read keys are sensitive: ${leaked.join(", ")}`);
});

test("no key this route reads looks like a credential or a server URL", async () => {
  // Belt-and-braces over the isSensitiveSettingKey check: a key that the
  // sensitive-key matcher doesn't yet know about but which is obviously secret
  // or infrastructural should still not be here.
  await body();
  const suspicious = requestedKeys().filter((k) => /token|secret|apikey|password|url|adminemail/i.test(k));
  assert.deepEqual(suspicious, [], `suspicious keys in the public read: ${suspicious.join(", ")}`);
});

test("a secret sitting in the Setting table is never echoed back", async () => {
  settings.set("radarrApiKey", "super-secret-radarr-key");
  settings.set("jellyfinApiKey", "super-secret-jellyfin-key");
  settings.set("plexAdminToken", "super-secret-plex-token");
  settings.set("siteTitle", "Home Media");
  const text = JSON.stringify(await body());
  for (const secret of ["super-secret-radarr-key", "super-secret-jellyfin-key", "super-secret-plex-token"]) {
    assert.ok(!text.includes(secret), `${secret} leaked into the public config`);
  }
  assert.ok(text.includes("Home Media"));
});

test("the response shape is exactly the documented surface — no extra top-level keys", async () => {
  const keys = Object.keys(await body()).sort();
  assert.deepEqual(keys, ["donate", "features", "motd", "siteTitle"]);
});

// ── siteTitle + MOTD ─────────────────────────────────────────────────────────

test("an unset siteTitle is null rather than absent or empty", async () => {
  assert.equal((await body()).siteTitle, null);
});

test("a set siteTitle is passed through", async () => {
  settings.set("siteTitle", "Chris's Media");
  assert.equal((await body()).siteTitle, "Chris's Media");
});

test("the MOTD is disabled by default with null title and body", async () => {
  assert.deepEqual((await body()).motd, { enabled: false, title: null, body: null });
});

test("motdEnabled is a strict `true` string comparison, not truthiness", async () => {
  // A hand-edited "1"/"yes"/"TRUE" must not silently enable the banner.
  for (const v of ["1", "yes", "TRUE", "True", " true", "on"]) {
    settings.set("motdEnabled", v);
    invalidateFeatureFlagCache();
    assert.equal(((await body()).motd as { enabled: boolean }).enabled, false, `"${v}" must not enable the MOTD`);
    ops = [];
  }
  settings.set("motdEnabled", "true");
  assert.equal(((await body()).motd as { enabled: boolean }).enabled, true);
});

test("MOTD title and body are carried through when set", async () => {
  settings.set("motdEnabled", "true");
  settings.set("motdTitle", "Maintenance");
  settings.set("motdBody", "Back at 5pm.");
  assert.deepEqual((await body()).motd, { enabled: true, title: "Maintenance", body: "Back at 5pm." });
});

// ── donation hrefs ───────────────────────────────────────────────────────────

test("unset donation links are all null, and every provider key is present", async () => {
  const donate = (await body()).donate as Record<string, unknown>;
  assert.deepEqual(Object.keys(donate).sort(), [
    "amazon", "buyMeACoffee", "patreon", "paypal", "venmo", "zelle",
  ]);
  for (const [k, v] of Object.entries(donate)) assert.equal(v, null, `${k} should be null when unset`);
});

test("http and https donation URLs pass through unchanged", async () => {
  settings.set("donationPaypal", "https://paypal.me/alice");
  settings.set("donationPatreon", "http://patreon.com/alice");
  const donate = (await body()).donate as Record<string, unknown>;
  assert.equal(donate.paypal, "https://paypal.me/alice");
  assert.equal(donate.patreon, "http://patreon.com/alice");
});

for (const [label, url] of [
  ["javascript:", "javascript:alert(document.cookie)"],
  ["data:", "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="],
  ["vbscript:", "vbscript:msgbox(1)"],
  ["file:", "file:///etc/passwd"],
  ["a custom app scheme", "summonarr://steal"],
] as const) {
  test(`a ${label} donation value collapses to null and never reaches a client href`, async () => {
    settings.set("donationPaypal", url);
    assert.equal(((await body()).donate as Record<string, unknown>).paypal, null);
  });
}

test("a bare handle is not a URL and collapses to null", async () => {
  settings.set("donationVenmo", "@alice");
  settings.set("donationZelle", "alice@example.com");
  const donate = (await body()).donate as Record<string, unknown>;
  assert.equal(donate.venmo, null);
  assert.equal(donate.zelle, null);
});

test("a protocol-relative URL is rejected rather than resolved against the client's origin", async () => {
  settings.set("donationAmazon", "//evil.example.com/wishlist");
  assert.equal(((await body()).donate as Record<string, unknown>).amazon, null);
});

test("a relative path is rejected", async () => {
  settings.set("donationBuyMeACoffee", "/donate");
  assert.equal(((await body()).donate as Record<string, unknown>).buyMeACoffee, null);
});

test("one poisoned donation value does not take down the others", async () => {
  settings.set("donationPaypal", "javascript:alert(1)");
  settings.set("donationVenmo", "https://venmo.com/alice");
  const donate = (await body()).donate as Record<string, unknown>;
  assert.equal(donate.paypal, null);
  assert.equal(donate.venmo, "https://venmo.com/alice");
});

// ── recommendedIosBuild is presence-keyed ────────────────────────────────────

test("an unset recommendedIosBuild omits the field entirely", async () => {
  // Clients test for the FIELD's existence, so a null/0 would read as a real
  // recommendation to a `!= nil` check.
  const b = await body();
  assert.ok(!("recommendedIosBuild" in b));
});

test("a valid positive integer is exposed as a number", async () => {
  settings.set("recommendedIosBuild", "42");
  const b = await body();
  assert.equal(b.recommendedIosBuild, 42);
  assert.equal(typeof b.recommendedIosBuild, "number");
});

for (const [label, raw] of [
  ["zero", "0"],
  ["a negative", "-3"],
  ["a float", "1.5"],
  ["non-numeric", "latest"],
  ["an empty string", ""],
  ["whitespace", "  "],
  ["a numeric string with a suffix", "42beta"],
  ["a leading plus", "+42"],
] as const) {
  test(`${label} recommendedIosBuild omits the field rather than sending a junk value`, async () => {
    settings.set("recommendedIosBuild", raw);
    assert.ok(!("recommendedIosBuild" in (await body())));
  });
}

test("build 1 is a valid recommendation — the floor is >= 1, not > 1", async () => {
  settings.set("recommendedIosBuild", "1");
  assert.equal((await body()).recommendedIosBuild, 1);
});

test("a large build number survives without precision loss", async () => {
  settings.set("recommendedIosBuild", "999999");
  assert.equal((await body()).recommendedIosBuild, 999999);
});

// ── feature flags ────────────────────────────────────────────────────────────

test("the response carries the feature-flag map native clients gate nav on", async () => {
  const features = (await body()).features as Record<string, unknown>;
  assert.equal(typeof features, "object");
  assert.ok(features !== null);
  assert.ok(Object.keys(features).length > 0, "an empty flag map would hide every gated page");
});

test("every feature-flag value is a boolean", async () => {
  for (const [k, v] of Object.entries((await body()).features as Record<string, unknown>)) {
    assert.equal(typeof v, "boolean", `feature ${k} is ${typeof v}, not boolean`);
  }
});

test("the feature-flag read is a separate allowlisted query, not folded into the config read", async () => {
  await body();
  assert.ok(opsOf("setting.findMany").length >= 2, "expected a config read and a feature-flag read");
});
