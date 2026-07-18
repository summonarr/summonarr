// Unit tests for the push-notification orchestrator (src/lib/push.ts) — the
// module every notify*Push helper, the APNs relay path, and the VAPID key
// lifecycle run through. The channel CRYPTO is owned elsewhere and NOT re-pinned
// here: tests/web-push.test.mts owns the VAPID JWT + aes128gcm wire format,
// tests/push-e2e.test.mts owns the ECIES blob byte layout, and
// tests/request-notifications.test.mts owns that the hub REACHES push at all.
// What THIS file pins is push.ts's own orchestration:
//   - getOrCreateVapidPublicKey: an existing pair is returned without touching
//     the generator; an absent pair is generated ONCE under the pg advisory
//     lock (1001,5) and both halves persisted; a lock-race loser adopts the
//     winner's keys instead of overwriting; a PARTIAL pair refuses to
//     regenerate (regeneration invalidates every stored subscription) and
//     returns the surviving public half;
//   - the APNs relay wire: default relay URL, optional Bearer auth from the
//     apnsRelayKey Setting, decrypted deviceToken, collapseId = category, and
//     the privacy contract — the cleartext payload carries ONLY the generic
//     APNS_ALERTS text (never media titles/usernames), while a device with an
//     E2E publicKey gets mutable-content + an encrypted blob holding the rich
//     {t, b} and the deep link u (which may carry a tmdbId and must never
//     reach the relay in cleartext). An encrypt failure falls back to the
//     generic payload; a relay "unregistered" prunes the row; 5xx/401 keep it;
//   - the web (VAPID) branch: stored Setting keys are the ones on the wire,
//     p256dh/auth are decrypted via token-crypto, 410 prunes silently while
//     other failures log and keep, and missing VAPID keys skip web WITHOUT
//     blocking a sibling iOS send;
//   - feature.integration.push = "false" short-circuits every notify* helper
//     with zero subscription/user queries and zero network — but the operator
//     diagnostics (sendApnsTestToUser, sendAppUpdateNoticeToAllIos)
//     deliberately bypass the flag;
//   - recipient selection: MANAGE_REQUESTS holders (role presets + raw bits)
//     for admin pushes with the excludeUserId where-shape; notifyOnIssue +
//     MANAGE_ISSUES for issue pushes (restrictToUserId === excludeUserId is a
//     zero-query no-op); per-user pref columns (pushOnApproved/pushOnDeclined)
//     gate before any subscription read;
//   - the available batch: deduped pref query, per-user device grouping (ALL
//     devices get the push), per-request payloads/deep links, empty input is a
//     total no-op (not even the flag read);
//   - counters/outcomes: sendAppUpdateNoticeToAllIos {sent, failed} and
//     notifyAdminGrabCompletedPush's delivered/skipped-no-subs/skipped-no-keys/
//     failed mapping; per-subscription failure isolation throughout.
//
// No DB, network, or DNS: prisma.setting/pushSubscription/user and
// $transaction are shadowed in-memory (tests/_helpers.mts), globalThis.fetch
// is scripted (relay hosts + a TEST-NET-3 web endpoint respond; anything else
// throws), and dns/promises.lookup is stubbed so the safe-fetch SSRF resolver
// never leaves the process. PushSubscription secret fields are built with the
// REAL encryptToken (the one legitimate call-site outside the prisma
// extension — guardrail 7a) so the decrypt-at-send contract is exercised for
// real. Dynamic imports keep the stubs ahead of the module graph (the
// trakt.test pattern).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

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

// ── scripted fetch: relay hosts + the TEST-NET-3 web endpoint ───────────────
type ApnsAps = {
  alert?: { title?: string; body?: string };
  sound?: string;
  "mutable-content"?: number;
};
type RelayBody = {
  deviceToken: string;
  payload: { aps?: ApnsAps; url?: string; e2e?: string };
  collapseId?: string;
};
type RelayCall = { url: string; auth: string | null; contentType: string | null; body: RelayBody };
type WebCall = { url: string; headers: Headers };

const fetchUrls: string[] = [];
const relayCalls: RelayCall[] = [];
const webCalls: WebCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let relayRespond: (call: RelayCall) => Response = () => jsonResponse({ ok: true });
let webRespond: (call: WebCall) => Response = () => new Response(null, { status: 201 });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  fetchUrls.push(url);
  const { hostname } = new URL(url);
  if (hostname === "summonapns.gadgetusaf.com" || hostname === "relay.example.com") {
    const call: RelayCall = {
      url,
      auth: new Headers(init?.headers).get("authorization"),
      contentType: new Headers(init?.headers).get("content-type"),
      body: JSON.parse(String(init?.body)) as RelayBody,
    };
    relayCalls.push(call);
    return relayRespond(call);
  }
  if (hostname === "203.0.113.5") {
    const call: WebCall = { url, headers: new Headers(init?.headers) };
    webCalls.push(call);
    return webRespond(call);
  }
  throw new Error(`unexpected fetch: ${url} — script a responder for this test`);
}) as typeof fetch;

// Dynamic imports so the stubs above genuinely precede the module-graph load.
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { encryptToken } = await import("../src/lib/token-crypto.ts");
const { generateVapidKeys, base64UrlDecode } = await import("../src/lib/web-push.ts");
const {
  getOrCreateVapidPublicKey,
  sendApnsTestToUser,
  sendAppUpdateNoticeToAllIos,
  notifyAdminsNewRequestPush,
  notifyAdminsNewIssuePush,
  notifyAdminsIssueMessagePush,
  notifyAdminsDeletionVoteThresholdPush,
  notifyAdminGrabCompletedPush,
  notifyUserIssueMessagePush,
  notifyUserRequestApprovedPush,
  notifyUserRequestDeclinedPush,
  notifyUsersRequestsAvailablePush,
  notifyUsersRequestsApprovedPush,
  notifyUsersRequestsDeclinedPush,
} = await import("../src/lib/push.ts");

// ── prisma stubs ────────────────────────────────────────────────────────────
// Setting: one map serves the feature-flag read, the VAPID key read, and the
// relay config read (request-notifications.test pattern).
const settings = new Map<string, string>();
const settingFindManyKeys: string[][] = [];
const settingFindUniqueKeys: string[] = [];

type SettingFindManyArgs = { where?: { key?: { in?: string[] } } };
async function settingFindMany(args: SettingFindManyArgs) {
  const keys = args?.where?.key?.in ?? [...settings.keys()];
  settingFindManyKeys.push([...keys]);
  return keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! }));
}
shadowPrismaModel(prisma, "setting", {
  findMany: settingFindMany,
  findUnique: async (args: { where: { key: string } }) => {
    settingFindUniqueKeys.push(args.where.key);
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
});

// $transaction: getOrCreateVapidPublicKey's interactive init tx. The fake tx
// shares the settings map so a committed upsert is visible to the post-tx
// re-read; onTxStart lets a test simulate a concurrent winner committing while
// this caller waited on the advisory lock.
const advisoryLockSqls: string[] = [];
const settingUpserts: Array<{ where: { key: string }; create: { key: string; value: string } }> = [];
let txCalls = 0;
let onTxStart: (() => void) | null = null;
const fakeTx = {
  $executeRaw: async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    advisoryLockSqls.push(Array.isArray(strings) ? strings.join("?") : String(strings));
    return 0;
  },
  setting: {
    findMany: settingFindMany,
    upsert: async (args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) => {
      settingUpserts.push({ where: args.where, create: args.create });
      settings.set(args.where.key, args.create.value);
      return { key: args.where.key, value: args.create.value };
    },
  },
};
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => {
  txCalls++;
  onTxStart?.();
  if (typeof arg !== "function") throw new Error("unexpected batch $transaction — push.ts only uses the interactive form");
  return (arg as (tx: typeof fakeTx) => Promise<unknown>)(fakeTx);
});

// PushSubscription: rows are filtered through a matcher covering exactly the
// where-shapes push.ts issues, so recipient assertions are behavior-derived;
// the raw args are captured for exact where-shape pins.
type UserMeta = { role: string; permissions: bigint; notifyOnIssue?: boolean };
type SubRow = {
  id: string;
  userId: string;
  endpoint: string;
  platform: string;
  p256dh: string | null;
  auth: string | null;
  deviceToken: string | null;
  publicKey: string | null;
  label: string | null;
  user: UserMeta;
};
type SubWhere = {
  userId?: string | { in?: string[]; not?: string };
  platform?: string;
  user?: { notifyOnIssue?: boolean };
};
type SubFindManyArgs = { where?: SubWhere; include?: unknown };

function subMatches(row: SubRow, where: SubWhere | undefined): boolean {
  if (!where) return true;
  if (typeof where.userId === "string" && row.userId !== where.userId) return false;
  if (where.userId && typeof where.userId === "object") {
    if (where.userId.in && !where.userId.in.includes(row.userId)) return false;
    if (where.userId.not !== undefined && row.userId === where.userId.not) return false;
  }
  if (where.platform !== undefined && row.platform !== where.platform) return false;
  if (where.user?.notifyOnIssue === true && row.user?.notifyOnIssue !== true) return false;
  return true;
}

let subRows: SubRow[] = [];
const subQueries: SubFindManyArgs[] = [];
const subDeletes: Array<{ where: { endpoint: string } }> = [];
let subFindManyImpl = async (args: SubFindManyArgs) => {
  subQueries.push(args);
  return subRows.filter((r) => subMatches(r, args?.where));
};
const defaultSubFindMany = subFindManyImpl;
shadowPrismaModel(prisma, "pushSubscription", {
  findMany: async (args: SubFindManyArgs) => subFindManyImpl(args),
  deleteMany: async (args: { where: { endpoint: string } }) => {
    subDeletes.push(args);
    const before = subRows.length;
    subRows = subRows.filter((r) => r.endpoint !== args.where.endpoint);
    return { count: before - subRows.length };
  },
});

// User: findUnique backs the per-user pref gates; findMany backs the batch
// helpers' pushOnAvailable/pushOnApproved/pushOnDeclined pref query.
type UserRow = {
  id: string;
  pushOnApproved?: boolean;
  pushOnDeclined?: boolean;
  pushOnAvailable?: boolean;
};
let userRows: UserRow[] = [];
const userFindUniqueCalls: Array<{ where: { id: string }; select: Record<string, unknown> }> = [];
const userFindManyCalls: Array<{ where: Record<string, unknown>; select: Record<string, unknown> }> = [];
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string }; select: Record<string, unknown> }) => {
    userFindUniqueCalls.push(args);
    const row = userRows.find((u) => u.id === args.where.id);
    return row ? { ...row } : null;
  },
  findMany: async (args: { where: { id?: { in?: string[] } } & Record<string, unknown>; select: Record<string, unknown> }) => {
    userFindManyCalls.push(args);
    const ids = args.where?.id?.in ?? [];
    const prefKey = ["pushOnAvailable", "pushOnApproved", "pushOnDeclined"].find((k) => args.where[k] === true);
    return userRows
      .filter((u) => ids.includes(u.id) && (prefKey ? u[prefKey as keyof UserRow] === true : true))
      .map((u) => ({ id: u.id }));
  },
});

// ── fixtures ────────────────────────────────────────────────────────────────
// E2E device: P-256 keypair whose public half is stored (plaintext base64) on
// the subscription row. The decryptor mirrors PushCrypto.swift's recipe — the
// byte-format contract itself is owned by tests/push-e2e.test.mts; here it is
// only the window into what the relay payload actually carries.
function makeDevice() {
  const ecdh = createECDH("prime256v1");
  const pub = ecdh.generateKeys();
  return { ecdh, pubB64: Buffer.from(pub).toString("base64") };
}
type Device = ReturnType<typeof makeDevice>;

function decryptE2e(device: Device, wireB64: string): { t: string; b: string; u?: string } {
  const blob = Buffer.from(wireB64, "base64");
  const ephPub = blob.subarray(0, 65);
  const nonce = blob.subarray(65, 77);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(77, blob.length - 16);
  const shared = device.ecdh.computeSecret(ephPub);
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("summonarr-push-e2e-v1", "utf8"), 32));
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plain = decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
  return JSON.parse(plain) as { t: string; b: string; u?: string };
}

let subSeq = 0;
const USER_META: UserMeta = { role: "USER", permissions: 0n, notifyOnIssue: false };

// iOS subscription row. deviceToken is stored ENCRYPTED (the route-level
// encryptToken call — guardrail 7a); publicKey (E2E) is plaintext by design.
function iosSub(
  userId: string,
  token: string,
  opts: { e2e?: Device; label?: string | null; user?: UserMeta; endpoint?: string } = {},
): SubRow {
  subSeq++;
  return {
    id: `sub-${subSeq}`,
    userId,
    endpoint: opts.endpoint ?? `apns:device/${token}/${String(subSeq).padStart(4, "0")}-${"x".repeat(24)}`,
    platform: "ios",
    p256dh: null,
    auth: null,
    deviceToken: encryptToken(token),
    publicKey: opts.e2e ? opts.e2e.pubB64 : null,
    label: opts.label ?? null,
    user: opts.user ?? { ...USER_META },
  };
}

// Web subscription row with REAL UA-side crypto material (65-byte point +
// 16-byte auth secret), both stored encrypted — sendPushNotification validates
// the decrypted values before any network call, so a decrypt drift fails loud.
function webSub(userId: string, slug: string, opts: { user?: UserMeta } = {}): SubRow {
  subSeq++;
  const ecdh = createECDH("prime256v1");
  const pub = ecdh.generateKeys();
  return {
    id: `sub-${subSeq}`,
    userId,
    endpoint: `https://203.0.113.5/push/${slug}`,
    platform: "web",
    p256dh: encryptToken(Buffer.from(pub).toString("base64url")),
    auth: encryptToken(randomBytes(16).toString("base64url")),
    deviceToken: null,
    publicKey: null,
    label: null,
    user: opts.user ?? { ...USER_META },
  };
}

const WEB_VAPID = generateVapidKeys();
function seedWebPushKeys(): void {
  settings.set("vapidPublicKey", WEB_VAPID.publicKey);
  settings.set("vapidPrivateKey", WEB_VAPID.privateKey);
  settings.set("smtpFrom", "push@example.com");
}

const ADMIN: UserMeta = { role: "ADMIN", permissions: 0n, notifyOnIssue: false };

beforeEach(() => {
  settings.clear();
  invalidateFeatureFlagCache(); // the 10s flag cache must not leak across tests
  warns.length = 0;
  errors.length = 0;
  fetchUrls.length = 0;
  relayCalls.length = 0;
  webCalls.length = 0;
  relayRespond = () => jsonResponse({ ok: true });
  webRespond = () => new Response(null, { status: 201 });
  settingFindManyKeys.length = 0;
  settingFindUniqueKeys.length = 0;
  advisoryLockSqls.length = 0;
  settingUpserts.length = 0;
  txCalls = 0;
  onTxStart = null;
  subRows = [];
  subQueries.length = 0;
  subDeletes.length = 0;
  subFindManyImpl = defaultSubFindMany;
  userRows = [];
  userFindUniqueCalls.length = 0;
  userFindManyCalls.length = 0;
});

// ── getOrCreateVapidPublicKey ───────────────────────────────────────────────

test("an existing keypair is returned as-is: no generation, no transaction, no writes", async () => {
  settings.set("vapidPublicKey", "stored-public-key");
  settings.set("vapidPrivateKey", "stored-private-key");

  assert.equal(await getOrCreateVapidPublicKey(), "stored-public-key");
  assert.equal(txCalls, 0);
  assert.equal(settingUpserts.length, 0);
  // The raw read pulls the keypair plus the contact-address fallbacks in one query.
  assert.deepEqual(settingFindManyKeys[0], ["vapidPublicKey", "vapidPrivateKey", "smtpFrom", "smtpUser"]);
});

test("absent keys: one advisory-locked transaction persists BOTH halves; the second call is a pure read", async () => {
  const key = await getOrCreateVapidPublicKey();

  assert.equal(txCalls, 1);
  assert.equal(advisoryLockSqls.length, 1);
  assert.ok(advisoryLockSqls[0].includes("pg_advisory_xact_lock(1001, 5)"), advisoryLockSqls[0]);
  // Both halves written, public first, values matching what the map now holds.
  assert.deepEqual(settingUpserts.map((u) => u.where.key), ["vapidPublicKey", "vapidPrivateKey"]);
  assert.equal(settings.get("vapidPublicKey"), key);
  assert.ok(settings.get("vapidPrivateKey"));
  assert.notEqual(settings.get("vapidPrivateKey"), key);
  // The returned key is a real uncompressed P-256 point (usable by a browser).
  const point = base64UrlDecode(key);
  assert.equal(point.length, 65);
  assert.equal(point[0], 0x04);

  // Idempotent: the stored key is returned without another generation cycle.
  assert.equal(await getOrCreateVapidPublicKey(), key);
  assert.equal(txCalls, 1);
  assert.equal(settingUpserts.length, 2);
});

test("a lock-race loser adopts the winner's keys instead of overwriting them", async () => {
  // Simulate a concurrent request having generated+committed while this caller
  // waited on pg_advisory_xact_lock: by the time the tx re-checks, both rows exist.
  onTxStart = () => {
    settings.set("vapidPublicKey", "winner-public-key");
    settings.set("vapidPrivateKey", "winner-private-key");
  };

  assert.equal(await getOrCreateVapidPublicKey(), "winner-public-key");
  assert.equal(txCalls, 1);
  assert.equal(settingUpserts.length, 0); // the loser's freshly generated pair is discarded
  assert.equal(settings.get("vapidPublicKey"), "winner-public-key"); // never clobbered
  assert.deepEqual(errors, []);
});

test("a PARTIAL keypair refuses to regenerate: surviving public half returned, missing public half yields ''", async () => {
  // Only the public half survives (e.g. a botched restore). Regenerating would
  // invalidate every stored subscription, so the code must refuse and keep it.
  settings.set("vapidPublicKey", "surviving-public-half");
  assert.equal(await getOrCreateVapidPublicKey(), "surviving-public-half");
  assert.equal(settingUpserts.length, 0);
  assert.equal(settings.get("vapidPublicKey"), "surviving-public-half");
  assert.equal(settings.get("vapidPrivateKey"), undefined); // nothing synthesized
  assert.ok(
    errors.some((e) => e.includes("VAPID keypair is incomplete")),
    "the operator repair hint must be logged",
  );
  assert.equal(settingFindUniqueKeys.at(-1), "vapidPublicKey");

  // Only the private half survives: nothing usable to hand back — empty string,
  // still no regeneration.
  settings.clear();
  settings.set("vapidPrivateKey", "orphaned-private-half");
  assert.equal(await getOrCreateVapidPublicKey(), "");
  assert.equal(settingUpserts.length, 0);
  assert.equal(settings.get("vapidPrivateKey"), "orphaned-private-half");
});

// ── APNs relay wire ─────────────────────────────────────────────────────────

test("relay wire for a plain iOS device: default relay, decrypted token, generic alert only — rich text never leaves", async () => {
  subRows = [iosSub("u-admin", "apns-token-admin", { user: ADMIN })];

  await notifyAdminsNewRequestPush({ title: "Dune", mediaType: "MOVIE", requestedBy: "alice" });

  assert.equal(relayCalls.length, 1);
  const call = relayCalls[0];
  assert.equal(call.url, "https://summonapns.gadgetusaf.com/push"); // the default publisher relay
  assert.equal(call.auth, null); // no apnsRelayKey configured → no Authorization header
  assert.equal(call.contentType, "application/json");
  // The ENTIRE body is pinned: the deviceToken is the decrypted plaintext (the
  // ciphertext never rides the wire), the alert is the content-free generic,
  // and collapseId groups by category.
  assert.deepEqual(call.body, {
    deviceToken: "apns-token-admin",
    payload: {
      aps: { alert: { title: "New request", body: "A new request needs review" }, sound: "default" },
      url: "/admin",
    },
    collapseId: "new_request",
  });
  // Privacy contract: no media title, no username, no e2e blob, not mutable.
  const raw = JSON.stringify(call.body);
  assert.ok(!raw.includes("Dune") && !raw.includes("alice"), "rich text must never reach the relay in cleartext");
  assert.deepEqual(errors, []);
});

test("E2E device: mutable-content + encrypted blob carrying the rich text and the tmdbId deep link; no u without a tmdbId", async () => {
  const device = makeDevice();
  userRows = [{ id: "u-e2e", pushOnApproved: true, pushOnDeclined: true }];
  subRows = [iosSub("u-e2e", "apns-token-e2e", { e2e: device })];

  await notifyUserRequestApprovedPush({ userId: "u-e2e", title: "Dune", mediaType: "MOVIE", tmdbId: 438631 });

  assert.equal(relayCalls.length, 1);
  const approved = relayCalls[0].body;
  // Cleartext stays generic; the rewrite marker tells the NSE to decrypt.
  assert.deepEqual(approved.payload.aps?.alert, { title: "Request approved", body: "Open Summonarr to see details" });
  assert.equal(approved.payload.aps?.["mutable-content"], 1);
  assert.equal(approved.payload.url, "/requests");
  assert.equal(approved.collapseId, "approved");
  // The blob decrypts (device-side recipe) to the rich text + the deep link —
  // the tmdbId-bearing URL rides ONLY inside the ciphertext.
  assert.ok(approved.payload.e2e);
  assert.deepEqual(decryptE2e(device, approved.payload.e2e), {
    t: "Request Approved",
    b: "Your Movie request for Dune has been approved",
    u: "/media/movie/438631",
  });

  // No tmdbId → the encrypted envelope carries no u key at all (and TV maps to
  // the "TV Show" label).
  await notifyUserRequestDeclinedPush({ userId: "u-e2e", title: "Andor", mediaType: "TV" });
  assert.equal(relayCalls.length, 2);
  assert.deepEqual(decryptE2e(device, relayCalls[1].body.payload.e2e!), {
    t: "Request Declined",
    b: "Your TV Show request for Andor was not approved",
  });
  assert.deepEqual(errors, []);
});

test("an E2E encrypt failure falls back to the generic payload — the send still goes out, scoped log emitted", async () => {
  userRows = [{ id: "u-bad", pushOnApproved: true }];
  const bad = iosSub("u-bad", "apns-token-badkey");
  bad.publicKey = "not-base64!!!"; // fails encryptForDevice's key validation
  subRows = [bad];

  await notifyUserRequestApprovedPush({ userId: "u-bad", title: "Dune", mediaType: "MOVIE" });

  assert.equal(relayCalls.length, 1);
  const body = relayCalls[0].body;
  assert.equal(body.payload.e2e, undefined);
  assert.equal(body.payload.aps?.["mutable-content"], undefined);
  assert.deepEqual(body.payload.aps?.alert, { title: "Request approved", body: "Open Summonarr to see details" });
  assert.ok(errors.some((e) => e.includes("[push] e2e encrypt failed:")), errors.join("\n"));
});

test("a configured apnsRelayUrl/apnsRelayKey routes to the custom relay with Bearer auth", async () => {
  settings.set("apnsRelayUrl", "https://relay.example.com/push");
  settings.set("apnsRelayKey", "relay-secret"); // stub returns the post-extension (decrypted) view
  userRows = [{ id: "u-custom", pushOnApproved: true }];
  subRows = [iosSub("u-custom", "apns-token-custom")];

  await notifyUserRequestApprovedPush({ userId: "u-custom", title: "Dune", mediaType: "MOVIE" });

  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].url, "https://relay.example.com/push");
  assert.equal(relayCalls[0].auth, "Bearer relay-secret");
});

test("relay outcomes: 'unregistered' prunes exactly that row; 500 and 401 keep the row and log why", async () => {
  userRows = [{ id: "u-mix", pushOnApproved: true }];
  const gone = iosSub("u-mix", "token-unregistered");
  const flaky = iosSub("u-mix", "token-500");
  const denied = iosSub("u-mix", "token-401");
  subRows = [gone, flaky, denied];
  relayRespond = (call) => {
    if (call.body.deviceToken === "token-unregistered") return jsonResponse({ ok: false, reason: "unregistered" });
    if (call.body.deviceToken === "token-500") return jsonResponse({ error: "relay exploded" }, 500);
    return jsonResponse({ error: "bad key" }, 401);
  };

  await notifyUserRequestApprovedPush({ userId: "u-mix", title: "Dune", mediaType: "MOVIE" });

  assert.equal(relayCalls.length, 3); // one device's failure never blocks the others
  // Only the unregistered device is pruned, keyed by ITS endpoint.
  assert.deepEqual(subDeletes, [{ where: { endpoint: gone.endpoint } }]);
  assert.deepEqual(subRows.map((s) => s.id), [flaky.id, denied.id]);
  // Transient/auth failures are logged with their relay-supplied detail.
  assert.ok(errors.some((e) => e.includes("APNs relay HTTP 500") && e.includes("relay exploded")), errors.join("\n"));
  assert.ok(errors.some((e) => e.includes("401") && e.includes("apnsRelayKey")), errors.join("\n"));
});

// ── web (VAPID) branch ──────────────────────────────────────────────────────

test("web send: stored Setting keys reach the wire (k=) and the decrypted subscription material passes validation", async () => {
  seedWebPushKeys();
  userRows = [{ id: "u-web", pushOnApproved: true }];
  subRows = [webSub("u-web", "sub-main")];

  await notifyUserRequestApprovedPush({ userId: "u-web", title: "Dune", mediaType: "MOVIE" });

  assert.equal(webCalls.length, 1);
  assert.equal(webCalls[0].url, "https://203.0.113.5/push/sub-main");
  // The payload was really encrypted (aes128gcm) — sendPushNotification rejects
  // malformed p256dh/auth BEFORE any network call, so reaching the endpoint
  // proves the token-crypto decrypt round-tripped the real material.
  assert.equal(webCalls[0].headers.get("content-encoding"), "aes128gcm");
  const auth = webCalls[0].headers.get("authorization") ?? "";
  const k = auth.match(/k=([A-Za-z0-9_-]+)$/)?.[1];
  assert.equal(k, WEB_VAPID.publicKey, "the STORED vapid public key must be the one advertised on the wire");
  assert.deepEqual(errors, []);
});

test("web failures: 410 prunes the subscription silently; other statuses log and keep it; siblings still deliver", async () => {
  seedWebPushKeys();
  userRows = [{ id: "u-web2", pushOnApproved: true }];
  const goneSub = webSub("u-web2", "sub-gone");
  const okSub = webSub("u-web2", "sub-ok");
  subRows = [goneSub, okSub];
  webRespond = (call) =>
    call.url.includes("sub-gone") ? new Response("gone", { status: 410 }) : new Response(null, { status: 201 });

  await notifyUserRequestApprovedPush({ userId: "u-web2", title: "Dune", mediaType: "MOVIE" });

  assert.equal(webCalls.length, 2); // the dead subscription didn't stop the healthy one
  assert.deepEqual(subDeletes, [{ where: { endpoint: goneSub.endpoint } }]);
  // Length check, not deepEqual: deepEqual's `asserts actual is T` overload would
  // narrow `errors` to never[] and break the .includes() probe below.
  assert.equal(errors.length, 0); // a revoked-subscription prune is expected housekeeping, not an error

  // A non-410/404 failure is a real error: logged, and the row is KEPT.
  webRespond = () => new Response("upstream sad", { status: 400 });
  await notifyUserRequestApprovedPush({ userId: "u-web2", title: "Dune", mediaType: "MOVIE" });
  assert.equal(subDeletes.length, 1); // no new prune
  assert.ok(errors.some((e) => e.includes("[push] Send failed:")), errors.join("\n"));
});

test("missing VAPID keys skip the web device but must NOT block a sibling iOS send (relay needs no VAPID)", async () => {
  // No vapid* Settings at all — pushContext still proceeds with keys: null.
  userRows = [{ id: "u-both", pushOnApproved: true }];
  subRows = [webSub("u-both", "sub-nokeys"), iosSub("u-both", "apns-token-both")];

  await notifyUserRequestApprovedPush({ userId: "u-both", title: "Dune", mediaType: "MOVIE" });

  assert.equal(webCalls.length, 0); // web silently skipped — no keys to sign with
  assert.equal(relayCalls.length, 1); // iOS delivered through the relay regardless
  assert.equal(relayCalls[0].body.deviceToken, "apns-token-both");
  assert.deepEqual(errors, []);
});

// ── feature-flag gating + failure isolation ─────────────────────────────────

test("feature.integration.push=false short-circuits every notify helper: zero subscription/user queries, zero network", async () => {
  settings.set("feature.integration.push", "false");
  subRows = [iosSub("u-admin", "apns-token-gated", { user: ADMIN })];
  userRows = [{ id: "u-x", pushOnApproved: true, pushOnAvailable: true }];

  await notifyAdminsNewRequestPush({ title: "Dune", mediaType: "MOVIE", requestedBy: "alice" });
  await notifyUserRequestApprovedPush({ userId: "u-x", title: "Dune", mediaType: "MOVIE" });
  await notifyUsersRequestsAvailablePush([{ requestedBy: "u-x", title: "Dune", mediaType: "MOVIE" }]);
  await notifyAdminsNewIssuePush({ title: "Dune", issueType: "VIDEO", reportedBy: "alice" });
  assert.equal(await notifyAdminGrabCompletedPush({ userId: "u-x", title: "Dune", scope: "ALL", issueId: "i1" }), "skipped-no-keys");

  assert.equal(subQueries.length, 0);
  assert.equal(userFindUniqueCalls.length, 0);
  assert.equal(userFindManyCalls.length, 0);
  assert.equal(fetchUrls.length, 0);
  assert.deepEqual(errors, []);
});

test("a subscription-query failure is swallowed into the helper's scoped log — the caller never sees a throw", async () => {
  subFindManyImpl = async () => {
    throw new Error("pool exhausted");
  };

  await notifyAdminsNewRequestPush({ title: "Dune", mediaType: "MOVIE", requestedBy: "alice" });

  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("[push] Failed to notify admins (request):"), errors[0]);
  assert.ok(errors[0].includes("pool exhausted"));
  assert.equal(fetchUrls.length, 0);
});

test("empty batch input is a TOTAL no-op — not even the feature-flag read happens", async () => {
  await notifyUsersRequestsAvailablePush([]);
  await notifyUsersRequestsApprovedPush([]);
  await notifyUsersRequestsDeclinedPush([]);

  assert.equal(settingFindManyKeys.length, 0);
  assert.equal(subQueries.length, 0);
  assert.equal(userFindManyCalls.length, 0);
  assert.equal(fetchUrls.length, 0);
});

// ── recipient selection ─────────────────────────────────────────────────────

test("admin pushes go to MANAGE_REQUESTS holders only: ADMIN superbit and raw grant pass; USER/ISSUE_ADMIN presets don't; requester excluded", async () => {
  subRows = [
    iosSub("u-admin", "token-role-admin", { user: { role: "ADMIN", permissions: 0n } }),
    iosSub("u-operator", "token-raw-grant", { user: { role: "USER", permissions: 4n } }), // MANAGE_REQUESTS = 1n<<2n
    iosSub("u-pleb", "token-plain-user", { user: { role: "USER", permissions: 0n } }), // USER preset: request bits only
    iosSub("u-issues", "token-issue-admin", { user: { role: "ISSUE_ADMIN", permissions: 0n } }), // MANAGE_ISSUES only
    iosSub("u-requester", "token-self", { user: { role: "ADMIN", permissions: 0n } }), // the acting admin
  ];

  await notifyAdminsNewRequestPush({
    title: "Dune",
    mediaType: "MOVIE",
    requestedBy: "alice",
    excludeUserId: "u-requester",
  });

  // Exact query shape: DB-level exclusion + the role/permissions join the
  // bitmask filter needs.
  assert.deepEqual(subQueries[0], {
    where: { userId: { not: "u-requester" } },
    include: { user: { select: { role: true, permissions: true } } },
  });
  assert.deepEqual(
    relayCalls.map((c) => c.body.deviceToken).sort(),
    ["token-raw-grant", "token-role-admin"],
  );

  // No excludeUserId (deletion-vote broadcast): unfiltered where, same bitmask
  // — so the previously-excluded admin's device is now included as well.
  relayCalls.length = 0;
  await notifyAdminsDeletionVoteThresholdPush({ title: "Dune", mediaType: "MOVIE", voteCount: 5 });
  assert.deepEqual(subQueries[1].where, {});
  assert.deepEqual(
    relayCalls.map((c) => c.body.deviceToken).sort(),
    ["token-raw-grant", "token-role-admin", "token-self"],
  );
  assert.equal(relayCalls[0].body.collapseId, "deletion_votes");
  assert.equal(relayCalls[0].body.payload.url, "/votes");
});

test("issue pushes: notifyOnIssue rides the where clause, MANAGE_ISSUES the bitmask; restrict==exclude is a zero-query no-op", async () => {
  subRows = [
    iosSub("u-ia", "token-issue-admin-on", { user: { role: "ISSUE_ADMIN", permissions: 0n, notifyOnIssue: true } }),
    iosSub("u-adm", "token-admin-on", { user: { role: "ADMIN", permissions: 0n, notifyOnIssue: true } }),
    iosSub("u-muted", "token-issue-admin-muted", { user: { role: "ISSUE_ADMIN", permissions: 0n, notifyOnIssue: false } }),
    iosSub("u-user", "token-user-on", { user: { role: "USER", permissions: 0n, notifyOnIssue: true } }),
  ];

  await notifyAdminsNewIssuePush({ title: "Dune", issueType: "VIDEO", reportedBy: "alice", excludeUserId: "u-rep" });

  assert.deepEqual(subQueries[0], {
    where: { userId: { not: "u-rep" }, user: { notifyOnIssue: true } },
    include: { user: { select: { role: true, permissions: true } } },
  });
  assert.deepEqual(
    relayCalls.map((c) => c.body.deviceToken).sort(),
    ["token-admin-on", "token-issue-admin-on"],
  );
  assert.equal(relayCalls[0].body.collapseId, "new_issue");

  // restrictToUserId === excludeUserId (the grab-completion self-notify case):
  // resolved to [] BEFORE any query — nothing hits the subscription table.
  const queriesBefore = subQueries.length;
  relayCalls.length = 0;
  await notifyAdminsIssueMessagePush({
    title: "Dune",
    userName: "alice",
    body: "hi",
    restrictToUserId: "u-ia",
    excludeUserId: "u-ia",
  });
  assert.equal(subQueries.length, queriesBefore);
  assert.equal(relayCalls.length, 0);

  // restrictToUserId alone narrows the where to exactly that user.
  await notifyAdminsIssueMessagePush({ title: "Dune", userName: "alice", body: "hi", restrictToUserId: "u-ia" });
  assert.deepEqual(subQueries.at(-1)?.where, { userId: "u-ia", user: { notifyOnIssue: true } });
  assert.deepEqual(relayCalls.map((c) => c.body.deviceToken), ["token-issue-admin-on"]);
});

test("per-user pref gates read exactly their column and stop BEFORE the subscription query when off", async () => {
  userRows = [{ id: "u-pref", pushOnApproved: false, pushOnDeclined: true }];
  subRows = [iosSub("u-pref", "token-pref")];

  // pushOnApproved=false: the pref read happens, the subscription read doesn't.
  await notifyUserRequestApprovedPush({ userId: "u-pref", title: "Dune", mediaType: "MOVIE" });
  assert.deepEqual(userFindUniqueCalls[0], { where: { id: "u-pref" }, select: { pushOnApproved: true } });
  assert.equal(subQueries.length, 0);
  assert.equal(fetchUrls.length, 0);

  // pushOnDeclined=true: its own column is read and the push goes out.
  await notifyUserRequestDeclinedPush({ userId: "u-pref", title: "Dune", mediaType: "MOVIE" });
  assert.deepEqual(userFindUniqueCalls[1].select, { pushOnDeclined: true });
  assert.equal(subQueries.length, 1);
  assert.deepEqual(relayCalls.map((c) => c.body.deviceToken), ["token-pref"]);
  assert.equal(relayCalls[0].body.collapseId, "declined");
});

test("issue-reply push to the reporter: notifyOnIssue where-shape, 100-char body truncation, and the issue deep URL", async () => {
  const device = makeDevice();
  subRows = [iosSub("u-rep", "token-reporter", { e2e: device, user: { role: "USER", permissions: 0n, notifyOnIssue: true } })];
  const longBody = "y".repeat(150);

  await notifyUserIssueMessagePush({ userId: "u-rep", title: "Stutter on Dune", body: longBody, issueId: "iss-9" });

  // Recipient query: the user's own subs, gated on their notifyOnIssue pref in
  // the where itself (no include — no role filtering for the reporter).
  assert.deepEqual(subQueries[0], { where: { userId: "u-rep", user: { notifyOnIssue: true } } });
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].body.payload.url, "/issues?selected=iss-9");
  assert.equal(relayCalls[0].body.collapseId, "issue_reply");
  const rich = decryptE2e(device, relayCalls[0].body.payload.e2e!);
  assert.equal(rich.t, "Admin replied on: Stutter on Dune");
  assert.equal(rich.b, "y".repeat(97) + "…"); // 100-char cap: 97 + ellipsis
});

// ── batch fan-out ───────────────────────────────────────────────────────────

test("available batch: deduped pref query, ALL of an eligible user's devices per request, exact rich payloads + deep links", async () => {
  const dev1 = makeDevice();
  const dev2 = makeDevice();
  const deviceByToken = new Map<string, Device>([
    ["avail-dev-1", dev1],
    ["avail-dev-2", dev2],
  ]);
  userRows = [
    { id: "u1", pushOnAvailable: true },
    { id: "u2", pushOnAvailable: false }, // opted out
    { id: "u3", pushOnAvailable: true }, // opted in but has no devices
  ];
  subRows = [
    iosSub("u1", "avail-dev-1", { e2e: dev1 }),
    iosSub("u1", "avail-dev-2", { e2e: dev2 }),
    iosSub("u2", "avail-dev-optout"),
  ];

  await notifyUsersRequestsAvailablePush([
    { requestedBy: "u1", title: "Heat", mediaType: "MOVIE", tmdbId: 949 },
    { requestedBy: "u2", title: "Dune", mediaType: "MOVIE" },
    { requestedBy: "u1", title: "Andor", mediaType: "TV" }, // duplicate user → deduped in the pref query
    { requestedBy: "u3", title: "Alien", mediaType: "MOVIE" },
  ]);

  // One pref query over the UNIQUE requester ids, selecting only ids.
  assert.equal(userFindManyCalls.length, 1);
  assert.deepEqual(userFindManyCalls[0], {
    where: { id: { in: ["u1", "u2", "u3"] }, pushOnAvailable: true },
    select: { id: true },
  });
  // One subscription query over the eligible users only.
  assert.deepEqual(subQueries[0]?.where, { userId: { in: ["u1", "u3"] } });

  // u1's TWO devices each get BOTH of u1's requests; the opted-out user's
  // device gets nothing; the device-less user produces no jobs.
  assert.equal(relayCalls.length, 4);
  const delivered = relayCalls
    .map((c) => ({ token: c.body.deviceToken, ...decryptE2e(deviceByToken.get(c.body.deviceToken)!, c.body.payload.e2e!) }))
    .sort((a, b) => (a.token + a.b).localeCompare(b.token + b.b));
  assert.deepEqual(delivered, [
    { token: "avail-dev-1", t: "Now Available", b: "Your Movie Heat is ready to watch", u: "/media/movie/949" },
    { token: "avail-dev-1", t: "Now Available", b: "Your TV Show Andor is ready to watch" },
    { token: "avail-dev-2", t: "Now Available", b: "Your Movie Heat is ready to watch", u: "/media/movie/949" },
    { token: "avail-dev-2", t: "Now Available", b: "Your TV Show Andor is ready to watch" },
  ]);
  for (const c of relayCalls) assert.equal(c.body.collapseId, "available");
  assert.deepEqual(errors, []);
});

// ── operator diagnostics + outcome counters ─────────────────────────────────

test("sendApnsTestToUser: bypasses the disabled flag, selects ONLY the user's iOS rows, reports per-device results", async () => {
  settings.set("feature.integration.push", "false"); // diagnostics ignore the off-switch
  const device = makeDevice();
  subRows = [
    iosSub("u-me", "test-ios-1", { e2e: device, label: "iPhone", endpoint: "apns:device/0123456789abcdefghij" }),
    iosSub("u-me", "test-ios-2", { label: null, endpoint: "apns:device/aaaabbbbccccddddeeee" }),
    webSub("u-me", "test-web"), // web rows are tested separately via VAPID — never selected
    iosSub("u-other", "test-other-user"),
  ];
  relayRespond = (call) =>
    call.body.deviceToken === "test-ios-2" ? jsonResponse({ error: "boom" }, 500) : jsonResponse({ ok: true });

  const results = await sendApnsTestToUser("u-me");

  assert.deepEqual(subQueries[0]?.where, { userId: "u-me", platform: "ios" });
  // Per-device outcome, endpoints truncated to 28 chars for display, one
  // failure isolated (both literals pin the truncation).
  assert.deepEqual(results, [
    { endpoint: "apns:device/0123456789abcdef…", label: "iPhone", ok: true },
    { endpoint: "apns:device/aaaabbbbccccdddd…", label: null, ok: false },
  ]);
  assert.equal(relayCalls.length, 2); // the web row and the other user's row never sent
  // The cleartext alert is the generic test banner (no emoji)…
  assert.deepEqual(relayCalls[0].body.payload.aps?.alert, { title: "Summonarr", body: "Test notification — push is working!" });
  assert.equal(relayCalls[0].body.collapseId, "test");
  // …while the E2E envelope carries the rich text through the same path the
  // real notifications use.
  assert.deepEqual(decryptE2e(device, relayCalls[0].body.payload.e2e!), {
    t: "Summonarr",
    b: "Test notification — push is working! 🎉",
  });
});

test("sendAppUpdateNoticeToAllIos: every iOS device across users, {sent, failed} counters, unregistered rows pruned", async () => {
  settings.set("feature.integration.push", "false"); // operator broadcast ignores the off-switch
  const ok = iosSub("u-a", "upd-ok");
  const goneRow = iosSub("u-b", "upd-unregistered");
  const flaky = iosSub("u-b", "upd-500");
  subRows = [ok, goneRow, flaky, webSub("u-a", "upd-web")]; // web row excluded by the platform filter
  relayRespond = (call) => {
    if (call.body.deviceToken === "upd-unregistered") return jsonResponse({ ok: false, reason: "unregistered" });
    if (call.body.deviceToken === "upd-500") return jsonResponse({ error: "later" }, 500);
    return jsonResponse({ ok: true });
  };

  const counts = await sendAppUpdateNoticeToAllIos();

  assert.deepEqual(subQueries[0]?.where, { platform: "ios" });
  assert.equal(relayCalls.length, 3);
  assert.deepEqual(counts, { sent: 1, failed: 2 }); // unregistered + 500 both count as failed
  assert.deepEqual(subDeletes, [{ where: { endpoint: goneRow.endpoint } }]); // and the dead token is pruned
  assert.deepEqual(relayCalls[0].body.payload.aps?.alert, {
    title: "Update Summonarr",
    body: "A new version of the Summonarr app is available on the App Store",
  });
  assert.equal(relayCalls[0].body.collapseId, "app_update");
});

test("grab-completed outcome mapping: skipped-no-subs / delivered / failed (a token-less iOS row fails with zero network)", async () => {
  const data = { userId: "u-grab", title: "Dune Part Two", scope: "SEASON", seasonNumber: 2, issueId: "iss-7" };

  // No subscriptions at all → the caller is told to backstop via another channel.
  assert.equal(await notifyAdminGrabCompletedPush(data), "skipped-no-subs");

  // One healthy device → delivered (any success wins), with the season-scoped
  // rich body observable through the E2E envelope.
  const device = makeDevice();
  subRows = [iosSub("u-grab", "grab-ok", { e2e: device })];
  assert.equal(await notifyAdminGrabCompletedPush(data), "delivered");
  assert.equal(relayCalls.at(-1)?.body.collapseId, "grab_complete");
  // No u key: grab pushes carry no media deep link — the tap target is the
  // cleartext payload.url (/issues?selected=…) alone.
  assert.deepEqual(decryptE2e(device, relayCalls.at(-1)!.body.payload.e2e!), {
    t: "Download complete",
    b: "Dune Part Two Season 2 has finished downloading",
  });

  // An iOS row with no deviceToken can never deliver: sendApns refuses before
  // any network call and the helper reports the send as failed.
  const broken = iosSub("u-grab", "grab-broken");
  broken.deviceToken = null;
  subRows = [broken];
  const fetchesBefore = fetchUrls.length;
  assert.equal(await notifyAdminGrabCompletedPush(data), "failed");
  assert.equal(fetchUrls.length, fetchesBefore);
});
