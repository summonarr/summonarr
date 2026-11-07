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

test("DiscordBotForm: a blank bot token is never sent (the route can't clear it) and the form says how to turn the bot off", () => {
  const src = form("discord-bot-form.tsx");
  const save = src.slice(src.indexOf("async function handleSave"), src.indexOf("return (\n"));
  assert.match(save, /current !== saved\[key\] && !\(key === "discordBotToken" && current === ""\)/);
  // The hint shows while the field is blank over a saved token.
  assert.match(src, /\{botToken === "" && tokenSaved && \(\s*<p[^>]*>\{t\("settings\.form\.discord\.botTokenKept"\)\}<\/p>/);
});

test("EmailForm: the SMTP port is a bounded number and Save waits for a valid one; the Saved line fades", () => {
  const src = form("email-form.tsx");
  assert.match(src, /id="smtp-port"\s+type="number"\s+inputMode="numeric"\s+min=\{1\}\s+max=\{65535\}/);
  assert.match(src, /const portValid = \/\^\\d\+\$\/\.test\(port\) && Number\(port\) >= 1 && Number\(port\) <= 65535;/);
  assert.match(src, /backend === "smtp" \? Boolean\(host\) && portValid :/);
  assert.match(src, /okTimer\.current = setTimeout\(\(\) => setStatus\(\(s\) => \(s === "ok" \? "idle" : s\)\), 3000\);/);
});

test("DeletionVoteThresholdForm: the input carries the route's 0–10000 range and the error is set only by a failure", () => {
  const src = form("deletion-vote-threshold-form.tsx");
  assert.match(src, /min="0"\s+max="10000"/);
  assert.match(src, /const \[error, setError\] = useState\(""\);/);
  const okBranch = src.match(/if \(res\.ok && data\.ok !== false\) \{([\s\S]*?)\} else \{/);
  assert.ok(okBranch, "success branch not found");
  assert.doesNotMatch(okBranch[1], /setError\(/, "a success never writes an error message");
});
