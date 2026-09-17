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
//   6. OTHER VIEWERS ARE PEOPLE. Each audience identity is keyed by the account
//      that owns it (resolveMediaServerUserOwners — the same branches), so one
//      person's Plex and Jellyfin logins count once, one Plex account seen on
//      two servers counts once, and a login an admin pinned away from the
//      requester counts as someone else. The requester's own logins never make
//      a viewer — by construction, not by a filter: flagged plays of theirs give
//      the request full credit, and (pin 7) full-credit requests are never read.
//   8. THE PREVIEW judges what a save would: stored values for keys the body
//      leaves out, defaults for blank ones, the same bounds and cross-field
//      rules — and grades every requester under both the stored and the proposed
//      settings. ADMIN only, like the settings route it sits beside.
//   7. THE AUDIENCE IS READ ONLY WHERE IT CAN MATTER — scored requests short of
//      full credit — as ONE ROW PER IDENTITY AND SEASON built from play history's
//      own watched/completed flags, never per episode. That is what keeps the
//      Users page (a thousand accounts, a year of requests) from pulling every
//      viewer × every episode of every popular show on each render.
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
const { resolveAccountMediaIdentities, resolveLinkedMediaServerUserIds, resolveMediaServerUserOwners } = await import(
  "../src/lib/my-watch-history.ts"
);
const {
  computeWatchGrades,
  getWatchGradeAvailability,
  getWatchGradeSummaries,
  getUserWatchGradeDetail,
  mergedWatchGradeSettings,
  previewWatchGradeSpread,
  MAX_VERDICT_ROWS,
} = await import("../src/lib/watch-grade-data.ts");
const { WATCH_GRADE_DEFAULTS } = await import("../src/lib/watch-grade.ts");
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
  // Two shapes: the identity read (id in) and the owner read (an OR of id /
  // plexUserId / jellyfinUserId `in` lists).
  findMany: async (args: { where: { id?: { in: string[] }; OR?: Record<string, { in: string[] }>[] } }) => {
    ops.push({ op: "user.findMany", args });
    const { where } = args;
    if (where.id) return users.filter((u) => where.id!.in.includes(u.id)).map((u) => ({ ...u }));
    if (!where.OR) throw new Error("unexpected User filter");
    return users
      .filter((u) =>
        where.OR!.some((branch) =>
          Object.entries(branch).every(([k, v]) => {
            if (!["id", "plexUserId", "jellyfinUserId"].includes(k)) throw new Error(`unexpected User OR key ${k}`);
            const value = u[k as "id" | "plexUserId" | "jellyfinUserId"];
            return value !== null && v.in.includes(value);
          }),
        ),
      )
      .map((u) => ({ ...u }));
  },
  update: async () => ({}),
});

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) => authSessions.get(args.where.sessionId) ?? null,
  update: async () => ({}),
});

shadowPrismaModel(prisma, "mediaServerUser", {
  // Two shapes: the linkage branches (OR) and the owner read (id in).
  findMany: async (args: { where: { OR?: Record<string, unknown>[]; id?: { in: string[] } }; select?: Record<string, boolean> }) => {
    ops.push({ op: "mediaServerUser.findMany", args });
    const { where } = args;
    if (where.id) return msus.filter((m) => where.id!.in.includes(m.id)).map((m) => ({ ...m }));
    return msus
      .filter((m) => where.OR!.some((b) => eqBranch(m as unknown as Record<string, unknown>, b)))
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
    const out: { tmdbId: number; seasonNumber: number; episodes: number }[] = [];
    for (const tmdbId of new Set(ids)) {
      const perSeason = new Map<number, Set<number>>();
      for (const e of episodes) {
        if (e.tmdbId !== tmdbId || e.seasonNumber <= 0) continue;
        const set = perSeason.get(e.seasonNumber) ?? new Set<number>();
        set.add(e.episodeNumber);
        perSeason.set(e.seasonNumber, set);
      }
      for (const [seasonNumber, set] of perSeason) out.push({ tmdbId, seasonNumber, episodes: set.size });
    }
    return out;
  }
  if (sql.text.includes(`AS "msuId"`)) {
    // The audience aggregate: per (request, identity, season), from the stored
    // watched/completed flags only — a movie's any-watched bit, a season's
    // distinct watched episodes. Rows with nothing watched are returned as 0.
    const groups = new Map<string, { requestId: string; msuId: string; seasonNumber: number | null; movie: boolean; anyWatched: boolean; episodes: Set<number> }>();
    for (const id of sql.values as string[]) {
      const r = requests.find((x) => x.id === id);
      if (!r) continue;
      for (const p of plays) {
        if (p.tmdbId !== r.tmdbId || p.mediaType !== r.mediaType) continue;
        if (p.startedAt.getTime() < r.createdAt.getTime()) continue;
        const key = `${r.id}|${p.mediaServerUserId}|${p.seasonNumber}`;
        const g = groups.get(key) ?? { requestId: r.id, msuId: p.mediaServerUserId, seasonNumber: p.seasonNumber, movie: r.mediaType === "MOVIE", anyWatched: false, episodes: new Set<number>() };
        const flagged = p.watched || p.completed;
        g.anyWatched ||= flagged;
        if (flagged && p.episodeNumber != null) g.episodes.add(p.episodeNumber);
        groups.set(key, g);
      }
    }
    return [...groups.values()].map((g) => ({
      requestId: g.requestId,
      msuId: g.msuId,
      seasonNumber: g.seasonNumber,
      watched: g.movie ? (g.anyWatched ? 1 : 0) : g.episodes.size,
    }));
  }
  if (sql.text.includes(`JOIN (VALUES`)) {
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

// Route handlers, imported after every stub is in place.
const { GET: getWatchGrade } = await import("../src/app/api/admin/users/[id]/watch-grade/route.ts");
const { POST: postPreview } = await import("../src/app/api/admin/watch-grade/preview/route.ts");

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
    settings: { ...WATCH_GRADE_DEFAULTS, graceDays: 14 },
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
  // Claimed twice again, but the subject claimant is created FIRST, so "first
  // match" and "FK first" give different owners.
  user("subjectClaimant", { jellyfinUserId: "j-C" });
  user("fkClaimant");
  msu("m-C1", { source: "jellyfin", sourceUserId: "j-C", userId: "fkClaimant", manualUserLink: false });

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

  // The reverse lookup agrees: an identity's owner is an account whose linked set
  // holds it, the FK account when several do, and nobody when none does.
  msu("m-orphan", { source: "plex", sourceUserId: "p-nobody" });
  const owners = await resolveMediaServerUserOwners(msus.map((m) => m.id));
  for (const row of msus) {
    const claimants = ids.filter((id) => batch.get(id)!.linked.some((l) => l.id === row.id));
    const owner = owners.get(row.id)!;
    assert.deepEqual({ source: owner.source, sourceUserId: owner.sourceUserId }, { source: row.source, sourceUserId: row.sourceUserId });
    if (claimants.length === 0) assert.equal(owner.userId, null, `${row.id} belongs to nobody`);
    else if (row.userId && claimants.includes(row.userId)) assert.equal(owner.userId, row.userId, `${row.id} → its FK account`);
    else assert.ok(owner.userId && claimants.includes(owner.userId), `${row.id} → one of ${claimants.join(",")}`);
  }
  // m-Z1 and m-C1 are each claimed twice (an FK and an unpinned subject): the FK wins.
  assert.equal(owners.get("m-Z1")!.userId, "pinTarget");
  assert.equal(owners.get("m-C1")!.userId, "fkClaimant");
  assert.equal(owners.get("m-U1")!.userId, null, "an admin unlink belongs to nobody");
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

  const sql = (opsOf("$queryRaw").map((o) => o.args as SqlArg)).find((s) => s.text.includes(`JOIN (VALUES`))!;
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
  assert.deepEqual(v.episodes, { season: 1, watched: 3, started: 0, library: 8, required: 4 });
  assert.equal(v.credit, 0.75);
  const sql = opsOf("$queryRaw").map((o) => o.args as SqlArg).find((s) => s.text.includes(`FROM "TVEpisodeCache"`))!;
  assert.match(sql.text, /COUNT\(DISTINCT "episodeNumber"\)/);
  assert.match(sql.text, /"seasonNumber" > 0/);
  assert.match(sql.text, /GROUP BY "tmdbId", "seasonNumber"/);
});

// ═══ other viewers ═══════════════════════════════════════════════════════════

test("other viewers are PEOPLE: one account's two logins count once, a login with no account counts alone, the requester's logins never count", async () => {
  historySince("plex", 400);
  user("u", { plexUserId: "p-u" });
  msu("m-u", { source: "plex", sourceUserId: "p-u" }); // subject link
  msu("m-u2", { source: "jellyfin", sourceUserId: "j-u", userId: "u" }); // FK link
  user("a", { plexUserId: "p-a" });
  msu("m-a1", { source: "plex", sourceUserId: "p-a" }); // a, by subject only
  msu("m-a2", { source: "jellyfin", sourceUserId: "j-a", userId: "a" }); // a, by FK
  user("b");
  msu("m-b", { source: "jellyfin", sourceUserId: "j-b", userId: "b" });
  msu("m-x", { source: "plex", sourceUserId: "p-x" }); // no account at all

  const oneAccountTwice = request("u", 60);
  play("m-a1", oneAccountTwice, 50);
  play("m-a2", oneAccountTwice, 49);
  const accountAndStranger = request("u", 70);
  play("m-a1", accountAndStranger, 65);
  play("m-x", accountAndStranger, 64);
  const ownWatch = request("u", 80);
  play("m-u", ownWatch, 75);
  play("m-u2", ownWatch, 74);
  play("m-b", ownWatch, 73);

  const { grades } = await computeWatchGrades(["u"]);
  const verdict = (id: string) => grades.get("u")!.verdicts.find((v) => v.requestId === id)!;
  assert.deepEqual(
    { others: verdict(oneAccountTwice.id).otherViewers, byOthers: verdict(oneAccountTwice.id).watchedByOthers, credit: verdict(oneAccountTwice.id).credit },
    { others: 1, byOthers: false, credit: 0 },
  );
  assert.deepEqual(
    { others: verdict(accountAndStranger.id).otherViewers, byOthers: verdict(accountAndStranger.id).watchedByOthers, credit: verdict(accountAndStranger.id).credit },
    { others: 2, byOthers: true, credit: 1 },
  );
  assert.equal(verdict(ownWatch.id).watch, "watched");
  assert.equal(verdict(ownWatch.id).otherViewers, null, "a watched request never has its audience read");
  assert.equal(grades.get("u")!.summary.byOthers, 1);
});

test("other viewers: plays before the request don't count, and the audience SQL never restates the linkage rule", async () => {
  historySince("plex", 400);
  user("u", { plexUserId: "p-u" });
  msu("m-a", { source: "plex", sourceUserId: "p-a" });
  msu("m-b", { source: "plex", sourceUserId: "p-b" });
  const r = request("u", 60);
  play("m-a", r, 200); // long before the request
  play("m-b", r, 55);

  const v = (await computeWatchGrades(["u"])).grades.get("u")!.verdicts[0];
  assert.equal(v.otherViewers, 1);
  assert.equal(v.watchedByOthers, false);

  const sql = opsOf("$queryRaw").map((o) => o.args as SqlArg).find((s) => s.text.includes(`AS "msuId"`))!;
  assert.match(sql.text, /h\."startedAt" >= r\."createdAt"/);
  assert.match(sql.text, /h\."mediaType" = r\."mediaType"/);
  // One row per identity and season, from the stored flags — never per episode,
  // never from summed play time.
  assert.match(sql.text, /GROUP BY r\."id", r\."mediaType", h\."mediaServerUserId", h\."seasonNumber"$/m);
  assert.match(sql.text, /COUNT\(DISTINCT h\."episodeNumber"\) FILTER \(WHERE \(h\."watched" OR h\."completed"\)/);
  assert.doesNotMatch(sql.text, /playDuration|h\."duration"|h\."episodeNumber" AS/);
  assert.doesNotMatch(sql.text, /manualUserLink|plexUserId|jellyfinUserId|"userId"/);
});

test("other viewers: a login an admin pinned AWAY from the requester is someone else; one pinned TO them is theirs", async () => {
  historySince("plex", 400);
  user("u", { plexUserId: "p-u" });
  user("a", { plexUserId: "p-a" });
  // An admin unlinked u's own Plex subject row: it is not u's any more.
  msu("m-away", { source: "plex", sourceUserId: "p-u", userId: null, manualUserLink: true });
  // An admin pinned a's Plex subject row to u: it is u's, not a's.
  msu("m-to-u", { source: "plex", sourceUserId: "p-a", userId: "u", manualUserLink: true });
  msu("m-x", { source: "jellyfin", sourceUserId: "j-x" });

  const r = request("u", 60);
  play("m-away", r, 55);
  play("m-x", r, 54);
  play("m-to-u", r, 53, { watched: false, completed: false, playDuration: 1500 }); // u's own: a quarter of it

  const v = (await computeWatchGrades(["u"])).grades.get("u")!.verdicts[0];
  assert.equal(v.watch, "partial", "the pinned-to-u login is u's own watch");
  assert.equal(v.otherViewers, 2, "the pinned-away login and the stranger");
  assert.equal(v.watchedByOthers, true);
  assert.equal(v.credit, 1);
});

test("other viewers: one Plex account seen on two servers is ONE person, even with no Summonarr account", async () => {
  historySince("plex", 400);
  user("u", { plexUserId: "p-u" });
  // The same plex.tv account has a row per server (unique on source+serverInstance+sourceUserId).
  msu("m-x-home", { source: "plex", sourceUserId: "p-x" });
  msu("m-x-remote", { source: "plex", sourceUserId: "p-x" });
  msu("m-y", { source: "plex", sourceUserId: "p-y" });
  const twoRowsOnePerson = request("u", 60);
  play("m-x-home", twoRowsOnePerson, 55);
  play("m-x-remote", twoRowsOnePerson, 54);
  const twoPeople = request("u", 61);
  play("m-x-home", twoPeople, 55);
  play("m-y", twoPeople, 54);

  const { grades } = await computeWatchGrades(["u"]);
  const verdict = (id: string) => grades.get("u")!.verdicts.find((v) => v.requestId === id)!;
  assert.deepEqual({ others: verdict(twoRowsOnePerson.id).otherViewers, byOthers: verdict(twoRowsOnePerson.id).watchedByOthers }, { others: 1, byOthers: false });
  assert.deepEqual({ others: verdict(twoPeople.id).otherViewers, byOthers: verdict(twoPeople.id).watchedByOthers }, { others: 2, byOthers: true });
});

test("other viewers: a person's logins merge per season by MAX — the same episode twice is one, different episodes are not summed", async () => {
  historySince("plex", 400);
  user("u", { plexUserId: "p-u" });
  user("a", { plexUserId: "p-a" });
  msu("m-a-plex", { source: "plex", sourceUserId: "p-a" });
  msu("m-a-jf", { source: "jellyfin", sourceUserId: "j-a", userId: "a" });
  const ep = (e: number) => ({ seasonNumber: 1, episodeNumber: e, playDuration: 1400, duration: 1400 });
  const seed = (tv: { tmdbId: number }) => {
    for (let e = 1; e <= 8; e++) episodes.push({ source: "plex", tmdbId: tv.tmdbId, seasonNumber: 1, episodeNumber: e });
  };

  // 4 needed. Episodes 1–3 on Plex and 1–4 on Jellyfin: the overlap is one set of four.
  const overlap = request("u", 60, { mediaType: "TV" });
  seed(overlap);
  for (const e of [1, 2, 3]) play("m-a-plex", overlap, 55, ep(e));
  for (const e of [1, 2, 3, 4]) play("m-a-jf", overlap, 54, ep(e));
  // Episodes 1–2 on Plex and 3–4 on Jellyfin: four distinct episodes, read as two —
  // the conservative approximation, pinned so it is a choice and not a surprise.
  const split = request("u", 61, { mediaType: "TV" });
  seed(split);
  for (const e of [1, 2]) play("m-a-plex", split, 55, ep(e));
  for (const e of [3, 4]) play("m-a-jf", split, 54, ep(e));

  setSettings({ ...TRACKING_ON, watchGradeOtherViewers: "1" });
  const { grades } = await computeWatchGrades(["u"]);
  const verdict = (id: string) => grades.get("u")!.verdicts.find((v) => v.requestId === id)!;
  assert.equal(verdict(overlap.id).otherViewers, 1);
  assert.equal(verdict(split.id).otherViewers, 0);
});

test("other viewers are read ONLY for scored requests short of full credit — never for grace, untracked or watched ones", async () => {
  historySince("plex", 60);
  user("u", { plexUserId: "p-u" });
  msu("m-u", { source: "plex", sourceUserId: "p-u" });
  msu("m-a", { source: "plex", sourceUserId: "p-a" });
  msu("m-b", { source: "plex", sourceUserId: "p-b" });
  const unwatched = request("u", 40);
  const started = request("u", 41);
  const watched = request("u", 42);
  const inGrace = request("u", 5);
  const untracked = request("u", 100); // fulfilled before Plex history began
  play("m-u", started, 39, { watched: false, completed: false, playDuration: 1800, duration: 7200 });
  play("m-u", watched, 39);
  for (const r of [unwatched, started, watched, inGrace, untracked]) {
    play("m-a", r, 4);
    play("m-b", r, 3);
  }

  ops = [];
  const { grades } = await computeWatchGrades(["u"]);
  const audience = opsOf("$queryRaw").map((o) => o.args as SqlArg).filter((q) => q.text.includes(`AS "msuId"`));
  assert.equal(audience.length, 1);
  assert.deepEqual([...(audience[0].values as string[])].sort(), [started.id, unwatched.id].sort());
  const verdict = (id: string) => grades.get("u")!.verdicts.find((v) => v.requestId === id)!;
  assert.equal(verdict(unwatched.id).watchedByOthers, true);
  assert.equal(verdict(started.id).watchedByOthers, true);
  assert.equal(verdict(watched.id).otherViewers, null, "not read, so not counted — the request already has full credit");
  assert.equal(verdict(inGrace.id).scoring, "grace");
  assert.equal(verdict(untracked.id).scoring, "untracked");
  // Owners are resolved only for identities with something watched on those requests —
  // the requester's own login (a start on one, nothing on the other) isn't among them.
  const ownerRead = opsOf("mediaServerUser.findMany").find((o) => "id" in (o.args as { where: object }).where)!;
  assert.deepEqual([...new Set((ownerRead.args as { where: { id: { in: string[] } } }).where.id.in)].sort(), ["m-a", "m-b"]);
});

test("a title requested on two instances is graded once, from the earlier request", async () => {
  historySince("plex", 400);
  user("u", { plexUserId: "p-u" });
  msu("m-u", { source: "plex", sourceUserId: "p-u" });
  const hd = request("u", 60, { tmdbId: 777 });
  const fourK = request("u", 20, { tmdbId: 777, createdAt: daysAgo(30) }); // later request, inside grace on its own
  play("m-u", hd, 50);
  const g = (await computeWatchGrades(["u"])).grades.get("u")!;
  assert.equal(g.verdicts.length, 1);
  assert.equal(g.verdicts[0].requestId, hd.id);
  assert.equal(g.verdicts[0].duplicates, 1);
  assert.equal(g.verdicts[0].watch, "watched");
  assert.equal(g.summary.graded, 1);
  void fourK;
});

test("watchGradeOtherViewers 0 turns other viewers off: no audience query, no owner reads, no credit", async () => {
  setSettings({ ...TRACKING_ON, watchGradeOtherViewers: "0" });
  historySince("plex", 400);
  user("u", { plexUserId: "p-u" });
  msu("m-a", { source: "plex", sourceUserId: "p-a" });
  msu("m-b", { source: "plex", sourceUserId: "p-b" });
  const r = request("u", 60);
  play("m-a", r, 55);
  play("m-b", r, 54);

  ops = [];
  const v = (await computeWatchGrades(["u"])).grades.get("u")!.verdicts[0];
  assert.deepEqual({ others: v.otherViewers, byOthers: v.watchedByOthers, credit: v.credit }, { others: null, byOthers: false, credit: 0 });
  assert.ok(!opsOf("$queryRaw").some((o) => (o.args as SqlArg).text.includes(`AS "msuId"`)), "no audience query");
  assert.ok(
    !opsOf("mediaServerUser.findMany").some((o) => "id" in (o.args as { where: object }).where),
    "no owner read",
  );
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

// ═══ tuning ══════════════════════════════════════════════════════════════════

test("computeWatchGrades grades with a settings override — window, cutoffs, requests needed — leaving the stored ones alone", async () => {
  historySince("plex", 900);
  user("u", { plexUserId: "p-u" });
  msu("m", { source: "plex", sourceUserId: "p-u" });
  const recent = [request("u", 40), request("u", 41), request("u", 42)];
  const old = request("u", 500); // outside the stored 365-day window
  play("m", recent[0], 35);
  play("m", recent[1], 35);
  play("m", old, 400);

  const stored = (await computeWatchGrades(["u"])).grades.get("u")!.summary;
  assert.deepEqual({ graded: stored.graded, score: stored.score, letter: stored.letter }, { graded: 3, score: 67, letter: "B" });

  const override = { ...WATCH_GRADE_DEFAULTS, windowDays: 0, bandA: 70, bandB: 60, bandC: 50, bandD: 40, minGradedRequests: 4 };
  ops = [];
  const tuned = (await computeWatchGrades(["u"], { settings: override })).grades.get("u")!.summary;
  assert.deepEqual(
    { graded: tuned.graded, score: tuned.score, letter: tuned.letter, min: tuned.minGradedRequests },
    { graded: 4, score: 75, letter: "A", min: 4 },
  );
  assert.ok(!("OR" in (opsOf("mediaRequest.findMany")[0].args as { where: object }).where), "the override's window drives the request read");
  assert.equal(opsOf("setting.findMany").length, 1, "availability still reads what is stored, once");
});

test("mergedWatchGradeSettings: body keys win, a blank one means the default, a missing one keeps the stored value — unrepaired", async () => {
  setSettings({ ...TRACKING_ON, watchGradeGraceDays: "45", watchGradeBandA: "90", watchGradeBandB: "70" });
  const merged = await mergedWatchGradeSettings({ watchGradeBandA: " 65 ", watchGradeGraceDays: "", watchGradeTvPercent: 75 });
  assert.equal(merged.graceDays, WATCH_GRADE_DEFAULTS.graceDays, "blank → default");
  assert.equal(merged.bandB, 70, "missing → stored");
  assert.equal(merged.bandA, 65, "body wins, trimmed");
  assert.equal(merged.tvEpisodePercent, WATCH_GRADE_DEFAULTS.tvEpisodePercent, "a non-string is not a value");
  // A (65) below B (70): returned as is, so the cross-field check can refuse it.
  assert.ok(merged.bandA < merged.bandB);
});

test("previewWatchGradeSpread: every requester graded under the stored and the proposed settings", async () => {
  historySince("plex", 900);
  for (const id of ["keen", "mixed", "never"]) user(id, { plexUserId: `p-${id}` });
  msu("m-keen", { source: "plex", sourceUserId: "p-keen" });
  msu("m-mixed", { source: "plex", sourceUserId: "p-mixed" });
  for (let i = 0; i < 3; i++) play("m-keen", request("keen", 40 + i), 35);
  const mixed = [request("mixed", 40), request("mixed", 41), request("mixed", 42)];
  play("m-mixed", mixed[0], 35);
  play("m-mixed", mixed[1], 35);
  for (let i = 0; i < 3; i++) request("never", 40 + i);
  user("idle"); // no requests at all — not a requester

  const preview = await previewWatchGradeSpread({ ...WATCH_GRADE_DEFAULTS, bandA: 95, bandB: 70, bandC: 50, bandD: 30 });
  assert.equal(preview.enabled, true);
  assert.equal(preview.requesters, 3);
  // Stored: keen 100 → A, mixed 67 → B, never 0 → F.
  assert.deepEqual(preview.current, { A: 1, B: 1, C: 0, D: 0, F: 1, notGraded: 0 });
  // Proposed: keen 100 → A, mixed 67 → C (B now needs 70), never 0 → F.
  assert.deepEqual(preview.proposed, { A: 1, B: 0, C: 1, D: 0, F: 1, notGraded: 0 });

  const stricter = await previewWatchGradeSpread({ ...WATCH_GRADE_DEFAULTS, bandB: 70, minGradedRequests: 4 });
  assert.deepEqual(stricter.proposed, { A: 0, B: 0, C: 0, D: 0, F: 0, notGraded: 3 }, "4 requests needed — nobody has them");

  setSettings({ ...TRACKING_ON, "feature.behavior.watchGrades": "false" });
  assert.deepEqual(await previewWatchGradeSpread(WATCH_GRADE_DEFAULTS), { enabled: false, reason: "feature-off", requesters: 0, current: null, proposed: null });
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

async function callPreview(token: string | null, body: unknown) {
  const req = new NextRequest("http://localhost:3000/api/admin/watch-grade/preview", {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.7",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return postPreview(req, undefined);
}

test("preview route: ADMIN only — a MANAGE_USERS delegate may read grades but not preview settings", async () => {
  assert.equal((await callPreview(null, {})).status, 401);
  const delegate = await tokenFor("usersAdmin3", Permission.MANAGE_USERS);
  assert.equal((await callPreview(delegate, {})).status, 403);
  const admin = await tokenFor("admin1", 0n, "ADMIN");
  const res = await callPreview(admin, {});
  assert.equal(res.status, 200);
  const body = (await res.json()) as { enabled: boolean; requesters: number };
  assert.deepEqual({ enabled: body.enabled, requesters: body.requesters }, { enabled: true, requesters: 0 });
});

test("preview route: refuses exactly what a save would — bounds, types, cutoffs out of order against the STORED values", async () => {
  const admin = await tokenFor("admin2", 0n, "ADMIN");
  const error = async (body: unknown) => {
    const res = await callPreview(admin, body);
    return { status: res.status, error: ((await res.json()) as { error?: string }).error };
  };
  assert.deepEqual(await error({ watchGradeBandA: "101" }), { status: 400, error: `"watchGradeBandA" must be an integer between 1 and 100` });
  assert.deepEqual(await error({ watchGradeMinRequests: 3 }), { status: 400, error: `Setting "watchGradeMinRequests" must be a string` });
  assert.equal((await callPreview(admin, "[1]")).status, 400);
  // B alone, above the stored-default A.
  assert.deepEqual(await error({ watchGradeBandB: "85" }), { status: 400, error: "The A cutoff (80%) must be higher than the B cutoff (85%)" });
  // With A raised in the stored settings, the same B is fine.
  setSettings({ ...TRACKING_ON, watchGradeBandA: "90" });
  assert.equal((await callPreview(admin, { watchGradeBandB: "85" })).status, 200);
  // A blank value is the default, and is judged as one: grace back to 30 against a stored 30-day window.
  setSettings({ ...TRACKING_ON, watchGradeWindowDays: "30", watchGradeGraceDays: "10" });
  assert.equal((await callPreview(admin, {})).status, 200);
  assert.match((await error({ watchGradeGraceDays: "" })).error!, /must be longer than the grace period \(30 days\)/);
});
