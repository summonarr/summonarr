// fix-match candidates: the live Radarr/Sonarr cross-check survives whatever
// the arr answers (guardrail 5i). Its rows used to be appended with a spread
// push: a Radarr that ignored ?tmdbId= and sent its whole table past ~125k rows
// threw RangeError, and a non-array answer threw TypeError — both outside any
// try in the MOVIE branch, so the confirmation card's GET 500'd instead of
// degrading to "no confirmation". Sonarr's whole-table read was caught, but a
// table that large silently lost the confirmation.
//
// The route is invoked directly with a real signed session (bearer), a fake
// prisma on globalThis, and a scripted fetch on RFC1918 literals (admin SSRF
// mode, no DNS). Jellyfin mode: no media-server call at all, so every fetch is
// the arr's. TMDB_READ_TOKEN is unset ⇒ no TMDB egress.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "fix-match-candidates-test-secret-0123456789";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
delete process.env.TMDB_READ_TOKEN;

const errors: string[] = [];
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
console.warn = () => {};

const RADARR = "http://10.88.0.20:7878";
const SONARR = "http://10.88.0.21:8989";

let respond: (url: URL) => unknown = (url) => { throw new Error(`unexpected fetch ${url}`); };
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return new Response(JSON.stringify(respond(url)), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

type DbUser = {
  id: string; role: string; permissions: bigint; name: string | null; email: string | null;
  mediaServer: string | null; notificationEmail: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null; purgedAt: Date | null;
};
const usersById = new Map<string, DbUser>();
const authSessions = new Map<string, { userId: string }>();
const settings = new Map<string, string>();
type LibRow = { tmdbId: number; mediaType: string; serverInstance: string; filePath: string | null; jellyfinItemId: string; title: string; year: number };
const jellyfinRows: LibRow[] = [];
const tmdbCacheRows = new Map<string, string>();
const tmdbCacheExpiry = new Map<string, Date>();

(globalThis as unknown as { prisma: unknown }).prisma = {
  user: { findUnique: async (a: { where: { id: string } }) => { const u = usersById.get(a.where.id); return u ? { ...u } : null; } },
  authSession: {
    findUnique: async (a: { where: { sessionId: string } }) => {
      const row = authSessions.get(a.where.sessionId);
      return row ? { id: `row-${a.where.sessionId}`, sessionId: a.where.sessionId, userId: row.userId, deviceLabel: null } : null;
    },
    update: async () => ({}),
  },
  setting: {
    findMany: async (a: { where: { key: { in: string[] } } }) =>
      a.where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) as string })),
    findUnique: async (a: { where: { key: string } }) => {
      const value = settings.get(a.where.key);
      return value === undefined ? null : { key: a.where.key, value };
    },
  },
  tmdbCache: {
    findUnique: async (a: { where: { key: string } }) => {
      const data = tmdbCacheRows.get(a.where.key);
      if (data === undefined) return null;
      const expiresAt = tmdbCacheExpiry.get(a.where.key);
      return expiresAt ? { key: a.where.key, data, expiresAt } : { key: a.where.key, data };
    },
    deleteMany: async () => ({ count: 0 }),
  },
  jellyfinLibraryItem: {
    findFirst: async (a: { where: { tmdbId: number; mediaType: string; serverInstance: string } }) =>
      jellyfinRows.find((r) => r.tmdbId === a.where.tmdbId && r.mediaType === a.where.mediaType && r.serverInstance === a.where.serverInstance) ?? null,
  },
  plexLibraryItem: { findMany: async () => [] },
  auditLog: { create: async (a: { data: unknown }) => a.data },
};

const { NextRequest } = await import("next/server");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { GET: candidates } = await import("../src/app/api/admin/fix-match/candidates/route.ts");

let seq = 0;
async function admin(): Promise<Record<string, string>> {
  seq++;
  const id = `u03-admin-${seq}`;
  const sessionId = `u03-sess-${seq}`;
  usersById.set(id, {
    id, role: "ADMIN", permissions: 0n, name: "Admin", email: "admin@example.com", mediaServer: null, notificationEmail: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null, purgedAt: null,
  });
  authSessions.set(sessionId, { userId: id });
  const token = await signSessionJwt(
    { id, role: "ADMIN", permissions: "0", provider: "credentials", sessionId, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
    { expiresInSeconds: 7_200 },
  );
  return { authorization: `Bearer ${token}` };
}

type Body = { arrConfirmedTmdbId: number | null; arrPathAgrees: boolean | null; targetTitle: string };
async function confirmCard(mediaType: "MOVIE" | "TV"): Promise<{ status: number; body: Body }> {
  const params = new URLSearchParams({ server: "jellyfin", tmdbId: "111", mediaType, correctTmdbId: "222" });
  const res = await candidates(new NextRequest(`http://localhost:3000/api/admin/fix-match/candidates?${params}`, { headers: await admin() }), undefined);
  return { status: res.status, body: await res.json() as Body };
}

// Past where a spread push throws RangeError; the right title is the LAST row.
const HOSTILE = 130_000;
const table = (rightPath: string) => [
  ...Array.from({ length: HOSTILE }, (_, i) => ({ tmdbId: 1_000_000 + i, path: `/media/other/${i}` })),
  { tmdbId: 222, path: rightPath },
];

beforeEach(() => {
  settings.clear();
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
  settings.set("sonarrUrl", SONARR);
  settings.set("sonarrApiKey", "sonarr-key");
  jellyfinRows.length = 0;
  jellyfinRows.push(
    { tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/media/movies/Right Film (2010)/right.mkv", jellyfinItemId: "aaaaaaaa", title: "Wrong", year: 2010 },
    { tmdbId: 111, mediaType: "TV", serverInstance: "", filePath: "/media/tv/Right Show", jellyfinItemId: "bbbbbbbb", title: "Wrong", year: 2010 },
  );
  tmdbCacheRows.clear();
  tmdbCacheExpiry.clear();
  errors.length = 0;
});

test("a Radarr that answers ?tmdbId= with an object, not a list, degrades to no confirmation — never a 500", async () => {
  respond = (url) => {
    if (url.origin !== RADARR) throw new Error(`unexpected origin ${url.origin}`);
    return { message: "not a list" };
  };
  const { status, body } = await confirmCard("MOVIE");
  assert.equal(status, 200);
  assert.deepEqual([body.arrConfirmedTmdbId, body.arrPathAgrees], [null, null]);
});

test("a Radarr that answers with null rows beside the right one still confirms it", async () => {
  respond = (url) => (url.search === "?tmdbId=222" ? [null, 7, { tmdbId: 222, path: "/media/movies/Right Film (2010)" }] : null);
  const { status, body } = await confirmCard("MOVIE");
  assert.equal(status, 200);
  assert.deepEqual([body.arrConfirmedTmdbId, body.arrPathAgrees], [222, true]);
});

test("a Radarr that ignores ?tmdbId= and sends a 130k-title table still confirms the right title", async () => {
  respond = (url) => {
    if (url.origin !== RADARR) throw new Error(`unexpected origin ${url.origin}`);
    return table("/media/movies/Right Film (2010)");
  };
  const { status, body } = await confirmCard("MOVIE");
  assert.equal(status, 200);
  assert.deepEqual([body.arrConfirmedTmdbId, body.arrPathAgrees], [222, true]);
});

test("a 130k-series Sonarr table is read whole: the confirmation is not lost", async () => {
  respond = (url) => {
    if (url.origin !== SONARR || url.pathname !== "/api/v3/series") throw new Error(`unexpected ${url}`);
    return table("/media/tv/Right Show");
  };
  const { status, body } = await confirmCard("TV");
  assert.equal(status, 200);
  assert.deepEqual([body.arrConfirmedTmdbId, body.arrPathAgrees], [222, true]);
  assert.deepEqual(errors.filter((e) => e.includes("fix-match/candidates")), [], "nothing was rejected");
});

test("a Radarr entry with NO folder path confirms nothing — a path normalised from '' is '.', not a path", async () => {
  respond = (url) => (url.search === "?tmdbId=222" ? [{ tmdbId: 222 }] : []);
  const missing = await confirmCard("MOVIE");
  assert.equal(missing.status, 200);
  assert.deepEqual([missing.body.arrConfirmedTmdbId, missing.body.arrPathAgrees], [null, null]);

  respond = (url) => (url.search === "?tmdbId=222" ? [{ tmdbId: 222, path: "" }, { tmdbId: 222, path: "   " }] : []);
  const blank = await confirmCard("MOVIE");
  assert.deepEqual([blank.body.arrConfirmedTmdbId, blank.body.arrPathAgrees], [null, null]);

  // A real folder elsewhere still confirms membership; only the path disagrees
  // (split-mount deployments).
  respond = (url) => (url.search === "?tmdbId=222" ? [{ tmdbId: 222, path: "/elsewhere/Right Film" }] : []);
  const elsewhere = await confirmCard("MOVIE");
  assert.deepEqual([elsewhere.body.arrConfirmedTmdbId, elsewhere.body.arrPathAgrees], [222, false]);
});

test("an EXPIRED cached TMDB details row is a miss — its stale title never reaches the confirm card; a live row still does", async () => {
  respond = () => [];
  tmdbCacheRows.set("movie:222:details", JSON.stringify({ title: "Stale Title", imdbId: "tt0000001" }));
  tmdbCacheExpiry.set("movie:222:details", new Date(Date.now() - 60_000));
  const expired = await confirmCard("MOVIE");
  assert.equal(expired.status, 200);
  assert.equal(expired.body.targetTitle, "");

  tmdbCacheRows.set("movie:222:details", JSON.stringify({ title: "Cached Title" }));
  tmdbCacheExpiry.set("movie:222:details", new Date(Date.now() + 60_000));
  const live = await confirmCard("MOVIE");
  assert.equal(live.body.targetTitle, "Cached Title");
});
