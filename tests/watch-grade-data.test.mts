// Tests for the DATA half of request watch grades — src/lib/watch-grade-data.ts,
// the batch identity resolver it shares with my-watch-history.ts, and the
// GET /api/admin/users/[id]/watch-grade route. The grading RULES are pinned
// separately in tests/watch-grade.test.mts; here the question is whether the
// right facts reach them.
//
// The pins that matter:
//
//   1. A PROVIDER SUBJECT MAKES A USER OBSERVABLE. A Plex MediaServerUser row is
//      created at the account's first recorded play, so the person who requests
//      and never watches anything has NO row at all. Reading "no row" as
//      "unlinked" would exempt exactly the user this feature exists to grade.
//      Their subject (User.plexUserId) is proof their plays would be seen — unless
//      an admin pinned that subject's row to someone else.
//   2. ONE LINKAGE RULE. resolveAccountMediaIdentities attributes rows by
//      evaluating the same linkedIdentityBranches the self-service history page
//      queries with; a parity test runs both over the awkward fixtures (manual
//      unlink, pin-to-self, pin-away, FK-only, subject-only).
//   3. COVERAGE. Scoring starts when history began on the LATEST tracked server
//      the user is on; untracked servers and servers with no history don't hold
//      it back, and plays through an identity on an untracked server still count.
//   4. OFF MEANS OFF. Feature flag off or tracking off ⇒ no grade and no request
//      query; a failing aggregate on a list page degrades to "no grades" instead
//      of breaking the Users page or the request queue.
//   5. THE ROUTE is MANAGE_USERS or MANAGE_REQUESTS, 404s an unknown user.
//
// Harness: in-memory prisma stubs (shadowPrismaModel) with an op log, a real
// signed session JWT over the bearer transport for the route (the
// my-stats-route idiom), and a $queryRaw stub that evaluates the play aggregate
// the way the SQL does — link pairs and request ids are read back out of the
// bound values, so a wrong identity list produces a wrong answer, not a pass.
// No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "watch-grade-data-test-secret-0123456789abc";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (() => {
  throw new Error("unexpected network call from watch-grade-data tests");
}) as unknown as typeof fetch;

const errors: string[] = [];
console.warn = () => {};
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// The feature-flag (10s) and play-history settings (15s) memos key off Date.now;
// every settings change advances the clock past both.
const realDateNow = Date.now;
let clockOffsetMs = 0;
Date.now = () => realDateNow() + clockOffsetMs;

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { resolveAccountMediaIdentities, resolveLinkedMediaServerUserIds } = await import(
  "../src/lib/my-watch-history.ts"
);
const {
  computeWatchGrades,
  getWatchGradeAvailability,
  getWatchGradeSummaries,
  getUserWatchGradeDetail,
  MAX_VERDICT_ROWS,
} = await import("../src/lib/watch-grade-data.ts");
const { Permission } = await import("../src/lib/permissions.ts");

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(realDateNow() - n * DAY);

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// ── in-memory state ──────────────────────────────────────────────────────────
type DbUser = {
  id: string;
  plexUserId: string | null;
  jellyfinUserId: string | null;
  role: string;
  permissions: bigint;
  email: string;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
};
type DbMsu = { id: string; source: string; sourceUserId: string; userId: string | null; manualUserLink: boolean };
type DbRequest = {
  id: string;
  requestedBy: string;
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  releaseYear: string | null;
  posterPath: string | null;
  status: string;
  createdAt: Date;
  availableAt: Date | null;
  updatedAt: Date;
};
type DbPlay = {
  mediaServerUserId: string;
  source: string;
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  seasonNumber: number | null;
  episodeNumber: number | null;
  startedAt: Date;
  playDuration: number;
  duration: number;
  watched: boolean;
  completed: boolean;
};
type DbEpisode = { source: string; tmdbId: number; seasonNumber: number; episodeNumber: number };

let settings = new Map<string, string>();
let users: DbUser[] = [];
let msus: DbMsu[] = [];
let requests: DbRequest[] = [];
let plays: DbPlay[] = [];
let episodes: DbEpisode[] = [];
let failPlayAggregate = false;
const authSessions = new Map<string, { sessionId: string; userId: string; expiresAt: Date }>();

function setSettings(rows: Record<string, string>): void {
  settings = new Map(Object.entries(rows));
  clockOffsetMs += 16_000;
  invalidateFeatureFlagCache();
}
const TRACKING_ON = {
  playHistoryEnabled: "true",
  playHistoryPlexEnabled: "true",
  playHistoryJellyfinEnabled: "true",
};

function user(id: string, over: Partial<DbUser> = {}): DbUser {
  const u: DbUser = {
    id,
    plexUserId: null,
    jellyfinUserId: null,
    role: "USER",
    permissions: 0n,
    email: `${id}@example.com`,
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    ...over,
  };
  users.push(u);
  return u;
}
function msu(id: string, over: Partial<DbMsu> & { source: string; sourceUserId: string }): DbMsu {
  const row: DbMsu = { id, userId: null, manualUserLink: false, ...over };
  msus.push(row);
  return row;
}
let reqSeq = 0;
function request(requestedBy: string, fulfilledDaysAgo: number, over: Partial<DbRequest> = {}): DbRequest {
  reqSeq++;
  const r: DbRequest = {
    id: `req-${reqSeq}`,
    requestedBy,
    tmdbId: 5000 + reqSeq,
    mediaType: "MOVIE",
    title: `Title ${reqSeq}`,
    releaseYear: "2025",
    posterPath: null,
    status: "AVAILABLE",
    createdAt: daysAgo(fulfilledDaysAgo + 3),
    availableAt: daysAgo(fulfilledDaysAgo),
    updatedAt: daysAgo(fulfilledDaysAgo),
    ...over,
  };
  requests.push(r);
  return r;
}
function play(msuId: string, r: { tmdbId: number; mediaType: "MOVIE" | "TV" }, startedDaysAgo: number, over: Partial<DbPlay> = {}): DbPlay {
  const row: DbPlay = {
    mediaServerUserId: msuId,
    source: msus.find((m) => m.id === msuId)?.source ?? "plex",
    tmdbId: r.tmdbId,
    mediaType: r.mediaType,
    seasonNumber: null,
    episodeNumber: null,
    startedAt: daysAgo(startedDaysAgo),
    playDuration: 6000,
    duration: 6000,
    watched: true,
    completed: true,
    ...over,
  };
  plays.push(row);
  return row;
}
// History exists on a source (someone watched something) without touching the user under test.
function historySince(source: string, startedDaysAgo: number): void {
  const bystander = msu(`bystander-${source}-${startedDaysAgo}`, { source, sourceUserId: `by-${source}-${startedDaysAgo}` });
  play(bystander.id, { tmdbId: 1, mediaType: "MOVIE" }, startedDaysAgo);
}

beforeEach(() => {
  ops = [];
  users = [];
  msus = [];
  requests = [];
  plays = [];
  episodes = [];
  errors.length = 0;
  failPlayAggregate = false;
  setSettings({ ...TRACKING_ON });
});

// ── matchers (narrow on purpose — an unexpected query shape throws) ─────────
function eqBranch(row: Record<string, unknown>, branch: Record<string, unknown>): boolean {
  return Object.entries(branch).every(([k, v]) => {
    if (!["userId", "source", "sourceUserId", "manualUserLink"].includes(k)) {
      throw new Error(`unexpected MediaServerUser filter key ${k}`);
    }
    if (v !== null && typeof v === "object") throw new Error(`unexpected non-equality filter on ${k}`);
    return row[k] === v;
  });
}

function requestMatches(r: DbRequest, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "requestedBy") {
      if (!(v as { in: string[] }).in.includes(r.requestedBy)) return false;
    } else if (k === "status") {
      if (r.status !== v) return false;
    } else if (k === "OR") {
      const ok = (v as Record<string, unknown>[]).some((branch) =>
        Object.entries(branch).every(([bk, bv]) => {
          const value = r[bk as keyof DbRequest] as Date | null;
          if (bv === null) return value === null;
          const gte = (bv as { gte: Date }).gte;
          if (!(gte instanceof Date)) throw new Error(`unexpected MediaRequest OR filter on ${bk}`);
          return value !== null && value.getTime() >= gte.getTime();
        }),
      );
      if (!ok) return false;
    } else {
      throw new Error(`unexpected MediaRequest filter key ${k}`);
    }
  }
  return true;
}

// ── stubs ────────────────────────────────────────────────────────────────────
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    ops.push({ op: "setting.findMany", args });
    return args.where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! }));
  },
  findUnique: async (args: { where: { key: string } }) => {
    const value = settings.get(args.where.key);
    return value === undefined ? null : { key: args.where.key, value };
  },
});

shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    ops.push({ op: "user.findUnique", args });
    const u = users.find((x) => x.id === args.where.id);
    return u ? { ...u } : null;
  },
  findMany: async (args: { where: { id: { in: string[] } } }) => {
    ops.push({ op: "user.findMany", args });
    return users.filter((u) => args.where.id.in.includes(u.id)).map((u) => ({ ...u }));
  },
  update: async () => ({}),
});

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) => authSessions.get(args.where.sessionId) ?? null,
  update: async () => ({}),
});

shadowPrismaModel(prisma, "mediaServerUser", {
  findMany: async (args: { where: { OR: Record<string, unknown>[] }; select?: Record<string, boolean> }) => {
    ops.push({ op: "mediaServerUser.findMany", args });
    return msus
      .filter((m) => args.where.OR.some((b) => eqBranch(m as unknown as Record<string, unknown>, b)))
      .map((m) => ({ ...m }));
  },
});

shadowPrismaModel(prisma, "mediaRequest", {
  findMany: async (args: { where: Record<string, unknown> }) => {
    ops.push({ op: "mediaRequest.findMany", args });
    return requests.filter((r) => requestMatches(r, args.where)).map((r) => ({ ...r }));
  },
});

shadowPrismaModel(prisma, "playHistory", {
  findFirst: async (args: { where: { source: string }; orderBy: { startedAt: string } }) => {
    ops.push({ op: "playHistory.findFirst", args });
    assert.deepEqual(args.orderBy, { startedAt: "asc" });
    const rows = plays.filter((p) => p.source === args.where.source).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    return rows[0] ? { startedAt: rows[0].startedAt } : null;
  },
});

type SqlArg = { text: string; values: unknown[] };
shadowPrismaClientMethod(prisma, "$queryRaw", async (sql: SqlArg) => {
  ops.push({ op: "$queryRaw", args: sql });
  if (sql.text.includes(`FROM "TVEpisodeCache"`)) {
    const ids = sql.values as number[];
    const out: { tmdbId: number; episodes: number }[] = [];
    for (const tmdbId of new Set(ids)) {
      const distinct = new Set(
        episodes.filter((e) => e.tmdbId === tmdbId && e.seasonNumber > 0).map((e) => `${e.seasonNumber}:${e.episodeNumber}`),
      );
      if (distinct.size > 0) out.push({ tmdbId, episodes: distinct.size });
    }
    return out;
  }
  if (sql.text.includes(`JOIN "PlayHistory" h`)) {
    if (failPlayAggregate) throw new Error("simulated aggregate failure");
    // (VALUES ($1::text, $2::text), …) — two bound values per link, then the request ids.
    const linkValueCount = (sql.text.match(/::text/g) ?? []).length;
    const linkValues = sql.values.slice(0, linkValueCount) as string[];
    const requestIds = sql.values.slice(linkValueCount) as string[];
    const links: { userId: string; msuId: string }[] = [];
    for (let i = 0; i < linkValues.length; i += 2) links.push({ userId: linkValues[i], msuId: linkValues[i + 1] });

    const groups = new Map<string, { requestId: string; seasonNumber: number | null; episodeNumber: number | null; anyWatched: boolean; playSeconds: number; durationSeconds: number }>();
    for (const id of requestIds) {
      const r = requests.find((x) => x.id === id);
      if (!r) continue;
      for (const link of links.filter((l) => l.userId === r.requestedBy)) {
        for (const p of plays) {
          if (p.mediaServerUserId !== link.msuId || p.tmdbId !== r.tmdbId || p.mediaType !== r.mediaType) continue;
          if (p.startedAt.getTime() < r.createdAt.getTime()) continue;
          const key = `${r.id}|${p.seasonNumber}|${p.episodeNumber}`;
          const g = groups.get(key) ?? { requestId: r.id, seasonNumber: p.seasonNumber, episodeNumber: p.episodeNumber, anyWatched: false, playSeconds: 0, durationSeconds: 0 };
          g.anyWatched ||= p.watched || p.completed;
          g.playSeconds += p.playDuration;
          g.durationSeconds = Math.max(g.durationSeconds, p.duration);
          groups.set(key, g);
        }
      }
    }
    return [...groups.values()];
  }
  throw new Error(`unexpected $queryRaw: ${sql.text.slice(0, 80)}`);
});

// Route handler, imported after every stub is in place.
const { GET: getWatchGrade } = await import("../src/app/api/admin/users/[id]/watch-grade/route.ts");

// ═══ availability ════════════════════════════════════════════════════════════

test("feature flag off ⇒ disabled, and no request is ever read", async () => {
  setSettings({ ...TRACKING_ON, "feature.behavior.watchGrades": "false" });
  user("u1");
  request("u1", 60);
  const { availability, grades } = await computeWatchGrades(["u1"]);
  assert.deepEqual(availability, { enabled: false, reason: "feature-off" });
  assert.equal(grades.size, 0);
  assert.equal(opsOf("mediaRequest.findMany").length, 0);
  assert.equal(await getWatchGradeSummaries(["u1"]), null);
});

test("tracking off (globally, or on every source) ⇒ disabled with reason tracking-off", async () => {
  setSettings({ playHistoryPlexEnabled: "true" }); // master switch off
  assert.deepEqual(await getWatchGradeAvailability(), { enabled: false, reason: "tracking-off" });
  setSettings({ playHistoryEnabled: "true" }); // no source enabled
  assert.deepEqual(await getWatchGradeAvailability(), { enabled: false, reason: "tracking-off" });
  assert.equal(opsOf("mediaRequest.findMany").length, 0);
});

test("availability carries parsed settings, the tracked sources and the watched threshold", async () => {
  setSettings({
    playHistoryEnabled: "true",
    playHistoryJellyfinEnabled: "true",
    playHistoryWatchedThreshold: "70",
    watchGradeGraceDays: "14",
    watchGradeWindowDays: "bogus",
  });
  assert.deepEqual(await getWatchGradeAvailability(), {
    enabled: true,
    settings: { graceDays: 14, windowDays: 365, tvEpisodePercent: 50 },
    trackedSources: ["jellyfin"],
    watchedThresholdPercent: 70,
  });
});

// ═══ identity ════════════════════════════════════════════════════════════════

test("a Plex subject with NO MediaServerUser row is observable: the never-watcher gets an F, not 'unlinked'", async () => {
  historySince("plex", 400);
  user("never", { plexUserId: "plex-never" });
  request("never", 60);
  request("never", 70);
  request("never", 80);

  const summaries = await getWatchGradeSummaries(["never"]);
  const s = summaries!.get("never")!;
  assert.equal(s.status, "graded");
  assert.equal(s.letter, "F");
  assert.equal(s.unwatched, 3);
});

test("a subject whose row an admin pinned to ANOTHER account does not make the user observable", async () => {
  historySince("plex", 400);
  user("owner");
  user("claimant", { plexUserId: "plex-shared" });
  msu("pinned", { source: "plex", sourceUserId: "plex-shared", userId: "owner", manualUserLink: true });
  request("claimant", 60);

  const s = (await getWatchGradeSummaries(["claimant"]))!.get("claimant")!;
  assert.equal(s.status, "unlinked");
  assert.equal(s.letter, null);
});

test("parity: the batch resolver attributes exactly the rows the per-user resolver returns", async () => {
  user("subjectOnly", { plexUserId: "p-A" });
  msu("m-A1", { source: "plex", sourceUserId: "p-A" }); // subject link
  msu("m-A2", { source: "jellyfin", sourceUserId: "j-x", userId: "subjectOnly" }); // FK link
  user("pinnedAway", { jellyfinUserId: "j-B" });
  user("pinTarget");
  msu("m-B1", { source: "jellyfin", sourceUserId: "j-B", userId: "pinTarget", manualUserLink: true });
  user("pinnedSelf", { plexUserId: "p-E" });
  msu("m-E1", { source: "plex", sourceUserId: "p-E", userId: "pinnedSelf", manualUserLink: true });
  user("manualUnlink", { plexUserId: "p-U" });
  msu("m-U1", { source: "plex", sourceUserId: "p-U", userId: null, manualUserLink: true });
  user("emailLinkedElsewhere", { plexUserId: "p-Z" });
  msu("m-Z1", { source: "plex", sourceUserId: "p-Z", userId: "pinTarget", manualUserLink: false });
  user("nothing");

  const ids = users.map((u) => u.id);
  ops = [];
  const batch = await resolveAccountMediaIdentities(ids);
  // Two identity reads for the whole batch.
  assert.equal(opsOf("user.findMany").length, 1);
  assert.equal(opsOf("mediaServerUser.findMany").length, 1);
  for (const id of ids) {
    const single = await resolveLinkedMediaServerUserIds(id);
    assert.deepEqual(
      batch.get(id)!.linked.map((l) => l.id).sort(),
      [...single].sort(),
      `linked set for ${id}`,
    );
  }
  assert.deepEqual(batch.get("subjectOnly")!.subjects, ["plex"]);
  assert.deepEqual(batch.get("pinnedAway")!.subjects, []);
  assert.deepEqual(batch.get("pinnedSelf")!.subjects, ["plex"]);
  // An admin UNLINK pins the row to nobody — that is still "not this account".
  assert.deepEqual(batch.get("manualUnlink")!.subjects, []);
  assert.deepEqual(batch.get("emailLinkedElsewhere")!.subjects, ["plex"]);
  assert.deepEqual(batch.get("nothing"), { linked: [], subjects: [] });
});

// ═══ plays ═══════════════════════════════════════════════════════════════════

test("plays count through every linked identity; only plays since the request count (SQL bound pinned)", async () => {
  historySince("plex", 400);
  user("u", { plexUserId: "p-u" });
  msu("m-plex", { source: "plex", sourceUserId: "p-u" });
  msu("m-jf", { source: "jellyfin", sourceUserId: "j-u", userId: "u" });
  const viaPlex = request("u", 60);
  const viaJellyfin = request("u", 70);
  const watchedBeforeRequest = request("u", 80);
  play("m-plex", viaPlex, 50);
  play("m-jf", viaJellyfin, 65);
  play("m-plex", watchedBeforeRequest, 200); // long before it was requested

  const { grades } = await computeWatchGrades(["u"]);
  const verdict = (id: string) => grades.get("u")!.verdicts.find((v) => v.requestId === id)!;
  assert.equal(verdict(viaPlex.id).watch, "watched");
  assert.equal(verdict(viaJellyfin.id).watch, "watched");
  assert.equal(verdict(watchedBeforeRequest.id).watch, "unwatched");

  const sql = (opsOf("$queryRaw").map((o) => o.args as SqlArg)).find((s) => s.text.includes(`JOIN "PlayHistory" h`))!;
  assert.match(sql.text, /h\."startedAt" >= r\."createdAt"/);
  assert.match(sql.text, /h\."mediaType" = r\."mediaType"/);
  // Both identities bound as links for this user; the linkage rule is never restated in SQL.
  assert.doesNotMatch(sql.text, /manualUserLink|plexUserId|jellyfinUserId/);
});

test("an identity on an UNTRACKED source still supplies watches, but doesn't set coverage", async () => {
  setSettings({ playHistoryEnabled: "true", playHistoryPlexEnabled: "true" }); // Jellyfin not tracked
  historySince("plex", 400);
  historySince("jellyfin", 20); // would push coverage to 20 days ago if it counted
  user("u", { plexUserId: "p-u" });
  msu("m-jf", { source: "jellyfin", sourceUserId: "j-u", userId: "u" });
  const reqs = [request("u", 60), request("u", 70), request("u", 80)];
  play("m-jf", reqs[0], 55);

  const s = (await getWatchGradeSummaries(["u"]))!.get("u")!;
  assert.equal(s.graded, 3);
  assert.equal(s.untracked, 0);
  assert.equal(s.watched, 1);
  assert.equal(s.letter, "D");
});

test("coverage starts at the LATEST history start among the user's tracked sources", async () => {
  historySince("plex", 500);
  historySince("jellyfin", 100);
  user("both", { plexUserId: "p-b" });
  msu("m-jf", { source: "jellyfin", sourceUserId: "j-b", userId: "both" });
  const beforeJellyfin = request("both", 200);
  const after = [request("both", 40), request("both", 50), request("both", 60)];

  const { grades } = await computeWatchGrades(["both"]);
  const g = grades.get("both")!;
  assert.equal(g.verdicts.find((v) => v.requestId === beforeJellyfin.id)!.scoring, "untracked");
  assert.equal(g.summary.graded, after.length);

  // A Plex-only user on the same server is not held back by Jellyfin's late start.
  user("plexOnly", { plexUserId: "p-o" });
  const old = request("plexOnly", 200);
  const g2 = (await computeWatchGrades(["plexOnly"])).grades.get("plexOnly")!;
  assert.equal(g2.verdicts.find((v) => v.requestId === old.id)!.scoring, "scored");
});

test("a tracked source with no history at all yet doesn't block coverage from the other", async () => {
  historySince("plex", 300);
  user("u", { plexUserId: "p-u", jellyfinUserId: "j-u" }); // Jellyfin: tracked, zero plays anywhere
  request("u", 100);
  const g = (await computeWatchGrades(["u"])).grades.get("u")!;
  assert.equal(g.verdicts[0].scoring, "scored");
});

test("TV: library episodes are deduplicated across sources with specials excluded", async () => {
  historySince("plex", 400);
  user("u", { plexUserId: "p-u" });
  msu("m", { source: "plex", sourceUserId: "p-u" });
  const tv = request("u", 60, { mediaType: "TV" });
  for (const source of ["plex", "jellyfin"]) {
    for (let e = 1; e <= 8; e++) episodes.push({ source, tmdbId: tv.tmdbId, seasonNumber: 1, episodeNumber: e });
    episodes.push({ source, tmdbId: tv.tmdbId, seasonNumber: 0, episodeNumber: 1 });
  }
  for (const e of [1, 2, 3]) play("m", tv, 50, { seasonNumber: 1, episodeNumber: e, playDuration: 1400, duration: 1400 });

  const v = (await computeWatchGrades(["u"])).grades.get("u")!.verdicts[0];
  assert.deepEqual(v.episodes, { watched: 3, started: 0, library: 8, required: 4 });
  assert.equal(v.credit, 0.75);
  const sql = opsOf("$queryRaw").map((o) => o.args as SqlArg).find((s) => s.text.includes(`FROM "TVEpisodeCache"`))!;
  assert.match(sql.text, /COUNT\(DISTINCT \("seasonNumber", "episodeNumber"\)\)/);
  assert.match(sql.text, /"seasonNumber" > 0/);
});

// ═══ request selection ═══════════════════════════════════════════════════════

test("only AVAILABLE requests inside the window are read; legacy rows fall back to updatedAt", async () => {
  historySince("plex", 2000);
  user("u", { plexUserId: "p-u" });
  const legacy = request("u", 60, { availableAt: null, updatedAt: daysAgo(60) });
  request("u", 60, { status: "APPROVED" });
  request("u", 400); // outside the default 365-day window
  const legacyOld = request("u", 400, { availableAt: null, updatedAt: daysAgo(400) });

  const g = (await computeWatchGrades(["u"])).grades.get("u")!;
  assert.deepEqual(g.verdicts.map((v) => v.requestId), [legacy.id]);
  assert.ok(!g.verdicts.some((v) => v.requestId === legacyOld.id));
  const where = (opsOf("mediaRequest.findMany")[0].args as { where: Record<string, unknown> }).where;
  assert.equal(where.status, "AVAILABLE");
  assert.ok(Array.isArray(where.OR), "window predicate present");

  setSettings({ ...TRACKING_ON, watchGradeWindowDays: "0" });
  ops = [];
  const unlimited = (await computeWatchGrades(["u"])).grades.get("u")!;
  assert.equal(unlimited.verdicts.length, 3);
  assert.ok(!("OR" in (opsOf("mediaRequest.findMany")[0].args as { where: object }).where));
});

// ═══ list vs detail ══════════════════════════════════════════════════════════

test("list mode resolves identity for requesters only; everyone else gets an empty summary", async () => {
  historySince("plex", 400);
  user("requester", { plexUserId: "p-r" });
  user("idle", { plexUserId: "p-i" });
  request("requester", 60);

  const summaries = (await getWatchGradeSummaries(["requester", "idle"]))!;
  const identityRead = opsOf("user.findMany")[0].args as { where: { id: { in: string[] } } };
  assert.deepEqual(identityRead.where.id.in, ["requester"]);
  assert.equal(summaries.get("idle")!.status, "insufficient");
  assert.equal(summaries.get("idle")!.graded + summaries.get("idle")!.inGrace + summaries.get("idle")!.untracked, 0);
});

test("detail mode resolves identity even with nothing fulfilled, so 'unlinked' is reported", async () => {
  user("lonely");
  const detail = await getUserWatchGradeDetail("lonely");
  assert.equal(detail.enabled, true);
  assert.equal(detail.grade!.status, "unlinked");
  assert.deepEqual(detail.requests, []);
  assert.equal(detail.settings!.minGradedRequests, 3);
});

test("detail rows are capped, the grade is not", async () => {
  historySince("plex", 2000);
  user("heavy", { plexUserId: "p-h" });
  for (let i = 0; i < MAX_VERDICT_ROWS + 5; i++) request("heavy", 40 + (i % 300));
  const detail = await getUserWatchGradeDetail("heavy");
  assert.equal(detail.requests.length, MAX_VERDICT_ROWS);
  assert.equal(detail.truncated, true);
  assert.equal(detail.grade!.graded, MAX_VERDICT_ROWS + 5);
});

test("a failing aggregate degrades list surfaces to 'no grades' and is logged; detail surfaces it", async () => {
  historySince("plex", 400);
  user("u", { plexUserId: "p-u" });
  msu("m", { source: "plex", sourceUserId: "p-u" });
  request("u", 60);
  failPlayAggregate = true;

  assert.equal(await getWatchGradeSummaries(["u"]), null);
  assert.ok(errors.some((e) => e.startsWith("[watch-grade]")), errors.join("\n"));
  await assert.rejects(() => getUserWatchGradeDetail("u"), /simulated aggregate failure/);
});

// ═══ route ═══════════════════════════════════════════════════════════════════

let sessionSeq = 0;
async function tokenFor(userId: string, permissions: bigint, role = "USER"): Promise<string> {
  sessionSeq++;
  const sessionId = `sess-${sessionSeq}`;
  const existing = users.find((u) => u.id === userId);
  if (existing) Object.assign(existing, { permissions, role });
  else user(userId, { permissions, role });
  authSessions.set(sessionId, { sessionId, userId, expiresAt: new Date(realDateNow() + DAY) });
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions: permissions.toString(), provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

async function callRoute(token: string | null, id: string) {
  const req = new NextRequest(`http://localhost:3000/api/admin/users/${id}/watch-grade`, {
    method: "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-forwarded-for": "203.0.113.7",
    },
  });
  return getWatchGrade(req, { params: Promise.resolve({ id }) });
}

test("route: MANAGE_USERS and MANAGE_REQUESTS may read; a plain user may not; no session is 401", async () => {
  user("target");
  assert.equal((await callRoute(null, "target")).status, 401);

  const plain = await tokenFor("plain", Permission.REQUEST);
  assert.equal((await callRoute(plain, "target")).status, 403);

  const manager = await tokenFor("usersAdmin", Permission.MANAGE_USERS);
  const res = await callRoute(manager, "target");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { enabled: boolean; grade: { status: string } };
  assert.equal(body.enabled, true);
  assert.equal(body.grade.status, "unlinked");

  const approver = await tokenFor("approver", Permission.MANAGE_REQUESTS);
  assert.equal((await callRoute(approver, "target")).status, 200);
});

test("route: an unknown user is 404 before any grade work", async () => {
  const token = await tokenFor("usersAdmin2", Permission.MANAGE_USERS);
  ops = [];
  const res = await callRoute(token, "nobody");
  assert.equal(res.status, 404);
  assert.equal(opsOf("mediaRequest.findMany").length, 0);
});
