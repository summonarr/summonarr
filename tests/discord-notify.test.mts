// Unit tests for the Discord notification sender (src/lib/discord-notify.ts) —
// the module behind every request/issue Discord ping and the role-assign-on-link
// hook. The contracts pinned here:
//   - GATING SHORT-CIRCUITS: the feature.integration.discord flag and the
//     botToken/channel config are checked BEFORE any network call or user-row
//     read. A disabled integration (or half-configured one) must produce ZERO
//     fetches — resurrecting a disabled bot via a code shuffle is the failure
//     mode this guards.
//   - RECIPIENT RESOLUTION: per-user paths resolve the linked Discord account
//     via prisma.user (discordId + the per-event notifyOn* preference); no
//     linked account or an opted-out preference means no send. The admin
//     fan-out (notifyAdminsIssueMessage) selects by MANAGE_ISSUES permission
//     (role preset or explicit bit) and honors excludeUserId/restrictToUserId/
//     fromAdmin — the exclude path is what stops an admin being pinged for
//     their own reply.
//   - WIRE SHAPE (representative subset, not embed snapshots): exact discord.com
//     /api/v10 URLs, POST/PUT methods, `Bot <token>` auth header, the
//     channel-vs-DM split on discordNotifyChannelId, mention hygiene
//     (allowed_mentions parse:[] everywhere; the explicit users array only on
//     targeted channel posts; DMs carry no content mention), the approve/decline
//     button custom_ids the interaction handler dispatches on, and the
//     256-char title clamp that keeps Discord from 400-dropping the message.
//   - FAILURE DEGRADES: a Discord 4xx/5xx is logged with the [discord-notify]
//     scope and NEVER thrown to the caller — approve/decline routes must not
//     500 because Discord hiccuped. The admin fan-out isolates per-recipient
//     failures.
//   - assignDiscordRolesOnLink maps provider (synthetic @jellyfin.local email)
//     and app role to the configured role ids, skipping invalid snowflakes.
//
// No DB or network: prisma.setting/prisma.user are shadowed in-memory
// (tests/_helpers.mts), globalThis.fetch is scripted, and dns/promises.lookup
// is stubbed so the safe-fetch SSRF resolver never issues a real lookup for
// discord.com. The feature-flag cache is invalidated per test (10s TTL would
// otherwise leak a flag value across tests). Dynamic imports keep the stubs
// ahead of the module graph (static imports would hoist — trakt.test pattern).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.NEXTAUTH_SECRET ??= "unit-test-session-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";

// ── DNS stub (safe-fetch resolves discord.com before fetching) ─────────────
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
type SentRequest = { url: string; method: string; headers: Headers; body: Record<string, unknown> | undefined };
const sent: SentRequest[] = [];
const okJson = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
// Default responder works for both call shapes: message posts only check res.ok,
// the DM-channel open additionally reads { id } from the body.
let respond: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
  okJson({ id: "999999999999999999" });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const raw = init?.body;
  sent.push({
    url,
    method: init?.method ?? "GET",
    headers: new Headers(init?.headers),
    body: typeof raw === "string" && raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
  });
  return respond(url, init);
}) as typeof fetch;

// Dynamic imports so the stubs above genuinely precede the module-graph load.
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const {
  assignDiscordRolesOnLink,
  notifyAdminsNewRequestDiscord,
  notifyAdminsNewIssueDiscord,
  notifyAdminsIssueMessage,
  notifyUserRequestApproved,
  notifyUserRequestAvailable,
  notifyUsersRequestsApproved,
} = await import("../src/lib/discord-notify.ts");

// ── prisma stubs ────────────────────────────────────────────────────────────
// One Setting map serves BOTH the feature-flag read (findMany over FEATURE_KEYS)
// and the discord config reads — absent rows read as "unconfigured", and the
// discord flag defaults ON, so a bare map means "integration enabled, nothing
// configured".
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

type UserRow = Record<string, unknown>;
let userFindUniqueRow: UserRow | null = null;
let userFindManyRows: UserRow[] = [];
const userFindUniqueCalls: unknown[] = [];
const userFindManyWheres: Array<Record<string, unknown>> = [];
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: unknown) => { userFindUniqueCalls.push(args); return userFindUniqueRow; },
  findMany: async (args: { where: Record<string, unknown> }) => {
    userFindManyWheres.push(args.where);
    return userFindManyRows;
  },
});

function setSettings(map: Record<string, string>): void {
  settings.clear();
  for (const [k, v] of Object.entries(map)) settings.set(k, v);
}

const BOT = "test-bot-token";
const AUTH = `Bot ${BOT}`;
const API = "https://discord.com/api/v10";
const CHANNEL = "444444444444444444"; // discordNotifyChannelId
const ADMIN_CHANNEL = "445544554455445544"; // discordAdminRequestChannelId
const DID = "111111111111111111"; // a linked user's Discord id

// A fully-notifiable linked user; individual tests flip fields off.
const linkedUser = (overrides: UserRow = {}): UserRow => ({
  discordId: DID,
  notifyOnApproved: true,
  notifyOnAvailable: true,
  notifyOnDeclined: true,
  notifyOnIssue: true,
  ...overrides,
});

beforeEach(() => {
  settings.clear();
  invalidateFeatureFlagCache(); // the 10s flag cache must not leak across tests
  sent.length = 0;
  warns.length = 0;
  errors.length = 0;
  userFindUniqueRow = null;
  userFindManyRows = [];
  userFindUniqueCalls.length = 0;
  userFindManyWheres.length = 0;
  respond = () => okJson({ id: "999999999999999999" });
});

// ── gating short-circuits ───────────────────────────────────────────────────

test("feature flag off: every entry point returns before any fetch or user read, even fully configured", async () => {
  setSettings({
    "feature.integration.discord": "false",
    discordBotToken: BOT,
    discordNotifyChannelId: CHANNEL,
    discordAdminRequestChannelId: ADMIN_CHANNEL,
    discordGuildId: "900000000000000001",
    discordLinkedRoleId: "900000000000000002",
  });
  userFindUniqueRow = linkedUser();

  await notifyUserRequestApproved("u1", "Dune", "MOVIE");
  await notifyAdminsNewRequestDiscord({ requestId: "r1", title: "Dune", mediaType: "MOVIE", requestedBy: "alice", note: null, posterPath: null });
  await notifyAdminsNewIssueDiscord({ issueId: "i1", title: "Dune", mediaType: "MOVIE", issueType: "OTHER", reportedBy: "alice", note: null, posterPath: null });
  await assignDiscordRolesOnLink(DID, "alice@example.com", "USER");
  await notifyAdminsIssueMessage("Dune", "alice", "hello");
  await notifyUsersRequestsApproved([{ requestedBy: "u1", title: "Dune", mediaType: "MOVIE" }]);

  assert.equal(sent.length, 0, "a disabled integration must never touch the network");
  assert.equal(userFindUniqueCalls.length, 0, "recipient lookup must not run when the flag is off");
  assert.equal(userFindManyWheres.length, 0);
});

test("half-configured: missing botToken / channel / valid snowflake all short-circuit before fetch", async () => {
  userFindUniqueRow = linkedUser();

  // Flag on (default), channel present, but no bot token → getConfig() null,
  // and the user row is never read (config gates BEFORE recipient resolution).
  setSettings({ discordNotifyChannelId: CHANNEL });
  await notifyUserRequestApproved("u1", "Dune", "MOVIE");
  assert.equal(sent.length, 0);
  assert.equal(userFindUniqueCalls.length, 0);

  // Bot token but no admin-request channel → the admin post is skipped.
  setSettings({ discordBotToken: BOT });
  invalidateFeatureFlagCache();
  await notifyAdminsNewRequestDiscord({ requestId: "r1", title: "Dune", mediaType: "MOVIE", requestedBy: "alice", note: null, posterPath: null });
  assert.equal(sent.length, 0);

  // Admin channel configured but not a snowflake → skipped (never sent to Discord).
  setSettings({ discordBotToken: BOT, discordAdminRequestChannelId: "general" });
  invalidateFeatureFlagCache();
  await notifyAdminsNewRequestDiscord({ requestId: "r1", title: "Dune", mediaType: "MOVIE", requestedBy: "alice", note: null, posterPath: null });
  assert.equal(sent.length, 0);

  // Bot token but no notify channel → admin issue fan-out is channel-only, skips
  // without ever querying users.
  setSettings({ discordBotToken: BOT });
  invalidateFeatureFlagCache();
  await notifyAdminsIssueMessage("Dune", "alice", "hello");
  assert.equal(sent.length, 0);
  assert.equal(userFindManyWheres.length, 0);
});

// ── per-user notify: recipient resolution + transport split ────────────────

test("DM path (no channel configured): opens the DM channel then posts, with no mention content", async () => {
  setSettings({ discordBotToken: BOT });
  userFindUniqueRow = linkedUser();
  respond = (url) =>
    url.endsWith("/users/@me/channels") ? okJson({ id: "222222222222222222" }) : okJson({});

  await notifyUserRequestApproved("u1", "Dune", "MOVIE");

  assert.equal(sent.length, 2);
  const [open, msg] = sent;
  assert.equal(open.url, `${API}/users/@me/channels`);
  assert.equal(open.method, "POST");
  assert.equal(open.headers.get("authorization"), AUTH);
  assert.deepEqual(open.body, { recipient_id: DID });

  assert.equal(msg.url, `${API}/channels/222222222222222222/messages`);
  assert.equal(msg.method, "POST");
  assert.equal(msg.headers.get("authorization"), AUTH);
  const embeds = msg.body?.embeds as Array<Record<string, unknown>>;
  assert.equal(embeds.length, 1);
  assert.equal(embeds[0].color, 0x5865f2); // COLORS.approved
  assert.ok(String(embeds[0].title).startsWith("✅ Request Approved — Dune"));
  assert.ok(!("content" in (msg.body ?? {})), "a DM must not carry a mention — the channel IS the recipient");
});

test("channel path: one targeted post with the <@id> mention allowed explicitly and nothing else", async () => {
  setSettings({ discordBotToken: BOT, discordNotifyChannelId: CHANNEL });
  userFindUniqueRow = linkedUser();

  await notifyUserRequestAvailable("u1", "Dune *Part* Two", "MOVIE");

  assert.equal(sent.length, 1);
  const post = sent[0];
  assert.equal(post.url, `${API}/channels/${CHANNEL}/messages`);
  assert.equal(post.method, "POST");
  assert.equal(post.headers.get("authorization"), AUTH);
  assert.equal(post.body?.content, `<@${DID}>`);
  // parse:[] suppresses @everyone/@here; only the single target may ping.
  assert.deepEqual(post.body?.allowed_mentions, { parse: [], users: [DID] });
  const embed = (post.body?.embeds as Array<Record<string, unknown>>)[0];
  assert.equal(embed.color, 0x57f287); // COLORS.available
  // User-controlled title is markdown-escaped so it can't inject formatting.
  assert.ok(String(embed.title).includes("Dune \\*Part\\* Two"));
});

test("recipient gating: no linked account or an opted-out preference sends nothing; other prefs stay independent", async () => {
  setSettings({ discordBotToken: BOT, discordNotifyChannelId: CHANNEL });

  // Opted out of approved notifications specifically…
  userFindUniqueRow = linkedUser({ notifyOnApproved: false });
  await notifyUserRequestApproved("u1", "Dune", "MOVIE");
  assert.equal(sent.length, 0, "notifyOnApproved=false must gate the approved ping");

  // …while the available preference on the same user still delivers.
  await notifyUserRequestAvailable("u1", "Dune", "MOVIE");
  assert.equal(sent.length, 1, "an unrelated preference must not gate this event type");

  // No linked Discord account at all → nothing, no error noise.
  sent.length = 0;
  userFindUniqueRow = linkedUser({ discordId: null });
  await notifyUserRequestApproved("u1", "Dune", "MOVIE");
  assert.equal(sent.length, 0);
  assert.equal(errors.length, 0);
});

test("a failed Discord post degrades to a [discord-notify] error log and never throws to the caller", async () => {
  setSettings({ discordBotToken: BOT, discordNotifyChannelId: CHANNEL });
  userFindUniqueRow = linkedUser();
  respond = () => new Response("Missing Access", { status: 403 });

  await notifyUserRequestApproved("u1", "Dune", "MOVIE"); // must resolve, not reject
  assert.equal(sent.length, 1, "the post was attempted");
  assert.ok(
    errors.some((e) => e.includes("[discord-notify] Failed to send notification:") && e.includes("403")),
    "the failure must be logged with scope + status",
  );
});

test("embed titles are clamped to 256 chars at the send boundary (Discord 400-drops longer ones)", async () => {
  setSettings({ discordBotToken: BOT, discordNotifyChannelId: CHANNEL });
  userFindUniqueRow = linkedUser();

  await notifyUserRequestApproved("u1", "x".repeat(300), "MOVIE");

  const embed = (sent[0].body?.embeds as Array<Record<string, unknown>>)[0];
  const title = String(embed.title);
  assert.equal(title.length, 256);
  assert.ok(title.endsWith("…"), "the clamp marks truncation with an ellipsis");
});

// ── admin channel posts (new request / new issue) ───────────────────────────

test("notifyAdminsNewRequestDiscord: exact channel URL, approve/decline button ids, blockquoted note, suppressed mentions", async () => {
  setSettings({ discordBotToken: BOT, discordAdminRequestChannelId: ADMIN_CHANNEL });

  await notifyAdminsNewRequestDiscord({
    requestId: "req-42",
    title: "Dune",
    mediaType: "MOVIE",
    requestedBy: "alice",
    note: "line one\nline two",
    posterPath: "/dune.jpg",
  });

  assert.equal(sent.length, 1);
  const post = sent[0];
  assert.equal(post.url, `${API}/channels/${ADMIN_CHANNEL}/messages`);
  assert.equal(post.method, "POST");
  assert.equal(post.headers.get("authorization"), AUTH);
  assert.deepEqual(post.body?.allowed_mentions, { parse: [] }); // channel-wide post pings nobody

  const embed = (post.body?.embeds as Array<Record<string, unknown>>)[0];
  assert.equal(embed.color, 0xfee75c); // COLORS.pending
  assert.ok(String(embed.title).startsWith("📥 New Request — Dune"));
  // Every note line stays inside the blockquote (a bare second line would
  // render as normal channel text).
  assert.ok(String(embed.description).includes("\n> line one\n> line two"));
  assert.deepEqual(embed.thumbnail, { url: "https://image.tmdb.org/t/p/w185/dune.jpg" });

  // The interaction handler dispatches on these custom_ids — they are the wire contract.
  const rows = post.body?.components as Array<{ components: Array<{ custom_id: string; label: string }> }>;
  assert.deepEqual(
    rows[0].components.map((c) => c.custom_id),
    ["admin_approve:req-42", "admin_decline:req-42"],
  );
});

test("notifyAdminsNewIssueDiscord: same admin channel, human issue-type label, and NO action buttons", async () => {
  setSettings({ discordBotToken: BOT, discordAdminRequestChannelId: ADMIN_CHANNEL });

  await notifyAdminsNewIssueDiscord({
    issueId: "i-7",
    title: "Dune",
    mediaType: "MOVIE",
    issueType: "MISSING_SUBTITLES",
    reportedBy: "bob",
    note: null,
    posterPath: null,
  });

  assert.equal(sent.length, 1);
  const post = sent[0];
  assert.equal(post.url, `${API}/channels/${ADMIN_CHANNEL}/messages`);
  const embed = (post.body?.embeds as Array<Record<string, unknown>>)[0];
  assert.equal(embed.color, 0xeb459e); // COLORS.issue
  assert.ok(String(embed.title).startsWith("🛠️ New Issue — Dune"));
  assert.ok(String(embed.description).includes("Missing subtitles"), "ISSUE_TYPE_LABELS mapping applied");
  // Issues are triaged in-app (claim/resolve/reply) — no embed actions.
  assert.ok(!("components" in (post.body ?? {})));
});

// ── notifyAdminsIssueMessage: fan-out recipient selection ───────────────────

test("admin fan-out selects by MANAGE_ISSUES (role preset or explicit bit) and excludes the acting user via the query", async () => {
  setSettings({ discordBotToken: BOT, discordNotifyChannelId: CHANNEL });
  userFindManyRows = [
    { discordId: "555555555555555555", role: "ADMIN", permissions: 1n }, // ADMIN superbit
    { discordId: "666666666666666666", role: "USER", permissions: 0n }, // USER preset — no MANAGE_ISSUES
    { discordId: "777777777777777777", role: "ISSUE_ADMIN", permissions: 0n }, // preset carries MANAGE_ISSUES
    { discordId: "888888888888888888", role: "USER", permissions: 8n }, // explicit MANAGE_ISSUES bit
  ];

  await notifyAdminsIssueMessage("Dune", "bob", "the audio is wrong", { excludeUserId: "u-author" });

  // The DB query itself carries the recipient policy: linked, opted-in, not the author.
  assert.equal(userFindManyWheres.length, 1);
  assert.deepEqual(userFindManyWheres[0], {
    discordId: { not: null },
    notifyOnIssue: true,
    id: { not: "u-author" },
  });

  // Only the three MANAGE_ISSUES holders get a targeted channel post.
  assert.deepEqual(
    sent.map((s) => s.body?.content),
    ["<@555555555555555555>", "<@777777777777777777>", "<@888888888888888888>"],
  );
  for (const s of sent) {
    assert.equal(s.url, `${API}/channels/${CHANNEL}/messages`);
    const embed = (s.body?.embeds as Array<Record<string, unknown>>)[0];
    assert.ok(String(embed.title).startsWith("💬 User Reply on Issue — Dune"), "default heading is the user-reply variant");
  }
});

test("admin fan-out: restrictToUserId narrows the query, fromAdmin flips the heading, restrict==exclude is a no-op", async () => {
  setSettings({ discordBotToken: BOT, discordNotifyChannelId: CHANNEL });

  // restrictToUserId === excludeUserId → the sole allowed recipient is the one
  // being excluded — return before even querying users.
  await notifyAdminsIssueMessage("Dune", "admin-jane", "resolved it", {
    restrictToUserId: "u-1",
    excludeUserId: "u-1",
    fromAdmin: true,
  });
  assert.equal(userFindManyWheres.length, 0);
  assert.equal(sent.length, 0);

  userFindManyRows = [{ discordId: "555555555555555555", role: "ADMIN", permissions: 1n }];
  await notifyAdminsIssueMessage("Dune", "admin-jane", "resolved it", {
    restrictToUserId: "u-claimer",
    fromAdmin: true,
  });
  assert.deepEqual(userFindManyWheres[0], {
    discordId: { not: null },
    notifyOnIssue: true,
    id: "u-claimer",
  });
  const embed = (sent[0].body?.embeds as Array<Record<string, unknown>>)[0];
  assert.ok(String(embed.title).startsWith("💬 Admin Reply on Issue — Dune"));
});

test("admin fan-out isolates per-recipient failures: one 500 doesn't stop the rest and only logs", async () => {
  setSettings({ discordBotToken: BOT, discordNotifyChannelId: CHANNEL });
  userFindManyRows = [
    { discordId: "555555555555555555", role: "ADMIN", permissions: 1n },
    { discordId: "777777777777777777", role: "ADMIN", permissions: 1n },
  ];
  let calls = 0;
  respond = () => (++calls === 1 ? new Response("boom", { status: 500 }) : okJson({}));

  await notifyAdminsIssueMessage("Dune", "bob", "hello"); // must resolve

  assert.equal(sent.length, 2, "the second admin is still notified");
  assert.equal(sent[1].body?.content, "<@777777777777777777>");
  assert.ok(errors.some((e) => e.includes("[discord-notify] Failed to notify admin:") && e.includes("500")));
});

// ── assignDiscordRolesOnLink ────────────────────────────────────────────────

test("role assignment maps provider + app role to role ids and skips non-snowflake config values", async () => {
  const guild = "900000000000000001";
  const roleCfg = {
    discordBotToken: BOT,
    discordGuildId: guild,
    discordLinkedRoleId: "900000000000000002",
    discordPlexRoleId: "900000000000000003",
    discordJellyfinRoleId: "900000000000000004",
    discordAdminRoleId: "900000000000000005",
    discordIssueAdminRoleId: "900000000000000006",
  };

  // Plex account (real email), plain USER → linked + plex roles only.
  setSettings(roleCfg);
  await assignDiscordRolesOnLink(DID, "alice@example.com", "USER");
  assert.deepEqual(
    sent.map((s) => s.url),
    [
      `${API}/guilds/${guild}/members/${DID}/roles/900000000000000002`,
      `${API}/guilds/${guild}/members/${DID}/roles/900000000000000003`,
    ],
  );
  for (const s of sent) {
    assert.equal(s.method, "PUT");
    assert.equal(s.headers.get("authorization"), AUTH);
  }

  // Jellyfin account (synthetic @jellyfin.local email), ISSUE_ADMIN →
  // linked + jellyfin + issue-admin roles.
  sent.length = 0;
  await assignDiscordRolesOnLink(DID, "bob@jellyfin.local", "ISSUE_ADMIN");
  assert.deepEqual(
    sent.map((s) => s.url.split("/roles/")[1]),
    ["900000000000000002", "900000000000000004", "900000000000000006"],
  );

  // A non-snowflake configured role id is filtered out instead of sent to Discord.
  sent.length = 0;
  setSettings({ ...roleCfg, discordPlexRoleId: "plex-members" });
  invalidateFeatureFlagCache();
  await assignDiscordRolesOnLink(DID, "alice@example.com", "USER");
  assert.deepEqual(sent.map((s) => s.url.split("/roles/")[1]), ["900000000000000002"]);
});

test("role assignment: no guild config or invalid member id → zero fetches; a failed PUT only logs", async () => {
  // Bot token but no guild → nothing to do.
  setSettings({ discordBotToken: BOT, discordLinkedRoleId: "900000000000000002" });
  await assignDiscordRolesOnLink(DID, "alice@example.com", "USER");
  assert.equal(sent.length, 0);

  // Guild configured but the (external-input) Discord user id is not a snowflake.
  setSettings({
    discordBotToken: BOT,
    discordGuildId: "900000000000000001",
    discordLinkedRoleId: "900000000000000002",
  });
  invalidateFeatureFlagCache();
  await assignDiscordRolesOnLink("not-a-snowflake", "alice@example.com", "USER");
  assert.equal(sent.length, 0);

  // A Discord-side failure is logged per role, never thrown.
  respond = () => new Response("Missing Permissions", { status: 403 });
  await assignDiscordRolesOnLink(DID, "alice@example.com", "USER");
  assert.equal(sent.length, 1);
  assert.ok(errors.some((e) => e.includes("[discord-notify] Failed to assign role") && e.includes("403")));
});

// ── bulk approved fan-out ───────────────────────────────────────────────────

test("bulk approve: dedups requesters in one opt-in query, posts per REQUEST, and silently skips unresolvable users", async () => {
  setSettings({ discordBotToken: BOT, discordNotifyChannelId: CHANNEL });
  userFindManyRows = [
    { id: "u1", discordId: "111111111111111111" },
    { id: "u2", discordId: "222222222222222222" },
    // u3 absent: no linked discord or opted out — the query already filtered it.
  ];

  await notifyUsersRequestsApproved([
    { requestedBy: "u1", title: "Alpha", mediaType: "MOVIE" },
    { requestedBy: "u1", title: "Beta", mediaType: "TV" },
    { requestedBy: "u2", title: "Gamma", mediaType: "MOVIE" },
    { requestedBy: "u3", title: "Delta", mediaType: "MOVIE" },
  ]);

  // One user query: deduped ids, linked + opted-in filters in the WHERE.
  assert.equal(userFindManyWheres.length, 1);
  assert.deepEqual(userFindManyWheres[0], {
    id: { in: ["u1", "u2", "u3"] },
    discordId: { not: null },
    notifyOnApproved: true,
  });

  // One post per resolvable REQUEST (u1 gets two), none for u3.
  assert.deepEqual(
    sent.map((s) => [s.body?.content, String((s.body?.embeds as Array<Record<string, unknown>>)[0].title)] as const),
    [
      ["<@111111111111111111>", "✅ Request Approved — Alpha"],
      ["<@111111111111111111>", "✅ Request Approved — Beta"],
      ["<@222222222222222222>", "✅ Request Approved — Gamma"],
    ],
  );
});

test("bulk approve: an empty batch is a pure no-op (no config read, no query, no fetch)", async () => {
  setSettings({ discordBotToken: BOT, discordNotifyChannelId: CHANNEL });
  await notifyUsersRequestsApproved([]);
  assert.equal(sent.length, 0);
  assert.equal(userFindManyWheres.length, 0);
});
