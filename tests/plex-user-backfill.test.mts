// Unit tests for runPlexUserBackfillIfNeeded (src/lib/plex-user-backfill.ts) —
// the boot-time self-heal that binds pre-migration Plex users (real email, null
// plexUserId) to their immutable plex.tv account id so id-based sign-in doesn't
// refuse them. The contracts pinned here are the ones a wrong refactor would
// turn into a lockout, a wrong-account bind, or boot noise:
//   - the "IfNeeded" gate is CANDIDATE-DRIVEN: the exact Plex-only where-filter
//     (null plexUserId/jellyfinUserId/passwordHash/deactivatedAt, no oidc
//     Account, no @jellyfin.local synthetic email) runs first, and an empty
//     result is a
//     complete no-op — no Setting reads, no plex.tv traffic, no writes. There
//     is deliberately NO module-level once-guard and the ranAt marker is
//     write-only (never read): once-per-boot lives in instrumentation.ts;
//   - unconfigured Plex (NO instance with an admin token) returns before any
//     network; an instance whose account fetch fails or returns empty warns
//     (instance-labeled) and contributes nothing, and when NO instance
//     contributes accounts the run skips WITHOUT stamping ranAt or touching
//     users;
//   - the account lists of EVERY configured Plex instance are merged into ONE
//     union (plexUserId is the plex.tv CLOUD account id, stable across
//     servers, so any instance's list resolves the same correct id), the
//     ambiguous-email drop applies across the MERGED map, and one instance
//     failing never costs another instance's binds;
//   - matching is by normalizeEmail on BOTH sides (candidate row and plex.tv
//     account), an ambiguous email (two distinct account ids) is never bound,
//     and an account with no email can never match an empty candidate email;
//   - a matched user gets exactly { plexUserId } written; a unique-violation
//     race on that update is swallowed (the live sign-in won) — not counted
//     bound, not warned unmatched;
//   - unmatched users produce the admin-facing REFUSED warning; the whole
//     helper NEVER throws (best-effort boot task).
//
// No DB, network, or DNS: prisma.user/prisma.setting are shadowed in-memory
// (tests/_helpers.mts), globalThis.fetch is scripted for the two real plex.tv
// hops getPlexAccounts makes (/api/v2/user owner JSON + /api/users friends
// XML), and dns/promises.lookup is stubbed for the plex.tv SSRF resolve.
// Every instance hits those SAME plex.tv origins, so multi-instance fixtures
// dispatch on the X-Plex-Token header (plexResponderByToken), not the origin.
// Dynamic imports keep the stubs ahead of the module graph (trakt.test pattern).
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

// ── scripted fetch ──────────────────────────────────────────────────────────
type FetchCall = { url: URL; headers: Headers };
const fetchCalls: FetchCall[] = [];
// Responders receive the request headers too: every Plex instance hits the
// SAME plex.tv origins, so multi-instance fixtures dispatch on X-Plex-Token.
let respond: (url: URL, headers: Headers) => Response = () => {
  throw new Error("unexpected fetch — script a responder for this test");
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  fetchCalls.push({ url, headers });
  return respond(url, headers);
}) as typeof fetch;

// Dynamic imports so the stubs above genuinely precede the module-graph load.
const { Prisma } = await import("../src/generated/prisma/index.js");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { runPlexUserBackfillIfNeeded } = await import("../src/lib/plex-user-backfill.ts");

// ── prisma stubs ────────────────────────────────────────────────────────────
type CandidateRow = { id: string; email: string };
let candidateRows: CandidateRow[] = [];
const userFindManyCalls: unknown[] = [];
const userUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
let userUpdateImpl: (args: { where: { id: string } }) => Promise<unknown> = async (args) => args.where;

shadowPrismaModel(prisma, "user", {
  findMany: async (args: unknown) => {
    userFindManyCalls.push(args);
    return candidateRows;
  },
  update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    userUpdates.push(args);
    return userUpdateImpl(args);
  },
});

const settings = new Map<string, string>();
const settingReadKeys: string[] = [];
const settingUpserts: Array<{ where: { key: string }; create: { key: string; value: string }; update: { value: string } }> = [];
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    settingReadKeys.push(args.where.key);
    const value = settings.get(args.where.key);
    return value === undefined ? null : { key: args.where.key, value };
  },
  upsert: async (args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) => {
    settingUpserts.push(args);
    return args.create;
  },
});

// ── responders / fixtures ───────────────────────────────────────────────────
const TOKEN = "plex-admin-token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/xml" } });
}

// plex.tv/api/users XML — ids must be digits (the parser matches id="(\d+)"),
// email is optional exactly like a real friend row that hid their address.
function friendsXml(friends: Array<{ id: string; name: string; email?: string }>): string {
  const blocks = friends
    .map((f) => `<User id="${f.id}" title="${f.name}"${f.email !== undefined ? ` email="${f.email}"` : ""} thumb="/t.png"></User>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer size="${friends.length}">\n${blocks}\n</MediaContainer>`;
}

// Standard responder: owner (JSON, numeric id like the real /api/v2/user) +
// friends (XML). Individual tests override `respond` for failure paths.
function plexResponder(opts: {
  owner?: { id: number; email: string };
  friends?: Array<{ id: string; name: string; email?: string }>;
}): (url: URL) => Response {
  return (url) => {
    if (url.pathname === "/api/v2/user") {
      return opts.owner
        ? jsonResponse({ id: opts.owner.id, email: opts.owner.email, username: "owner", thumb: "" })
        : jsonResponse({ error: "unauthorized" }, 401);
    }
    if (url.pathname === "/api/users") {
      return opts.friends ? xmlResponse(friendsXml(opts.friends)) : xmlResponse("", 401);
    }
    throw new Error(`unexpected fetch path: ${url.pathname}`);
  };
}

function configurePlex(): void {
  settings.set("plexAdminToken", TOKEN);
  settings.set("plexServerUrl", "http://plex.local:32400");
}

const REMOTE_TOKEN = "plex-remote-admin-token";

// Registers a second, named Plex instance ("remote") with its own admin token.
// No plexRemoteServerUrl on purpose: getPlexAccounts ignores its serverUrl
// param (both hops are account-level plex.tv calls, not machine-scoped) and
// the source tolerates the key missing.
function configureRemoteInstance(): void {
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  settings.set("plexRemoteAdminToken", REMOTE_TOKEN);
}

// Multi-instance responder: every instance's getPlexAccounts hits the SAME
// plex.tv origins (/api/v2/user + /api/users), so per-instance fixtures are
// keyed on the X-Plex-Token header — the only wire-level difference between
// instances. A function value lets a test make one instance die on the wire.
function plexResponderByToken(
  byToken: Record<string, Parameters<typeof plexResponder>[0] | ((url: URL) => Response) | undefined>,
): (url: URL, headers: Headers) => Response {
  return (url, headers) => {
    const token = headers.get("X-Plex-Token") ?? "";
    const script = byToken[token];
    if (script === undefined) throw new Error(`unexpected X-Plex-Token "${token}" — script a fixture for this token`);
    return typeof script === "function" ? script(url) : plexResponder(script)(url);
  };
}

beforeEach(() => {
  warns.length = 0;
  errors.length = 0;
  fetchCalls.length = 0;
  candidateRows = [];
  userFindManyCalls.length = 0;
  userUpdates.length = 0;
  userUpdateImpl = async (args) => args.where;
  settings.clear();
  settingReadKeys.length = 0;
  settingUpserts.length = 0;
  respond = () => {
    throw new Error("unexpected fetch — script a responder for this test");
  };
});

// ── the IfNeeded gate ───────────────────────────────────────────────────────

test("no Plex-only candidates → complete no-op: no Setting reads, no network, no writes, no logs", async () => {
  candidateRows = [];
  configurePlex(); // even fully configured, nothing must run
  await runPlexUserBackfillIfNeeded();
  assert.equal(userFindManyCalls.length, 1); // the gate query itself
  assert.deepEqual(settingReadKeys, []); // token is not even read
  assert.equal(fetchCalls.length, 0);
  assert.equal(userUpdates.length, 0);
  assert.equal(settingUpserts.length, 0);
  assert.deepEqual(warns, []);
  assert.deepEqual(errors, []);
});

test("the candidate query pins the Plex-only definition (who would ACTUALLY be locked out)", async () => {
  // Local (passwordHash), Jellyfin (jellyfinUserId or synthetic email), and
  // OIDC users have another way in — they must not be candidates, or every
  // boot spams REFUSED warnings for users that are fine. `deactivatedAt: null`
  // is the same rule for REMOVED accounts: sign-in is refused for them outright,
  // so a plexUserId they can never use is pointless to backfill — and a PURGED
  // row (purgeUserDataInTx nulls passwordHash / plexUserId / jellyfinUserId and
  // drops the Account rows) matches the Plex-only shape exactly — see the
  // dedicated test below.
  await runPlexUserBackfillIfNeeded();
  assert.deepEqual(userFindManyCalls[0], {
    where: {
      plexUserId: null,
      jellyfinUserId: null,
      passwordHash: null,
      deactivatedAt: null,
      accounts: { none: { provider: "oidc" } },
      NOT: { email: { endsWith: "@jellyfin.local" } },
    },
    select: { id: true, email: true },
  });
});

test("a purged user is excluded — the row shape purgeUserDataInTx leaves behind IS the Plex-only shape", async () => {
  // Regression: every boot warned "1 Plex-only user(s) could NOT be bound …
  // REFUSED on next Plex sign-in" naming deleted-<id>@deleted.invalid. The row
  // is deactivated and its .invalid email can never appear in plex.tv's account
  // list, so it can neither be bound nor ever sign in — pure boot noise that
  // also re-printed the deleted user's id on every restart.
  //
  // Assert against the where-clause (the in-memory stub does not filter): the
  // deactivatedAt term must be present, so the DB never returns such a row.
  const anonymizedShape = {
    // exactly what account-lifecycle.ts's purge writes, minus the fields it leaves alone
    passwordHash: null,
    plexUserId: null,
    jellyfinUserId: null,
    email: "deleted-x6we5f10j4qbt74jpn7mto1f@deleted.invalid",
    deactivatedAt: new Date("2026-07-26T00:00:00.000Z"),
  };
  await runPlexUserBackfillIfNeeded();
  const where = (userFindManyCalls[0] as { where: Record<string, unknown> }).where;

  // Every other candidate term matches the anonymized row — only deactivatedAt
  // rejects it, so dropping that term silently restores the warning.
  assert.equal(anonymizedShape.plexUserId, where.plexUserId);
  assert.equal(anonymizedShape.jellyfinUserId, where.jellyfinUserId);
  assert.equal(anonymizedShape.passwordHash, where.passwordHash);
  assert.ok(!anonymizedShape.email.endsWith("@jellyfin.local"));
  assert.ok("deactivatedAt" in where, "candidate filter must exclude deactivated (deleted) users");
  assert.equal(where.deactivatedAt, null);
  assert.notEqual(anonymizedShape.deactivatedAt, null);
});

test("Plex unconfigured: missing or empty plexAdminToken returns before any network or write", async () => {
  candidateRows = [{ id: "u1", email: "user@example.com" }];

  // No token row at all — plexServerUrl must not even be read. The instance
  // registry read (multi-server union) now precedes the connection keys; the
  // default instance's token is still the FIRST connection key read.
  await runPlexUserBackfillIfNeeded();
  assert.deepEqual(settingReadKeys, ["plexInstances", "plexAdminToken"]);
  assert.equal(fetchCalls.length, 0);

  // Cleared token ("") is also unconfigured.
  settings.set("plexAdminToken", "");
  await runPlexUserBackfillIfNeeded();
  assert.equal(fetchCalls.length, 0);
  assert.equal(userUpdates.length, 0);
  assert.equal(settingUpserts.length, 0); // ranAt is NOT stamped on the skip paths
  assert.deepEqual(warns, []);
});

// ── binding ─────────────────────────────────────────────────────────────────

test("happy path: owner + friend matched by normalized email; exact update shape, wire shape, and ranAt stamp", async () => {
  candidateRows = [
    { id: "u-owner", email: "owner@example.COM" }, // case-differs from plex.tv's "Owner@Example.com"
    { id: "u-friend", email: "friend@example.com" },
  ];
  configurePlex();
  respond = plexResponder({
    owner: { id: 100, email: "Owner@Example.com" }, // numeric id → coerced to "100"
    friends: [{ id: "201", name: "Friend", email: "FRIEND@Example.COM" }],
  });

  await runPlexUserBackfillIfNeeded();

  // Exactly plexUserId is written — nothing else on the User row.
  assert.deepEqual(userUpdates, [
    { where: { id: "u-owner" }, data: { plexUserId: "100" } },
    { where: { id: "u-friend" }, data: { plexUserId: "201" } },
  ]);

  // Wire shape: the two real plex.tv hops, both carrying the admin token.
  assert.deepEqual(
    fetchCalls.map((c) => c.url.origin + c.url.pathname),
    ["https://plex.tv/api/v2/user", "https://plex.tv/api/users"],
  );
  for (const c of fetchCalls) assert.equal(c.headers.get("X-Plex-Token"), TOKEN);

  // ranAt marker: written with an ISO timestamp, and NEVER read — the gate is
  // candidate-driven, not marker-driven.
  assert.equal(settingUpserts.length, 1);
  assert.equal(settingUpserts[0].where.key, "plexUserIdBackfillRanAt");
  assert.ok(!Number.isNaN(Date.parse(settingUpserts[0].create.value)));
  assert.ok(!Number.isNaN(Date.parse(settingUpserts[0].update.value)));
  // Registry read first (multi-server union), then the default instance's
  // token-before-ServerUrl pair — the exact legacy Setting keys.
  assert.deepEqual(settingReadKeys, ["plexInstances", "plexAdminToken", "plexServerUrl"]);

  // One admin-facing summary warn, no unmatched noise, no errors.
  assert.deepEqual(warns, ["[plex-backfill] bound 2 existing Plex user(s) to their plex.tv account id."]);
  assert.deepEqual(errors, []);
});

test("unmatched candidate: no update, ranAt still stamped, REFUSED warning names the user", async () => {
  candidateRows = [{ id: "u-ghost", email: "ghost@nowhere.com" }];
  configurePlex();
  respond = plexResponder({ owner: { id: 100, email: "owner@example.com" }, friends: [] });

  await runPlexUserBackfillIfNeeded();

  assert.equal(userUpdates.length, 0);
  assert.equal(settingUpserts.length, 1); // the run itself completed — marker written
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes("1 Plex-only user(s) could NOT be bound"), warns[0]);
  assert.ok(warns[0].includes("REFUSED on next Plex sign-in"), warns[0]);
  assert.ok(warns[0].includes("ghost@nowhere.com (u-ghost)"), warns[0]);
});

test("ambiguous email (two distinct account ids) is never bound; the same id listed twice is not ambiguous", async () => {
  // Plex emails are user-changeable and not unique — binding an ambiguous one
  // could attach a local record to the WRONG plex.tv account. Skipping it is
  // the safety contract; the admin sets plexUserId explicitly instead.
  candidateRows = [
    { id: "u-dup", email: "dup@example.com" },
    { id: "u-same", email: "same@example.com" },
  ];
  configurePlex();
  respond = plexResponder({
    owner: { id: 100, email: "owner@example.com" },
    friends: [
      { id: "201", name: "A", email: "dup@example.com" },
      { id: "202", name: "B", email: "dup@example.com" }, // second id ⇒ ambiguous
      { id: "301", name: "C", email: "same@example.com" },
      { id: "301", name: "C-again", email: "same@example.com" }, // same id ⇒ fine
    ],
  });

  await runPlexUserBackfillIfNeeded();

  assert.deepEqual(userUpdates, [{ where: { id: "u-same" }, data: { plexUserId: "301" } }]);
  const unmatchedWarn = warns.find((w) => w.includes("could NOT be bound"));
  assert.ok(unmatchedWarn?.includes("dup@example.com (u-dup)"), String(unmatchedWarn));
});

test("an account with no email can never match — an empty candidate email lands in unmatched, not on a bogus bind", async () => {
  candidateRows = [{ id: "u-empty", email: "" }];
  configurePlex();
  respond = plexResponder({
    owner: { id: 100, email: "owner@example.com" },
    friends: [{ id: "401", name: "NoEmailFriend" }], // email attr absent → parsed as ""
  });

  await runPlexUserBackfillIfNeeded();

  // A ""→"" match would bind an arbitrary hidden-email friend; pin that the
  // no-email account is dropped from the map instead.
  assert.equal(userUpdates.length, 0);
  assert.ok(warns.some((w) => w.includes("could NOT be bound")));
});

// ── multi-instance union ────────────────────────────────────────────────────

test("union: a candidate present only in a NAMED instance's account list is bound", async () => {
  // plexUserId is the plex.tv CLOUD account id — stable across servers — so a
  // person matched via ANY instance's admin list gets the same correct id;
  // fetching only the default instance would strand this user unmatched.
  candidateRows = [{ id: "u-roamer", email: "roamer@example.com" }];
  configurePlex();
  configureRemoteInstance();
  respond = plexResponderByToken({
    [TOKEN]: { owner: { id: 100, email: "owner@example.com" }, friends: [] },
    [REMOTE_TOKEN]: {
      owner: { id: 900, email: "remote-admin@example.com" },
      friends: [{ id: "501", name: "Roamer", email: "roamer@example.com" }],
    },
  });

  await runPlexUserBackfillIfNeeded();

  assert.deepEqual(userUpdates, [{ where: { id: "u-roamer" }, data: { plexUserId: "501" } }]);
  // Read order pins the union plumbing: registry first, then per instance the
  // token BEFORE ServerUrl (a tokenless instance must skip without touching
  // its ServerUrl key), default instance first.
  assert.deepEqual(settingReadKeys, [
    "plexInstances",
    "plexAdminToken",
    "plexServerUrl",
    "plexRemoteAdminToken",
    "plexRemoteServerUrl",
  ]);
  // Two plex.tv hops per instance, each pair carrying its OWN admin token.
  assert.deepEqual(
    fetchCalls.map((c) => c.headers.get("X-Plex-Token")),
    [TOKEN, TOKEN, REMOTE_TOKEN, REMOTE_TOKEN],
  );
  assert.equal(settingUpserts.length, 1); // union contributed accounts → ranAt stamped
  assert.deepEqual(warns, ["[plex-backfill] bound 1 existing Plex user(s) to their plex.tv account id."]);
  assert.deepEqual(errors, []);
});

test("cross-instance ambiguity: the same email with DIFFERENT ids across instances binds neither; the same id across instances still binds", async () => {
  // The ambiguous-email drop applies to the MERGED map: two instances' admins
  // each reporting an email under a different plex.tv id means we cannot know
  // which account owns the local record — bind neither. The same id re-listed
  // by both instances is the normal shared-admin/shared-friend case
  // (getPlexAccounts is account-level) and stays a plain no-op.
  candidateRows = [
    { id: "u-xdup", email: "xdup@example.com" },
    { id: "u-shared", email: "shared@example.com" },
  ];
  configurePlex();
  configureRemoteInstance();
  respond = plexResponderByToken({
    [TOKEN]: {
      owner: { id: 100, email: "owner@example.com" },
      friends: [
        { id: "201", name: "A", email: "xdup@example.com" },
        { id: "301", name: "S", email: "shared@example.com" },
      ],
    },
    [REMOTE_TOKEN]: {
      owner: { id: 900, email: "remote-admin@example.com" },
      friends: [
        { id: "202", name: "A2", email: "xdup@example.com" }, // different id for the same email ⇒ ambiguous across the union
        { id: "301", name: "S", email: "shared@example.com" }, // same id from both instances ⇒ fine
      ],
    },
  });

  await runPlexUserBackfillIfNeeded();

  assert.deepEqual(userUpdates, [{ where: { id: "u-shared" }, data: { plexUserId: "301" } }]);
  const unmatchedWarn = warns.find((w) => w.includes("could NOT be bound"));
  assert.ok(unmatchedWarn?.includes("xdup@example.com (u-xdup)"), String(unmatchedWarn));
});

test("per-instance failure isolation: the default instance dying on the wire does not cost the named instance's binds", async () => {
  candidateRows = [{ id: "u-remote", email: "friend@example.com" }];
  configurePlex();
  configureRemoteInstance();
  respond = plexResponderByToken({
    [TOKEN]: () => {
      throw new Error("ECONNREFUSED plex.tv"); // both default-instance hops die on the wire
    },
    [REMOTE_TOKEN]: {
      owner: { id: 900, email: "remote-admin@example.com" },
      friends: [{ id: "601", name: "Friend", email: "friend@example.com" }],
    },
  });

  await runPlexUserBackfillIfNeeded();

  assert.deepEqual(userUpdates, [{ where: { id: "u-remote" }, data: { plexUserId: "601" } }]);
  assert.equal(settingUpserts.length, 1); // the union still contributed accounts → ranAt stamped
  // The dead instance degrades to its own labeled warn (getPlexAccounts
  // swallows the per-hop failures and returns []) without aborting the union.
  assert.ok(
    warns.some((w) => w.includes("[plex-backfill] plex returned no accounts; skipping this instance (token may be invalid).")),
    warns.join("\n"),
  );
  assert.ok(warns.some((w) => w.includes("bound 1 existing Plex user(s)")), warns.join("\n"));
  assert.deepEqual(errors, []);
});

test("all instances empty/unreachable: per-instance warns and NO ranAt stamp (retry next boot)", async () => {
  candidateRows = [{ id: "u1", email: "user@example.com" }];
  configurePlex();
  configureRemoteInstance();
  respond = plexResponderByToken({
    [TOKEN]: {}, // both hops 401 → empty list
    [REMOTE_TOKEN]: {}, // both hops 401 → empty list
  });

  await runPlexUserBackfillIfNeeded();

  assert.equal(userUpdates.length, 0);
  assert.equal(settingUpserts.length, 0); // nothing fetched anywhere → retryable next boot
  assert.ok(
    warns.some((w) => w.includes("[plex-backfill] plex returned no accounts; skipping this instance")),
    warns.join("\n"),
  );
  assert.ok(
    warns.some((w) => w.includes("[plex-backfill] plex:remote returned no accounts; skipping this instance")),
    warns.join("\n"),
  );
});

// ── degradation ─────────────────────────────────────────────────────────────

test("plex.tv returns no accounts (bad token): warn + skip — no binds, and NO ranAt stamp", async () => {
  candidateRows = [{ id: "u1", email: "user@example.com" }];
  configurePlex();
  respond = plexResponder({}); // both hops 401 → owner throw (warned in plex.ts), friends skipped

  await runPlexUserBackfillIfNeeded();

  assert.equal(userUpdates.length, 0);
  assert.equal(settingUpserts.length, 0); // a failed run must be retryable next boot
  assert.ok(warns.some((w) => w.includes("[plex] Failed to fetch server owner info:")));
  // The skip warn is instance-labeled now (mediaInstanceLabel: "plex" = the
  // default instance) and scoped to the instance, not the whole run.
  assert.ok(
    warns.some((w) => w.includes("[plex-backfill] plex returned no accounts; skipping this instance (token may be invalid).")),
  );
  assert.deepEqual(errors, []);
});

test("a unique-violation race on the update is swallowed: not bound, not unmatched, run still completes", async () => {
  // A concurrent live sign-in can bind the same plexUserId first; the loser's
  // update throws P2002 and that user needs neither warning — they're fine.
  //
  // Throws a REAL PrismaClientKnownRequestError: the catch discriminates on the
  // error code, so a plain Error whose message merely contains "P2002" would
  // exercise the unexpected-error branch instead and pin nothing about races.
  candidateRows = [{ id: "u-race", email: "owner@example.com" }];
  configurePlex();
  respond = plexResponder({ owner: { id: 100, email: "owner@example.com" }, friends: [] });
  userUpdateImpl = async () => {
    throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
  };

  await runPlexUserBackfillIfNeeded();

  assert.equal(userUpdates.length, 1); // the attempt was made…
  assert.deepEqual(warns, []); // …but no bound-count warn and no REFUSED warn
  assert.deepEqual(errors, []); // and the race is not an error
  assert.equal(settingUpserts.length, 1); // the run completed → marker stamped
});

test("PIN: a NON-race update failure is surfaced, not silently swallowed", async () => {
  // The catch used to be bare, so a transient DB error left the user in neither
  // `bound` nor `unmatched` — no warning at all, and the never-retry marker
  // stamped over a failure nobody could see. It must warn and count as unmatched.
  candidateRows = [{ id: "u-db", email: "owner@example.com" }];
  configurePlex();
  respond = plexResponder({ owner: { id: 100, email: "owner@example.com" }, friends: [] });
  userUpdateImpl = async () => {
    throw new Error("connection terminated unexpectedly");
  };

  await runPlexUserBackfillIfNeeded();

  assert.equal(userUpdates.length, 1);
  assert.ok(
    warns.some((w) => w.includes("[plex-backfill] Binding owner@example.com failed:")),
    warns.join("\n"),
  );
  assert.ok(warns.some((w) => w.includes("could NOT be bound")), "the user lands in unmatched");
});

test("PIN: a partial account fetch that leaves someone unbound withholds the run marker", async () => {
  // getPlexAccountsDetailed swallows each hop, so an owner-only list from a
  // FAILED friends hop looks identical to "this admin shares with nobody".
  // Stamping the never-retry marker on that strands every friend permanently —
  // the read side in instrumentation.ts never calls the backfill again.
  candidateRows = [{ id: "u-friend", email: "friend@example.com" }];
  configurePlex();
  // Owner hop succeeds; omitting `friends` makes the shared-users hop 401 →
  // friendsOk false, while the owner still comes back (an owner-only list).
  respond = plexResponder({ owner: { id: 100, email: "owner@example.com" } });

  await runPlexUserBackfillIfNeeded();

  assert.equal(settingUpserts.length, 0, "no marker — the next boot must retry");
  assert.ok(
    warns.some((w) => w.includes("returned a partial account list")),
    warns.join("\n"),
  );
});

test("never throws: a failing candidate query degrades to a [plex-backfill] error log", async () => {
  const boom = new Error("connection refused");
  shadowPrismaModel(prisma, "user", {
    findMany: async () => {
      throw boom;
    },
    update: async () => ({}),
  });
  try {
    await runPlexUserBackfillIfNeeded(); // must resolve — boot depends on it
  } finally {
    // Restore the standard stub for any later test.
    shadowPrismaModel(prisma, "user", {
      findMany: async (args: unknown) => {
        userFindManyCalls.push(args);
        return candidateRows;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        userUpdates.push(args);
        return userUpdateImpl(args);
      },
    });
  }
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("[plex-backfill] Backfill failed:"), errors[0]);
});

test("no module-level once-guard: a second invocation runs the whole flow again", async () => {
  // The once-per-boot guarantee lives in instrumentation.ts, not here; the
  // helper itself must stay re-runnable (and re-entrant across boots).
  candidateRows = [{ id: "u1", email: "owner@example.com" }];
  configurePlex();
  respond = plexResponder({ owner: { id: 100, email: "owner@example.com" }, friends: [] });

  await runPlexUserBackfillIfNeeded();
  await runPlexUserBackfillIfNeeded();

  assert.equal(userFindManyCalls.length, 2);
  assert.equal(userUpdates.length, 2); // stub never mutates, so both runs bind
  assert.equal(settingUpserts.length, 2);
  assert.equal(fetchCalls.length, 4); // two plex.tv hops per run
});
