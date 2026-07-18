// Unit tests for the notification-email ORCHESTRATION layer (src/lib/email.ts) —
// the seam between "something happened" call sites and the transports. Sibling
// ownership: tests/smtp.test.mts owns the SMTP wire (RFC 5322/2045/5321, AUTH,
// TLS) via fake sockets, and tests/notification-email.test.mts owns
// resolveUserNotificationEmail — neither is re-tested here. This file pins what
// email.ts adds ON TOP of those:
//   - the three-stage send gate (feature.integration.email flag → the
//     enableUserEmails master toggle → backend-specific config presence), that
//     isNotificationEmailEnabled mirrors it exactly, and that a closed gate
//     short-circuits with ZERO transport activity and ZERO recipient reads;
//   - recipient resolution: getAdminEmails (MANAGE_REQUESTS bitmask incl. the
//     ADMIN superbit, exclusion where-shape, synthetic-address drop via the
//     resolver) and getIssueAdminEmails (notifyOnIssue as a DB-side filter,
//     MANAGE_ISSUES bitmask client-side, restrictToUserId short-circuit);
//   - per-recipient failure isolation (Promise.all: every send is issued even
//     when one fails) and the log-never-throw notifier error contract;
//   - sendTestEmail's toggle bypass (but NOT flag bypass) and loud errors,
//     vs sendNotificationEmailVerification which respects the toggle;
//   - verification-link building (token URL-encoding, siteUrl/AUTH_URL base);
//   - header-injection scrubbing (safeHeader/safeTo/safeSubject) caller-side,
//     before the transport-layer defense smtp.test.mts already pins;
//   - the SMTP path's pre-socket gates (isSafeAddrForAdmin refusal for IP
//     literals and DNS answers, port validation).
//
// Transport seam chosen: the RESEND backend (sendOne → safeFetchTrusted →
// api.resend.com) carries every actually-sent email, with globalThis.fetch
// scripted and dns.lookup stubbed (the trakt.test.mts pattern) — the least-
// scaffolding seam, and it makes "no transport activity" a single
// fetchCalls.length === 0 assertion. The SMTP backend is exercised only up to
// its pre-connect failures (they throw before any socket); net.connect and
// tls.connect are additionally replaced with throwing guards so a regression
// that reaches the socket layer fails fast instead of opening a connection.
//
// No DB or network: prisma.setting / prisma.user are shadowed in-memory
// (tests/_helpers.mts). Bypassing the Setting crypto extension is faithful for
// the sensitive keys read here (smtpPassword/resendApiKey) — the extension
// hands callers plaintext, which is exactly what the stub returns.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// ── DNS stub ────────────────────────────────────────────────────────────────
// Serves both consumers of the shared dns.promises object: ssrf.ts's
// lookupHostCached/verifyResolvedHost (safeFetchTrusted's rebind checks for
// api.resend.com) and email.ts's own resolveSafeSmtpHost. Per-host override so
// SMTP-host tests can point a hostname at a blocked address.
const DEFAULT_PUBLIC_ADDR = "93.184.216.34";
let dnsByHost: Record<string, string> = {};
const fakeLookup = async (host: string) => [
  { address: dnsByHost[host] ?? DEFAULT_PUBLIC_ADDR, family: 4 },
];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── socket guards ───────────────────────────────────────────────────────────
// Every SMTP-path test here must fail BEFORE the socket layer. If one ever
// reaches net/tls.connect, fail loudly instead of dialing a real host.
const socketGuard = () => {
  throw new Error("unexpected net/tls.connect — email.test.mts must fail before any socket opens");
};
(net as unknown as { connect: unknown }).connect = socketGuard;
(tls as unknown as { connect: unknown }).connect = socketGuard;
if ((net as unknown as { connect: unknown }).connect !== socketGuard) {
  throw new Error("could not stub net.connect — aborting before a real socket can open");
}

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch ──────────────────────────────────────────────────────────
type FetchCall = { url: string; method: string | undefined; headers: Headers; body: string | undefined };
const fetchCalls: FetchCall[] = [];
let respond: (call: FetchCall) => Response = () =>
  new Response(JSON.stringify({ id: "email_ok" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const call: FetchCall = {
    url: String(input),
    method: init?.method,
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? init.body : undefined,
  };
  fetchCalls.push(call);
  return respond(call);
}) as typeof fetch;

// Dynamic imports so the stubs above genuinely precede the module-graph load
// (static imports would hoist above them).
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const {
  isNotificationEmailEnabled,
  notifyAdminsNewRequest,
  notifyAdminsNewIssue,
  notifyAdminsIssueMessageEmail,
  notifyUserRequestAvailableEmail,
  sendTestEmail,
  sendNotificationEmailVerification,
} = await import("../src/lib/email.ts");

// ── prisma stubs ────────────────────────────────────────────────────────────
// One Setting map serves both readers: getEmailConfig (the EMAIL_KEYS findMany)
// and features.ts getFeatureFlags (the FEATURE_KEYS findMany). Missing feature
// rows fall back to defaults — feature.integration.email defaults ON.
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in
      .filter((k) => settings.has(k))
      .map((k) => ({ key: k, value: settings.get(k) as string })),
});

type UserRow = { email: string; notificationEmail: string | null; role: string; permissions: bigint };
let userRows: UserRow[] = [];
const userFindManyCalls: Array<{ where?: unknown; select?: unknown }> = [];
shadowPrismaModel(prisma, "user", {
  findMany: async (args: { where?: unknown; select?: unknown }) => {
    userFindManyCalls.push(args);
    return userRows;
  },
});

// ── helpers ─────────────────────────────────────────────────────────────────
function configureResend(overrides: Record<string, string | undefined> = {}): void {
  settings.clear(); // each configure is a full baseline — no leakage between phases
  settings.set("enableUserEmails", "true");
  settings.set("emailBackend", "resend");
  settings.set("resendApiKey", "re_test_123");
  settings.set("resendFrom", "Summonarr <noreply@example.com>");
  settings.set("siteUrl", "https://summonarr.example.com");
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) settings.delete(k);
    else settings.set(k, v);
  }
  invalidateFeatureFlagCache();
}

function adminUser(email: string, extra: Partial<UserRow> = {}): UserRow {
  return { email, notificationEmail: null, role: "ADMIN", permissions: 0n, ...extra };
}

type SentEmail = { from: string; to: string; subject: string; html: string };
function sentEmails(): SentEmail[] {
  return fetchCalls.map((c) => JSON.parse(c.body ?? "{}") as SentEmail);
}

beforeEach(() => {
  settings.clear();
  userRows = [];
  userFindManyCalls.length = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  dnsByHost = {};
  delete process.env.AUTH_URL;
  respond = () =>
    new Response(JSON.stringify({ id: "email_ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  invalidateFeatureFlagCache();
});

// ── the send gate ───────────────────────────────────────────────────────────

test("isNotificationEmailEnabled mirrors the full gate: flag → master toggle → per-backend config", async () => {
  // Nothing configured: flag defaults ON but the master toggle is off ⇒ false.
  assert.equal(await isNotificationEmailEnabled(), false);

  // Toggle on, no transport: the DEFAULT backend is smtp (emailBackend unset),
  // so a configured resendApiKey alone must NOT count as "configured".
  settings.set("enableUserEmails", "true");
  settings.set("resendApiKey", "re_test_123");
  assert.equal(await isNotificationEmailEnabled(), false);

  // smtpHost is the smtp backend's minimum config.
  settings.set("smtpHost", "mail.example.com");
  assert.equal(await isNotificationEmailEnabled(), true);

  // Switching to resend makes smtp config irrelevant: key absent ⇒ false…
  settings.set("emailBackend", "resend");
  settings.delete("resendApiKey");
  assert.equal(await isNotificationEmailEnabled(), false);
  // …key present ⇒ true.
  settings.set("resendApiKey", "re_test_123");
  assert.equal(await isNotificationEmailEnabled(), true);

  // The feature flag kills the whole gate even with everything else on.
  settings.set("feature.integration.email", "false");
  invalidateFeatureFlagCache();
  assert.equal(await isNotificationEmailEnabled(), false);
});

test("feature flag off: notifiers no-op with zero transport activity and zero recipient reads", async () => {
  configureResend({ "feature.integration.email": "false" });
  userRows = [adminUser("alpha@example.com")];
  await notifyAdminsNewRequest({ title: "Dune", mediaType: "MOVIE", requestedBy: "Paul", note: null });
  await notifyUserRequestAvailableEmail({ toEmail: "user@example.com", title: "Dune", mediaType: "MOVIE" });
  assert.equal(fetchCalls.length, 0);
  assert.equal(userFindManyCalls.length, 0); // recipient query is behind the gate
  assert.deepEqual(errors, []); // a closed gate is a clean return, not an error
});

test("master toggle off / backend unconfigured: notifiers mute before the recipient query", async () => {
  // Toggle off (unset), transport fully configured.
  configureResend({ enableUserEmails: undefined });
  userRows = [adminUser("alpha@example.com")];
  await notifyAdminsNewRequest({ title: "Dune", mediaType: "MOVIE", requestedBy: "Paul", note: null });
  assert.equal(fetchCalls.length, 0);
  assert.equal(userFindManyCalls.length, 0);

  // Toggle on but the selected backend lacks its minimum config.
  configureResend({ resendApiKey: undefined });
  await notifyAdminsNewRequest({ title: "Dune", mediaType: "MOVIE", requestedBy: "Paul", note: null });
  assert.equal(fetchCalls.length, 0);
  assert.equal(userFindManyCalls.length, 0); // isBackendConfigured runs before getAdminEmails
  assert.deepEqual(errors, []);
});

// ── admin recipient resolution ──────────────────────────────────────────────

test("notifyAdminsNewRequest: MANAGE_REQUESTS bitmask selects recipients; exclusion and select shape pinned", async () => {
  configureResend();
  userRows = [
    adminUser("alpha@example.com"), // role ADMIN ⇒ superbit
    { email: "bravo@example.com", notificationEmail: null, role: "USER", permissions: Permission.MANAGE_REQUESTS },
    { email: "charlie@example.com", notificationEmail: null, role: "USER", permissions: 0n }, // USER preset lacks MANAGE_REQUESTS
    { email: "delta@example.com", notificationEmail: null, role: "ISSUE_ADMIN", permissions: 0n }, // preset has MANAGE_ISSUES, not MANAGE_REQUESTS
    adminUser("jellyfin-abc@jellyfin.local"), // synthetic identity — dropped by the resolver
    adminUser("echo-login@example.com", { notificationEmail: "echo-notify@example.com" }), // preference wins
  ];

  await notifyAdminsNewRequest({
    title: "Dune",
    mediaType: "MOVIE",
    requestedBy: "Paul Atreides",
    note: "please and thank you",
    releaseYear: "2021",
    excludeUserId: "u-req",
  });

  // The requester exclusion is a DB-side where; the select is exactly what the
  // permission filter + resolver consume.
  assert.equal(userFindManyCalls.length, 1);
  assert.deepEqual(userFindManyCalls[0].where, { id: { not: "u-req" } });
  assert.deepEqual(userFindManyCalls[0].select, {
    email: true,
    notificationEmail: true,
    role: true,
    permissions: true,
  });

  // One send per eligible recipient, through the resend wire.
  const emails = sentEmails();
  assert.deepEqual(
    emails.map((e) => e.to).sort(),
    ["alpha@example.com", "bravo@example.com", "echo-notify@example.com"],
  );
  const wire = fetchCalls[0];
  assert.equal(wire.url, "https://api.resend.com/emails");
  assert.equal(wire.method, "POST");
  assert.equal(wire.headers.get("authorization"), "Bearer re_test_123");
  assert.equal(wire.headers.get("content-type"), "application/json");
  for (const e of emails) {
    assert.equal(e.from, "Summonarr <noreply@example.com>");
    assert.equal(e.subject, "New Movie Request: Dune");
    assert.ok(e.html.includes("Dune (2021)"), "title carries the release year");
    assert.ok(e.html.includes("please and thank you"), "the note block renders");
  }
  assert.deepEqual(errors, []);
});

test("notifyAdminsNewIssue: notifyOnIssue filters DB-side, MANAGE_ISSUES filters client-side", async () => {
  configureResend();
  // The stub returns rows AS IF they matched notifyOnIssue — the DB-side
  // contract is the where shape; the bitmask filter is what runs on the rows.
  userRows = [
    adminUser("alpha@example.com"), // superbit passes MANAGE_ISSUES
    { email: "issue-admin@example.com", notificationEmail: null, role: "ISSUE_ADMIN", permissions: 0n }, // preset grants MANAGE_ISSUES
    { email: "granted@example.com", notificationEmail: null, role: "USER", permissions: Permission.MANAGE_ISSUES },
    { email: "plain@example.com", notificationEmail: null, role: "USER", permissions: 0n }, // excluded
  ];

  await notifyAdminsNewIssue({
    title: "Dune",
    mediaType: "MOVIE",
    issueType: "WRONG_AUDIO",
    reportedBy: "Paul",
    note: "the audio is in Chakobsa",
    issueId: "iss-1",
    excludeUserId: "u-rep",
  });

  assert.equal(userFindManyCalls.length, 1);
  assert.deepEqual(userFindManyCalls[0].where, { notifyOnIssue: true, id: { not: "u-rep" } });
  const emails = sentEmails();
  assert.deepEqual(
    emails.map((e) => e.to).sort(),
    ["alpha@example.com", "granted@example.com", "issue-admin@example.com"],
  );
  assert.equal(emails[0].subject, "New Issue Report: Dune");
  assert.ok(emails[0].html.includes("/admin/issues?selected=iss-1"), "CTA deep-links to the issue");
  // Pins current behavior: the label transform replaces underscores and
  // uppercases word starts but never lowercases, so uppercase enum values
  // (the real IssueType shape) render as "WRONG AUDIO", not "Wrong Audio".
  assert.ok(emails[0].html.includes("WRONG AUDIO"), "issue type keeps enum casing, underscores become spaces");
});

test("notifyAdminsIssueMessageEmail: restrictToUserId === excludeUserId short-circuits before any query", async () => {
  configureResend();
  userRows = [adminUser("alpha@example.com")];

  // Restricting to the same user we exclude can never produce a recipient —
  // pinned as zero DB reads and zero sends, not an empty-result query.
  await notifyAdminsIssueMessageEmail({
    issueTitle: "Broken subtitles",
    userName: "Paul",
    body: "still broken",
    issueId: "iss-2",
    excludeUserId: "u1",
    restrictToUserId: "u1",
  });
  assert.equal(userFindManyCalls.length, 0);
  assert.equal(fetchCalls.length, 0);

  // A genuine restriction targets exactly that user id, still gated by notifyOnIssue.
  userRows = [{ email: "target@example.com", notificationEmail: null, role: "ISSUE_ADMIN", permissions: 0n }];
  await notifyAdminsIssueMessageEmail({
    issueTitle: "Broken subtitles",
    userName: "Paul",
    body: "still broken",
    issueId: "iss-2",
    excludeUserId: "u1",
    restrictToUserId: "u2",
  });
  assert.equal(userFindManyCalls.length, 1);
  assert.deepEqual(userFindManyCalls[0].where, { notifyOnIssue: true, id: "u2" });
  assert.deepEqual(sentEmails().map((e) => e.to), ["target@example.com"]);
});

test("no eligible recipients: clean no-op after the query, no transport, no error", async () => {
  configureResend();
  userRows = [
    { email: "plain@example.com", notificationEmail: null, role: "USER", permissions: 0n },
    adminUser("discord_1@discord.local"), // synthetic — resolver returns null
  ];
  await notifyAdminsNewRequest({ title: "Dune", mediaType: "TV", requestedBy: "Paul", note: null });
  assert.equal(userFindManyCalls.length, 1); // the gate was open; recipients just filtered to none
  assert.equal(fetchCalls.length, 0);
  assert.deepEqual(errors, []);
});

// ── failure isolation and error degradation ────────────────────────────────

test("one failing recipient: every send is still issued, the notifier logs once and never throws", async () => {
  configureResend();
  userRows = [
    adminUser("alpha@example.com"),
    adminUser("bravo@example.com"),
    adminUser("charlie@example.com"),
  ];
  respond = (call) => {
    const to = (JSON.parse(call.body ?? "{}") as { to: string }).to;
    return to === "bravo@example.com"
      ? new Response(JSON.stringify({ message: "quota exceeded" }), { status: 429 })
      : new Response(JSON.stringify({ id: "ok" }), { status: 200 });
  };

  // Must resolve — the notifier contract is log, never throw to the caller.
  await notifyAdminsNewRequest({ title: "Dune", mediaType: "MOVIE", requestedBy: "Paul", note: null });

  // All three sends were issued (Promise.all starts them all before any settles);
  // the one failure did not suppress the other two deliveries.
  assert.deepEqual(
    sentEmails().map((e) => e.to).sort(),
    ["alpha@example.com", "bravo@example.com", "charlie@example.com"],
  );
  assert.equal(errors.length, 1);
  assert.ok(errors[0].startsWith("[email] Failed to send new request notification:"), "scoped [email] log");
  assert.ok(errors[0].includes("quota exceeded"), "surfaces the Resend error message");
});

// ── user-facing notifier: single recipient, deep link, header scrubbing ────

test("notifyUserRequestAvailableEmail: single send, tmdb deep link, CRLF scrubbed from to/subject", async () => {
  configureResend({ siteUrl: "https://summonarr.example.com/" }); // trailing slash must not double up
  await notifyUserRequestAvailableEmail({
    toEmail: "user@example.com",
    title: "Dune",
    mediaType: "MOVIE",
    tmdbId: 550,
  });
  assert.equal(fetchCalls.length, 1);
  const sent = sentEmails()[0];
  assert.equal(sent.to, "user@example.com");
  assert.equal(sent.subject, "Now Available: Dune");
  assert.ok(sent.html.includes("https://summonarr.example.com/movie/550"), "CTA deep-links to the media page");
  assert.equal(userFindManyCalls.length, 0); // user notifiers never query recipients

  // Header-injection scrubbing happens caller-side (safeHeader/safeSubject),
  // before the smtp-layer defense smtp.test.mts pins separately.
  fetchCalls.length = 0;
  await notifyUserRequestAvailableEmail({
    toEmail: "victim@example.com\r\nBcc: hidden@evil.example",
    title: "Dune\r\nX-Injected: 1",
    mediaType: "MOVIE",
  });
  const scrubbed = sentEmails()[0];
  assert.equal(/[\r\n]/.test(scrubbed.to), false);
  assert.equal(/[\r\n]/.test(scrubbed.subject), false);
  assert.equal(scrubbed.to, "victim@example.com Bcc: hidden@evil.example");
  assert.equal(scrubbed.subject, "Now Available: Dune X-Injected: 1");
});

// ── sendTestEmail ───────────────────────────────────────────────────────────

test("sendTestEmail bypasses the master toggle but not the feature flag, and fails loud", async () => {
  // Toggle OFF: notifiers are muted, but the admin test email still goes out —
  // that's the whole point of the transport test. Also pins the from-address
  // fallback chain (no resendFrom ⇒ smtpFrom is reused).
  configureResend({
    enableUserEmails: undefined,
    resendFrom: undefined,
    smtpFrom: "Summonarr <smtp-from@example.com>",
  });
  await sendTestEmail("admin@example.com");
  assert.equal(fetchCalls.length, 1);
  assert.equal(sentEmails()[0].to, "admin@example.com");
  assert.equal(sentEmails()[0].subject, "Summonarr — Test Email");
  assert.equal(sentEmails()[0].from, "Summonarr <smtp-from@example.com>");

  // The feature flag is NOT bypassed.
  fetchCalls.length = 0;
  configureResend({ "feature.integration.email": "false" });
  await assert.rejects(() => sendTestEmail("admin@example.com"), /Email integration is disabled/);
  assert.equal(fetchCalls.length, 0);

  // Backend-specific unconfigured messages, still zero transport.
  configureResend({ resendApiKey: undefined });
  await assert.rejects(() => sendTestEmail("admin@example.com"), /Resend API key not configured/);
  configureResend({ emailBackend: undefined, smtpHost: undefined }); // default smtp backend, no host
  await assert.rejects(() => sendTestEmail("admin@example.com"), /SMTP not configured/);
  assert.equal(fetchCalls.length, 0);

  // Transport failures propagate to the caller (loud), unlike the notifiers.
  configureResend();
  respond = () => new Response(JSON.stringify({ message: "invalid api key" }), { status: 401 });
  await assert.rejects(() => sendTestEmail("admin@example.com"), /invalid api key/);
});

// ── sendNotificationEmailVerification ───────────────────────────────────────

test("verification email: token is URL-encoded into the confirm link under a trimmed siteUrl", async () => {
  configureResend({ siteUrl: "https://summonarr.example.com///" });
  const token = "a b/c+&=";
  await sendNotificationEmailVerification("new-addr@example.com", token);
  assert.equal(fetchCalls.length, 1);
  const sent = sentEmails()[0];
  assert.equal(sent.to, "new-addr@example.com");
  assert.equal(sent.subject, "Verify your Summonarr notification email");
  assert.ok(
    sent.html.includes(
      "https://summonarr.example.com/api/profile/notification-email/confirm?token=a%20b%2Fc%2B%26%3D",
    ),
    "link = trimmed siteUrl + confirm path + encodeURIComponent(token)",
  );
});

test("verification email: respects the master toggle, falls back to AUTH_URL, refuses with no base", async () => {
  // Unlike sendTestEmail, this flow respects enableUserEmails — a muted server
  // must not start mailing verification links.
  configureResend({ enableUserEmails: undefined });
  await assert.rejects(
    () => sendNotificationEmailVerification("x@example.com", "tok"),
    /Email transport is not configured on this server/,
  );
  assert.equal(fetchCalls.length, 0);

  // No siteUrl Setting → AUTH_URL is the link base (trailing slash trimmed).
  configureResend({ siteUrl: undefined });
  process.env.AUTH_URL = "https://auth.example.com/";
  await sendNotificationEmailVerification("x@example.com", "tok123");
  assert.ok(
    sentEmails()[0].html.includes(
      "https://auth.example.com/api/profile/notification-email/confirm?token=tok123",
    ),
  );

  // Neither siteUrl nor AUTH_URL: refuse rather than emit a relative/broken link.
  fetchCalls.length = 0;
  delete process.env.AUTH_URL;
  await assert.rejects(
    () => sendNotificationEmailVerification("x@example.com", "tok"),
    /No site URL is configured/,
  );
  assert.equal(fetchCalls.length, 0);
});

// ── SMTP path: pre-socket gates ─────────────────────────────────────────────

test("smtp backend: SSRF and port gates fire before any socket (and the resend path is never touched)", async () => {
  // IP-literal host in a blocked range (link-local = cloud metadata) is refused
  // by isSafeAddrForAdmin without a DNS lookup.
  configureResend({ emailBackend: undefined, resendApiKey: undefined, smtpHost: "169.254.169.254" });
  await assert.rejects(
    () => sendTestEmail("admin@example.com"),
    /Refusing SMTP host 169\.254\.169\.254 — address is not allowed/,
  );

  // A hostname is resolved and EVERY address must pass the admin policy.
  dnsByHost["smtp.internal.test"] = "169.254.99.1";
  configureResend({ emailBackend: undefined, resendApiKey: undefined, smtpHost: "smtp.internal.test" });
  await assert.rejects(
    () => sendTestEmail("admin@example.com"),
    /Refusing SMTP host smtp\.internal\.test — resolves to 169\.254\.99\.1 which is not allowed/,
  );

  // Garbage port from the Setting row fails with a clear error instead of
  // crashing net.connect deep inside a fire-and-forget notifier. Reaching this
  // error also proves the smtp (default) backend was selected.
  configureResend({
    emailBackend: undefined,
    resendApiKey: undefined,
    smtpHost: "192.0.2.10",
    smtpPort: "banana",
  });
  await assert.rejects(() => sendTestEmail("admin@example.com"), /Invalid SMTP port: banana/);

  assert.equal(fetchCalls.length, 0); // resend transport never involved
});
