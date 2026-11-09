// Settings forms must not send a value the route can't store, nor report a save
// the route didn't make. The route half (blanks that clear, `ignored`, the mask
// check) is pinned in tests/settings-route.test.mts; these client components have
// no render harness in node:test, so their half is pinned on the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const form = (name: string) =>
  readFileSync(new URL(`../src/components/settings/forms/${name}`, import.meta.url), "utf8");

test("ApiKeySettingForm: the field starts empty — the mask is only a placeholder, so a pasted key can't land after it", () => {
  const src = form("api-key-setting-form.tsx");
  // As the field's VALUE, a key pasted with the caret at the end was saved as
  // "••••••••<key>" and stored as the credential.
  assert.match(src, /const \[apiKey, setApiKey\] = useState\(""\);/);
  assert.doesNotMatch(src, /useState\(initialApiKey\)/, "neither the field nor the saved baseline is seeded with the mask");
  assert.match(src, /const \[keyIsSet, setKeyIsSet\] = useState\(initialApiKey\.length > 0\);/, "a saved key is still known — Test checks it");
  assert.match(src, /placeholder=\{keyIsSet \? SECRET_MASK_SENTINEL : undefined\}/);
  assert.doesNotMatch(src, /"••••••••"/, "the mask comes from secret-mask.ts, never a local copy");
});

test("DiscordBotForm: a blank bot token is never sent (the route can't clear it) and the form says how to turn the bot off", async () => {
  const keys = form("discord-bot-keys.ts");
  const src = form("discord-bot-form.tsx");
  // The one diff Save sends (and the dirty flag reads) drops a blank token.
  assert.match(keys, /current !== saved\[key\] && !\(key === "discordBotToken" && current === ""\)/);
  const save = src.slice(src.indexOf("async function handleSave"), src.indexOf("// A labelled text input"));
  assert.match(save, /const changed = pendingChanges\(values, saved\);/);
  assert.match(save, /const result = await save\(changed\);/);
  // The hint shows while the field is blank over a saved token.
  assert.match(src, /\{values\.discordBotToken === "" && tokenSaved && \(\s*<p[^>]*>\{t\("settings\.form\.discord\.botTokenKept"\)\}<\/p>/);
  // Removal is its own explicit action: a confirmed button sends the one blank.
  assert.match(src, /async function handleRemoveToken\(\) \{[\s\S]*?await save\(\{ discordBotToken: "" \}\);/);
  const { discordFormInitial, pendingChanges, DISCORD_KEYS } = await import("../src/components/settings/forms/discord-bot-keys.ts");
  const initial = discordFormInitial({ discordBotToken: "real-token", discordClientId: "1", discordRequireLinkedAccount: "true" });
  // The token never reaches the browser, not even as the mask: only whether one is saved.
  assert.equal(initial.values.discordBotToken, "");
  assert.equal(initial.tokenSaved, true);
  assert.equal(initial.values.discordRequireLinkedAccount, "true");
  assert.equal(initial.values.discordRequireLinkedAccountSite, "false");
  assert.equal(initial.values.discordGuildId, "");
  assert.deepEqual(Object.keys(initial.values), [...DISCORD_KEYS], "every key, once");
  assert.equal(discordFormInitial({}).tokenSaved, false);
  assert.deepEqual(pendingChanges({ ...initial.values, discordGuildId: "9" }, initial.values), { discordGuildId: "9" });
  assert.deepEqual(pendingChanges(initial.values, initial.values), {});
});

// The settings page reads exactly the keys the form edits: one list.
test("DiscordBotForm: the settings page builds the form from the one key list", () => {
  const tab = readFileSync(new URL("../src/app/(app)/settings/_tabs/notifications-tab.tsx", import.meta.url), "utf8");
  assert.match(tab, /\.\.\.DISCORD_KEYS,/);
  assert.match(tab, /<DiscordBotForm \{\.\.\.discordFormInitial\(cfg\)\} \/>/);
  assert.doesNotMatch(tab, /initialBotToken/);
});

// An edit during Save & Test flipped "saving" to "idle" and re-enabled Save, so
// a second click sent a second test email.
test("EmailForm: the SMTP port is a bounded number and Save waits for a valid one; edits go through the shared saver", async () => {
  const src = form("email-form.tsx");
  assert.match(src, /id="smtp-port"\s+type="number"\s+inputMode="numeric"\s+min=\{1\}\s+max=\{65535\}/);
  assert.match(src, /const portValid = \/\^\\d\+\$\/\.test\(port\) && Number\(port\) >= 1 && Number\(port\) <= 65535;/);
  assert.match(src, /backend === "smtp" \? Boolean\(host\) && portValid :/);
  assert.match(src, /const \{ status, message, save, edited \} = useSettingsSave\(\);/);
  assert.doesNotMatch(src, /setStatus\(/, "no hand-rolled status");
  assert.doesNotMatch(src, /useState\(initialPassword\)|useState\(initialResendApiKey\)/, "a secret field never starts as the mask");
  const { emailSaveBody, ignoredKeys } = await import("../src/components/settings/forms/email-form-body.ts");
  const base = { backend: "smtp" as const, host: "h", port: "587", user: "u", password: "", from: "f", resendApiKey: "", resendFrom: "r" };
  assert.deepEqual(emailSaveBody(base), { emailBackend: "smtp", smtpHost: "h", smtpPort: "587", smtpUser: "u", smtpFrom: "f" },
    "a blank password over a saved one is not sent: it is kept");
  assert.equal(emailSaveBody({ ...base, password: "p" }).smtpPassword, "p");
  assert.deepEqual(emailSaveBody({ ...base, backend: "resend" }), { emailBackend: "resend", resendFrom: "r" });
  // The route answers what it left unchanged; the form says so instead of a bare "Saved".
  assert.deepEqual(ignoredKeys({ ok: true, ignored: ["smtpHost", 3] }), ["smtpHost"]);
  assert.deepEqual(ignoredKeys({ ok: true }), []);
  assert.match(src, /setIgnored\(ignoredKeys\(result\.data\)\);/);
});

test("DeletionVoteThresholdForm: the input carries the route's 0–10000 range and the error is set only by a failure", () => {
  const src = form("deletion-vote-threshold-form.tsx");
  assert.match(src, /min="0"\s+max="10000"/);
  // The message is the shared save's, which only a failure writes
  // (tests/settings-save.test.mts); the form keeps no error of its own.
  assert.match(src, /const \{ status, message, save, edited \} = useSettingsSave\(\);/);
  assert.doesNotMatch(src, /setError\(|useState\(""\)/);
  assert.match(src, /errorLabel=\{message \|\| t\("settings\.form\.common\.saveFailed"\)\}/);
});
