// Admin play-history operations — the export download and the per-row DELETE.
//
//   • GET /api/play-history/export emits the stored `bitrate` as KBPS under an
//     explicit unit (JSON `bitrateKbps`, CSV "Bitrate (kbps)") via bitrateToKbps
//     (guardrail 19a — Plex stores kbps, Jellyfin bps, and the raw column is
//     unitless without `source`). A Jellyfin 20 Mbps row (20 000 000 bps) and a
//     Plex 8 Mbps row (8000 kbps) must export as 20000 and 8000, never the raw
//     column. The CSV also opens with a UTF-8 BOM so Excel reads non-ASCII titles.
//   • DELETE /api/play-history/[id] flushes the activity cache after the delete
//     (the write path flushes on every finalize; the stats/calendar/heatmap panels
//     otherwise kept counting a play the audit row recorded as removed for 5–30
//     min). Pinned by EFFECT, not by spying on the import: a cached getter is
//     primed, the DELETE runs, and the getter must hit the data layer again.
//
// Harness: the play-history-admin-guard idiom — real signed session JWTs over
// bearer transport, in-memory authSession/user stubs, a synthetic request scope
// for the export's requireAuth() → headers(), no DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "ph-admin-ops-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (() => {
  throw new Error("unexpected network call from play-history-admin-ops tests");
}) as unknown as typeof fetch;

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");

type RunStore = { run<T>(store: unknown, fn: () => T): T };
const cjsRequire = createRequire(import.meta.url);
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

function runInScope<T>(token: string | null, fn: () => T): T {
  const reqHeaders = new Headers({ "x-forwarded-for": "203.0.113.5" });
  if (token) reqHeaders.set("authorization", `Bearer ${token}`);
  const workStore = {
    route: "/play-history-admin-ops.test",
    forceStatic: false,
    dynamicShouldError: false,
    afterContext: { after: () => {} },
  };
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

// ── in-memory auth state ──────────────────────────────────────────────────────
type DbUser = {
  role: string; permissions: bigint; mediaServer: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
  email: string | null; notificationEmail: string | null; passwordHash: string | null;
  plexUserId: string | null; jellyfinUserId: string | null;
};
const usersById = new Map<string, DbUser>();
const authSessions = new Map<string, { sessionId: string; userId: string; expiresAt: Date }>();

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (a: { where: { sessionId: string } }) => authSessions.get(a.where.sessionId) ?? null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (a: { where: { id: string } }) => {
    const u = usersById.get(a.where.id);
    return u ? { ...u } : null;
  },
  update: async () => ({}),
});
// The audit paper trail (awaited by the export, void by the delete).
const auditRows: unknown[] = [];
shadowPrismaModel(prisma, "auditLog", {
  create: async (a: { data: unknown }) => { auditRows.push(a.data); return a.data; },
});

// ── the exported rows + the raw-SQL dispatcher ────────────────────────────────
// One Jellyfin row at 20 Mbps (bps) and one Plex row at 8 Mbps (kbps): the same
// human bitrate, two storage units — exactly the pair guardrail 19a is about.
// A third row with no bitrate pins the null case.
const startedAt = new Date("2026-10-01T20:00:00.000Z");
const stoppedAt = new Date("2026-10-01T21:30:00.000Z");
function exportRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "ph-1", title: "Amélie", mediaType: "MOVIE", year: "2001", seasonNumber: null, episodeNumber: null,
    episodeTitle: null, source: "plex", startedAt, stoppedAt, duration: 5400, playDuration: 5300,
    pausedDuration: 0, watched: true, platform: "Roku", player: "Plex for Roku", device: "Roku",
    playMethod: "DirectPlay", videoCodec: "h264", audioCodec: "aac", resolution: "1080",
    bitrate: 8000, videoDecision: "directplay", audioDecision: "directplay", container: "mkv",
    username: "alice",
    ...over,
  };
}
const EXPORT_ROWS = [
  exportRow({ id: "ph-jf", source: "jellyfin", bitrate: 20_000_000, username: "bob", title: "東京物語" }),
  exportRow({ id: "ph-plex", source: "plex", bitrate: 8000 }),
  exportRow({ id: "ph-none", source: "plex", bitrate: null, title: "No Bitrate" }),
];

let rawCalls: string[] = [];
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string) => {
  rawCalls.push(sql);
  // The export joins the username alias; everything else (the cached stats
  // getters) gets an empty result set.
  if (sql.includes('LEFT JOIN "MediaServerUser" msu')) return EXPORT_ROWS;
  return [];
});

// ── the delete target ────────────────────────────────────────────────────────
const deletedIds: string[] = [];
shadowPrismaModel(prisma, "playHistory", {
  findUnique: async (a: { where: { id: string } }) =>
    a.where.id === "ph-del"
      ? { id: "ph-del", mediaServerUserId: "msu-1", title: "Test Movie", source: "plex", tmdbId: 550, startedAt, stoppedAt, referenceId: null }
      : null,
  delete: async (a: { where: { id: string } }) => { deletedIds.push(a.where.id); return { id: a.where.id }; },
  deleteMany: async () => ({ count: 0 }),
});

// ── session minting ───────────────────────────────────────────────────────────
let seq = 0;
async function mintAdmin(): Promise<string> {
  seq++;
  const userId = `admin-${seq}`;
  const sessionId = `sess-${seq}`;
  usersById.set(userId, {
    role: "ADMIN", permissions: 0n, mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: `admin-${seq}@example.com`, notificationEmail: null, passwordHash: null,
    plexUserId: null, jellyfinUserId: null,
  });
  authSessions.set(sessionId, { sessionId, userId, expiresAt: new Date(Date.now() + 86_400_000) });
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "ADMIN", permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

type Req = InstanceType<typeof NextRequest>;
function req(path: string, token: string, method = "GET"): Req {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.5" },
  });
}

// Route handlers + the cached getter — imported AFTER the stubs are in place.
const exportRoute = (await import("../src/app/api/play-history/export/route.ts")).GET;
const idMod = await import("../src/app/api/play-history/[id]/route.ts");
const { getTranscodeOffenders, clearActivityCache } = await import("../src/lib/play-history.ts");

beforeEach(() => {
  rawCalls = [];
  deletedIds.length = 0;
  auditRows.length = 0;
  warns.length = 0;
  errors.length = 0;
  clearActivityCache();
});

// ═══ Export: bitrate leaves the DB in kbps, under an explicit unit ═══════════

test("GUARDRAIL 19a: the JSON export emits `bitrateKbps` normalized on `source` — Jellyfin bps → kbps, Plex kbps as-is, null when absent — and never the raw column", async () => {
  const token = await mintAdmin();
  const res = await runInScope(token, () => exportRoute(req("/api/play-history/export?format=json", token)));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /play-history-.*\.json/);
  const data = (await res.json()) as Array<Record<string, unknown>>;
  assert.equal(data.length, 3);

  const jf = data.find((r) => r.id === "ph-jf")!;
  const plex = data.find((r) => r.id === "ph-plex")!;
  const none = data.find((r) => r.id === "ph-none")!;
  assert.equal(jf.bitrateKbps, 20_000, "a Jellyfin 20 000 000 bps row exports as 20000 kbps");
  assert.equal(plex.bitrateKbps, 8000, "a Plex 8000 kbps row exports unchanged");
  assert.equal(none.bitrateKbps, null, "no stored bitrate → null, not 0");
  for (const r of data) {
    assert.equal("bitrate" in r, false, "the unitless raw column must not leave the DB");
  }
  // Field position kept: the unit-explicit key sits where `bitrate` used to.
  const keys = Object.keys(jf);
  assert.equal(keys[keys.indexOf("resolution") + 1], "bitrateKbps");
  assert.equal(keys[keys.indexOf("bitrateKbps") + 1], "videoDecision");
  assert.equal(auditRows.length, 1, "the paper-trail audit row is written before the rows stream");
});

test("GUARDRAIL 19a: the CSV export opens with a UTF-8 BOM, titles the column \"Bitrate (kbps)\", and writes the normalized value per row", async () => {
  const token = await mintAdmin();
  const res = await runInScope(token, () => exportRoute(req("/api/play-history/export?format=csv", token)));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  // Raw bytes, not res.text(): the Fetch spec's text() runs "UTF-8 decode", which
  // STRIPS a leading U+FEFF, so the BOM is only observable on the wire bytes —
  // which is exactly where Excel reads it.
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(
    [...bytes.slice(0, 3)],
    [0xef, 0xbb, 0xbf],
    "the body opens with the UTF-8 BOM (Excel sniffs encoding from it, not from the Content-Type charset)",
  );
  const text = new TextDecoder().decode(bytes); // default decoder drops the BOM

  const lines = text.trimEnd().split("\n");
  const header = lines[0].split(",");
  assert.ok(header.includes("Bitrate (kbps)"), `the column names its unit; header=${lines[0]}`);
  assert.equal(header.includes("Bitrate"), false, "the unitless header is gone");
  const bitrateIdx = header.indexOf("Bitrate (kbps)");
  assert.equal(header[bitrateIdx - 1], "Resolution", "column position kept");

  const byTitle = new Map(lines.slice(1).map((l) => [l.split(",")[0], l.split(",")]));
  assert.equal(byTitle.get("東京物語")![bitrateIdx], "20000", "Jellyfin bps → kbps in the CSV too");
  assert.equal(byTitle.get("Amélie")![bitrateIdx], "8000", "Plex kbps unchanged — and the non-ASCII title survives intact");
  assert.equal(lines.length, 1 + 3, "three data rows, no truncation notice under the cap");
});

// ═══ DELETE flushes the activity cache ═══════════════════════════════════════

test("DELETE /api/play-history/[id] flushes the activity cache after the delete — a primed cached getter hits the data layer again", async () => {
  // Prime: the first read hits the data layer (two raw queries), the second is a
  // cache hit (zero). This is the 5-minute STATS_TTL window the deleted play
  // used to keep living in.
  await getTranscodeOffenders();
  const primed = rawCalls.length;
  assert.ok(primed > 0, "the first read hits the data layer");
  await getTranscodeOffenders();
  assert.equal(rawCalls.length, primed, "the second read is served from the activity cache");

  const token = await mintAdmin();
  const res = await idMod.DELETE(
    req("/api/play-history/ph-del", token, "DELETE"),
    { params: Promise.resolve({ id: "ph-del" }) },
  );
  assert.equal(res.status, 204);
  assert.deepEqual(deletedIds, ["ph-del"], "the row is deleted");

  await getTranscodeOffenders();
  assert.equal(
    rawCalls.length,
    primed * 2,
    "after the DELETE the cached getter must re-query — the stats/calendar/heatmap panels may not keep counting a play the audit row recorded as removed",
  );
});

test("neither route console.errors on its happy path (guardrail 7)", () => {
  assert.deepEqual(errors, []);
});
