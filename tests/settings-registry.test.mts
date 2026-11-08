// The admin settings key registry (src/lib/settings-registry.ts): one entry per
// key the settings route accepts, and the checks every PATCH value goes through.
// The route's own behaviour over HTTP is pinned in tests/settings-route.test.mts;
// these pins cover the table itself and the pure checks, one rule at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto at load
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning

const R = await import("../src/lib/settings-registry.ts");
const { SETTINGS_SENSITIVE_KEYS_SET } = await import("../src/lib/settings-sensitive-keys.ts");
const { FEATURE_KEYS } = await import("../src/lib/features.ts");
const { TRACKING_STAMP_KEYS } = await import("../src/lib/never-watched.ts");
const { WATCH_GRADE_SETTING_KEYS } = await import("../src/lib/watch-grade.ts");
const { CLEANUP_FEATURE_KEY } = await import("../src/lib/library-cleanup-data.ts");
const { NEVER_WATCHED_FEATURE_KEY } = await import("../src/lib/never-watched-data.ts");

type Def = (typeof R.SETTINGS_REGISTRY) extends ReadonlyMap<string, infer D> ? D : never;

// Echoes the catalog key and its variables, so a test can tell which 400 text was chosen.
const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const deps = { t, knowsTimeZone: async (zone: string) => zone !== "Antarctica/Troll" };
const check = (key: string, value: string) => R.checkSettingValue(key as never, value, deps);
const keysWhere = (f: (d: Def, key: string) => boolean) => [...R.SETTINGS_REGISTRY].filter(([k, d]) => f(d, k)).map(([k]) => k);

// ── the table ────────────────────────────────────────────────────────────────

test("the registry is consistent with the encryption gate and the credential naming rule", () => {
  assert.deepEqual(
    R.registryProblems(R.SETTINGS_REGISTRY, SETTINGS_SENSITIVE_KEYS_SET, FEATURE_KEYS, []),
    [],
  );
  // vapidPrivateKey is sensitive but deliberately not admin-writable.
  assert.equal(R.isSettingKey("vapidPrivateKey"), false);
});

test("registryProblems names each kind of drift", () => {
  const text = { type: { kind: "text" } } as const;
  const secret = { type: { kind: "secret" }, sensitive: true } as const;
  const problems = (entries: Array<[string, Def]>, sensitive: string[], base: string[] = []) =>
    R.registryProblems(new Map(entries), new Set(sensitive), ["feature.page.top"], base);

  assert.match(problems([["fooApiKey", secret]], [])[0], /missing from SETTINGS_SENSITIVE_KEYS/);
  assert.match(problems([["fooApiKey", { type: { kind: "secret" } }]], ["fooApiKey"])[0], /not marked sensitive/);
  assert.match(problems([["fooToken", { ...text, sensitive: true }]], ["fooToken"])[0], /secret-shaped but not of kind "secret"/);
  assert.match(problems([["fooPassword", { ...secret }]], ["fooPassword"])[0], /not secret-shaped but of kind "secret"/);
  assert.match(problems([["feature.page.top", { type: { kind: "boolean" } }]], [], ["feature.page.top"])[0], /feature flag/);
  // A sensitive key the route never exposes is fine.
  assert.deepEqual(problems([["siteTitle", text]], ["vapidPrivateKey"]), []);
});

test("every feature flag is a writable, cooldown-exempt true/false switch", () => {
  for (const key of FEATURE_KEYS) {
    const def = R.SETTINGS_REGISTRY.get(key);
    assert.ok(def, key);
    assert.equal(def.type.kind, "boolean", key);
    assert.equal(def.cooldownExempt, true, key);
  }
});

test("a change to any never-watched report input drops the report — exactly those keys", () => {
  const inputs = [...Object.keys(TRACKING_STAMP_KEYS), "playHistoryRetentionDays", CLEANUP_FEATURE_KEY, NEVER_WATCHED_FEATURE_KEY];
  assert.deepEqual(keysWhere((d) => d.effects?.includes("neverWatchedReport") === true).sort(), inputs.sort());
});

test("every playHistory* key drops play-history's settings memo", () => {
  const keys = keysWhere((_d, k) => k.startsWith("playHistory"));
  assert.ok(keys.length >= 8, keys.join());
  for (const key of keys) {
    assert.ok(R.SETTINGS_REGISTRY.get(key as never)?.effects?.includes("playHistorySettings"), key);
  }
  assert.deepEqual([...R.settingEffects(["playHistoryArcGapDays"])], ["playHistorySettings"]);
  assert.deepEqual([...R.settingEffects(["siteTitle", "radarrUrl"])], []);
});

test("the watch-grade keys are the read side's own keys, each bounded by its parser and clearable", () => {
  assert.deepEqual(keysWhere((d) => d.type.kind === "watchGrade").sort(), Object.values(WATCH_GRADE_SETTING_KEYS).sort());
  for (const key of Object.values(WATCH_GRADE_SETTING_KEYS)) assert.equal(R.isClearableSetting(key), true, key);
});

test("exactly the watch-grade keys drop the grade settings memo", () => {
  assert.deepEqual(
    keysWhere((d) => d.effects?.includes("watchGradeSettings") === true).sort(),
    Object.values(WATCH_GRADE_SETTING_KEYS).sort(),
  );
  const route = readFileSync(new URL("../src/app/api/settings/route.ts", import.meta.url), "utf8");
  assert.match(route, /effects\.has\("watchGradeSettings"\)\) invalidateWatchGradeSettings\(\)/, "the settings route drops it after a save");
});

test("the Discord registration inputs re-register; the public key only drops the signature cache", () => {
  assert.deepEqual([...R.settingEffects(["discordGuildId"])].sort(), ["discordCommands", "discordPublicKey"]);
  assert.deepEqual([...R.settingEffects(["discordPublicKey"])], ["discordPublicKey"]);
  assert.deepEqual([...R.settingEffects(["discordNotifyChannelId"])], []);
});

// ── one value ────────────────────────────────────────────────────────────────

test("every integer setting is digits only, inside its bounds, with its own 400 text", async () => {
  const cases: Array<[key: string, ok: string, bad: string[], message: string]> = [
    ["rateLimitRequests", "10000", ["0", "10001", "1e3", "-1", "5 "], 'apiAdmin.settings.intRange10000 {"key":"rateLimitRequests"}'],
    ["recommendedIosBuild", "1000000", ["0", "1000001", "1.5"], 'apiAdmin.settings.intRangeMillion {"key":"recommendedIosBuild"}'],
    ["radarrQualityProfileId", "99999999999999999999", ["0", "x", "9".repeat(400)], 'apiAdmin.settings.positiveInt {"key":"radarrQualityProfileId"}'],
    ["auditPiiRetentionDays", "7", ["6", "3651"], 'apiAdmin.settings.daysRange {"key":"auditPiiRetentionDays"}'],
    ["smtpPort", "65535", ["0", "65536", "25a"], 'apiAdmin.settings.intRange {"key":"smtpPort","min":1,"max":65535}'],
    ["sessionMaxDuration", "7776000", ["59", "7776001"], 'apiAdmin.settings.intRange {"key":"sessionMaxDuration","min":60,"max":7776000}'],
  ];
  for (const [key, ok, bad, message] of cases) {
    assert.deepEqual(await check(key, ok), { ok: true, value: ok }, key);
    for (const value of bad) {
      assert.deepEqual(await check(key, value), { ok: false, rejection: { error: message } }, `${key}=${value}`);
    }
  }
  assert.equal(R.isIntInRange("1e3", 1, 10_000), false, "parseInt would read it as 1");
});

test("the type checks: booleans, enums, URLs, donations, library ids, relay key, snowflakes", async () => {
  const refused = async (key: string, value: string) => (await check(key, value)).ok === false;
  assert.equal(await refused("maintenanceEnabled", "yes"), true);
  assert.equal(await refused("feature.page.top", "false"), false);
  assert.equal(await refused("quotaPeriod", "year"), true);
  assert.deepEqual(await check("radarrMinimumAvailability", "soon"), {
    ok: false, rejection: { error: 'apiAdmin.settings.minimumAvailability {"key":"radarrMinimumAvailability"}' },
  });
  assert.equal(await refused("apnsRelayUrl", "http://relay.example.com"), true, "the relay is https only");
  assert.equal(await refused("radarrUrl", "http://10.0.0.1:7878"), false);
  assert.equal(await refused("radarrUrl", "http://user:pw@10.0.0.1:7878"), true);
  assert.equal(await refused("donationVenmo", "@alice"), false, "a handle stays a handle");
  assert.deepEqual(await check("donationVenmo", "http://venmo.com/alice"), {
    ok: false, rejection: { error: "apiAdmin.settings.donationHttps", code: "invalid-url" },
  });
  assert.equal(await refused("donationAmazon", "my-wishlist"), true, "Amazon has no handle form");
  assert.equal(await refused("plexLibraries", "1, 2,,abc_d-3"), false);
  assert.equal(await refused("plexLibraries", "1&x=2"), true);
  assert.equal(await refused("apnsRelayKey", "short"), true);
  assert.equal(await refused("apnsRelayKey", "key,with,commas"), true);
  assert.equal(await refused("apnsRelayKey", "a-long-printable-key"), false);
  assert.equal(await refused("machineSessionAllowedIps", "10.0.0.0/8, nope"), true);
  assert.equal(await refused("discordClientId", "1234567890123456"), true, "16 digits");
  assert.equal(await refused("discordClientId", "12345678901234567"), false, "17 digits");
  assert.equal(R.DISCORD_SNOWFLAKE_RE.test("123456789012345678901"), false, "21 digits");
  assert.equal(await refused("radarrApiKey", "abc\ndef"), true, "a control character in a credential");
  assert.equal(await refused("traktClientId", "abc\ndef"), false, "not a secret-shaped name");
});

test("Connect-only keys and a mask-prefixed secret are refused before the type check", async () => {
  assert.deepEqual(await check("plexAdminEmail", "a@b.c"), {
    ok: false, rejection: { error: 'apiAdmin.settings.plexConnectOnly {"key":"plexAdminEmail"}' },
  });
  assert.deepEqual(await check("radarrApiKey", `${R.MASKED_VALUE}pasted`), {
    ok: false, rejection: { error: 'apiAdmin.settings.maskedPlaceholder {"key":"radarrApiKey"}' },
  });
});

test("the normalizing checks return the value to store", async () => {
  const hex = "ab".repeat(32);
  assert.deepEqual(await check("discordPublicKey", `${hex}\n`), { ok: true, value: hex });
  assert.deepEqual(await check("statsTimeZone", "asia/tokyo"), { ok: true, value: "Asia/Tokyo" });
  assert.equal((await check("statsTimeZone", "Antarctica/Troll")).ok, false, "a zone Postgres lacks");
  assert.equal((await check("statsTimeZone", "+05:00")).ok, false, "a bare offset");
});

// ── a whole body ─────────────────────────────────────────────────────────────

test("a body is checked in its own order, and the first problem is the answer", async () => {
  const first = await R.checkSubmittedSettings({ smtpPort: "x", maintenanceEnabled: 1 }, new Map(), deps);
  assert.deepEqual(first, { ok: false, rejection: { error: 'apiAdmin.settings.intRange {"key":"smtpPort","min":1,"max":65535}' } });
  const second = await R.checkSubmittedSettings({ maintenanceEnabled: 1, smtpPort: "x" }, new Map(), deps);
  assert.deepEqual(second, { ok: false, rejection: { error: 'apiAdmin.settings.mustBeString {"key":"maintenanceEnabled"}' } });
  const long = await R.checkSubmittedSettings({ motdBody: "x".repeat(5001) }, new Map(), deps);
  assert.deepEqual(long, { ok: false, rejection: { error: 'apiAdmin.settings.tooLong {"key":"motdBody","max":5000}' } });
});

test("a blank, the mask and a resent stored value skip the per-key rules; unknown keys are ignored", async () => {
  const stored = new Map([["donationVenmo", "http://legacy.example.com"]]);
  const result = await R.checkSubmittedSettings(
    { donationVenmo: "http://legacy.example.com", radarrApiKey: R.MASKED_VALUE, smtpPort: "", notASetting: 5, discordPublicKey: ` ${"cd".repeat(32)} ` },
    stored,
    deps,
  );
  assert.ok(result.ok);
  assert.deepEqual([...result.values], [
    ["donationVenmo", "http://legacy.example.com"],
    ["radarrApiKey", R.MASKED_VALUE],
    ["smtpPort", ""],
    ["discordPublicKey", "cd".repeat(32)],
  ]);
});

test("what a checked body stores: no mask, blanks only where clearable, sanitized copy, ignored blanks reported", () => {
  const stored = new Map([["smtpHost", "mail.example.com"], ["quotaLimit", "5"]]);
  const values = new Map<string, string>([
    ["radarrApiKey", R.MASKED_VALUE],
    ["smtpHost", ""], // not clearable, and would replace a stored value
    ["smtpPassword", ""], // not clearable, nothing stored
    ["quotaLimit", ""], // clearable
    ["motdTitle", "<b>Hi</b>"],
  ]);
  const { submitted, ignored } = R.submittedSettings(values as never, stored);
  assert.deepEqual(ignored, ["smtpHost"]);
  assert.equal(submitted.has("radarrApiKey" as never), false);
  assert.equal(submitted.get("quotaLimit" as never), "");
  assert.notEqual(submitted.get("motdTitle" as never), "<b>Hi</b>", "user-facing copy goes through sanitizeText");
  assert.deepEqual(R.changedSettings(new Map([["quotaLimit", "5"], ["siteTitle", ""]]) as never, stored), [], "unchanged, and a blank over nothing");
});

test("GET presentation: secrets masked, URL credentials stripped, the rest as stored", () => {
  assert.equal(R.presentSettingValue("radarrApiKey", "secret"), R.MASKED_VALUE);
  assert.equal(R.presentSettingValue("radarrApiKey", ""), "");
  assert.equal(R.presentSettingValue("radarrUrl", "http://u:p@host:7878/"), "http://host:7878/");
  assert.equal(R.presentSettingValue("donationVenmo", "http://u:p@x/"), "http://u:p@x/", "not a server URL");
  assert.equal(R.presentSettingValue("siteTitle", "Home"), "Home");
});
