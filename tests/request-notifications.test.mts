// Unit tests for the request-notification fan-out hub (src/lib/request-notifications.ts)
// — the module every AVAILABLE/APPROVED/DECLINED transition routes through. The
// channel internals are owned elsewhere (tests/discord-notify.test.mts,
// tests/notify-available.test.mts for the CAS statement itself,
// tests/notification-data.test.mts for row shaping, tests/in-app-notify.test.mts
// for the single-row writer); what THIS file pins is the hub's own wiring:
//   - notifyAvailablePerServer's per-server split: a requester bound to a media
//     server is notified only when THAT server has the item, with the documented
//     fallbacks when a server isn't configured (and an unknown mediaServer value
//     never notifies). No match ⇒ a complete no-op — zero CAS statements, zero
//     writes, zero channel reads;
//   - the hub claims through claimAvailableNotificationWinners with
//     requireStatusAvailable (the statement carries the notifiedAvailable CAS
//     predicate AND the status='AVAILABLE' guard, and never flips status), and
//     ONLY claimed winners reach any channel — a CAS loser appears in no
//     recipient query, no inbox row, no email;
//   - writeAvailableInAppNotifications: one createMany with skipDuplicates and
//     buildNotificationData-shaped rows per winner; failures are swallowed into
//     a scoped log so an inbox blip can't sink the sync run;
//   - notifyUsersRequestsAvailableEmail: one deduped pref query, then per-winner
//     sends gated on emailOnAvailable and a deliverable address
//     (notificationEmail precedence, synthetic *.local skipped) — driven to the
//     real Resend wire via scripted fetch so recipient selection is observable;
//     a pref-fetch failure is isolated (logged, zero sends, no throw);
//   - pollAndNotifyAvailable: notifies immediately when no server is configured;
//     otherwise probes on the 30s cadence (mocked setTimeout) until satisfied,
//     coalesces identical pending sets into ONE in-flight poll (and cleans up so
//     a later identical set polls fresh), and gives up after 24 probes WITHOUT
//     burning the once-only CAS;
//   - notifyRequestStatusChange: returns void synchronously, writes the in-app
//     inbox row unconditionally, and fans out discord/push/email per status —
//     the email leg reading exactly the per-status pref column (emailOnApproved/
//     emailOnAvailable/emailOnDeclined) and staying silent when it's off.
//
// No DB, network, or DNS: prisma.setting/user/notification/pushSubscription are
// shadowed in-memory and $queryRaw captures the CAS statement
// (tests/_helpers.mts); globalThis.fetch is scripted (only the Resend hop
// responds; anything else throws); dns/promises.lookup is stubbed for the
// api.resend.com SSRF resolve; the feature-flag cache is invalidated per test.
// Channel identification piggybacks on each channel's distinctive prisma read
// (discord: notifyOnAvailable/discordId; push: pushOnAvailable/pushOn*; email:
// the pref selects) — recipients stay empty so no channel ever reaches its own
// wire except the deliberately-scripted Resend POST. Dynamic imports keep the
// stubs ahead of the module graph (trakt.test pattern).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.NEXTAUTH_SECRET ??= "unit-test-session-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";

// ── DNS stub (see tests/trakt.test.mts for the rationale) ───────────────────
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch: only the Resend hop is real ─────────────────────────────
type ResendPost = { auth: string | null; body: { from: string; to: string; subject: string; html: string } };
const resendPosts: ResendPost[] = [];
const fetchUrls: string[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  fetchUrls.push(url);
  if (url === "https://api.resend.com/emails") {
    resendPosts.push({
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as ResendPost["body"],
    });
    return new Response(JSON.stringify({ id: `email_${resendPosts.length}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`unexpected fetch: ${url} — no channel other than Resend may reach the network`);
}) as typeof fetch;

// Dynamic imports so the stubs above genuinely precede the module-graph load.
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const {
  notifyAvailablePerServer,
  writeAvailableInAppNotifications,
  notifyUsersRequestsAvailableEmail,
  pollAndNotifyAvailable,
  notifyRequestStatusChange,
} = await import("../src/lib/request-notifications.ts");

// ── prisma stubs ────────────────────────────────────────────────────────────
// One Setting map serves the feature-flag read AND every channel's config read
// (discord token, VAPID keys, EMAIL_KEYS) — the discord-notify.test pattern.
const settings = new Map<string, string>();
const settingFindManyKeys: string[][] = [];
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where?: { key?: { in?: string[] } } }) => {
    const keys = args.where?.key?.in ?? [...settings.keys()];
    settingFindManyKeys.push([...keys]);
    return keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! }));
  },
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
});

// user.findMany is dispatched on each channel's distinctive where-shape; the
// recorded args ARE the assertion surface for "which channel got which ids".
type FindManyArgs = { where: Record<string, unknown> & { id?: { in?: string[] } }; select?: Record<string, unknown> };
const discordAvailableQueries: FindManyArgs[] = [];
const pushAvailableQueries: FindManyArgs[] = [];
const emailPrefQueries: FindManyArgs[] = [];
type EmailPrefRow = { id: string; email: string; notificationEmail: string | null; emailOnAvailable: boolean };
let emailPrefRows: EmailPrefRow[] = [];
let emailPrefImpl: (args: FindManyArgs) => Promise<EmailPrefRow[]> = async () => emailPrefRows;

type FindUniqueArgs = { where: { id: string }; select: Record<string, unknown> };
const discordUserReads: FindUniqueArgs[] = [];
const pushUserReads: FindUniqueArgs[] = [];
const emailUserReads: FindUniqueArgs[] = [];
let emailUserRow: Record<string, unknown> | null = null;

shadowPrismaModel(prisma, "user", {
  findMany: async (args: FindManyArgs) => {
    if (args.where.notifyOnAvailable === true) {
      discordAvailableQueries.push(args);
      return []; // no linked Discord users — the channel stops before its wire
    }
    if (args.where.pushOnAvailable === true) {
      pushAvailableQueries.push(args);
      return []; // no push-eligible users — the channel stops before its wire
    }
    emailPrefQueries.push(args);
    return emailPrefImpl(args);
  },
  findUnique: async (args: FindUniqueArgs) => {
    if (args.select.discordId) {
      discordUserReads.push(args);
      return null; // unlinked — discord stops after recipient resolution
    }
    if (args.select.pushOnApproved || args.select.pushOnDeclined) {
      pushUserReads.push(args);
      return null;
    }
    emailUserReads.push(args); // the hub's own per-status email-pref read
    return emailUserRow;
  },
});

const notifCreates: Array<{ data: Record<string, unknown> }> = [];
const createManyCalls: Array<{ data: Array<Record<string, unknown>>; skipDuplicates?: boolean }> = [];
let createManyImpl: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown> = async (args) => ({
  count: args.data.length,
});
shadowPrismaModel(prisma, "notification", {
  create: async (args: { data: Record<string, unknown> }) => {
    notifCreates.push(args);
    return args.data;
  },
  createMany: async (args: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
    createManyCalls.push(args);
    return createManyImpl(args);
  },
});

shadowPrismaModel(prisma, "pushSubscription", { findMany: async () => [] });

// The CAS claim (notify-available.ts) runs through $queryRaw; the captured
// Prisma.Sql exposes the statement + bind params. Default: every candidate wins.
type SqlLike = { sql: string; values: unknown[] };
const claims: SqlLike[] = [];
let claimImpl: (q: SqlLike) => Promise<{ id: string }[]> = async (q) => q.values.map((v) => ({ id: String(v) }));
shadowPrismaClientMethod(prisma, "$queryRaw", async (q: SqlLike) => {
  claims.push(q);
  return claimImpl(q);
});

// ── helpers ─────────────────────────────────────────────────────────────────
const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

function reqRow(id: string, mediaServer: string | null, over: Record<string, unknown> = {}) {
  return {
    id,
    requestedBy: `user-${id}`,
    title: `Title ${id}`,
    mediaType: "MOVIE",
    user: { mediaServer },
    ...over,
  };
}

// Channels short-circuit on ABSENT config; these keys let discord reach its
// recipient query and route email onto the scripted Resend wire.
function configureChannels(): void {
  settings.set("discordBotToken", "bot-token");
  settings.set("emailBackend", "resend");
  settings.set("resendApiKey", "rk_test");
  settings.set("smtpFrom", "noreply@summonarr.test");
  settings.set("enableUserEmails", "true");
}

const drain = async (rounds = 25) => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
};

async function waitFor(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  assert.fail(`timed out waiting for ${label}`);
}

// The hub fires channels fire-and-forget; settle until every counter has been
// stable for a stretch so no floating chain can bleed into the next test.
async function quiesce(): Promise<void> {
  let snapshot = "";
  let stable = 0;
  for (let i = 0; i < 400 && stable < 12; i++) {
    await new Promise<void>((r) => setImmediate(r));
    const now = JSON.stringify([
      settingFindManyKeys.length, discordAvailableQueries.length, pushAvailableQueries.length,
      emailPrefQueries.length, discordUserReads.length, pushUserReads.length, emailUserReads.length,
      notifCreates.length, createManyCalls.length, resendPosts.length, fetchUrls.length, claims.length,
    ]);
    if (now === snapshot) stable++;
    else { snapshot = now; stable = 0; }
  }
}

beforeEach(() => {
  settings.clear();
  invalidateFeatureFlagCache(); // the 10s flag cache must not leak across tests
  warns.length = 0;
  errors.length = 0;
  resendPosts.length = 0;
  fetchUrls.length = 0;
  settingFindManyKeys.length = 0;
  discordAvailableQueries.length = 0;
  pushAvailableQueries.length = 0;
  emailPrefQueries.length = 0;
  emailPrefRows = [];
  emailPrefImpl = async () => emailPrefRows;
  discordUserReads.length = 0;
  pushUserReads.length = 0;
  emailUserReads.length = 0;
  emailUserRow = null;
  notifCreates.length = 0;
  createManyCalls.length = 0;
  createManyImpl = async (args) => ({ count: args.data.length });
  claims.length = 0;
  claimImpl = async (q) => q.values.map((v) => ({ id: String(v) }));
});

// ── notifyAvailablePerServer: per-server split ──────────────────────────────

test("per-server split: only requesters whose own server has the item are claimed; unknown servers never notify", async () => {
  const pending = [
    reqRow("p1", "plex"), // plex has it → notified
    reqRow("j1", "jellyfin"), // jellyfin configured but doesn't have it → held back
    reqRow("n1", null, { user: null }), // no server preference → any match counts
    reqRow("e1", "emby"), // unknown value → never notified (fail closed)
  ];
  await notifyAvailablePerServer(pending, true, false, true, true, "scope");
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0].values, ["p1", "n1"]);
  await waitFor(() => createManyCalls.length === 1 && pushAvailableQueries.length === 1, "fan-out settle");
  await quiesce();
});

test("unconfigured-server fallbacks: a plex-bound user degrades to jellyfin only when plex is unconfigured", async () => {
  const plexBound = [reqRow("p1", "plex")];

  // Plex not configured, jellyfin has it → notified via the fallback.
  await notifyAvailablePerServer(plexBound, false, true, false, true, "scope");
  assert.deepEqual(claims[0]?.values, ["p1"]);
  await waitFor(() => createManyCalls.length === 1, "first fan-out settle");
  await quiesce();

  // Plex not configured, jellyfin configured but does NOT have it → held back.
  claims.length = 0;
  await notifyAvailablePerServer(plexBound, false, false, false, true, "scope");
  assert.equal(claims.length, 0);

  // Nothing configured at all → every requester is notified (nothing to check).
  await notifyAvailablePerServer(
    [reqRow("p2", "plex"), reqRow("j2", "jellyfin"), reqRow("n2", null)],
    false, false, false, false, "scope",
  );
  assert.deepEqual(claims[0]?.values, ["p2", "j2", "n2"]);
  await waitFor(() => createManyCalls.length === 2, "second fan-out settle");
  await quiesce();
});

test("no server matched (or empty pending) → complete no-op: no CAS, no writes, no channel reads, no network", async () => {
  await notifyAvailablePerServer([reqRow("p1", "plex")], false, true, true, true, "scope");
  await notifyAvailablePerServer([], true, true, true, true, "scope");
  await quiesce();
  assert.equal(claims.length, 0); // notifiedAvailable is never burned on a non-match
  assert.equal(createManyCalls.length, 0);
  assert.equal(discordAvailableQueries.length + pushAvailableQueries.length + emailPrefQueries.length, 0);
  assert.equal(settingFindManyKeys.length, 0); // not even a config/flag read
  assert.equal(fetchUrls.length, 0);
  assert.deepEqual(errors, []);
});

// ── notifyAvailablePerServer: CAS contract + winner-only fan-out ────────────

test("claims with requireStatusAvailable and fans out ONLY the CAS winners — a loser reaches no channel", async () => {
  configureChannels();
  const pending = [reqRow("a", null), reqRow("b", null), reqRow("c", null)];
  claimImpl = async () => [{ id: "a" }, { id: "c" }]; // "b" lost a concurrent race

  await notifyAvailablePerServer(pending, true, false, true, true, "scope");

  // One statement: the notifiedAvailable CAS plus the status guard this
  // non-markAvailable caller must pass — and it never flips status itself.
  assert.equal(claims.length, 1);
  const sql = norm(claims[0].sql);
  assert.match(sql, /AND "notifiedAvailable" = false/);
  assert.match(sql, /AND "status" = 'AVAILABLE'/);
  const setClause = sql.slice(sql.indexOf("SET"), sql.indexOf("WHERE"));
  assert.doesNotMatch(setClause, /"status"/);

  // Email pref fetch is awaited in the hub — winners only.
  assert.equal(emailPrefQueries.length, 1);
  assert.deepEqual(emailPrefQueries[0].where.id?.in, ["user-a", "user-c"]);

  await waitFor(
    () => discordAvailableQueries.length === 1 && pushAvailableQueries.length === 1 && createManyCalls.length === 1,
    "winner fan-out",
  );
  assert.deepEqual(discordAvailableQueries[0].where.id?.in, ["user-a", "user-c"]);
  assert.deepEqual(pushAvailableQueries[0].where.id?.in, ["user-a", "user-c"]);
  assert.deepEqual(createManyCalls[0].data.map((r) => r.userId), ["user-a", "user-c"]);
  const everything = JSON.stringify([discordAvailableQueries, pushAvailableQueries, emailPrefQueries, createManyCalls]);
  assert.ok(!everything.includes("user-b"), "the CAS loser must reach no channel");
  await quiesce();
});

test("zero CAS winners (all lost the race) → no channel is invoked at all", async () => {
  configureChannels();
  claimImpl = async () => [];
  await notifyAvailablePerServer([reqRow("a", null)], true, true, true, true, "scope");
  await quiesce();
  assert.equal(claims.length, 1); // the claim was attempted…
  assert.equal(createManyCalls.length, 0); // …but nothing fanned out
  assert.equal(discordAvailableQueries.length + pushAvailableQueries.length + emailPrefQueries.length, 0);
  assert.equal(resendPosts.length, 0);
});

// ── writeAvailableInAppNotifications ────────────────────────────────────────

test("batch inbox write: one createMany with skipDuplicates and buildNotificationData-shaped rows", async () => {
  await writeAvailableInAppNotifications([
    { requestedBy: "u1", title: "Dune", mediaType: "MOVIE", tmdbId: 438631, posterPath: "/d.jpg" },
    { requestedBy: "u2", title: "Severance", mediaType: "TV" }, // optionals default to null
  ]);
  assert.equal(createManyCalls.length, 1);
  assert.equal(createManyCalls[0].skipDuplicates, true);
  assert.deepEqual(createManyCalls[0].data, [
    {
      userId: "u1",
      type: "REQUEST_AVAILABLE",
      title: "Dune",
      body: "Your movie is now available to watch.",
      tmdbId: 438631,
      mediaType: "MOVIE",
      posterPath: "/d.jpg",
    },
    {
      userId: "u2",
      type: "REQUEST_AVAILABLE",
      title: "Severance",
      body: "Your TV show is now available to watch.",
      tmdbId: null,
      mediaType: "TV",
      posterPath: null,
    },
  ]);
  await writeAvailableInAppNotifications([]); // empty winner set is a no-op
  assert.equal(createManyCalls.length, 1);
  assert.deepEqual(errors, []);
});

test("a failed inbox batch write is swallowed into a scoped log — never a throw", async () => {
  createManyImpl = async () => {
    throw new Error("connection refused");
  };
  await writeAvailableInAppNotifications(
    [{ requestedBy: "u1", title: "Dune", mediaType: "MOVIE" }],
    "sync-plex",
  );
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("[sync-plex] in-app available write failed:"), errors[0]);
  assert.ok(errors[0].includes("connection refused"));
});

// ── notifyUsersRequestsAvailableEmail ───────────────────────────────────────

test("email recipients: one deduped pref query; emailOnAvailable + deliverable-address gating decide who is mailed", async () => {
  configureChannels();
  emailPrefRows = [
    { id: "u-yes", email: "yes@example.com", notificationEmail: null, emailOnAvailable: true },
    { id: "u-pref", email: "login@example.com", notificationEmail: "custom@example.com", emailOnAvailable: true },
    { id: "u-off", email: "off@example.com", notificationEmail: null, emailOnAvailable: false },
    { id: "u-syn", email: "jellyfin-1@jellyfin.local", notificationEmail: null, emailOnAvailable: true },
  ];
  await notifyUsersRequestsAvailableEmail([
    { requestedBy: "u-yes", title: "Dune", mediaType: "MOVIE", tmdbId: 438631 },
    { requestedBy: "u-yes", title: "Andor", mediaType: "TV" }, // second title, same user → second email
    { requestedBy: "u-pref", title: "Dune", mediaType: "MOVIE" },
    { requestedBy: "u-off", title: "Dune", mediaType: "MOVIE" }, // opted out
    { requestedBy: "u-syn", title: "Dune", mediaType: "MOVIE" }, // synthetic login identity, no notificationEmail
    { requestedBy: "u-ghost", title: "Dune", mediaType: "MOVIE" }, // no user row at all
  ]);

  // ONE pref query, user ids deduped, exactly the pref columns selected.
  assert.equal(emailPrefQueries.length, 1);
  assert.deepEqual(emailPrefQueries[0].where.id?.in, ["u-yes", "u-pref", "u-off", "u-syn", "u-ghost"]);
  assert.deepEqual(emailPrefQueries[0].select, {
    id: true,
    email: true,
    notificationEmail: true,
    emailOnAvailable: true,
  });

  await waitFor(() => resendPosts.length === 3, "three deliverable emails");
  await quiesce();
  assert.equal(resendPosts.length, 3); // opted-out / synthetic / unknown users stayed silent
  assert.deepEqual(
    resendPosts.map((p) => p.body.to).sort(),
    ["custom@example.com", "yes@example.com", "yes@example.com"], // notificationEmail wins over the login email
  );
  for (const p of resendPosts) {
    assert.equal(p.auth, "Bearer rk_test");
    assert.ok(p.body.subject.startsWith("Now Available:"), p.body.subject);
  }
  assert.deepEqual(errors, []);
});

test("a failed email-pref fetch is isolated: scoped log, zero sends, and the call still resolves", async () => {
  configureChannels();
  emailPrefImpl = async () => {
    throw new Error("pool exhausted");
  };
  await notifyUsersRequestsAvailableEmail(
    [{ requestedBy: "u-yes", title: "Dune", mediaType: "MOVIE" }],
    "sync-jellyfin",
  );
  await quiesce();
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("[sync-jellyfin] email-pref fetch failed:"), errors[0]);
  assert.equal(resendPosts.length, 0);

  await notifyUsersRequestsAvailableEmail([]); // empty winners: not even a pref query
  assert.equal(emailPrefQueries.length, 1); // only the failed one from above
});

// ── pollAndNotifyAvailable ──────────────────────────────────────────────────

test("no media server configured: notifies immediately — no polling, no timers", async () => {
  const pending = [reqRow("nc1", "plex"), reqRow("nc2", null)];
  await pollAndNotifyAvailable(pending, null, null, "nc");
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0].values, ["nc1", "nc2"]); // server-bound users included: nothing to check against
  await waitFor(() => createManyCalls.length === 1, "inbox write");
  await quiesce();
});

test("polls on the 30s cadence until the server reports the item, then claims exactly once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let plexChecks = 0;
  const checkPlex = async () => {
    plexChecks++;
    return plexChecks >= 2; // present on the second probe
  };
  const p = pollAndNotifyAvailable([reqRow("poll1", "plex")], checkPlex, null, "poll");

  await drain();
  assert.equal(plexChecks, 0); // parked in the first 30s sleep — no eager probe
  assert.equal(claims.length, 0);

  t.mock.timers.tick(30_000);
  await drain();
  assert.equal(plexChecks, 1);
  assert.equal(claims.length, 0); // not there yet → the once-only CAS is not burned

  t.mock.timers.tick(30_000);
  await drain();
  assert.equal(plexChecks, 2);
  await p;
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0].values, ["poll1"]);
  await waitFor(() => createManyCalls.length === 1, "inbox write");
  await quiesce();
});

test("an identical pending set joins the in-flight poll; after completion the same set polls fresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let checks = 0;
  const checkPlex = async () => {
    checks++;
    return true;
  };
  const p1 = pollAndNotifyAvailable([reqRow("co1", "plex")], checkPlex, null, "co");
  await drain();
  const p2 = pollAndNotifyAvailable([reqRow("co1", "plex")], checkPlex, null, "co"); // same id set, new array

  t.mock.timers.tick(30_000);
  await drain();
  await p1;
  await p2;
  assert.equal(checks, 1); // ONE poll served both webhook invocations
  assert.equal(claims.length, 1); // and one claim

  // The finally-cleanup released the key: a later identical set starts fresh.
  const p3 = pollAndNotifyAvailable([reqRow("co1", "plex")], checkPlex, null, "co");
  await drain();
  assert.equal(checks, 1); // parked on its own first sleep — a genuinely new poll
  t.mock.timers.tick(30_000);
  await drain();
  await p3;
  assert.equal(checks, 2);
  assert.equal(claims.length, 2);
  await quiesce();
});

test("gives up after 24 probes without burning the CAS — the orchestrator fallback owns the row from here", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let checks = 0;
  const checkPlex = async () => {
    checks++;
    return false; // the item never shows up
  };
  const p = pollAndNotifyAvailable([reqRow("gu1", "plex")], checkPlex, null, "giveup");
  for (let i = 0; i < 24; i++) {
    t.mock.timers.tick(30_000);
    await drain(6);
  }
  await p;
  assert.equal(checks, 24); // ITEM_POLL_MAX — the 12-minute budget
  assert.equal(claims.length, 0); // notifiedAvailable untouched → the sync fallback can still notify
  assert.equal(createManyCalls.length, 0);
  await quiesce();
});

// ── notifyRequestStatusChange ───────────────────────────────────────────────

test("APPROVED: synchronous void, unconditional in-app row, discord+push+email legs each fired; email honors emailOnApproved", async () => {
  configureChannels();
  emailUserRow = { email: "app@example.com", notificationEmail: null, emailOnApproved: true };

  const ret = notifyRequestStatusChange("APPROVED", {
    requestedBy: "u-app",
    title: "Dune",
    mediaType: "MOVIE",
    tmdbId: 438631,
    posterPath: "/d.jpg",
  });
  assert.equal(ret, undefined); // void — the approve route is never blocked on channels

  await waitFor(() => notifCreates.length === 1 && resendPosts.length === 1, "approved fan-out");
  await quiesce();

  // In-app inbox row: unconditional, shaped by the shared shaper.
  assert.deepEqual(notifCreates[0].data, {
    userId: "u-app",
    type: "REQUEST_APPROVED",
    title: "Dune",
    body: "Your movie request was approved and is downloading.",
    tmdbId: 438631,
    mediaType: "MOVIE",
    posterPath: "/d.jpg",
  });

  // Discord + push each reached their recipient resolution for this user.
  assert.equal(discordUserReads.length, 1);
  assert.equal(discordUserReads[0].where.id, "u-app");
  assert.deepEqual(pushUserReads[0], { where: { id: "u-app" }, select: { pushOnApproved: true } });

  // Email leg read exactly the per-status pref column, then mailed the user.
  assert.deepEqual(emailUserReads[0], {
    where: { id: "u-app" },
    select: { email: true, notificationEmail: true, emailOnApproved: true },
  });
  assert.equal(resendPosts[0].body.to, "app@example.com");
  assert.ok(resendPosts[0].body.subject.includes("Approved"), resendPosts[0].body.subject);
  assert.ok(resendPosts[0].body.subject.includes("Dune"));
  assert.deepEqual(errors, []);
});

test("DECLINED with emailOnDeclined off: the inbox row is still written but no email leaves", async () => {
  configureChannels();
  emailUserRow = { email: "dec@example.com", notificationEmail: null, emailOnDeclined: false };

  notifyRequestStatusChange("DECLINED", {
    requestedBy: "u-dec",
    title: "Andor",
    mediaType: "TV",
    adminNote: "duplicate request",
  });

  await waitFor(() => notifCreates.length === 1 && emailUserReads.length === 1, "declined fan-out");
  await quiesce();

  assert.deepEqual(notifCreates[0].data, {
    userId: "u-dec",
    type: "REQUEST_DECLINED",
    title: "Andor",
    body: "Your TV show request was declined.",
    tmdbId: null,
    mediaType: "TV",
    posterPath: null,
  });
  assert.deepEqual(emailUserReads[0].select, { email: true, notificationEmail: true, emailOnDeclined: true });
  assert.deepEqual(pushUserReads[0].select, { pushOnDeclined: true });
  assert.equal(resendPosts.length, 0); // the opt-out gate lives in THIS module
  assert.deepEqual(errors, []);
});

test("AVAILABLE: routes push through the batch helper and mails via emailOnAvailable", async () => {
  configureChannels();
  emailUserRow = { email: "av@example.com", notificationEmail: null, emailOnAvailable: true };

  notifyRequestStatusChange("AVAILABLE", {
    requestedBy: "u-av",
    title: "Dune",
    mediaType: "MOVIE",
    tmdbId: 438631,
  });

  await waitFor(
    () => notifCreates.length === 1 && pushAvailableQueries.length === 1 && resendPosts.length === 1,
    "available fan-out",
  );
  await quiesce();

  assert.equal(notifCreates[0].data.type, "REQUEST_AVAILABLE");
  assert.equal(notifCreates[0].data.body, "Your movie is now available to watch.");
  // The single-user AVAILABLE push reuses the batch fan-out (pushOnAvailable).
  assert.deepEqual(pushAvailableQueries[0].where.id?.in, ["u-av"]);
  assert.equal(discordUserReads.length, 1); // discord's per-user path also ran
  assert.deepEqual(emailUserReads[0].select, { email: true, notificationEmail: true, emailOnAvailable: true });
  assert.equal(resendPosts[0].body.to, "av@example.com");
  assert.deepEqual(errors, []);
});
