// Pure rules several API routes read their input through: the email a new
// local account may hold, the TRaSH instance variant, the one-field PATCH of
// an admin user edit, the terminate-playback body, a Plex device header, the
// Jellyfin user diagnosis, the watch sync page's suggestions and the secret
// compare. The routes' own suites pin the wiring; these pin the rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const { parseAccountEmail } = await import("../src/lib/account-email.ts");
const { parseTrashVariant } = await import("../src/lib/trash-variant.ts");
const {
  presentUserPatchFields,
  isSelfPrivilegeField,
  storedQuotaValue,
  contentCapBeyondOwn,
  USER_NOTIF_KEYS,
} = await import("../src/lib/admin-user-fields.ts");
const { parseTerminateRequest, upstreamFailureDetail, SESSION_KEY_MAX_LEN } = await import("../src/lib/terminate-session-request.ts");
const { SafeFetchError } = await import("../src/lib/safe-fetch.ts");
const { plexDeviceValue } = await import("../src/lib/plex-pin.ts");
const { readUsersBody, diagnoseJellyfinUser } = await import("../src/lib/jellyfin-user-diagnosis.ts");
const { watchSyncSuggestions, serverUserOut, splitServerUsers } = await import("../src/lib/watch-sync-view.ts");
const { safeCompareStrings } = await import("../src/lib/safe-compare.ts");

// ── account email ────────────────────────────────────────────────────────────

test("a new account's email is normalized, then judged on the normalized value", () => {
  assert.equal(parseAccountEmail("Admin@Example.COM"), "admin@example.com");
  // NFKC folds a fullwidth "＠" into "@": judged after folding, it is two @s.
  assert.equal(parseAccountEmail("a＠b@c.com"), null);
  for (const bad of [undefined, null, 42, "", " a@b.co", "a@b.co ", "a b@c.co", "nodomain@", "@b.co", "a@b", "a@.co", "a@b.", "a@b@c.co", `${"x".repeat(250)}@b.co`]) {
    assert.equal(parseAccountEmail(bad), null, JSON.stringify(bad));
  }
});

// ── TRaSH variant ────────────────────────────────────────────────────────────

test("the TRaSH variant trims before reading the legacy 'hd', so every route agrees", () => {
  assert.equal(parseTrashVariant(undefined), "");
  assert.equal(parseTrashVariant(null), "");
  assert.equal(parseTrashVariant(""), "");
  assert.equal(parseTrashVariant("hd"), "");
  assert.equal(parseTrashVariant(" hd "), "");
  assert.equal(parseTrashVariant("  4k  "), "4k");
  assert.equal(parseTrashVariant("anime"), "anime");
  for (const bad of ["Bad Slug", "UPPER", "with/slash", 5, true, {}]) {
    assert.equal(parseTrashVariant(bad), null, JSON.stringify(bad));
  }
});

// ── admin user PATCH fields ──────────────────────────────────────────────────

test("a user edit names the fields it sends — null counts, unknown keys don't", () => {
  assert.deepEqual(presentUserPatchFields({}), []);
  assert.deepEqual(presentUserPatchFields({ bogus: 1 }), []);
  assert.deepEqual(presentUserPatchFields({ maxContentRating: null }), ["maxContentRating"]);
  assert.deepEqual(presentUserPatchFields({ role: "USER", movieQuotaDays: 3 }).sort(), ["movieQuotaDays", "role"]);
  assert.deepEqual(presentUserPatchFields(JSON.parse('{"__proto__": {"role": "ADMIN"}}')), [], "a prototype key names nothing");
  for (const k of USER_NOTIF_KEYS) assert.deepEqual(presentUserPatchFields({ [k]: true }), [k]);
});

test("the self-edit gate covers the grant-bearing fields and the quotas, not the rest", () => {
  for (const f of ["maxContentRating", "instanceGrants", "mediaServerGrants", "movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays"] as const) {
    assert.equal(isSelfPrivilegeField(f), true, f);
  }
  for (const f of ["mediaServer", "notifyOnApproved", "permissions", "role"] as const) {
    assert.equal(isSelfPrivilegeField(f), false, f);
  }
});

test("a 0-day quota window is stored as no value; a 0 limit is not the days' business", () => {
  assert.equal(storedQuotaValue("movieQuotaDays", 0), null);
  assert.equal(storedQuotaValue("tvQuotaDays", 0), null);
  assert.equal(storedQuotaValue("movieQuotaDays", 30), 30);
  assert.equal(storedQuotaValue("movieQuotaLimit", 0), 0);
  assert.equal(storedQuotaValue("tvQuotaLimit", null), null);
});

test("a capped delegate may not clear a cap or loosen it; an uncapped one may set anything", () => {
  assert.equal(contentCapBeyondOwn(null, null), false);
  assert.equal(contentCapBeyondOwn("R", null), false);
  assert.equal(contentCapBeyondOwn(null, "PG-13"), true);
  assert.equal(contentCapBeyondOwn("R", "PG-13"), true);
  assert.equal(contentCapBeyondOwn("PG", "PG-13"), false);
});

// ── terminate playback ───────────────────────────────────────────────────────

test("the terminate body: a bounded, printable session key, a valid instance, and an optional reason", () => {
  assert.deepEqual(parseTerminateRequest({ sessionKey: " 77 " }), { ok: true, value: { sessionKey: "77", serverInstance: "", reason: null } });
  assert.deepEqual(parseTerminateRequest({ sessionKey: "k", serverInstance: "remote", reason: "  stop  " }), { ok: true, value: { sessionKey: "k", serverInstance: "remote", reason: "stop" } });
  assert.equal((parseTerminateRequest({ sessionKey: "k", reason: "r".repeat(900) }) as { value: { reason: string } }).value.reason.length, 500);
  assert.deepEqual(parseTerminateRequest({}), { ok: false, error: "sessionKeyRequired" });
  assert.deepEqual(parseTerminateRequest({ sessionKey: "   " }), { ok: false, error: "sessionKeyRequired" });
  assert.deepEqual(parseTerminateRequest({ sessionKey: "k".repeat(SESSION_KEY_MAX_LEN + 1) }), { ok: false, error: "sessionKeyInvalid" });
  assert.deepEqual(parseTerminateRequest({ sessionKey: "a\u0007b" }), { ok: false, error: "sessionKeyInvalid" });
  assert.deepEqual(parseTerminateRequest({ sessionKey: "k", serverInstance: "Bad Slug" }), { ok: false, error: "invalidServerInstance" });
  assert.deepEqual(parseTerminateRequest({ sessionKey: "k", serverInstance: 3 }), { ok: false, error: "invalidServerInstance" });
});

test("a media-server failure is told to the admin by kind, never by its text", () => {
  assert.equal(upstreamFailureDetail(new SafeFetchError("timeout", "http://10.0.0.5:32400/x", "timed out for http://10.0.0.5:32400/x")), "timeout");
  assert.equal(upstreamFailureDetail(new Error("Plex sessions: 503")), "HTTP 503");
  assert.equal(upstreamFailureDetail(Object.assign(new Error("x"), { name: "TimeoutError" })), "timeout");
  assert.equal(upstreamFailureDetail(new Error("connect ECONNREFUSED 10.0.0.5:32400")), "error");
  assert.equal(upstreamFailureDetail("a string"), "error");
});

// ── Plex device header ───────────────────────────────────────────────────────

test("a Plex device string is made header-safe, bounded, or falls back", () => {
  assert.equal(plexDeviceValue("iPhone", "Web"), "iPhone");
  assert.equal(plexDeviceValue("Chris’s iPhone", "Web"), "Chriss iPhone");
  assert.equal(plexDeviceValue("иОС", "Web"), "Web");
  assert.equal(plexDeviceValue("   ", "Web"), "Web");
  assert.equal(plexDeviceValue(42, "hosted"), "hosted");
  assert.equal(plexDeviceValue("d".repeat(200), "Web").length, 32);
});

// ── Jellyfin user diagnosis ──────────────────────────────────────────────────

test("the /Users answer is read as an array, a QueryResult, or named as unexpected", () => {
  assert.deepEqual(readUsersBody([{ Id: "a" }]).responseShape, "array");
  assert.deepEqual(readUsersBody({ Items: [{ Id: "a" }] }), { items: [{ Id: "a" }], responseShape: "QueryResult{Items}" });
  assert.deepEqual(readUsersBody({ nope: true }), { items: [], responseShape: "unexpected:object" });
  assert.deepEqual(readUsersBody("x"), { items: [], responseShape: "unexpected:string" });
  assert.deepEqual(readUsersBody(null), { items: [], responseShape: "unknown" });
});

test("a Jellyfin user is diagnosed field by field, masked, with every skip reason", () => {
  assert.deepEqual(diagnoseJellyfinUser({ Id: "u1", Name: "alice", Email: "alice@example.com", Policy: { IsAdministrator: false, IsDisabled: true, EnableContentDownloading: true } }), {
    id: "u1", name: "alice", email: "ali…", isAdmin: false, isDisabled: true, isHidden: null, downloadsEnabled: true, wouldBeSkipped: false, skipReasons: [],
  });
  assert.deepEqual(diagnoseJellyfinUser({ Name: "" }).skipReasons, ["missing-id", "empty-name", "no-policy"]);
  assert.deepEqual(diagnoseJellyfinUser({ Id: 7, Name: 3, Policy: "yes" }).skipReasons, ["missing-id", "missing-name", "no-policy"], "a malformed field is reported, not trusted");
  assert.deepEqual(diagnoseJellyfinUser(null).skipReasons, ["missing-id", "missing-name", "no-policy"]);
});

// ── watch sync page ──────────────────────────────────────────────────────────

const row = (id: string, source: string, username: string, userId: string | null, name: string | null = null) =>
  ({ id, source, serverInstance: "", username, active: true, userId, user: name ? { name, email: null } : null });

test("watch sync suggests each unpaired Plex/Jellyfin pair on one account, A–Z by account", () => {
  const plex = [row("p1", "plex", "zed", "acc-z", "Zed"), row("p2", "plex", "amy", "acc-a", "Amy"), row("p3", "plex", "loner", null)];
  const jelly = [row("j1", "jellyfin", "amy-jf", "acc-a"), row("j2", "jellyfin", "zed-jf", "acc-z"), row("j3", "jellyfin", "zed-2", "acc-z")];
  const suggestions = watchSyncSuggestions(plex, jelly, [{ plexUser: { id: "p1" }, jellyfinUser: { id: "j3" } }]);
  assert.deepEqual(suggestions, [
    { plexUserId: "p2", jellyfinUserId: "j1", account: "Amy" },
    { plexUserId: "p1", jellyfinUserId: "j2", account: "Zed" },
  ]);
});

test("watch sync names a server by its display name, and lists each service A–Z ignoring case", () => {
  const names = { plex: new Map([["remote", "Friend's"]]), jellyfin: new Map<string, string>() };
  assert.equal(serverUserOut(names, { ...row("p", "plex", "a", null), serverInstance: "remote" }).server, "Friend's");
  assert.equal(serverUserOut(names, { ...row("j", "jellyfin", "a", null), serverInstance: "gone" }).server, "gone");
  assert.equal(serverUserOut(names, row("j", "jellyfin", "a", null)).server, "jellyfin");
  const { plex, jellyfin } = splitServerUsers([row("1", "plex", "GuestRoom", null), row("2", "plex", "alice", null), row("3", "jellyfin", "bob", null)]);
  assert.deepEqual(plex.map((u) => u.username), ["alice", "GuestRoom"]);
  assert.deepEqual(jellyfin.map((u) => u.username), ["bob"]);
});

// ── secret compare ───────────────────────────────────────────────────────────

test("the secret compare is equality, whatever the lengths", () => {
  assert.equal(safeCompareStrings("secret", "secret"), true);
  assert.equal(safeCompareStrings("secret", "secreT"), false);
  assert.equal(safeCompareStrings("short", "a much longer value"), false);
  assert.equal(safeCompareStrings("", ""), true);
});

test("the hash-both-sides secret compare has one home: no other source file keeps a private copy", () => {
  const root = new URL("../src/", import.meta.url).pathname;
  const digest = String.raw`create(?:Hash\("sha256"\)|Hmac\("sha256", \w+\))\.update\(\w+\)\.digest\(\);`;
  const copy = new RegExp(`${digest}\\s*const \\w+ = ${digest}\\s*return timingSafeEqual\\(`);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "generated") walk(full);
      } else if (/\.tsx?$/.test(entry.name) && copy.test(readFileSync(full, "utf8"))) {
        offenders.push(full.slice(root.length));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, ["lib/safe-compare.ts"]);
});
