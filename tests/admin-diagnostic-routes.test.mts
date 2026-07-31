// Route-level unit tests for two uncovered admin diagnostics:
//   GET /api/admin/debug/history-link
//   GET /api/admin/library-sample-paths
//
// history-link is the operator's answer to "why does this account see no watch
// history?", and it is the documented first stop for that question — so its own
// verdicts have to be right, or it sends the operator hunting the wrong layer.
// It reports, per candidate MediaServerUser row, which of the TWO matchers in
// resolveLinkedMediaServerUserIds would fire (guardrail 34):
//
//   matchesFk       — MediaServerUser.userId == the account
//   matchesSubject  — (source, sourceUserId) == the account's own
//                     User.plexUserId / jellyfinUserId
//
// The pins that matter:
//   1. visibleToUser is exactly `matchesFk || matchesSubject`, and NOT influenced
//      by email. Email is shown as `emailWouldRelink` because it IS the key
//      automatic linking uses at INGEST — but it is not a read-path matcher, and
//      conflating the two would tell an operator the history is visible when it
//      is not.
//   2. The subject matcher is SOURCE-SCOPED. A Jellyfin row whose sourceUserId
//      happens to equal the account's plexUserId must not match.
//   3. orphanedWithHistory is the actionable output: rows holding history the
//      account cannot see. A row with no history is not an orphan worth flagging.
//   4. A local-credentials / OIDC account has NO provider subject, so matcher 2
//      can never fire for it — the FK is its only route, and the dump says so.
//   5. The purged-tombstone flag uses isPurgedRow, not a bare `purgedAt != null`
//      — rows scrubbed before that column existed carry only the tombstone email
//      shape. Looking one up is the classic wrong turn, so the dump must label it.
//   6. allServerIdentities appears ONLY when nothing matched (otherwise noise),
//      and is bounded.
//   7. Read-only: the whole route must issue no writes.
//
// library-sample-paths backs the strip-prefix editor. Its pin is guardrail 35:
// the query is scoped to the DEFAULT server instance, because mixing instances
// hands commonPathPrefix two unrelated bind-mount roots, collapses the inferred
// mount to "", and then shows the admin full absolute paths as if that were the
// default server's mount while they type a prefix against it. Its pure helpers
// (longest common directory prefix, evenly-spaced sampling, show-folder dedup)
// are exercised through the route.
//
// Harness: real withAdmin-wrapped handlers, genuine signed session JWTs, a
// synthetic Next request scope, in-memory prisma stubs. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "admin-diagnostics-secret-0123456789abcd";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (() => { throw new Error("unexpected network call"); }) as unknown as typeof fetch;
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
const { Permission } = await import("../src/lib/permissions.ts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);
const writeOps = () => ops.filter((o) => /(create|update|upsert|delete)/i.test(o.op));

// ── auth fixture ─────────────────────────────────────────────────────────────
const sessionUsers = new Map<string, Record<string, unknown>>();
const sessionRows = new Set<string>();
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
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
    plexUserId: null, jellyfinUserId: null, purgedAt: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

// ── app users (the lookup target) ────────────────────────────────────────────
type Target = {
  id: string; email: string | null; name: string | null;
  plexUserId: string | null; jellyfinUserId: string | null;
  deactivatedAt: Date | null; purgedAt: Date | null;
};
let targets: Target[] = [];

shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id?: string; email?: string } }) => {
    // Session resolution comes through here too.
    if (args.where.id && sessionUsers.has(args.where.id)) return sessionUsers.get(args.where.id);
    rec("user.findUnique", args.where);
    if (args.where.id) return targets.find((u) => u.id === args.where.id) ?? null;
    if (args.where.email) return targets.find((u) => u.email === args.where.email) ?? null;
    return null;
  },
  update: async () => ({}),
});

// ── MediaServerUser ──────────────────────────────────────────────────────────
type Msu = {
  id: string; source: string; sourceUserId: string; username: string;
  email: string | null; userId: string | null; manualUserLink: boolean;
  active: boolean; isServerAdmin: boolean; historyRows: number;
};
let msus: Msu[] = [];

shadowPrismaModel(prisma, "mediaServerUser", {
  findMany: async (args: { where?: { OR?: Record<string, unknown>[] }; take?: number }) => {
    rec("mediaServerUser.findMany", { where: args.where, take: args.take });
    const or = args.where?.OR;
    const rows = or
      ? msus.filter((m) =>
          or.some((c) => {
            if ("userId" in c) return m.userId === c.userId;
            if ("email" in c) return m.email === c.email;
            return m.source === c.source && m.sourceUserId === c.sourceUserId;
          }),
        )
      : msus;
    const out = rows.map((m) => ({ ...m, _count: { playHistory: m.historyRows } }));
    return args.take != null ? out.slice(0, args.take) : out;
  },
});

// ── library items (for library-sample-paths) ─────────────────────────────────
type LibItem = { serverInstance: string; mediaType: string; filePath: string | null };
let plexItems: LibItem[] = [];
let jellyfinItems: LibItem[] = [];

function libStub(name: string, rows: () => LibItem[]) {
  return {
    findMany: async (args: { where: { serverInstance: string; mediaType: string; filePath?: unknown }; take?: number }) => {
      rec(`${name}.findMany`, args.where);
      const out = rows().filter(
        (r) => r.serverInstance === args.where.serverInstance && r.mediaType === args.where.mediaType && r.filePath != null,
      );
      return (args.take != null ? out.slice(0, args.take) : out).map((r) => ({ filePath: r.filePath }));
    },
  };
}
shadowPrismaModel(prisma, "plexLibraryItem", libStub("plexLibraryItem", () => plexItems));
shadowPrismaModel(prisma, "jellyfinLibraryItem", libStub("jellyfinLibraryItem", () => jellyfinItems));
shadowPrismaModel(prisma, "setting", { findUnique: async () => null, findMany: async () => [] });

const historyLink = await import("../src/app/api/admin/debug/history-link/route.ts");
const samplePaths = await import("../src/app/api/admin/library-sample-paths/route.ts");

// ── scope ────────────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/admin-diagnostics.test", forceStatic: false, dynamicShouldError: false,
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
function mk(path: string, token: string | null, query = "") {
  return new NextRequest(`http://localhost:3000${path}${query}`, {
    method: "GET",
    headers: token ? { cookie: `${COOKIE}=${token}` } : {},
  });
}
const link = (t: string | null, q: string) => inScope(() => historyLink.GET(mk("/api/admin/debug/history-link", t, q), undefined));
const paths = (t: string | null) => inScope(() => samplePaths.GET(mk("/api/admin/library-sample-paths", t), undefined));

function target(over: Partial<Target> & { id: string }): Target {
  return {
    email: null, name: null, plexUserId: null, jellyfinUserId: null,
    deactivatedAt: null, purgedAt: null, ...over,
  };
}
function msu(over: Partial<Msu> & { id: string }): Msu {
  return {
    source: "plex", sourceUserId: `src-${over.id}`, username: `user-${over.id}`,
    email: null, userId: null, manualUserLink: false, active: true,
    isServerAdmin: false, historyRows: 0, ...over,
  };
}

beforeEach(() => {
  ops = [];
  targets = [];
  msus = [];
  plexItems = [];
  jellyfinItems = [];
});

// ── gating + read-only ───────────────────────────────────────────────────────

test("both diagnostics refuse anonymous with 401", async () => {
  assert.equal((await link(null, "?userId=u1")).status, 401);
  assert.equal((await paths(null)).status, 401);
});

test("a plain USER is 403 on both", async () => {
  const t = await mintSession({ role: "USER", permissions: 0n });
  assert.equal((await link(t, "?userId=u1")).status, 403);
  assert.equal((await paths(t)).status, 403);
});

test("history-link is READ-ONLY — it issues no writes", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1", email: "u1@example.com" })];
  msus = [msu({ id: "m1", userId: "u1", historyRows: 5 })];
  await link(t, "?userId=u1");
  assert.deepEqual(writeOps(), [], "the diagnostic must not mutate anything");
});

test("history-link requires a userId or email", async () => {
  const t = await mintSession();
  const res = await link(t, "");
  assert.equal(res.status, 400);
  assert.equal(opsOf("user.findUnique").length, 0);
});

test("history-link 404s an unknown account", async () => {
  const t = await mintSession();
  assert.equal((await link(t, "?userId=nope")).status, 404);
  assert.equal((await link(t, "?email=nobody@example.com")).status, 404);
});

test("history-link accepts a lookup by email, normalized", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1", email: "person@example.com" })];
  const res = await link(t, "?email=%20Person%40Example.COM%20");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.id, "u1");
});

// ── 1 + 2: the two matchers ──────────────────────────────────────────────────

test("an FK-linked row is visible", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1" })];
  msus = [msu({ id: "m1", userId: "u1", historyRows: 3 })];
  const body = await (await link(t, "?userId=u1")).json();
  const row = body.candidates[0];
  assert.equal(row.matchesFk, true);
  assert.equal(row.matchesSubject, false);
  assert.equal(row.visibleToUser, true);
  assert.deepEqual(body.resolvedMediaServerUserIds, ["m1"]);
  assert.equal(body.visibleHistoryRows, 3);
});

test("a provider-subject match is visible even with no FK", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1", plexUserId: "plex-77" })];
  msus = [msu({ id: "m1", source: "plex", sourceUserId: "plex-77", userId: null, historyRows: 4 })];
  const row = (await (await link(t, "?userId=u1")).json()).candidates[0];
  assert.equal(row.matchesFk, false);
  assert.equal(row.matchesSubject, true);
  assert.equal(row.visibleToUser, true);
});

test("the subject matcher is SOURCE-scoped — a Jellyfin row with the Plex id does not match", async () => {
  // The row only becomes a CANDIDATE via the email key here; source-scoping is
  // then enforced again in the verdict. (The candidate query pairs
  // source+sourceUserId too, so a row like this is normally not even selected —
  // this exercises the verdict half.)
  const t = await mintSession();
  targets = [target({ id: "u1", email: "p@example.com", plexUserId: "shared-id" })];
  msus = [msu({ id: "m1", source: "jellyfin", sourceUserId: "shared-id", email: "p@example.com", userId: null, historyRows: 2 })];
  const body = await (await link(t, "?userId=u1")).json();
  const row = body.candidates.find((r: { id: string }) => r.id === "m1");
  assert.ok(row, "the row should be a candidate via its email");
  assert.equal(row.matchesSubject, false, "a jellyfin row must not match a plexUserId");
  assert.equal(row.visibleToUser, false);
});

test("the candidate QUERY itself pairs source with sourceUserId", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1", plexUserId: "plex-1", jellyfinUserId: "jf-1" })];
  await link(t, "?userId=u1");
  const or = (opsOf("mediaServerUser.findMany")[0].args as { where: { OR: Record<string, unknown>[] } }).where.OR;
  const subjectClauses = or.filter((c) => "sourceUserId" in c);
  assert.equal(subjectClauses.length, 2);
  for (const c of subjectClauses) {
    assert.ok("source" in c, "a subject clause must be source-scoped");
  }
});

test("an EMAIL match alone is NOT visible — email is an ingest key, not a read matcher", async () => {
  // Conflating the two would tell an operator the history is visible when the
  // read path cannot see it at all.
  const t = await mintSession();
  targets = [target({ id: "u1", email: "person@example.com" })];
  msus = [msu({ id: "m1", email: "person@example.com", userId: null, historyRows: 9 })];
  const body = await (await link(t, "?userId=u1")).json();
  const row = body.candidates.find((r: { id: string }) => r.id === "m1");
  assert.equal(row.matchesFk, false);
  assert.equal(row.matchesSubject, false);
  assert.equal(row.visibleToUser, false);
  assert.equal(row.emailWouldRelink, true, "but it IS flagged as the key that would heal the FK at ingest");
  assert.deepEqual(body.resolvedMediaServerUserIds, []);
});

test("visibleToUser is exactly matchesFk || matchesSubject for every candidate", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1", email: "p@example.com", plexUserId: "plex-1", jellyfinUserId: "jf-1" })];
  msus = [
    msu({ id: "fk", userId: "u1" }),
    msu({ id: "subj-plex", source: "plex", sourceUserId: "plex-1" }),
    msu({ id: "subj-jf", source: "jellyfin", sourceUserId: "jf-1" }),
    msu({ id: "email-only", email: "p@example.com" }),
  ];
  const body = await (await link(t, "?userId=u1")).json();
  for (const r of body.candidates) {
    assert.equal(r.visibleToUser, r.matchesFk || r.matchesSubject, `row ${r.id} disagrees`);
  }
  assert.deepEqual([...body.resolvedMediaServerUserIds].sort(), ["fk", "subj-jf", "subj-plex"]);
});

// ── 3: orphanedWithHistory ───────────────────────────────────────────────────

test("a row holding history the account cannot see is reported as an orphan", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1", email: "p@example.com" })];
  msus = [msu({ id: "orphan", email: "p@example.com", userId: null, historyRows: 42 })];
  const body = await (await link(t, "?userId=u1")).json();
  assert.equal(body.orphanedWithHistory.length, 1);
  assert.equal(body.orphanedWithHistory[0].mediaServerUserId, "orphan");
  assert.equal(body.orphanedWithHistory[0].playHistoryRows, 42);
});

test("an invisible row with NO history is not flagged as an orphan", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1", email: "p@example.com" })];
  msus = [msu({ id: "empty", email: "p@example.com", userId: null, historyRows: 0 })];
  const body = await (await link(t, "?userId=u1")).json();
  assert.deepEqual(body.orphanedWithHistory, []);
});

test("a VISIBLE row is never an orphan, however much history it holds", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1" })];
  msus = [msu({ id: "mine", userId: "u1", historyRows: 100 })];
  const body = await (await link(t, "?userId=u1")).json();
  assert.deepEqual(body.orphanedWithHistory, []);
  assert.equal(body.visibleHistoryRows, 100);
});

test("a row linked to a DIFFERENT account surfaces who holds it", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1", email: "p@example.com" })];
  msus = [msu({ id: "taken", email: "p@example.com", userId: "someone-else", historyRows: 7 })];
  const body = await (await link(t, "?userId=u1")).json();
  assert.equal(body.orphanedWithHistory[0].linkedToOtherUserId, "someone-else");
});

// ── 4 + 5: the account's own identity columns ────────────────────────────────

test("an account with no provider subject is labelled — matcher 2 can never fire for it", async () => {
  // A local-credentials or OIDC account has no plexUserId/jellyfinUserId at all,
  // so the FK is its ONLY route to its own history.
  const t = await mintSession();
  targets = [target({ id: "u1", email: "p@example.com" })];
  const body = await (await link(t, "?userId=u1")).json();
  assert.equal(body.user.hasProviderSubject, false);
  assert.equal(body.user.plexUserId, null);
  assert.equal(body.user.jellyfinUserId, null);
});

test("an account WITH a provider subject is labelled accordingly", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1", plexUserId: "plex-9" })];
  const body = await (await link(t, "?userId=u1")).json();
  assert.equal(body.user.hasProviderSubject, true);
});

test("a purged-by-marker row is labelled a tombstone", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1", email: "deleted-u1@deleted.invalid", purgedAt: new Date() })];
  const body = await (await link(t, "?userId=u1")).json();
  assert.equal(body.user.isPurgedTombstone, true);
});

test("a LEGACY purged row (tombstone shape, NULL purgedAt) is still labelled", async () => {
  // Rows scrubbed before purgedAt existed carry only the shape; a bare
  // `purgedAt != null` reads them as merely disabled — the guardrail-33 trap.
  const t = await mintSession();
  targets = [target({ id: "u1", email: "deleted-u1@deleted.invalid", purgedAt: null })];
  const body = await (await link(t, "?userId=u1")).json();
  assert.equal(body.user.isPurgedTombstone, true);
});

test("an ordinary account is NOT labelled a tombstone", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1", email: "real@example.com" })];
  const body = await (await link(t, "?userId=u1")).json();
  assert.equal(body.user.isPurgedTombstone, false);
});

// ── 6: allServerIdentities only when nothing matched ─────────────────────────

test("allServerIdentities is omitted when candidates were found", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1" })];
  msus = [msu({ id: "m1", userId: "u1" })];
  const body = await (await link(t, "?userId=u1")).json();
  assert.equal(body.allServerIdentities, undefined);
});

test("allServerIdentities appears when NOTHING matched — the hardest case to read", async () => {
  // Plex reports the server OWNER's sessions under a server-local account id, so
  // the owner's row can carry a sourceUserId no User.plexUserId will ever equal.
  const t = await mintSession();
  targets = [target({ id: "u1", plexUserId: "plex-77" })];
  msus = [msu({ id: "owner", source: "plex", sourceUserId: "1", username: "owner", historyRows: 500 })];
  const body = await (await link(t, "?userId=u1")).json();
  assert.deepEqual(body.candidates, []);
  assert.ok(Array.isArray(body.allServerIdentities));
  assert.equal(body.allServerIdentities[0].mediaServerUserId, "owner");
  assert.equal(body.allServerIdentities[0].playHistoryRows, 500);
});

test("the fallback identity dump is bounded", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1" })];
  msus = Array.from({ length: 250 }, (_, i) => msu({ id: `m${i}`, sourceUserId: `s${i}` }));
  await link(t, "?userId=u1");
  const dump = opsOf("mediaServerUser.findMany").find((o) => (o.args as { take?: number }).take != null);
  assert.equal((dump!.args as { take: number }).take, 200);
});

test("a soft-deleted row still appears — history outlives removal (guardrail 28)", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1" })];
  msus = [msu({ id: "gone", userId: "u1", active: false, historyRows: 12 })];
  const body = await (await link(t, "?userId=u1")).json();
  assert.equal(body.candidates.length, 1);
  assert.equal(body.candidates[0].active, false);
  assert.equal(body.visibleHistoryRows, 12);
});

test("manualUserLink is surfaced so a pinned binding is visible", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1" })];
  msus = [msu({ id: "pinned", userId: "u1", manualUserLink: true })];
  const body = await (await link(t, "?userId=u1")).json();
  assert.equal(body.candidates[0].manualUserLink, true);
});

test("the raw _count scaffold does not leak into the payload", async () => {
  const t = await mintSession();
  targets = [target({ id: "u1" })];
  msus = [msu({ id: "m1", userId: "u1", historyRows: 3 })];
  const body = await (await link(t, "?userId=u1")).json();
  assert.equal(body.candidates[0].playHistoryRows, 3);
  assert.ok(!("_count" in body.candidates[0]) || body.candidates[0]._count === undefined);
});

// ── library-sample-paths ─────────────────────────────────────────────────────

test("sample-paths scopes every query to the DEFAULT server instance (guardrail 35)", async () => {
  // Mixing instances hands commonPathPrefix two unrelated bind-mount roots and
  // collapses the inferred mount to "", after which the admin is shown full
  // absolute paths as if that were the default server's mount.
  const t = await mintSession();
  await paths(t);
  const queries = [...opsOf("plexLibraryItem.findMany"), ...opsOf("jellyfinLibraryItem.findMany")];
  assert.equal(queries.length, 4);
  for (const q of queries) {
    assert.equal((q.args as { serverInstance: string }).serverInstance, "", "query not scoped to the default instance");
  }
});

test("a named instance's paths never reach the preview", async () => {
  const t = await mintSession();
  plexItems = [
    { serverInstance: "", mediaType: "MOVIE", filePath: "/plexmedia/movies/A/a.mkv" },
    { serverInstance: "", mediaType: "MOVIE", filePath: "/plexmedia/movies/B/b.mkv" },
    { serverInstance: "remote", mediaType: "MOVIE", filePath: "/mnt/nas/video/C/c.mkv" },
  ];
  const body = await (await paths(t)).json();
  assert.equal(body.plex.movie.mountPoint, "/plexmedia/movies/");
  assert.ok(!JSON.stringify(body).includes("nas"), "another instance's root leaked into the preview");
});

test("the mount point is the longest shared DIRECTORY prefix, excluding the filename", async () => {
  const t = await mintSession();
  plexItems = [
    { serverInstance: "", mediaType: "MOVIE", filePath: "/data/movies/Alpha/alpha.mkv" },
    { serverInstance: "", mediaType: "MOVIE", filePath: "/data/movies/Beta/beta.mkv" },
  ];
  const body = await (await paths(t)).json();
  assert.equal(body.plex.movie.mountPoint, "/data/movies/");
  assert.deepEqual(body.plex.movie.samples, ["Alpha/alpha.mkv", "Beta/beta.mkv"]);
});

test("no shared prefix collapses the mount to an empty string", async () => {
  const t = await mintSession();
  plexItems = [
    { serverInstance: "", mediaType: "MOVIE", filePath: "/data/a.mkv" },
    { serverInstance: "", mediaType: "MOVIE", filePath: "/other/b.mkv" },
  ];
  const body = await (await paths(t)).json();
  assert.equal(body.plex.movie.mountPoint, "");
});

test("a single path still yields its directory as the mount", async () => {
  const t = await mintSession();
  plexItems = [{ serverInstance: "", mediaType: "MOVIE", filePath: "/data/movies/only.mkv" }];
  const body = await (await paths(t)).json();
  assert.equal(body.plex.movie.mountPoint, "/data/movies/");
  assert.deepEqual(body.plex.movie.samples, ["only.mkv"]);
});

test("an empty library yields an empty mount and no samples", async () => {
  const t = await mintSession();
  const body = await (await paths(t)).json();
  assert.equal(body.plex.movie.mountPoint, "");
  assert.deepEqual(body.plex.movie.samples, []);
});

test("windows-style separators are normalized", async () => {
  const t = await mintSession();
  plexItems = [
    { serverInstance: "", mediaType: "MOVIE", filePath: "D:\\Media\\Movies\\A\\a.mkv" },
    { serverInstance: "", mediaType: "MOVIE", filePath: "D:\\Media\\Movies\\B\\b.mkv" },
  ];
  const body = await (await paths(t)).json();
  assert.ok(!body.plex.movie.mountPoint.includes("\\"), "backslashes should be normalized away");
  assert.deepEqual(body.plex.movie.samples, ["A/a.mkv", "B/b.mkv"]);
});

test("the movie sample list is capped and evenly spread rather than the first N", async () => {
  const t = await mintSession();
  plexItems = Array.from({ length: 100 }, (_, i) => ({
    serverInstance: "", mediaType: "MOVIE",
    filePath: `/data/movies/Film${String(i).padStart(3, "0")}/f.mkv`,
  }));
  const body = await (await paths(t)).json();
  assert.ok(body.plex.movie.samples.length <= 6, `got ${body.plex.movie.samples.length} samples`);
  // An evenly-spaced pick includes the LAST item; a naive slice(0,6) would not.
  assert.ok(
    body.plex.movie.samples.some((s: string) => s.includes("Film099")),
    `the spread should reach the end of the list: ${body.plex.movie.samples.join(", ")}`,
  );
});

test("the TV preview lists distinct SHOW folders, not many files from one show", async () => {
  const t = await mintSession();
  plexItems = [
    { serverInstance: "", mediaType: "TV", filePath: "/data/tv/ShowA/S01/e01.mkv" },
    { serverInstance: "", mediaType: "TV", filePath: "/data/tv/ShowA/S01/e02.mkv" },
    { serverInstance: "", mediaType: "TV", filePath: "/data/tv/ShowA/S01/e03.mkv" },
    { serverInstance: "", mediaType: "TV", filePath: "/data/tv/ShowB/S01/e01.mkv" },
  ];
  const body = await (await paths(t)).json();
  assert.deepEqual(body.plex.tv.samples, ["ShowA", "ShowB"]);
});

test("plex and jellyfin previews are computed independently", async () => {
  const t = await mintSession();
  plexItems = [{ serverInstance: "", mediaType: "MOVIE", filePath: "/plexmedia/movies/a.mkv" }];
  jellyfinItems = [{ serverInstance: "", mediaType: "MOVIE", filePath: "/jfmedia/films/b.mkv" }];
  const body = await (await paths(t)).json();
  assert.equal(body.plex.movie.mountPoint, "/plexmedia/movies/");
  assert.equal(body.jellyfin.movie.mountPoint, "/jfmedia/films/");
});

test("each library query is bounded", async () => {
  const t = await mintSession();
  await paths(t);
  for (const q of [...opsOf("plexLibraryItem.findMany"), ...opsOf("jellyfinLibraryItem.findMany")]) {
    assert.equal((q.args as { take?: number }).take ?? 500, 500);
  }
});

test("rows with a null filePath are excluded by the query, not crashed on", async () => {
  const t = await mintSession();
  plexItems = [
    { serverInstance: "", mediaType: "MOVIE", filePath: null },
    { serverInstance: "", mediaType: "MOVIE", filePath: "/data/movies/a.mkv" },
  ];
  const body = await (await paths(t)).json();
  assert.equal(body.plex.movie.mountPoint, "/data/movies/");
  const where = opsOf("plexLibraryItem.findMany")[0].args as { filePath?: unknown };
  assert.ok(where.filePath, "the query should filter nulls server-side");
});

test("sample-paths is read-only", async () => {
  const t = await mintSession();
  plexItems = [{ serverInstance: "", mediaType: "MOVIE", filePath: "/data/movies/A/a.mkv" }];
  await paths(t);
  assert.deepEqual(writeOps(), []);
});
