// Route-level unit tests for the DUAL-AUTH admin diagnostic
// src/app/api/admin/check-schema/route.ts — CLAUDE.md cites it as THE example of
// a route that wraps with withAdmin AND keeps an inline isCronAuthorized check
// (guardrail 6a's documented exception). This file invokes the exported GET
// handler directly with constructed NextRequests + REAL signed sessions and pins
// the exact, non-obvious authorization matrix, plus the schema-introspection
// result shape.
//
// ── THE MATRIX (traced from the two guards STACKED, not either alone) ─────────
// The handler runs only if BOTH pass, in order:
//   1. withAdmin  — resolves BEARER-FIRST then cookie (guardrail 6b), DB-checks
//      the session, requires role ADMIN. 401 (no/invalid session) or 403 (wrong
//      role) short-circuit BEFORE the handler body.
//   2. inline isCronAuthorized(request) — inside the body; accepts an active
//      admin session (which additionally requires a same-origin Origin/Referer +
//      UA-fingerprint) OR `Authorization: Bearer <CRON_SECRET>`. On failure the
//      handler itself returns 403.
//
// The load-bearing, easy-to-get-wrong consequence pinned here: because withAdmin
// runs FIRST and resolves the Authorization header bearer-FIRST, a bare
// `Bearer <CRON_SECRET>` is treated as a session token, fails verifySessionJwt,
// and 401s at step 1 — it NEVER reaches the inline CRON_SECRET branch. So the
// CRON_SECRET path is effectively shadowed for THIS route: the only way through
// is an admin session that ALSO clears isCronAuthorized's same-origin gate. That
// is exactly why the route requires "both an admin session AND" the inline check
// — the inline check hardens the session path (same-origin/CSRF), it is not an
// independent CRON_SECRET escape hatch here.
//
// ── Division of labour (owned elsewhere; NOT re-pinned) ──────────────────────
//   - tests/cron-auth.test.mts OWNS isCronAuthorized's CRON_SECRET compare
//     (exact "Bearer " scheme, timing-safe, fail-closed). Here we pin how it
//     COMPOSES with withAdmin on this specific route.
//   - tests/api-auth.test.mts OWNS the withAdmin wrapper matrix in isolation.
//
// No DB, no network: globalThis.prisma is a recording fake seeded BEFORE the
// module graph loads; $queryRaw (the information_schema introspection) is scripted
// per test. Sessions are REAL jose JWTs over in-memory rows; claims mirror the
// rows so the privilege-rotation path never fires.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto at load
process.env.NEXTAUTH_SECRET = "check-schema-route-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000"; // unprefixed cookie name + the trusted same-origin
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
// A valid CRON_SECRET (≥32 chars) so the inline CRON_SECRET branch WOULD accept a
// bare Bearer if it were ever reached — the point being that on this route it is not.
const CRON_SECRET = "check-schema-cron-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON_SECRET;

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

globalThis.fetch = (() => {
  throw new Error("unexpected network call from check-schema tests");
}) as unknown as typeof fetch;

// ── recording fake prisma (seeded on globalThis before the module graph) ─────
type SchemaRow = { table_name: string; column_name: string; data_type: string };
let schemaRows: SchemaRow[] = [];
let queryRawCalls = 0;

type DbUser = {
  id: string; role: string; permissions: bigint; name: string | null; email: string | null;
  mediaServer: string | null; notificationEmail: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
};
const usersById = new Map<string, DbUser>();
const authSessionsById = new Map<string, { userId: string }>();

const fakePrisma = {
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
    update: async () => ({}),
  },
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) =>
      authSessionsById.has(args.where.sessionId)
        ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
        : null,
    update: async () => ({}),
  },
  // Tagged-template call: the route does prisma.$queryRaw`SELECT … information_schema.columns …`.
  $queryRaw: async (..._args: unknown[]) => {
    queryRawCalls++;
    return schemaRows;
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── dynamic imports (env + globalThis stubs must precede the module graph) ───
const { NextRequest } = await import("next/server");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { GET } = await import("../src/app/api/admin/check-schema/route.ts");

type Req = InstanceType<typeof NextRequest>;
const COOKIE = getSessionCookieName();
const ENDPOINT = "http://localhost:3000/api/admin/check-schema";
const TRUSTED_ORIGIN = "http://localhost:3000";

// ── the columns the route asserts (mirror of the route's EXPECTED) ───────────
// Kept as a local fixture so a schema-contract change breaks these tests loudly.
const EXPECTED: Record<string, string[]> = {
  User: ["id", "name", "email", "passwordHash", "role", "permissions", "mediaServer", "discordId", "autoApprove", "quotaExempt"],
  PlexLibraryItem: ["tmdbId", "mediaType", "filePath", "plexRatingKey", "title", "year", "overview"],
  JellyfinLibraryItem: ["tmdbId", "mediaType", "filePath", "jellyfinItemId", "title", "year", "overview"],
  TVEpisodeCache: ["source", "tmdbId", "seasonNumber", "episodeNumber"],
  PlayHistory: ["id", "source", "tmdbId", "mediaType", "title", "year", "posterPath", "startedAt", "watched"],
  MediaRequest: ["id", "tmdbId", "mediaType", "title", "posterPath", "status", "requestedBy"],
  TmdbCache: ["key", "data", "expiresAt"],
  ActiveSession: ["id", "source", "tmdbId", "title"],
  MediaServerUser: ["id", "source", "sourceUserId", "username"],
};

function rowsFor(tables: Record<string, string[]>): SchemaRow[] {
  const rows: SchemaRow[] = [];
  for (const [table_name, cols] of Object.entries(tables)) {
    for (const column_name of cols) rows.push({ table_name, column_name, data_type: "text" });
  }
  return rows;
}

// ── fixtures ────────────────────────────────────────────────────────────────
let seq = 0;

async function mintToken(role: string): Promise<{ userId: string; sessionId: string; token: string }> {
  seq++;
  const userId = `actor-${seq}`;
  const sessionId = `actor-sess-${seq}`;
  usersById.set(userId, {
    id: userId, role, permissions: 0n, name: `Actor ${seq}`, email: "admin@example.com",
    mediaServer: null, notificationEmail: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
  });
  authSessionsById.set(sessionId, { userId });
  const token = await signSessionJwt(
    { id: userId, role, permissions: "0", provider: "credentials", sessionId, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
    { expiresInSeconds: 7_200 },
  );
  return { userId, sessionId, token };
}

function req(headers: Record<string, string> = {}): Req {
  return new NextRequest(ENDPOINT, { method: "GET", headers });
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const cookie = (token: string): Record<string, string> => ({ cookie: `${COOKIE}=${token}` });
const sameOrigin: Record<string, string> = { origin: TRUSTED_ORIGIN };

beforeEach(() => {
  schemaRows = [];
  queryRawCalls = 0;
  warns.length = 0;
  errors.length = 0;
});

// ════════════════════════════════════════════════════════════════════════════
// Step-1 gate: withAdmin (bearer-first, DB-checked, ADMIN-only)
// ════════════════════════════════════════════════════════════════════════════

test("no auth material → 401 (withAdmin), the schema introspection never runs", async () => {
  const res = await GET(req(sameOrigin), undefined);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Unauthorized" });
  assert.equal(queryRawCalls, 0, "the $queryRaw introspection must not run for an unauthenticated caller");
});

test("a plain USER → 403 (withAdmin is ADMIN-only), introspection never runs", async () => {
  const user = await mintToken("USER");
  const res = await GET(req({ ...bearer(user.token), ...sameOrigin }), undefined);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Forbidden" });
  assert.equal(queryRawCalls, 0);
});

test("an ISSUE_ADMIN → 403 (this route is ADMIN-only, not issue-admin)", async () => {
  const issueAdmin = await mintToken("ISSUE_ADMIN");
  const res = await GET(req({ ...bearer(issueAdmin.token), ...sameOrigin }), undefined);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Forbidden" });
  assert.equal(queryRawCalls, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// The CRON_SECRET path is SHADOWED here: withAdmin's bearer-first rejects the
// non-JWT bearer before the inline isCronAuthorized branch can accept it.
// ════════════════════════════════════════════════════════════════════════════

test("a bare Bearer CRON_SECRET → 401 at withAdmin (bearer-first treats it as a session token; the inline cron branch is never reached)", async () => {
  // CRON_SECRET is a valid ≥32-char secret and isCronAuthorized WOULD accept it —
  // but withAdmin resolves the Authorization header bearer-first, runs the
  // CRON_SECRET through verifySessionJwt, gets null (not a JWT), and 401s. This
  // pins that the dual guard is admin-session-only in practice, not a CRON escape.
  const res = await GET(req({ authorization: `Bearer ${CRON_SECRET}`, ...sameOrigin }), undefined);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Unauthorized" });
  assert.equal(queryRawCalls, 0);
});

test("an admin COOKIE alongside a Bearer CRON_SECRET → still 401: bearer-first ignores the valid cookie", async () => {
  // A valid admin cookie can't rescue the request — withAdmin consumes the
  // Authorization bearer (the CRON_SECRET) first and never falls back to the
  // cookie (guardrail 6b). So the CRON_SECRET truly cannot combine with a session.
  const admin = await mintToken("ADMIN");
  const res = await GET(
    req({ authorization: `Bearer ${CRON_SECRET}`, ...cookie(admin.token), ...sameOrigin }),
    undefined,
  );
  assert.equal(res.status, 401);
  assert.equal(queryRawCalls, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// Step-2 gate: inline isCronAuthorized hardens the admin-session path (same-origin)
// ════════════════════════════════════════════════════════════════════════════

test("an admin session WITHOUT a same-origin Origin/Referer → 403 from the inline isCronAuthorized (withAdmin passed, the inline check did not)", async () => {
  // withAdmin admits the admin bearer, but isCronAuthorized's admin-session path
  // requires a trusted Origin/Referer (CSRF hardening). With none present it
  // returns false, so the handler itself returns 403 — proving the inline check
  // is a real, additional gate stacked on top of withAdmin.
  const admin = await mintToken("ADMIN");
  const res = await GET(req(bearer(admin.token)), undefined); // no Origin header
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Forbidden" });
  assert.equal(queryRawCalls, 0, "a 403 from the inline check must short-circuit before the introspection");
});

test("an admin session from an UNTRUSTED Origin → 403 (same-origin gate rejects a foreign Origin)", async () => {
  const admin = await mintToken("ADMIN");
  const res = await GET(req({ ...bearer(admin.token), origin: "https://evil.example.com" }), undefined);
  assert.equal(res.status, 403);
  assert.equal(queryRawCalls, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// Authorized (both gates pass) → the schema-introspection result shape
// ════════════════════════════════════════════════════════════════════════════

test("admin BEARER + same-origin, schema complete → 200 { allOk:true, tables, allTables }", async () => {
  const admin = await mintToken("ADMIN");
  // Every expected table + column present, plus a bonus table to prove allTables
  // reflects the live introspection (sorted union), not just EXPECTED.
  schemaRows = rowsFor({ ...EXPECTED, Setting: ["key", "value"] });

  const res = await GET(req({ ...bearer(admin.token), ...sameOrigin }), undefined);
  assert.equal(res.status, 200);
  assert.equal(queryRawCalls, 1, "the introspection query runs exactly once when authorized");

  const body = (await res.json()) as {
    allOk: boolean;
    tables: Record<string, { ok: boolean; missing: string[]; columns: string[] }>;
    allTables: string[];
  };
  assert.equal(body.allOk, true);
  // Every EXPECTED table reports ok:true with no missing columns.
  for (const table of Object.keys(EXPECTED)) {
    assert.equal(body.tables[table].ok, true, `${table} should be ok`);
    assert.deepEqual(body.tables[table].missing, [], `${table} should have no missing columns`);
  }
  // Per-table `columns` echoes what introspection returned.
  assert.deepEqual(body.tables.MediaServerUser.columns, EXPECTED.MediaServerUser);
  // allTables is the sorted set of ALL introspected tables (incl. the bonus one).
  assert.ok(body.allTables.includes("Setting"), "allTables reflects the live table set, not just EXPECTED");
  assert.deepEqual(body.allTables, [...body.allTables].sort(), "allTables must be sorted");
});

test("admin COOKIE + same-origin → 200 (the web transport authorizes through both gates)", async () => {
  const admin = await mintToken("ADMIN");
  schemaRows = rowsFor(EXPECTED);
  const res = await GET(req({ ...cookie(admin.token), ...sameOrigin }), undefined);
  assert.equal(res.status, 200);
  assert.equal(queryRawCalls, 1);
  assert.equal((await res.json() as { allOk: boolean }).allOk, true);
});

test("authorized but the live schema has drifted → 200 { allOk:false } with the missing column named, complete tables still ok", async () => {
  const admin = await mintToken("ADMIN");
  // Drop PlexLibraryItem.overview from the live schema; leave everything else intact.
  const drifted: Record<string, string[]> = { ...EXPECTED, PlexLibraryItem: EXPECTED.PlexLibraryItem.filter((c) => c !== "overview") };
  schemaRows = rowsFor(drifted);

  const res = await GET(req({ ...bearer(admin.token), ...sameOrigin }), undefined);
  assert.equal(res.status, 200, "drift is reported in the body, not via an HTTP error");
  const body = (await res.json()) as {
    allOk: boolean;
    tables: Record<string, { ok: boolean; missing: string[]; columns: string[] }>;
  };
  assert.equal(body.allOk, false, "any missing column flips allOk to false");
  assert.equal(body.tables.PlexLibraryItem.ok, false);
  assert.deepEqual(body.tables.PlexLibraryItem.missing, ["overview"], "the exact missing column is reported");
  assert.equal(body.tables.User.ok, true, "an unaffected table stays ok");
  assert.deepEqual(body.tables.User.missing, []);
});
