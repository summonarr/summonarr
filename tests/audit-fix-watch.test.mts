// The admin nav's Download Queue badge stays fresh between full page loads
// (audit C004). App Router layouts do not re-render on client navigation, so
// the count the (app) layout rendered used to freeze for the whole session —
// a monitor run moved nothing, and a stopped monitor's count never aged out.
//
// What is pinned:
//   1. GET /api/admin/arr-watch answers an additive `navBadges` computed by the
//      SAME rule as the layout (arrWatchNavBadgesFor — no badge for a zero
//      count or a stale snapshot), `{}` for none; the settings card's fields
//      are unchanged; non-admins get nothing.
//   2. parseNavBadges: an object is the new truth (`{}` = none); anything else
//      (an older server, a garbled body) is null and keeps what is shown.
//   3. ONE NavBadgesProvider in the layout feeds both nav surfaces (they are
//      both mounted at every viewport, so a poll in each would read twice); its
//      fetch is inside an effect with an interval (guardrail 16 — nothing read
//      during render), and Sidebar/MobileNav read the hook, not a frozen prop.
//
// Harness: the real withAdmin-wrapped route, a genuine signed session JWT, a
// synthetic Next request scope and in-memory prisma (setting, authSession,
// user). No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "audit-fix-watch-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
delete process.env.ARR_WATCH_INTERVAL;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
console.warn = () => {};
console.error = () => {};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new Error(`unexpected fetch ${String(input)}`);
}) as typeof fetch;

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(HERE, rel), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

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
const { Permission } = await import("../src/lib/permissions.ts");

const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const keys = args.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
});
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
  const userId = `u-${seq}`;
  const sessionId = `sess-${seq}`;
  const role = opts.role ?? "ADMIN";
  const permissions = (opts.permissions ?? Permission.ADMIN).toString();
  sessionUsers.set(userId, {
    id: userId, name: `User ${seq}`, role, permissions: BigInt(permissions),
    mediaServer: null, sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: `u-${seq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/audit-fix-watch.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const reqHeaders = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

const route = await import("../src/app/api/admin/arr-watch/route.ts");
const { ARR_WATCH_SUMMARY_KEY, readArrWatchNavBadges, arrWatchNavBadgesFor } = await import("../src/lib/arr-watch-data.ts");
const { parseNavBadges, NAV_BADGE_POLL_MS } = await import("../src/lib/nav-badges.ts");

const COOKIE = getSessionCookieName();
const get = (token: string) =>
  inScope(() => route.GET(new NextRequest("http://localhost:3000/api/admin/arr-watch", { headers: { cookie: `${COOKIE}=${token}` } }), undefined));
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const summary = (atMs: number, attention: number) => JSON.stringify({ at: iso(atMs), attention, lowDisks: 1, failed24h: 2 });

beforeEach(() => {
  settings.clear();
});

// ── 1: the route ─────────────────────────────────────────────────────────────

test("GET answers navBadges by the layout's own rule — the count for a fresh snapshot, {} for a stale or empty one", async () => {
  const t = await mintSession();
  settings.set(ARR_WATCH_SUMMARY_KEY, summary(Date.now() - 5 * MIN, 3));
  let res = await get(t);
  assert.equal(res.status, 200);
  let body = (await res.json()) as { settings: unknown; summary: { attention: number } | null; navBadges: unknown };
  assert.deepEqual(body.navBadges, { "/admin/queue": 3 });
  assert.deepEqual(body.navBadges, await readArrWatchNavBadges(), "the route and the layout disagree about the badge");
  // Additive: the settings card's fields are still there.
  assert.deepEqual(body.settings, { diskLowPercent: 10 });
  assert.equal(body.summary?.attention, 3);

  // A monitor that stopped: the summary is still reported, the badge is not.
  settings.set(ARR_WATCH_SUMMARY_KEY, summary(Date.now() - 2 * 60 * MIN, 3));
  res = await get(t);
  body = (await res.json()) as typeof body;
  assert.deepEqual(body.navBadges, {}, "a stale snapshot kept its badge up");
  assert.equal(body.summary?.attention, 3);

  settings.set(ARR_WATCH_SUMMARY_KEY, summary(Date.now() - 5 * MIN, 0));
  assert.deepEqual(((await (await get(t)).json()) as typeof body).navBadges, {});
  settings.delete(ARR_WATCH_SUMMARY_KEY);
  assert.deepEqual(((await (await get(t)).json()) as typeof body).navBadges, {});
});

test("GET is ADMIN-only — a plain user gets no badge counts", async () => {
  const t = await mintSession({ role: "USER", permissions: 0n });
  settings.set(ARR_WATCH_SUMMARY_KEY, summary(Date.now() - 5 * MIN, 3));
  const res = await get(t);
  assert.equal(res.status, 403);
  assert.ok(!JSON.stringify(await res.json()).includes("/admin/queue"));
});

test("arrWatchNavBadgesFor is the one rule: three monitor intervals, at least an hour", () => {
  const now = Date.parse("2026-10-11T12:00:00.000Z");
  const s = { at: iso(now - 59 * MIN), attention: 2, lowDisks: 0, failed24h: 0 };
  assert.deepEqual(arrWatchNavBadgesFor(s, now), { "/admin/queue": 2 });
  assert.equal(arrWatchNavBadgesFor({ ...s, at: iso(now - 61 * MIN) }, now), undefined);
  assert.equal(arrWatchNavBadgesFor(null, now), undefined);
});

// ── 2: the client's parse ────────────────────────────────────────────────────

test("parseNavBadges: an object is the new truth ({} = none); anything else keeps what is shown", () => {
  assert.deepEqual(parseNavBadges({ "/admin/queue": 4 }), { "/admin/queue": 4 });
  assert.deepEqual(parseNavBadges({}), {});
  for (const junk of [undefined, null, "3", 3, [["/admin/queue", 3]]]) assert.equal(parseNavBadges(junk), null, JSON.stringify(junk));
  // Only whole positive counts under an admin href.
  assert.deepEqual(parseNavBadges({ "/admin/queue": 0, "/admin/x": -1, "/admin/y": 1.5, "/admin/z": "2", "/elsewhere": 3, "/admin/ok": 2 }), { "/admin/ok": 2 });
  assert.ok(NAV_BADGE_POLL_MS >= 60_000, "a badge poll faster than a minute is load for nothing — the monitor runs every 15 minutes");
});

// ── 3: one provider, both surfaces ───────────────────────────────────────────

test("ONE NavBadgesProvider in the layout wraps both nav surfaces; neither takes a frozen badge prop", () => {
  const layout = stripComments(src("../src/app/(app)/layout.tsx"));
  assert.equal(layout.match(/<NavBadgesProvider\b/g)?.length, 1, "one provider, not one per surface");
  const inner = /<NavBadgesProvider initial=\{navBadges\} enabled=\{isAdmin\}>([\s\S]*?)<\/NavBadgesProvider>/.exec(layout)?.[1] ?? "";
  assert.match(inner, /<Sidebar\b/);
  assert.match(inner, /<MobileNav\b/);
  assert.ok(!/<(Sidebar|MobileNav)\b[^>]*navBadges=/.test(layout), "a surface still gets the layout's frozen value as a prop");
  for (const rel of ["../src/components/layout/sidebar.tsx", "../src/components/layout/mobile-nav.tsx"]) {
    const code = stripComments(src(rel));
    assert.match(code, /const navBadges = useNavBadges\(\);/, `${rel} does not read the provider`);
    assert.ok(!/useEffect[\s\S]*?\/api\/admin\/arr-watch/.test(code) && !code.includes("/api/admin/arr-watch"), `${rel} polls on its own — a second request per tab`);
  }
});

test("the provider reads inside an effect, on an interval, skipped in a hidden tab — nothing during render (guardrail 16)", () => {
  const code = stripComments(src("../src/components/layout/admin-nav-groups.tsx"));
  const provider = /export function NavBadgesProvider\(([\s\S]*?)\n\}\n/.exec(code)?.[1] ?? "";
  assert.ok(provider, "NavBadgesProvider not found");
  const effect = /useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[enabled\]\);/.exec(provider)?.[1] ?? "";
  assert.ok(effect, "the poll is not an effect keyed on `enabled`");
  assert.match(effect, /if \(!enabled\) return;/, "a non-admin would poll an ADMIN route");
  assert.match(effect, /fetch\(withBasePath\("\/api\/admin\/arr-watch"\)/);
  assert.match(effect, /setInterval\([\s\S]*?document\.visibilityState === "hidden"[\s\S]*?NAV_BADGE_POLL_MS\)/);
  assert.match(effect, /clearInterval\(timer\)/);
  assert.match(effect, /removeEventListener\("visibilitychange", onVisibility\)/);
  // Outside the effect, the body is state and the context — no fetch, no clock.
  const render = provider.replace(effect, "");
  assert.ok(!/fetch\(|Date\.now\(|new Date\(/.test(render), "the provider reads or calls the clock during render");
  // A failed read keeps what is shown: no setBadges in the failure paths.
  assert.match(effect, /if \(!res\.ok\) return;/);
  assert.match(effect, /if \(!cancelled && next !== null\) setBadges\(/);
});
