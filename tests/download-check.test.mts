// Unit tests for the 90s "did the approval actually start downloading?" follow-up
// (src/lib/download-check.ts) — the body that used to be duplicated across the web
// PATCH approve path and the Discord /request auto-approve path, and that the
// Discord admin-approve BUTTON never scheduled at all (it armed pendingNotifyAt and
// stopped there, so the ping only arrived on the next sync tick).
//
// The contracts pinned here:
//   - STATUS RE-READ GATES EVERYTHING: a row that moved off APPROVED (or was
//     deleted) between scheduling and firing produces zero writes, zero upstream
//     calls and zero notifications. This is the only thing standing between an
//     arr-push rollback and a "your download is pending" DM about a request that
//     is PENDING again — every caller schedules unconditionally and relies on it.
//   - TRI-STATE DOWNLOADING CHECK: only a confirmed `false` proceeds. `true`
//     (downloading) and `null` (queue unreadable) both return with pendingNotifyAt
//     LEFT ARMED so the orchestrator backstop re-checks on a later tick. Clearing
//     it on `null` would silently drop the follow-up for the whole outage.
//   - pendingNotifyAt IS CLEARED BEFORE NOTIFYING. This is the half the Discord
//     copy was missing: leaving it armed means the orchestrator's overdue sweep
//     fires the SAME notification again on the next tick — a duplicate DM.
//   - GUARDRAIL 33 (CONSUME, DON'T DEFER): a deactivated requester still gets
//     pendingNotifyAt cleared and the DM dropped, so re-enabling an account never
//     replays a backlog of stale "download pending" messages. Copied from the
//     orchestrator's disabledRequesters short-circuit; the Discord copy lacked it.
//   - RELEASE SPLIT: an unreleased title notifies "awaiting release" with the
//     SOONEST date, sorted CHRONOLOGICALLY — a bare .sort() is string ordering and
//     picks the later date the moment Radarr returns one offset date and one in Z.
//   - DRIFT PINS: the admin-approve button schedules, and the check body has no
//     third copy outside this module.
//
// No DB or network: prisma.mediaRequest/user/setting/tmdbCache are shadowed
// in-memory (tests/_helpers.mts), globalThis.fetch is scripted, and dns.lookup is
// stubbed so safe-fetch's SSRF resolver never issues a real lookup. Dynamic imports
// keep the stubs ahead of the module graph (the discord-notify.test pattern).
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Pinned BEFORE any Date is formatted: notifyUserAwaitingRelease renders the
// release date with toLocaleDateString, so the chronological-sort assertion below
// is only deterministic once the runner's local zone is fixed.
process.env.TZ = "UTC";

process.env.NEXTAUTH_SECRET ??= "unit-test-session-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";
// tmdbAuth() reads this at call time; tests that need getMovieReleaseInfo to run
// set it and pre-seed the TmdbCache row, so no test ever reaches api.themoviedb.org.
delete process.env.TMDB_READ_TOKEN;

const REPO = new URL("..", import.meta.url).pathname;

// ── DNS stub (safe-fetch resolves the arr/discord host before fetching) ─────
// A PUBLIC address: discord-notify goes through safeFetchTrusted (allowPrivate
// false, so a private answer would be rejected as SSRF), while arr's
// safeFetchAdminConfigured merely *also* permits private ones.
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture ─────────────────────────────────────────────────────────
const errors: string[] = [];
console.warn = () => {};
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch ──────────────────────────────────────────────────────────
type SentRequest = { url: string; body: Record<string, unknown> | undefined };
const sent: SentRequest[] = [];
const okJson = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
let respond: (url: string) => Response | Promise<Response> = () => okJson({});

// Records the interleaving of the pendingNotifyAt clear ("clear") and the outbound
// DM ("notify") so their ORDER can be asserted, not just their occurrence.
const order: string[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const raw = init?.body;
  sent.push({ url, body: typeof raw === "string" && raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : undefined });
  if (url.startsWith("https://discord.com/")) order.push("notify");
  return respond(url);
}) as typeof fetch;

// Dynamic imports so the stubs above genuinely precede the module-graph load.
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { DOWNLOAD_CHECK_DELAY_MS, runDownloadCheck, scheduleDownloadCheck, scheduleDownloadChecks } =
  await import("../src/lib/download-check.ts");

// ── prisma stubs ────────────────────────────────────────────────────────────
// One Setting map serves the feature-flag read, the arr getCfg read and the
// discord config read. Absent rows read as "unconfigured"; the discord flag
// defaults ON, so the DISCORD_CFG block alone makes a user notifiable.
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where?: { key?: { in?: string[] } } }) => {
    const keys = args.where?.key?.in ?? [...settings.keys()];
    return keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! }));
  },
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
});

let requestRow: { status: string } | null = null;
// Per-id overrides for the multi-target sweep tests; unset ids fall back to requestRow.
const requestRowById = new Map<string, { status: string } | null>();
let throwForRequestId: string | null = null;
const requestUpdates: Array<Record<string, unknown>> = [];
const requestUpdateIds: string[] = [];
shadowPrismaModel(prisma, "mediaRequest", {
  findUnique: async (args: { where: { id: string } }) => {
    if (throwForRequestId !== null && args.where.id === throwForRequestId) {
      throw new Error("simulated transient DB failure");
    }
    return requestRowById.has(args.where.id) ? requestRowById.get(args.where.id)! : requestRow;
  },
  update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    order.push("clear");
    requestUpdates.push(args.data);
    requestUpdateIds.push(args.where.id);
    return { id: args.where.id, ...args.data };
  },
});

let requesterDeactivatedAt: Date | null = null;
let requesterDiscordId: string | null = null;
shadowPrismaModel(prisma, "user", {
  // Serves BOTH readers: runDownloadCheck selects deactivatedAt, discord-notify's
  // notifyUser selects discordId + the notifyOn* prefs. Dispatch on the select so
  // one stub can answer both without either seeing the other's fields.
  findUnique: async (args: { select?: Record<string, boolean> }) => {
    if (args.select?.deactivatedAt) return { deactivatedAt: requesterDeactivatedAt };
    return {
      discordId: requesterDiscordId,
      notifyOnApproved: true,
      notifyOnAvailable: true,
      notifyOnDeclined: true,
      notifyOnIssue: true,
    };
  },
});

const tmdbCacheRows = new Map<string, string>();
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => {
    const data = tmdbCacheRows.get(args.where.key);
    // expiresAt far in the future — these rows are pre-seeded fixtures, never stale.
    return data === undefined ? null : { key: args.where.key, data, expiresAt: new Date(Date.now() + 86_400_000) };
  },
  deleteMany: async () => ({ count: 0 }),
  upsert: async () => ({}),
});

const DID = "111111111111111111";
const DISCORD_CFG = { discordBotToken: "test-bot-token", discordNotifyChannelId: "444444444444444444" };

// Unique arr URL per test: arr.ts memoizes the queue set in a module-level cache
// keyed on `radarr::${cfg.url}` / `sonarr::${cfg.url}`, which would otherwise leak
// one test's queue contents into the next.
let urlSeq = 0;
const nextArrUrl = () => `http://arr-${++urlSeq}.test:7878`;

const target = (over: Partial<Parameters<typeof runDownloadCheck>[0]> = {}) => ({
  requestId: "req-1",
  tmdbId: 603,
  mediaType: "MOVIE" as const,
  arrInstance: "",
  requestedBy: "user-1",
  title: "The Matrix",
  ...over,
});

// Discord posts land on discord.com; arr traffic does not. Splitting them keeps
// "was the user notified?" from being confused with "did we poll the queue?".
const discordPosts = () => sent.filter((s) => s.url.startsWith("https://discord.com/"));

beforeEach(() => {
  settings.clear();
  invalidateFeatureFlagCache(); // the 10s flag cache must not leak across tests
  tmdbCacheRows.clear();
  sent.length = 0;
  errors.length = 0;
  order.length = 0;
  requestUpdates.length = 0;
  requestUpdateIds.length = 0;
  requestRowById.clear();
  throwForRequestId = null;
  requestRow = { status: "APPROVED" };
  requesterDeactivatedAt = null;
  requesterDiscordId = DID;
  respond = () => okJson({});
  delete process.env.TMDB_READ_TOKEN;
});

// ── the status re-read is the only rollback guard ───────────────────────────

test("a row no longer APPROVED short-circuits: no write, no upstream call, no notify", async () => {
  setSettings({ ...DISCORD_CFG, radarrUrl: nextArrUrl(), radarrApiKey: "k" });

  for (const status of ["PENDING", "DECLINED", "AVAILABLE"]) {
    requestRow = { status };
    await runDownloadCheck(target());
  }

  assert.deepEqual(requestUpdates, [], "a rolled-back/declined request must never have pendingNotifyAt touched");
  assert.equal(sent.length, 0, "the status gate must precede every network call");
});

test("a deleted row (findUnique → null) short-circuits the same way", async () => {
  setSettings({ ...DISCORD_CFG, radarrUrl: nextArrUrl(), radarrApiKey: "k" });
  requestRow = null;

  await runDownloadCheck(target());

  assert.deepEqual(requestUpdates, []);
  assert.equal(sent.length, 0);
});

// ── the tri-state downloading check ─────────────────────────────────────────

test("downloading === true: pendingNotifyAt stays armed and nobody is notified", async () => {
  setSettings({ ...DISCORD_CFG, radarrUrl: nextArrUrl(), radarrApiKey: "k" });
  respond = () => okJson({ records: [{ movie: { tmdbId: 603 } }], totalRecords: 1 });

  await runDownloadCheck(target());

  assert.deepEqual(requestUpdates, [], "a healthy download must not consume the backstop");
  assert.equal(discordPosts().length, 0);
});

test("downloading === null (queue unreadable): backstop LEFT armed for a later tick", async () => {
  setSettings({ ...DISCORD_CFG, radarrUrl: nextArrUrl(), radarrApiKey: "k" });
  respond = () => new Response("upstream exploded", { status: 500 });

  await runDownloadCheck(target());

  assert.deepEqual(requestUpdates, [], "an unreadable queue is not a confirmed 'not downloading'");
  assert.equal(discordPosts().length, 0, "an indeterminate queue must never produce a 'download pending' DM");
});

// ── the confirmed-not-downloading path ──────────────────────────────────────

test("not downloading + released: clears pendingNotifyAt, then DMs 'Download Pending'", async () => {
  // No radarr config ⇒ isMovieDownloadingInRadarr returns a confirmed false, and
  // no TMDB token ⇒ getMovieReleaseInfo returns null ⇒ treated as released.
  setSettings(DISCORD_CFG);

  await runDownloadCheck(target());

  assert.deepEqual(requestUpdates, [{ pendingNotifyAt: null }],
    "pendingNotifyAt must be cleared — leaving it armed makes the orchestrator sweep send a DUPLICATE DM next tick");
  const posts = discordPosts();
  assert.equal(posts.length, 1);
  const embed = (posts[0].body?.embeds as Array<{ title: string }>)[0];
  assert.match(embed.title, /Download Pending — The Matrix/);
});

test("the pendingNotifyAt clear happens BEFORE the notify, not after", async () => {
  setSettings(DISCORD_CFG);

  await runDownloadCheck(target());

  // A DM that lands while the row still carries an elapsed pendingNotifyAt is
  // exactly the duplicate the orchestrator sweep would re-send.
  assert.deepEqual(order, ["clear", "notify"]);
});

// ── guardrail 33 ────────────────────────────────────────────────────────────

test("guardrail 33: a deactivated requester CONSUMES the backstop — cleared, but no DM", async () => {
  setSettings(DISCORD_CFG);
  requesterDeactivatedAt = new Date("2026-01-01T00:00:00Z");

  await runDownloadCheck(target());

  assert.deepEqual(requestUpdates, [{ pendingNotifyAt: null }],
    "deferring instead of consuming would replay a stale backlog when the account is re-enabled");
  assert.equal(discordPosts().length, 0, "a disabled account keeps a live Discord link — it must not be DMed");
});

// ── the release split ───────────────────────────────────────────────────────

test("TV with a future firstAired: 'Awaiting Release' carrying that date", async () => {
  const url = nextArrUrl();
  setSettings({ ...DISCORD_CFG, sonarrUrl: url, sonarrApiKey: "k" });
  const firstAired = new Date(Date.now() + 30 * 86_400_000).toISOString();
  respond = (u) => {
    if (u.includes("/api/v3/series/lookup")) return okJson([{ tmdbId: 1399, tvdbId: 121361, firstAired }]);
    if (u.includes("/api/v3/queue")) return okJson({ records: [], totalRecords: 0 });
    return okJson({});
  };

  await runDownloadCheck(target({ mediaType: "TV", tmdbId: 1399, title: "Game of Thrones" }));

  assert.deepEqual(requestUpdates, [{ pendingNotifyAt: null }]);
  const embed = (discordPosts()[0].body?.embeds as Array<{ title: string; description: string }>)[0];
  assert.match(embed.title, /Awaiting Release — Game of Thrones/);
  assert.match(embed.description, /Expected around/);
});

test("TV already aired: falls through to 'Download Pending', not 'Awaiting Release'", async () => {
  const url = nextArrUrl();
  setSettings({ ...DISCORD_CFG, sonarrUrl: url, sonarrApiKey: "k" });
  respond = (u) => {
    if (u.includes("/api/v3/series/lookup")) return okJson([{ tmdbId: 1399, tvdbId: 121361, firstAired: "2011-04-17T00:00:00Z" }]);
    if (u.includes("/api/v3/queue")) return okJson({ records: [], totalRecords: 0 });
    return okJson({});
  };

  await runDownloadCheck(target({ mediaType: "TV", tmdbId: 1399, title: "Game of Thrones" }));

  const embed = (discordPosts()[0].body?.embeds as Array<{ title: string }>)[0];
  assert.match(embed.title, /Download Pending/);
});

test("movie awaiting release picks the soonest date CHRONOLOGICALLY, not lexicographically", async () => {
  setSettings(DISCORD_CFG);
  process.env.TMDB_READ_TOKEN = "unit-test-tmdb-token";
  // Both dates are in the future, and the two orderings DISAGREE:
  //   digital  "2030-06-11T08:00:00+14:00" = 2030-06-10T18:00Z  ← earlier instant
  //   physical "2030-06-11T00:00:00Z"      = 2030-06-11T00:00Z  ← later instant
  // Lexicographically "…T00:00:00Z" < "…T08:00:00+14:00", so a bare .sort() names
  // the LATER release as "soonest". The offsets are chosen so the two instants also
  // land on different UTC calendar days (TZ is pinned to UTC above) — a same-day
  // pair formats identically and would let the mutation slip through.
  const digital = "2030-06-11T08:00:00+14:00";
  const physical = "2030-06-11T00:00:00Z";
  tmdbCacheRows.set("movie:603:release-info:v2", JSON.stringify({ digital, physical, primary: null }));

  await runDownloadCheck(target());

  const embed = (discordPosts()[0].body?.embeds as Array<{ title: string; description: string }>)[0];
  assert.match(embed.title, /Awaiting Release/);
  const fmt = (d: string) => new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  assert.equal(fmt(digital), "Jun 10, 2030");
  assert.equal(fmt(physical), "Jun 11, 2030");
  assert.match(embed.description, new RegExp(`Expected around \\*\\*${fmt(digital)}\\*\\*`));
  assert.ok(!embed.description.includes(fmt(physical)), "the lexicographic winner is the WRONG date");
});

test("movie with a past home-release date reads as released → 'Download Pending'", async () => {
  setSettings(DISCORD_CFG);
  process.env.TMDB_READ_TOKEN = "unit-test-tmdb-token";
  tmdbCacheRows.set(
    "movie:603:release-info:v2",
    JSON.stringify({ digital: "1999-06-01T00:00:00Z", physical: "2030-06-01T00:00:00Z", primary: null }),
  );

  await runDownloadCheck(target());

  const embed = (discordPosts()[0].body?.embeds as Array<{ title: string }>)[0];
  assert.match(embed.title, /Download Pending/);
});

// ── the scheduling wrapper ──────────────────────────────────────────────────

test("scheduleDownloadCheck queues at the 90s mark and reports acceptance", () => {
  assert.equal(DOWNLOAD_CHECK_DELAY_MS, 90_000,
    "the delay must match the pendingNotifyAt arm every approval path writes (now + 90_000)");
  assert.equal(scheduleDownloadCheck(target(), { name: "unit-test:download-check" }), true);
});

// Fake timers so the queued job actually RUNS — otherwise everything below is a
// 90-second wait. Only setTimeout is faked; the job's own awaits resolve on real
// microtasks, which is what the setImmediate drain below pumps.
async function fireScheduledJobs(): Promise<void> {
  mock.timers.tick(DOWNLOAD_CHECK_DELAY_MS);
  for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
}

test("an empty target list schedules nothing at all — no wasted timer slot", async () => {
  setSettings(DISCORD_CFG);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.equal(scheduleDownloadChecks([], { name: "unit-test:empty" }), false);
    await fireScheduledJobs();
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(requestUpdates, []);
  assert.equal(sent.length, 0);
});

test("one batched job sweeps EVERY target (the bulk/batch approve shape)", async () => {
  setSettings(DISCORD_CFG);
  const targets = [
    target({ requestId: "req-a", tmdbId: 1, title: "Alpha" }),
    target({ requestId: "req-b", tmdbId: 2, title: "Bravo" }),
    target({ requestId: "req-c", tmdbId: 3, title: "Charlie" }),
  ];

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.equal(scheduleDownloadChecks(targets, { name: "unit-test:sweep" }), true,
      "the whole batch must cost ONE pending timer, not one per row");
    await fireScheduledJobs();
  } finally {
    mock.timers.reset();
  }

  assert.deepEqual([...requestUpdateIds].sort(), ["req-a", "req-b", "req-c"]);
  const titles = discordPosts()
    .map((p) => (p.body?.embeds as Array<{ title: string }>)[0].title)
    .sort();
  assert.equal(titles.length, 3);
  for (const name of ["Alpha", "Bravo", "Charlie"]) {
    assert.ok(titles.some((t) => t.includes(name)), `${name} was skipped by the sweep`);
  }
});

test("a throwing target is isolated: the rest of the sweep still completes", async () => {
  setSettings(DISCORD_CFG);
  throwForRequestId = "req-b";
  const targets = [
    target({ requestId: "req-a", tmdbId: 1, title: "Alpha" }),
    target({ requestId: "req-b", tmdbId: 2, title: "Bravo" }),
    target({ requestId: "req-c", tmdbId: 3, title: "Charlie" }),
  ];

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    scheduleDownloadChecks(targets, { name: "unit-test:isolation" });
    await fireScheduledJobs();
  } finally {
    mock.timers.reset();
  }

  // Without the per-target catch, mapLimit's bounded Promise.all rejects on the
  // first failure and Alpha/Charlie silently lose their follow-up.
  assert.deepEqual([...requestUpdateIds].sort(), ["req-a", "req-c"]);
  assert.equal(discordPosts().length, 2);
  assert.ok(
    errors.some((e) => e.includes("[download-check]") && e.includes("simulated transient DB failure")),
    "a failed target must be logged under the [download-check] scope, not swallowed silently",
  );
});

test("the single-target wrapper runs the check through the same batched path", async () => {
  setSettings(DISCORD_CFG);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    scheduleDownloadCheck(target({ requestId: "req-solo", title: "Solo" }), { name: "unit-test:solo" });
    await fireScheduledJobs();
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(requestUpdateIds, ["req-solo"]);
  assert.equal(discordPosts().length, 1);
});

// ── drift pins ──────────────────────────────────────────────────────────────

const src = (rel: string) => readFileSync(join(REPO, rel), "utf8");

/** Every .ts/.tsx under src/, repo-relative, excluding the Prisma output (guardrail 12). */
function walkSrc(dir = "src", out: string[] = []): string[] {
  for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (rel.includes("/generated/")) continue;
    if (entry.isDirectory()) walkSrc(rel, out);
    else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

test("the Discord admin-approve button schedules the check, not just the pendingNotifyAt flag", () => {
  const text = src("src/app/api/interactions/route.ts");
  const start = text.indexOf('if (action === "admin_approve")');
  assert.ok(start > 0, "the admin_approve branch moved — update this pin");
  // Bounded to the approve arm: the sibling decline arm starts at the `} else {`
  // that closes it, and the /request auto-approve path is far earlier in the file.
  const branch = text.slice(start, text.indexOf("\n      } else {", start));
  assert.match(branch, /pendingNotifyAt: new Date\(Date\.now\(\) \+ 90_000\)/);
  assert.match(
    branch,
    /scheduleDownloadCheck\(/,
    "admin_approve arms pendingNotifyAt but never scheduled the check — the requester's " +
    "'download pending' ping then waits for the next sync tick instead of ~90s",
  );
});

test("every route that ARMS pendingNotifyAt also SCHEDULES the check", () => {
  // Derived, not a hardcoded list: a new approval path that copies the familiar
  // `pendingNotifyAt: now + 90_000` line and stops there is exactly the bug this
  // suite exists for, and it would sail past a fixed roster. Arming the flag only
  // buys the orchestrator's periodic sweep — the schedule is what makes it prompt.
  const arming = walkSrc()
    .filter((f) => f.startsWith("src/app/api/"))
    .filter((f) => {
      const text = src(f);
      return text.includes("pendingNotifyAt") && /\+ 90_000/.test(text);
    });

  // Guards the pin itself: if the arming literal is ever reformatted, the regex
  // matches nothing and the assertion below passes vacuously.
  assert.deepEqual(arming.sort(), [
    "src/app/api/interactions/route.ts",
    "src/app/api/requests/[id]/route.ts",
    "src/app/api/requests/batch/route.ts",
    "src/app/api/requests/bulk/route.ts",
    "src/app/api/requests/route.ts",
  ], "an approval path was added or removed — confirm it schedules, then update this roster");

  const armedButUnscheduled = arming.filter((f) => !/scheduleDownloadChecks?\(/.test(src(f)));
  assert.deepEqual(armedButUnscheduled, [],
    "these routes stamp pendingNotifyAt but never queue the job that consumes it, so the " +
    "requester's 'download pending' ping waits for the next sync tick instead of ~90s");
});

test("no third copy of the check body: only download-check.ts and the orchestrator backstop notify", () => {
  const text = src("src/lib/download-check.ts");
  assert.match(text, /scheduleDelayed\(DOWNLOAD_CHECK_DELAY_MS/);
  assert.match(text, /console\.error\("\[download-check\]/, "the wrapper must swallow-and-log, never reject into the job pool");

  // The two legitimate importers. /api/sync/route.ts is the periodic backstop that
  // sweeps elapsed pendingNotifyAt rows; anything else means the body was re-inlined.
  const ALLOWED = new Set(["src/lib/download-check.ts", "src/app/api/sync/route.ts"]);
  const offenders = walkSrc()
    .filter((f) => f !== "src/lib/discord-notify.ts" && /notifyUserDownloadPending|notifyUserAwaitingRelease/.test(src(f)))
    .filter((f) => !ALLOWED.has(f));
  assert.deepEqual(offenders, [],
    "call scheduleDownloadCheck(...) instead of re-inlining the 90s check — three copies is how the " +
    "pendingNotifyAt clear and the guardrail-33 suppression went missing from the Discord path");
});

function setSettings(map: Record<string, string>): void {
  settings.clear();
  for (const [k, v] of Object.entries(map)) settings.set(k, v);
}
