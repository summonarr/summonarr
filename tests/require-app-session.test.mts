// Behavioural tests for src/lib/require-app-session.ts — the DB-checked login
// gate on every (app) server-component page.
//
// tests/app-page-auth-guard.test.mts already pins this guardrail STRUCTURALLY:
// it walks the (app) tree and asserts every page.tsx calls a DB-checked read and
// none imports the JWT-only `auth`. That catches the failure mode that matters
// most (adding a page and forgetting the gate), but it never RUNS the guard — so
// nothing yet proved the guard actually refuses anything. These tests execute it.
//
// The distinction is the whole point of guardrail 29, so it is worth stating
// plainly. `auth()` verifies a JWT's signature and expiry and nothing else. It
// cannot see:
//   - a deleted AuthSession row (the user revoked that device)
//   - a sessionsRevokedAt cutoff (they revoked ALL devices, or changed password)
//   - a deactivatedAt flag (the account was disabled — guardrail 33)
//   - a role demotion (an ex-admin's unexpired token still claims ADMIN)
// requireAppSession goes through authActive(), which reconciles all four against
// the database. Every one of those is a separate test below, because each is a
// distinct row/column and a refactor can drop one without touching the others.
//
// Two structural properties are pinned as hard as the auth ones:
//   1. IT THROWS, IT DOES NOT RETURN. redirect() raises NEXT_REDIRECT, so an
//      unauthenticated render ABORTS. Were it ever changed to return null, every
//      caller — which all do `const session = await requireAppSession()` and then
//      read session.user — would render the page with an undefined session
//      rather than redirect, and TypeScript would not complain, because the
//      declared return type is non-nullable either way.
//   2. THE ROLE COMES BACK REFRESHED FROM THE DB, not from the token. Pages make
//      their own role decisions on the returned value, so a stale role here
//      would hand a demoted admin the admin pages the layout was skipped for.
//
// Harness: real requireAppSession, genuine signed session JWTs, a synthetic Next
// request scope carrying the cookie and User-Agent, in-memory prisma stubs. The
// prisma stub deliberately defines only findUnique/update, matching the shape
// tests/session-refresh.test.mts established (guardrail 35 names that stub shape
// as a harness contract). No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "require-app-session-secret-0123456789abc";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (async () => {
  throw new Error("unit-test: no network on this path");
}) as unknown as typeof fetch;

const cjsRequire = createRequire(import.meta.url);
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { extractUaFingerprint, serializeFingerprint } = await import("../src/lib/ua-fingerprint.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { requireAppSession } = await import("../src/lib/require-app-session.ts");

// ── in-memory DB ─────────────────────────────────────────────────────────────
type DbUser = {
  role: string;
  permissions: bigint;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  email: string | null;
  notificationEmail: string | null;
};
const usersById = new Map<string, DbUser>();
const sessionRows = new Set<string>();

shadowPrismaModel(prisma, "authSession", {
  // createdAt is the row's birth; nothing time-based keys off it any more (the
  // former ADMIN 7-day ceiling did — guardrail 6c removed it), but keep it a
  // real Date so the row shape stays faithful to production.
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId)
      ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId, createdAt: new Date() }
      : null,
  // A privilege change ROTATES the sessionId in place. Modelled for real rather
  // than no-opped: the rotation runs in a transaction whose failure makes the
  // whole verify return null, so a no-op stub turns every role-change test into
  // a redirect and reads as a source bug.
  update: async (args: { where: { sessionId: string }; data: { sessionId?: string } }) => {
    if (args.data.sessionId && sessionRows.delete(args.where.sessionId)) {
      sessionRows.add(args.data.sessionId);
    }
    return {};
  },
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async (args: { where: { id: string }; data: { sessionsRevokedAt?: Date } }) => {
    const u = usersById.get(args.where.id);
    if (u && args.data.sessionsRevokedAt) u.sessionsRevokedAt = args.data.sessionsRevokedAt;
    return {};
  },
});
// The rotation's interactive transaction — run the callback against the same
// in-memory models, the established idiom for these suites.
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => {
  if (Array.isArray(arg)) return Promise.all(arg);
  return (arg as (tx: unknown) => Promise<unknown>)(prisma);
});

// ── fixtures ─────────────────────────────────────────────────────────────────
const COOKIE = getSessionCookieName();
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const OTHER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const fpFor = (ua: string) => serializeFingerprint(extractUaFingerprint(ua));

let seq = 0;
type MintOpts = {
  role?: string;
  permissions?: bigint;
  expiresInSeconds?: number;
  iat?: number;
  uaFingerprint?: string | null;
};
async function mint(opts: MintOpts = {}): Promise<{ userId: string; sessionId: string; token: string }> {
  seq++;
  const userId = `person-${seq}`;
  const sessionId = `sess-${seq}`;
  const role = opts.role ?? "USER";
  const permissions = opts.permissions ?? 0n;
  usersById.set(userId, {
    role,
    permissions,
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: `person-${seq}@example.com`,
    notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    {
      id: userId,
      role,
      permissions: permissions.toString(),
      provider: "credentials",
      sessionId,
      expiresAt: iat + 86_400,
      ...(opts.uaFingerprint === null ? {} : { uaFingerprint: opts.uaFingerprint ?? fpFor(UA) }),
    },
    { expiresInSeconds: opts.expiresInSeconds ?? 7_200, iat },
  );
  return { userId, sessionId, token };
}

function inScope<T>(fn: () => Promise<T>, opts: { cookie?: string; ua?: string } = {}): Promise<T> {
  const h = new Headers();
  if (opts.cookie !== undefined) h.set("cookie", opts.cookie);
  h.set("user-agent", opts.ua ?? UA);
  const workStore = { route: "/require-app-session.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(h),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

const call = (token?: string, ua?: string) =>
  inScope(() => requireAppSession(), { cookie: token ? `${COOKIE}=${token}` : undefined, ua });

// Resolve the guard to one of three outcomes. Distinguishing "redirected" from
// "threw something else" matters: a raw error is an error boundary / 500, not a
// login redirect, and only NEXT_REDIRECT actually sends the user to sign in.
type Outcome =
  | { kind: "session"; session: { user: { id: string; role: string; permissions: bigint } } }
  | { kind: "redirect"; to: string }
  | { kind: "threw"; error: unknown };

async function outcome(token?: string, ua?: string): Promise<Outcome> {
  try {
    const session = await call(token, ua);
    return { kind: "session", session: session as Outcome extends never ? never : { user: { id: string; role: string; permissions: bigint } } };
  } catch (err) {
    const digest = (err as { digest?: unknown })?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      // digest form: NEXT_REDIRECT;replace;/login;307;
      return { kind: "redirect", to: digest.split(";")[2] ?? "" };
    }
    return { kind: "threw", error: err };
  }
}

beforeEach(() => {
  usersById.clear();
  sessionRows.clear();
});

// ── the happy path ───────────────────────────────────────────────────────────

test("a live session is returned", async () => {
  const { token, userId } = await mint();
  const res = await outcome(token);
  assert.equal(res.kind, "session");
  assert.equal(res.kind === "session" && res.session.user.id, userId);
});

test("the returned session carries what a page needs for personalization, so callers need no second read", async () => {
  const { token, userId } = await mint({ role: "ADMIN", permissions: Permission.ADMIN });
  const res = await outcome(token);
  assert.equal(res.kind, "session");
  if (res.kind !== "session") return;
  assert.equal(res.session.user.id, userId);
  assert.equal(res.session.user.role, "ADMIN");
  assert.equal(res.session.user.permissions, Permission.ADMIN);
});

// ── it redirects, and it THROWS to do it ─────────────────────────────────────

test("no cookie redirects to /login", async () => {
  const res = await outcome(undefined);
  assert.equal(res.kind, "redirect");
  assert.equal(res.kind === "redirect" && res.to, "/login");
});

test("the redirect is a THROW, never a returned null — a returning guard would render the page signed-out", async () => {
  let returned: unknown;
  try {
    returned = await call(undefined);
  } catch {
    returned = Symbol("threw");
  }
  assert.equal(typeof returned, "symbol");
  assert.equal(String(returned), "Symbol(threw)");
});

test("the redirect target is exactly /login — not an absolute URL a caller could be walked off-site with", async () => {
  const res = await outcome(undefined);
  assert.equal(res.kind === "redirect" && res.to, "/login");
});

test("a garbage cookie redirects rather than surfacing a raw error", async () => {
  const res = await outcome("not-a-jwt-at-all");
  assert.equal(res.kind, "redirect", "a malformed token produced an error boundary instead of a login redirect");
});

test("a token signed with the wrong secret redirects", async () => {
  const { token } = await mint();
  const tampered = `${token.slice(0, -6)}AAAAAA`;
  const res = await outcome(tampered);
  assert.equal(res.kind, "redirect");
});

test("an expired token redirects", async () => {
  const iat = Math.floor(Date.now() / 1000) - 10_000;
  const { token } = await mint({ iat, expiresInSeconds: 60 });
  const res = await outcome(token);
  assert.equal(res.kind, "redirect");
});

// ── the four things a JWT-only check cannot see (guardrail 29) ───────────────

test("a REVOKED DEVICE redirects — the AuthSession row is gone though the JWT is still valid", async () => {
  const { token, sessionId } = await mint();
  assert.equal((await outcome(token)).kind, "session", "precondition: the session was live");
  sessionRows.delete(sessionId);
  const res = await outcome(token);
  assert.equal(res.kind, "redirect", "a revoked device kept access — this is the JWT-only failure mode");
});

test("a sessionsRevokedAt cutoff redirects — 'sign out everywhere' takes effect immediately", async () => {
  const { token, userId } = await mint();
  usersById.get(userId)!.sessionsRevokedAt = new Date(Date.now() + 60_000);
  const res = await outcome(token);
  assert.equal(res.kind, "redirect");
});

test("a passwordChangedAt cutoff redirects — a password change invalidates tokens minted before it", async () => {
  const { token, userId } = await mint();
  usersById.get(userId)!.passwordChangedAt = new Date(Date.now() + 60_000);
  const res = await outcome(token);
  assert.equal(res.kind, "redirect");
});

test("a DEACTIVATED account redirects, even inside a still-valid JWT window (guardrail 33)", async () => {
  const { token, userId } = await mint();
  usersById.get(userId)!.deactivatedAt = new Date();
  const res = await outcome(token);
  assert.equal(res.kind, "redirect");
});

test("a deleted user row redirects", async () => {
  const { token, userId } = await mint();
  usersById.delete(userId);
  const res = await outcome(token);
  assert.equal(res.kind, "redirect");
});

test("a ROLE DEMOTION is reflected in the returned session, not read from the token", async () => {
  // The payoff of the DB check: pages make their own role decisions on this
  // value, so a token still claiming ADMIN must come back as USER.
  const { token, userId } = await mint({ role: "ADMIN", permissions: Permission.ADMIN });
  usersById.get(userId)!.role = "USER";
  usersById.get(userId)!.permissions = 0n;
  const res = await outcome(token);
  assert.equal(res.kind, "session");
  if (res.kind !== "session") return;
  assert.equal(res.session.user.role, "USER", "the demoted admin's page render still saw ADMIN");
  assert.equal(res.session.user.permissions & Permission.ADMIN, 0n);
});

test("a PROMOTION is picked up too — the refresh is not one-directional", async () => {
  const { token, userId } = await mint({ role: "USER" });
  usersById.get(userId)!.role = "ADMIN";
  usersById.get(userId)!.permissions = Permission.ADMIN;
  const res = await outcome(token);
  assert.equal(res.kind === "session" && res.session.user.role, "ADMIN");
});

// ── the UA-fingerprint binding (cookie sessions only) ────────────────────────

test("a cookie replayed from a DIFFERENT device redirects", async () => {
  // Page renders are cookie/SSR only, and the proxy's matcher skips prefetch
  // requests — so this path is one of the few places the cookie→device binding
  // is enforced at all.
  const { token } = await mint({ uaFingerprint: fpFor(UA) });
  assert.equal((await outcome(token, UA)).kind, "session", "precondition: the original device works");
  const res = await outcome(token, OTHER_UA);
  assert.equal(res.kind, "redirect", "a stolen cookie rendered a page from another device");
});

test("a token with NO stored fingerprint is not blocked — older tokens keep working", async () => {
  const { token } = await mint({ uaFingerprint: null });
  const res = await outcome(token, OTHER_UA);
  assert.equal(res.kind, "session");
});

test("a machine: fingerprint skips the UA binding by design", async () => {
  const { token } = await mint({ uaFingerprint: "machine:ci-runner" });
  const res = await outcome(token, OTHER_UA);
  assert.equal(res.kind, "session");
});
