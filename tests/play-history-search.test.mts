// The `?search=` parameter on the three admin play-history read paths:
// the list route's GROUPED and UNGROUPED modes (src/app/api/play-history/
// route.ts) and the CSV/JSON export (…/export/route.ts). All three read the
// same param off the same URLSearchParams the admin table builds, so all three
// have to answer the same question the same way.
//
// The regression this file exists to kill: the ungrouped and export paths used
// to build a Prisma `where` and pass the term through sanitizeContainsSearch,
// which STRIPS `%`, `_` and `\`. Stripping is the only option Prisma leaves —
// its `contains` filter emits an ILIKE with no ESCAPE clause — but it silently
// changes the question: a search for `john_doe` went to the database as
// `johndoe`, which matches NOTHING for the user or title actually named
// `john_doe`. The grouped path never had the bug; it has always escaped the
// term and paired it with `ESCAPE '\'` in raw SQL. Now all three share that.
//
// Both halves of the pairing are load-bearing, and each has its own failure:
//   • escape WITHOUT the `ESCAPE '\'` clause → Postgres reads the backslashes
//     as data and the search matches nothing (a different silent zero-result).
//   • the clause WITHOUT escaping → `%`/`_` stay live wildcards, so a
//     wildcard-laden term expands into an unindexable pattern scan (the
//     search-box DoS both helpers exist to prevent).
// So the tests pin BEHAVIOUR (a `_` matches one literal underscore, a `%`-laden
// term does not expand) rather than just the bind string, and separately assert
// structurally that no ILIKE anywhere ships without its ESCAPE clause.
//
// This is NOT an injection concern and these tests do not treat it as one: the
// term is a bound `$N` parameter on every path, and only whitelisted column
// names and comparators reach the SQL string. tests/play-history-sql.test.mts
// owns that discipline for the stats layer; the placeholder/param lockstep
// audit below is the same check applied to every query these routes issue —
// it is what catches the export's keyset-cursor bind arithmetic drifting.
//
// Harness: the tests/play-history-admin-guard.test.mts idiom (real signed
// session JWTs over bearer transport, which skips UA-fingerprint binding per
// guardrail 6b) plus the tests/watch-history-mine-route.test.mts idiom for raw
// SQL — $queryRawUnsafe is a JS MIRROR of the query contract. The mirror
// implements Postgres ILIKE-with-ESCAPE faithfully (a real pattern compiler,
// not a substring test) precisely so it can tell "matched literally" apart
// from "expanded as a wildcard"; a substring mirror would pass either way.
// The SQL text itself is proven against a real Postgres in live verification,
// not here. No DB, no network.
//
// Not covered: the export's cursor is exercised for its SQL/bind shape on the
// second page (via a forced full first page) but not for real keyset ordering
// over >PAGE_SIZE rows, and sort columns other than the default are exercised
// only through the mirror's own ORDER BY parsing.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

// Next's async-local-storage shim captures globalThis.AsyncLocalStorage at
// module load — assign it BEFORE anything pulls in next/* (the export route's
// requireAuth() reads next/headers headers(), which needs a request scope).
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "ph-search-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (() => {
  throw new Error("unexpected network call from play-history-search tests");
}) as unknown as typeof fetch;

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");

// ── request scope (the export route authenticates through next/headers) ──────
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const cjsRequire = createRequire(import.meta.url);
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

function runInScope<T>(token: string, fn: () => T): T {
  const reqHeaders = new Headers({
    "x-forwarded-for": "203.0.113.5",
    authorization: `Bearer ${token}`,
  });
  const workStore = {
    route: "/play-history-search.test",
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

// ── Postgres ILIKE, faithfully ───────────────────────────────────────────────
// Compiles a LIKE pattern the way Postgres does with `ESCAPE '\'`: a backslash
// makes the next character literal, an UNESCAPED `%` matches any run and an
// unescaped `_` matches exactly one character. Anchored, case-insensitive.
//
// Implementing this properly is the point of the file. A mirror that just
// unescaped the pattern and ran `String.includes` would report a pass whether
// or not the wildcards were neutralized, which is exactly the bug class here.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ilikeMatches(value: string, pattern: string): boolean {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[++i];
      // Postgres: "LIKE pattern must not end with escape character".
      assert.ok(next !== undefined, `LIKE pattern ends with a lone escape: ${pattern}`);
      out += escapeRegExp(next!);
      continue;
    }
    if (ch === "%") { out += "[\\s\\S]*"; continue; }
    if (ch === "_") { out += "[\\s\\S]"; continue; }
    out += escapeRegExp(ch);
  }
  return new RegExp(`^${out}$`, "i").test(value);
}

// ── in-memory rows ───────────────────────────────────────────────────────────
interface HistoryRow {
  id: string;
  source: string;
  serverInstance: string;
  startedAt: Date;
  stoppedAt: Date;
  duration: number;
  playDuration: number;
  pausedDuration: number;
  watched: boolean;
  completed: boolean;
  mediaServerUserId: string;
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV" | null;
  title: string;
  year: string | null;
  posterPath: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  sourceSessionId: string | null;
  sourceItemId: string | null;
  platform: string | null;
  player: string | null;
  device: string | null;
  ipAddress: string | null;
  playMethod: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  bitrate: number | null;
  videoDecision: string | null;
  audioDecision: string | null;
  container: string | null;
  transcodeReason: string | null;
  location: string | null;
  bandwidth: number | null;
  secure: boolean | null;
  relayed: boolean | null;
  introStartMs: number | null;
  introEndMs: number | null;
  creditsStartMs: number | null;
  creditsEndMs: number | null;
  referenceId: string | null;
  createdAt: Date;
}

interface ServerUser {
  id: string;
  username: string;
  source: string;
  thumbUrl: string | null;
  userId: string | null;
  userName: string | null;
}

const historyRows: HistoryRow[] = [];
const serverUsers = new Map<string, ServerUser>();
let rowSeq = 0;

function addServerUser(id: string, username: string, extra: Partial<ServerUser> = {}): ServerUser {
  const row: ServerUser = {
    id, username, source: "plex", thumbUrl: null, userId: null, userName: null, ...extra,
  };
  serverUsers.set(id, row);
  return row;
}

// Descending ids/timestamps so the default (startedAt DESC, id DESC) ordering
// is deterministic: each row is one second older than the one before it.
function addPlay(msuId: string, over: Partial<HistoryRow> = {}): HistoryRow {
  rowSeq++;
  const startedAt = new Date(Date.UTC(2026, 6, 1, 12, 0, 0) - rowSeq * 1000);
  const row: HistoryRow = {
    id: `play-${String(1000 - rowSeq)}`,
    source: "plex",
    serverInstance: "",
    startedAt,
    stoppedAt: new Date(startedAt.getTime() + 3_600_000),
    duration: 3600,
    playDuration: 3400,
    pausedDuration: 0,
    watched: true,
    completed: true,
    mediaServerUserId: msuId,
    tmdbId: null,
    mediaType: "MOVIE",
    title: "Untitled",
    year: "2026",
    posterPath: null,
    seasonNumber: null,
    episodeNumber: null,
    episodeTitle: null,
    sourceSessionId: null,
    sourceItemId: null,
    platform: "Chrome",
    player: "Web",
    device: "Mac",
    ipAddress: null,
    playMethod: "DirectPlay",
    videoCodec: "h264",
    audioCodec: "aac",
    resolution: "1080",
    bitrate: 8000,
    videoDecision: "directplay",
    audioDecision: "directplay",
    container: "mkv",
    transcodeReason: null,
    location: "lan",
    bandwidth: null,
    secure: null,
    relayed: null,
    introStartMs: null,
    introEndMs: null,
    creditsStartMs: null,
    creditsEndMs: null,
    referenceId: null,
    createdAt: startedAt,
    ...over,
  };
  historyRows.push(row);
  return row;
}

// ── the raw-SQL mirror ───────────────────────────────────────────────────────
const rawCalls: { sql: string; binds: unknown[] }[] = [];

// Every `$N` the SQL references must exist, and every bind must be referenced.
// An orphaned bind is the off-by-one signature (the SQL reads $2 while the
// value sits at params[0]) that shipped once already in this module family —
// see tests/play-history-sql.test.mts.
function auditPlaceholders(sql: string, binds: unknown[]): void {
  const used = new Set<number>();
  for (const m of sql.matchAll(/\$(\d+)/g)) {
    const i = Number(m[1]);
    assert.ok(i >= 1, `SQL references $${i}; placeholders are 1-based`);
    assert.ok(i <= binds.length, `SQL references $${i} but only ${binds.length} binds were passed`);
    used.add(i);
  }
  for (let i = 1; i <= binds.length; i++) {
    assert.ok(used.has(i), `bind $${i} is never referenced by the SQL — placeholder/param drift`);
  }
}

// No ILIKE may ship without `ESCAPE '\'`. Dropping the clause is invisible to
// the type checker and to any test that only inspects the bind string, but it
// turns every escaped term into a zero-result search against Postgres.
function auditIlikeEscapes(sql: string): void {
  for (const m of sql.matchAll(/ILIKE \$\d+( ESCAPE '\\')?/g)) {
    assert.ok(
      m[1],
      `ILIKE without an ESCAPE clause — the escaped term would be matched with its backslashes: ${m[0]}`,
    );
  }
}

function usernameOf(row: HistoryRow): string {
  return serverUsers.get(row.mediaServerUserId)?.username ?? "";
}

// Evaluate the filter fragments these routes can emit. Only the filters the
// tests actually set are interpreted; auditPlaceholders above independently
// guarantees nothing else slipped into the query unbound.
function matchingRows(sql: string, binds: unknown[]): HistoryRow[] {
  let rows = [...historyRows];

  const src = sql.match(/h\."source" = \$(\d+)/);
  if (src) {
    const want = binds[Number(src[1]) - 1];
    rows = rows.filter((r) => r.source === want);
  }

  const titleIlike = sql.match(/h\."title" ILIKE \$(\d+) ESCAPE '\\'/);
  if (titleIlike) {
    const ipIlike = sql.match(/h\."ipAddress" ILIKE \$(\d+) ESCAPE '\\'/);
    const userIlike = sql.match(/msu2\."username" ILIKE \$(\d+) ESCAPE '\\'/);
    assert.ok(ipIlike && userIlike, "the search fragment must cover title, ipAddress and username");
    const titlePattern = binds[Number(titleIlike[1]) - 1] as string;
    const ipPattern = binds[Number(ipIlike![1]) - 1] as string;
    const userPattern = binds[Number(userIlike![1]) - 1] as string;
    rows = rows.filter(
      (r) =>
        ilikeMatches(r.title, titlePattern) ||
        // NULL ILIKE <pattern> is NULL in SQL, never true.
        (r.ipAddress != null && ilikeMatches(r.ipAddress, ipPattern)) ||
        ilikeMatches(usernameOf(r), userPattern),
    );
  }

  return rows;
}

function cmp(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function paginate<T extends { startedAt: Date; id: string }>(
  rows: T[],
  sql: string,
  binds: unknown[],
): T[] {
  const ord = sql.match(/ORDER BY [hb]\."(\w+)" (ASC|DESC)/);
  assert.ok(ord, "every page query must carry an explicit ORDER BY");
  const dir = ord![2] === "ASC" ? 1 : -1;
  const col = ord![1] as keyof T;
  const sorted = [...rows].sort(
    (a, b) => cmp(a[col], b[col]) * dir || cmp(a.id, b.id) * dir,
  );
  const lim = sql.match(/LIMIT \$(\d+)(?: OFFSET \$(\d+))?/);
  assert.ok(lim, "every page query must carry a bound LIMIT");
  const limit = Number(binds[Number(lim![1]) - 1]);
  const offset = lim![2] ? Number(binds[Number(lim![2]) - 1]) : 0;
  return sorted.slice(offset, offset + limit);
}

function withJoin(row: HistoryRow) {
  const msu = serverUsers.get(row.mediaServerUserId);
  return {
    ...row,
    msu_username: msu?.username ?? null,
    msu_source: msu?.source ?? null,
    msu_thumb_url: msu?.thumbUrl ?? null,
    msu_user_id: msu?.userId ?? null,
    msu_user_name: msu?.userName ?? null,
  };
}

function groupedShape(row: HistoryRow) {
  // Every seeded row starts its own chain (no referenceId), so the window
  // aggregates collapse to the row's own values.
  return {
    ...withJoin(row),
    chain_id: row.id,
    rn: 1,
    segment_count: 1,
    total_play_duration: row.playDuration,
    total_paused_duration: row.pausedDuration,
    first_started_at: row.startedAt,
    last_stopped_at: row.stoppedAt,
    chain_watched: row.watched,
    chain_completed: row.completed,
  };
}

function exportShape(row: HistoryRow) {
  return {
    id: row.id,
    title: row.title,
    mediaType: row.mediaType,
    year: row.year,
    seasonNumber: row.seasonNumber,
    episodeNumber: row.episodeNumber,
    episodeTitle: row.episodeTitle,
    source: row.source,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt,
    duration: row.duration,
    playDuration: row.playDuration,
    pausedDuration: row.pausedDuration,
    watched: row.watched,
    platform: row.platform,
    player: row.player,
    device: row.device,
    playMethod: row.playMethod,
    videoCodec: row.videoCodec,
    audioCodec: row.audioCodec,
    resolution: row.resolution,
    bitrate: row.bitrate,
    videoDecision: row.videoDecision,
    audioDecision: row.audioDecision,
    container: row.container,
    username: usernameOf(row),
  };
}

// When > 0, the next export page query returns a FULL page of synthetic rows so
// the streaming loop is forced round again and has to build a keyset cursor.
let exportFullPages = 0;

shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string, ...binds: unknown[]) => {
  rawCalls.push({ sql, binds });
  auditPlaceholders(sql, binds);
  auditIlikeEscapes(sql);

  const rows = matchingRows(sql, binds);

  if (sql.includes("COUNT(DISTINCT") || sql.includes("COUNT(*)::int")) {
    return [{ total: rows.length }];
  }
  if (sql.includes("WITH base AS")) {
    return paginate(rows, sql, binds).map(groupedShape);
  }
  if (sql.includes("SELECT h.*")) {
    return paginate(rows, sql, binds).map(withJoin);
  }
  // Export page query.
  if (exportFullPages > 0) {
    exportFullPages--;
    const lim = sql.match(/LIMIT \$(\d+)/)!;
    const take = Number(binds[Number(lim[1]) - 1]);
    const template = historyRows[0]!;
    return Array.from({ length: take }, (_, i) =>
      exportShape({
        ...template,
        id: `synthetic-${String(take - i).padStart(6, "0")}`,
        startedAt: new Date(template.startedAt.getTime() - (i + 1) * 1000),
      }),
    );
  }
  return paginate(rows, sql, binds).map(exportShape);
});

// Nothing on these paths should reach the Prisma query builder any more — the
// ungrouped list and the export were the last two `findMany` callers, and both
// are raw now. Leave the tripwires in so a partial revert is loud.
shadowPrismaModel(prisma, "playHistory", {
  findMany: async () => { throw new Error("play-history search must not fall back to prisma.playHistory.findMany"); },
  count: async () => { throw new Error("play-history search must not fall back to prisma.playHistory.count"); },
});
// Poster resolution: no cached art, so the response's poster fields stay null.
shadowPrismaModel(prisma, "tmdbMediaCore", { findMany: async () => [] });
shadowPrismaModel(prisma, "tmdbCache", { findMany: async () => [] });

const auditRows: { action: string; details: string | null }[] = [];
shadowPrismaModel(prisma, "auditLog", {
  create: async (a: { data: { action: string; details: string | null } }) => {
    auditRows.push({ action: a.data.action, details: a.data.details });
    return a.data;
  },
});

// ── sessions ─────────────────────────────────────────────────────────────────
type DbUser = {
  role: string;
  permissions: bigint;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  email: string | null;
  notificationEmail: string | null;
  passwordHash: string | null;
  plexUserId: string | null;
  jellyfinUserId: string | null;
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

let sessionSeq = 0;
// A FRESH admin per call by default: the export route rate-limits at 5 per
// hour keyed on the session user alone, so reusing one identity across the
// export tests would 429 partway through and hide a real failure.
async function mintAdmin(): Promise<string> {
  sessionSeq++;
  const userId = `admin-${sessionSeq}`;
  const sessionId = `sess-${sessionSeq}`;
  usersById.set(userId, {
    role: "ADMIN", permissions: 0n, mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: `admin-${sessionSeq}@example.com`, notificationEmail: null, passwordHash: null,
    plexUserId: null, jellyfinUserId: null,
  });
  authSessions.set(sessionId, { sessionId, userId, expiresAt: new Date(Date.now() + 86_400_000) });
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "ADMIN", permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

const list = (await import("../src/app/api/play-history/route.ts")).GET;
const exportRoute = (await import("../src/app/api/play-history/export/route.ts")).GET;

function req(path: string, token: string) {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.5" },
  });
}

interface ListItem {
  id: string;
  title: string;
  mediaServerUser: { username: string; source: string; thumbUrl: string | null; user: { name: string | null } | null };
}

async function fetchList(query: Record<string, string>): Promise<{ items: ListItem[]; total: number }> {
  const token = await mintAdmin();
  const qs = new URLSearchParams(query).toString();
  const res = await list(req(`/api/play-history?${qs}`, token), undefined);
  assert.equal(res.status, 200, `list route returned ${res.status}`);
  return (await res.json()) as { items: ListItem[]; total: number };
}

async function fetchExportJson(query: Record<string, string>): Promise<{ id: string; title: string; username: string }[]> {
  const token = await mintAdmin();
  const qs = new URLSearchParams({ ...query, format: "json" }).toString();
  const res = await runInScope(token, () => exportRoute(req(`/api/play-history/export?${qs}`, token)));
  assert.equal(res.status, 200, `export route returned ${res.status}`);
  return (await res.json()) as { id: string; title: string; username: string }[];
}

// CSV body → the Title column of each data row (the header line is dropped).
async function fetchExportCsvTitles(query: Record<string, string>): Promise<string[]> {
  const token = await mintAdmin();
  const qs = new URLSearchParams({ ...query, format: "csv" }).toString();
  const res = await runInScope(token, () => exportRoute(req(`/api/play-history/export?${qs}`, token)));
  assert.equal(res.status, 200, `export route returned ${res.status}`);
  const body = await res.text();
  return body
    .split("\n")
    .slice(1)
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => (l.startsWith('"') ? l.slice(1, l.indexOf('"', 1)) : l.slice(0, l.indexOf(","))));
}

// Titles/usernames chosen so a stripped term (`john_doe` → `johndoe`) and a
// wildcard-expanded one (`ma%trix` → "ma…trix") each have a decoy to land on,
// and the literal answer is a DIFFERENT row from both.
function seed(): void {
  historyRows.length = 0;
  serverUsers.clear();
  rowSeq = 0;
  addServerUser("msu-underscore", "john_doe", { userId: "u-1", userName: "John" });
  addServerUser("msu-stripped", "johndoe");
  addServerUser("msu-wild", "johnXdoe");
  addServerUser("msu-plain", "alice");
  // Linked to an account that has no display name — `{ name: null }`, which is
  // a different answer from "not linked at all".
  addServerUser("msu-nameless", "bob", { userId: "u-2", userName: null });

  addPlay("msu-underscore", { title: "Underscore Owner" });
  addPlay("msu-stripped", { title: "Stripped Decoy" });
  addPlay("msu-wild", { title: "Wildcard Decoy" });
  addPlay("msu-nameless", { title: "Nameless Owner" });
  addPlay("msu-plain", { title: "100% Wolf" });
  addPlay("msu-plain", { title: "Man of Steel" });
  addPlay("msu-plain", { title: "The Matrix" });
  addPlay("msu-plain", { title: "Unrelated", ipAddress: "10.0.0.7" });
}

beforeEach(() => {
  seed();
  rawCalls.length = 0;
  auditRows.length = 0;
  exportFullPages = 0;
  warns.length = 0;
  errors.length = 0;
});

// ── the headline pins ────────────────────────────────────────────────────────

test("ungrouped: an underscore in the term matches ONE literal underscore — not any character, not nothing", async () => {
  const { items, total } = await fetchList({ ungrouped: "true", search: "john_doe" });

  // The row whose username IS `john_doe`, and nothing else. `johnXdoe` proves
  // the `_` was not left live as a single-character wildcard; `johndoe` proves
  // the character was not stripped out of the term (the shipped bug — that
  // search returned the decoy and MISSED the row the admin was looking for).
  assert.deepEqual(items.map((i) => i.title), ["Underscore Owner"]);
  assert.equal(items[0]!.mediaServerUser.username, "john_doe");
  assert.equal(total, 1, "the count query must agree with the page query");

  // The bind is the escaped pattern, ready for the ESCAPE clause beside it.
  const pageCall = rawCalls.find((c) => c.sql.includes("SELECT h.*"))!;
  assert.ok(
    pageCall.binds.includes("%john\\_doe%"),
    `expected an ILIKE-escaped bind, got ${JSON.stringify(pageCall.binds)}`,
  );
});

test("ungrouped: a %-laden term is matched literally and never expands into a wildcard scan", async () => {
  // A literal `%` still finds the title that actually contains one...
  const literal = await fetchList({ ungrouped: "true", search: "100%" });
  assert.deepEqual(literal.items.map((i) => i.title), ["100% Wolf"]);

  // ...and a term whose `%` sits BETWEEN two fragments matches nothing, rather
  // than bridging "Ma(n of Steel / trix)" the way a live wildcard would. This
  // is the DoS half: an unescaped `%`-laden term is an unindexable pattern scan.
  const bridged = await fetchList({ ungrouped: "true", search: "ma%x" });
  assert.deepEqual(bridged.items, []);
  assert.equal(bridged.total, 0);

  // A term that is nothing BUT wildcards must not degenerate into "match all".
  const allWild = await fetchList({ ungrouped: "true", search: "%_%_%" });
  assert.deepEqual(allWild.items, []);
  const wildCall = rawCalls.filter((c) => c.sql.includes("SELECT h.*")).at(-1)!;
  assert.ok(wildCall.binds.includes("%\\%\\_\\%\\_\\%%"), `got ${JSON.stringify(wildCall.binds)}`);
});

test("export (JSON and CSV): the same term, the same rows — both formats escape rather than strip", async () => {
  const json = await fetchExportJson({ search: "john_doe" });
  assert.deepEqual(json.map((r) => r.title), ["Underscore Owner"]);
  assert.deepEqual(json.map((r) => r.username), ["john_doe"]);

  const csv = await fetchExportCsvTitles({ search: "john_doe" });
  assert.deepEqual(csv, ["Underscore Owner"]);

  const bridgedJson = await fetchExportJson({ search: "ma%x" });
  assert.deepEqual(bridgedJson, []);
  const bridgedCsv = await fetchExportCsvTitles({ search: "ma%x" });
  assert.deepEqual(bridgedCsv, []);

  const literalCsv = await fetchExportCsvTitles({ search: "100%" });
  assert.deepEqual(literalCsv, ["100% Wolf"]);
});

test("grouped (the path that was always right): unchanged — literal underscore, no wildcard expansion", async () => {
  const underscore = await fetchList({ search: "john_doe" });
  assert.deepEqual(underscore.items.map((i) => i.title), ["Underscore Owner"]);
  assert.equal(underscore.total, 1);

  const bridged = await fetchList({ search: "ma%x" });
  assert.deepEqual(bridged.items, []);

  const literal = await fetchList({ search: "100%" });
  assert.deepEqual(literal.items.map((i) => i.title), ["100% Wolf"]);
});

// ── the structural pins behind the behaviour ─────────────────────────────────

test("every ILIKE on every path carries ESCAPE '\\' — the escape and the clause ship together", async () => {
  await fetchList({ ungrouped: "true", search: "a_b" });
  await fetchList({ search: "a_b" });
  await fetchExportJson({ search: "a_b" });
  await fetchExportCsvTitles({ search: "a_b" });

  const withIlike = rawCalls.filter((c) => c.sql.includes("ILIKE"));
  // page + count for each list mode, one query per export format.
  assert.equal(withIlike.length, 6, `expected 6 searching queries, saw ${withIlike.length}`);
  for (const call of withIlike) {
    const clauses = call.sql.match(/ILIKE \$\d+ ESCAPE '\\'/g) ?? [];
    assert.equal(clauses.length, 3, "title, ipAddress and username each need their own ESCAPE clause");
    // auditIlikeEscapes already ran inside the stub; this is the positive form.
    assert.ok(!/ILIKE \$\d+(?! ESCAPE)/.test(call.sql));
    assert.ok(call.binds.includes("%a\\_b%"));
  }
});

test("the term is never interpolated into SQL — it is always a bound parameter", async () => {
  // A term carrying SQL punctuation must appear ONLY in the binds. This is not
  // the reason the escaping exists (see the file header), but the discipline
  // has to survive the rewrite that moved these paths onto raw SQL.
  const hostile = "'; DROP TABLE \"PlayHistory\"; --";
  await fetchList({ ungrouped: "true", search: hostile });
  await fetchExportJson({ search: hostile });

  assert.ok(rawCalls.length > 0);
  for (const call of rawCalls) {
    assert.ok(!call.sql.includes("DROP TABLE"), "the search term reached the SQL string");
  }
  const searching = rawCalls.filter((c) => c.sql.includes("ILIKE"));
  assert.ok(searching.length > 0);
  for (const call of searching) {
    assert.ok(call.binds.some((b) => typeof b === "string" && b.includes("DROP TABLE")));
  }
});

test("search composes with the other filters and the binds stay in lockstep", async () => {
  addPlay("msu-underscore", { title: "Jellyfin Watch", source: "jellyfin" });

  // source=plex must exclude the jellyfin row even though its username matches.
  const { items, total } = await fetchList({ ungrouped: "true", source: "plex", search: "john_doe" });
  assert.deepEqual(items.map((i) => i.title), ["Underscore Owner"]);
  assert.equal(total, 1);

  // Every query issued had its placeholders audited in the stub; assert the
  // filter actually contributed a bind rather than being silently dropped.
  const pageCall = rawCalls.find((c) => c.sql.includes("SELECT h.*"))!;
  assert.ok(pageCall.binds.includes("plex"));
  assert.ok(pageCall.binds.includes("%john\\_doe%"));
});

test("the export's keyset cursor binds after the filters, with the search term still in place", async () => {
  // Force a full first page so the streaming loop goes round again and has to
  // build a cursor on top of the filter binds — the arithmetic that replaced
  // Prisma's `cursor` + `skip: 1`.
  exportFullPages = 1;
  await fetchExportCsvTitles({ search: "john_doe" });

  const pages = rawCalls.filter((c) => c.sql.includes('SELECT h."id", h."title"'));
  assert.equal(pages.length, 2, "a full first page must be followed by a second fetch");

  const [first, second] = pages;
  assert.ok(!first!.sql.includes('h."startedAt" <'), "the first page must not carry a cursor");
  assert.ok(
    /AND \(h\."startedAt" < \$(\d+) OR \(h\."startedAt" = \$\1 AND h\."id" < \$\d+\)\)/.test(second!.sql),
    `second page is missing the keyset predicate: ${second!.sql}`,
  );

  // The search fragment's three binds (title / ipAddress / username) come
  // first, then the cursor pair, then the LIMIT — and the cursor values are
  // the last row the first page emitted.
  assert.equal(second!.binds.length, 6);
  assert.deepEqual(second!.binds.slice(0, 3), ["%john\\_doe%", "%john\\_doe%", "%john\\_doe%"]);
  assert.ok(second!.binds[3] instanceof Date);
  assert.equal(second!.binds[4], "synthetic-000001");
  assert.equal(second!.binds[5], 1000);
});

// ── contract details that had to survive the rewrite ─────────────────────────

test("the ungrouped response keeps the nested mediaServerUser shape (including a linked user's name)", async () => {
  const { items } = await fetchList({ ungrouped: "true", search: "john_doe" });
  assert.deepEqual(items[0]!.mediaServerUser, {
    username: "john_doe",
    source: "plex",
    thumbUrl: null,
    user: { name: "John" },
  });

  // An UNLINKED server user is `user: null`, not `{ name: null }` — the shape
  // Prisma's include produced. The two must stay distinguishable, which is why
  // the join keys presence off the User id and not off the name: a linked
  // account that simply has no display name is `{ name: null }`, and reading it
  // as "unlinked" would drop a real account link from the payload.
  const plain = await fetchList({ ungrouped: "true", search: "alice" });
  assert.ok(plain.items.length > 0);
  assert.equal(plain.items[0]!.mediaServerUser.user, null);

  const nameless = await fetchList({ ungrouped: "true", search: "bob" });
  assert.deepEqual(nameless.items.map((i) => i.title), ["Nameless Owner"]);
  assert.deepEqual(nameless.items[0]!.mediaServerUser.user, { name: null });
});

test("the export's audit row records the search term as typed, not as a stripped approximation", async () => {
  await fetchExportJson({ search: "john_doe" });
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0]!.action, "PLAY_HISTORY_EXPORT");
  const details = JSON.parse(auditRows[0]!.details!) as { filters: { search: string | null } };
  // The paper trail has to describe the export that actually ran. Logging the
  // stripped form recorded a scope (`johndoe`) nobody asked for.
  assert.equal(details.filters.search, "john_doe");
});

test("an empty or whitespace-only search adds no ILIKE at all", async () => {
  await fetchList({ ungrouped: "true", search: "   " });
  await fetchExportJson({ search: "" });
  assert.equal(rawCalls.filter((c) => c.sql.includes("ILIKE")).length, 0);
  // ...and the unfiltered list still returns everything.
  const all = await fetchList({ ungrouped: "true" });
  assert.equal(all.total, historyRows.length);
});

test("the search paths stay silent (guardrail 7)", () => {
  assert.deepEqual(warns, []);
  assert.deepEqual(errors, []);
});

// The grouped path computes chain-wide counterparts of pausedDuration /
// startedAt / stoppedAt (SUM / MIN / MAX window aggregates) that the detail
// panel reads beside totalPlayDuration. Both modes have to carry them: the
// panel reads `totalPausedDuration ?? pausedDuration` (etc.) unconditionally,
// so an ungrouped response that omits the mirror is fine, but a grouped one
// that stops mapping the aliases silently regresses the panel to the newest
// segment's values (the defect this pins). The mirror's grouped rows are all
// single-segment chains, so the SUM/MIN/MAX arithmetic itself is Postgres's
// and is not exercised here — only that the route maps the aliases through.
interface ChainFields {
  pausedDuration: number | null;
  startedAt: string;
  stoppedAt: string | null;
  segmentCount: number;
  totalPlayDuration: number;
  totalPausedDuration: number | null;
  firstStartedAt: string;
  lastStoppedAt: string | null;
}

test("ungrouped: every item mirrors the chain-wide fields from its own single segment", async () => {
  addPlay("msu-plain", { title: "Paused Twice", pausedDuration: 120 });
  const { items } = await fetchList({ ungrouped: "true", search: "Paused Twice" });
  assert.equal(items.length, 1);
  const it = items[0] as unknown as ChainFields;
  assert.equal(it.segmentCount, 1);
  assert.equal(it.totalPausedDuration, 120);
  assert.equal(it.totalPausedDuration, it.pausedDuration);
  assert.equal(it.firstStartedAt, it.startedAt);
  assert.equal(it.lastStoppedAt, it.stoppedAt);
  assert.ok(typeof it.firstStartedAt === "string" && it.firstStartedAt.length > 0);
});

test("grouped: the window aliases map through as totalPausedDuration / firstStartedAt / lastStoppedAt", async () => {
  addPlay("msu-plain", { title: "Paused Twice", pausedDuration: 120 });
  const { items } = await fetchList({ search: "Paused Twice" });
  assert.equal(items.length, 1);
  const it = items[0] as unknown as ChainFields & Record<string, unknown>;
  assert.equal(it.totalPausedDuration, 120);
  assert.equal(it.firstStartedAt, it.startedAt);
  assert.equal(it.lastStoppedAt, it.stoppedAt);
  // The raw aliases the mirror emitted are what the route read — the mapped
  // values must equal them, not the representative row's columns by accident.
  assert.equal(it.totalPausedDuration, it.total_paused_duration);
  assert.equal(it.firstStartedAt, it.first_started_at);
  assert.equal(it.lastStoppedAt, it.last_stopped_at);
});
