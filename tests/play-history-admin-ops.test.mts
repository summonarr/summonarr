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
let auditThrows = false;
shadowPrismaModel(prisma, "auditLog", {
  create: async (a: { data: unknown }) => {
    if (auditThrows) throw new Error("simulated audit write failure");
    auditRows.push(a.data);
    return a.data;
  },
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
// When true, every export page query answers a FULL page (the LIMIT it was sent),
// so the CSV loop would page all the way to MAX_EXPORT_ROWS if nothing stopped it.
let fullExportPages = false;
// When set, the export's page queries share this many rows in all: each page
// answers what it asked for until the rows run out.
let exportRowBudget: number | null = null;
// When set, the export's Nth page query (1-based) throws.
let exportQueryThrowsAt: number | null = null;
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string, ...binds: unknown[]) => {
  rawCalls.push(sql);
  // The export joins the username alias; everything else (the cached stats
  // getters) gets an empty result set.
  if (sql.includes('LEFT JOIN "MediaServerUser" msu')) {
    if (exportQueryThrowsAt !== null && exportPageQueries() === exportQueryThrowsAt) {
      throw new Error("simulated DB failure mid-export");
    }
    if (exportRowBudget !== null) {
      const take = Math.min(Number(binds[binds.length - 1]), exportRowBudget);
      exportRowBudget -= take;
      const base = rawCalls.length * 1_000_000;
      return Array.from({ length: take }, (_, i) =>
        exportRow({ id: `ph-${base + i}`, startedAt: new Date(startedAt.getTime() - (base + i) * 1000) }));
    }
    if (fullExportPages) {
      const take = Number(binds[binds.length - 1]);
      const base = rawCalls.length * 1_000_000;
      return Array.from({ length: take }, (_, i) =>
        exportRow({ id: `ph-${base + i}`, startedAt: new Date(startedAt.getTime() - (base + i) * 1000) }));
    }
    return EXPORT_ROWS;
  }
  return [];
});
const exportPageQueries = () => rawCalls.filter((sql) => sql.includes('LEFT JOIN "MediaServerUser" msu')).length;

// ── the delete target ────────────────────────────────────────────────────────
const deletedIds: string[] = [];
// A concurrent delete removed the row between the route's read and its delete.
let deleteRaced = false;
shadowPrismaModel(prisma, "playHistory", {
  findUnique: async (a: { where: { id: string } }) =>
    a.where.id === "ph-del"
      ? { id: "ph-del", mediaServerUserId: "msu-1", title: "Test Movie", source: "plex", tmdbId: 550, startedAt, stoppedAt, referenceId: null }
      : null,
  delete: async (a: { where: { id: string } }) => {
    if (deleteRaced) throw Object.assign(new Error("Record to delete does not exist."), { name: "PrismaClientKnownRequestError", code: "P2025" });
    deletedIds.push(a.where.id);
    return { id: a.where.id };
  },
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
  fullExportPages = false;
  exportRowBudget = null;
  exportQueryThrowsAt = null;
  auditThrows = false;
  deleteRaced = false;
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

// ═══ Export: validation, audit scope, backpressure ═══════════════════════════

test("a mistyped export date is a 400 that spends no export budget and writes no audit row", async () => {
  const token = await mintAdmin();
  for (let i = 0; i < 5; i++) {
    const bad = await runInScope(token, () => exportRoute(req("/api/play-history/export?startDate=notadate", token)));
    assert.equal(bad.status, 400, `attempt ${i + 1} is refused for the date`);
  }
  assert.equal(auditRows.length, 0, "no PLAY_HISTORY_EXPORT row for an export that never ran");
  const ok = await runInScope(token, () => exportRoute(req("/api/play-history/export?format=json", token)));
  assert.equal(ok.status, 200, "the five 400s did not use up the five-per-hour budget");
  assert.equal(auditRows.length, 1);
});

function auditFilters(): Record<string, unknown> {
  const row = auditRows.at(-1) as { action: string; details: string };
  assert.equal(row.action, "PLAY_HISTORY_EXPORT");
  return (JSON.parse(row.details) as { filters: Record<string, unknown> }).filters;
}

test("the export audit records the filters the query applied — an unrecognised value is null, never the raw string", async () => {
  const token = await mintAdmin();
  const junk = await runInScope(token, () =>
    exportRoute(req("/api/play-history/export?format=json&source=foo&mediaType=X&watched=maybe&tmdbId=abc&playMethod=Nope", token)));
  assert.equal(junk.status, 200);
  const f = auditFilters();
  for (const key of ["source", "mediaType", "watched", "tmdbId", "playMethod"]) {
    assert.equal(f[key], null, `${key}: an ignored value must not be logged as a narrowing`);
  }

  const real = await runInScope(token, () =>
    exportRoute(req("/api/play-history/export?format=json&source=jellyfin&mediaType=TV&watched=false&tmdbId=603abc", token)));
  assert.equal(real.status, 200);
  const g = auditFilters();
  assert.equal(g.source, "jellyfin");
  assert.equal(g.mediaType, "TV");
  assert.equal(g.watched, "false");
  assert.equal(g.tmdbId, 603, "the query binds parseInt('603abc'), so the trail records 603");
});

test("the CSV export reads pages only as fast as the client downloads, and a cancelled download stops paging", async () => {
  fullExportPages = true;
  const token = await mintAdmin();
  const res = await runInScope(token, () => exportRoute(req("/api/play-history/export?format=csv", token)));
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  // Give an eager producer every chance to run ahead before the cancel.
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  const beforeCancel = exportPageQueries();
  await reader.cancel();
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.ok(beforeCancel <= 1, `with only the header read, at most one page is queried (got ${beforeCancel} of 10)`);
  assert.equal(exportPageQueries(), beforeCancel, "nothing is queried after the download is cancelled");
});

// Reads a CSV export to the end and splits it into lines (the BOM dropped by the decoder).
async function csvLines(res: Response): Promise<string[]> {
  return (await res.text()).trimEnd().split("\n");
}

test("a CSV export of EXACTLY the cap is complete: no truncation row; one row more is cut and says so", async () => {
  exportRowBudget = 10_000;
  const exactToken = await mintAdmin();
  const exact = await runInScope(exactToken, () => exportRoute(req("/api/play-history/export?format=csv", exactToken)));
  assert.equal(exact.status, 200);
  const exactLines = await csvLines(exact);
  assert.equal(exactLines.length, 1 + 10_000, "the header and every row, and no notice");
  assert.ok(!exactLines.at(-1)!.includes("truncated"), "a complete export is not reported as cut");

  exportRowBudget = 10_001;
  const token = await mintAdmin();
  const over = await runInScope(token, () => exportRoute(req("/api/play-history/export?format=csv", token)));
  const overLines = await csvLines(over);
  assert.equal(overLines.length, 1 + 10_000 + 1, "the cap's rows, then the notice — the probe row is never written");
  assert.match(overLines.at(-1)!, /truncated at 10000 rows/);
});

test("a DB failure part-way through a CSV export is logged, not swallowed; a cancelled download is not", async () => {
  fullExportPages = true;
  exportQueryThrowsAt = 2;
  const token = await mintAdmin();
  const res = await runInScope(token, () => exportRoute(req("/api/play-history/export?format=csv", token)));
  await res.text().catch(() => "");
  assert.ok(errors.some((e) => e.startsWith("[play-history-export]") && e.includes("simulated DB failure mid-export")), `no scoped log: ${errors.join(" | ")}`);

  // The cancel path (the backpressure test's): the consumer going away logs nothing.
  errors.length = 0;
  exportQueryThrowsAt = null;
  const token2 = await mintAdmin();
  const res2 = await runInScope(token2, () => exportRoute(req("/api/play-history/export?format=csv", token2)));
  const reader = res2.body!.getReader();
  await reader.read();
  await reader.cancel();
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(errors.filter((e) => e.startsWith("[play-history-export]")), []);
});

test("an export whose paper-trail row can't be written is refused (500) before any row is read", async () => {
  auditThrows = true;
  for (const format of ["csv", "json"]) {
    const token = await mintAdmin();
    const res = await runInScope(token, () => exportRoute(req(`/api/play-history/export?format=${format}`, token)));
    assert.equal(res.status, 500, format);
    assert.deepEqual(await res.json(), { error: "The export could not be started — the server log has the details" });
  }
  assert.equal(exportPageQueries(), 0, "no viewer history is read without its audit row");
});

test("the JSON export orders by (startedAt, id) like the CSV, so equal start times come out in one stable order", async () => {
  const token = await mintAdmin();
  await runInScope(token, () => exportRoute(req("/api/play-history/export?format=json", token)));
  const sql = rawCalls.find((q) => q.includes('LEFT JOIN "MediaServerUser" msu'))!;
  assert.match(sql, /ORDER BY h\."startedAt" DESC, h\."id" DESC/);
});

// ═══ the history filter's platform list ═══════════════════════════════════════

test("?distinct=platforms is served from the activity cache: one DISTINCT scan, repeated after a clear", async () => {
  const listRoute = (await import("../src/app/api/play-history/route.ts")).GET;
  const token = await mintAdmin();
  const distinctScans = () => rawCalls.filter((sql) => sql.includes(`DISTINCT "platform"`)).length;
  for (let i = 0; i < 2; i++) {
    const res = await listRoute(req("/api/play-history?distinct=platforms", token), undefined);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [], "the wire shape stays a string array");
  }
  assert.equal(distinctScans(), 1, "the table's mount-time fetch no longer rescans PlayHistory every time");
  clearActivityCache();
  await listRoute(req("/api/play-history?distinct=platforms", token), undefined);
  assert.equal(distinctScans(), 2, "a finalize's clear lets a new platform show up");
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

test("DELETE that lost the race to a concurrent delete still answers 204 but audits nothing — the delete that won wrote the row", async () => {
  deleteRaced = true;
  const token = await mintAdmin();
  const before = auditRows.length;
  const res = await idMod.DELETE(req("/api/play-history/ph-del", token, "DELETE"), { params: Promise.resolve({ id: "ph-del" }) });
  assert.equal(res.status, 204);
  await new Promise((r) => setImmediate(r));
  assert.equal(auditRows.length, before, "no PLAY_HISTORY_DELETE for a delete this call didn't make");
  assert.deepEqual(deletedIds, []);
});

test("neither route console.errors on its happy path (guardrail 7)", () => {
  assert.deepEqual(errors, []);
});
