// Settings forms: what a save in flight, a slow library load, a failed action
// or a missing secret does to the form. These are client components the
// node:test loader can't render, so the pins read the source (the same idiom as
// tests/settings-forms-save-state.test.mts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(`../src/components/settings/${rel}`, import.meta.url), "utf8");
const count = (src: string, re: RegExp) => src.match(new RegExp(re.source, "g"))?.length ?? 0;

// ── an edit during a save ────────────────────────────────────────────────────

// Every settings form whose Save PATCHes /api/settings goes through
// useSettingsSave (forms/shared.ts). Its state machine carries the rule, pinned
// in tests/settings-save.test.mts: an edit while a save is in flight keeps
// Save locked, and the answer doesn't call the unsent edit "Saved". What a form
// must do is route every field edit through edited().
const SAVE_FORMS = [
  "forms/maintenance-form.tsx",
  "play-history-settings.tsx",
  "watch-grade-settings.tsx",
  "forms/motd-form.tsx",
  "forms/quota-form.tsx",
  "forms/rate-limit-form.tsx",
  "forms/session-form.tsx",
  "forms/site-title-form.tsx",
  "forms/site-url-form.tsx",
  "forms/webhook-secret-form.tsx",
  "forms/library-match-form.tsx",
  "forms/donation-form.tsx",
  "forms/audit-retention-form.tsx",
  "forms/deletion-vote-threshold-form.tsx",
  "forms/ios-push-relay-form.tsx",
  "forms/mdblist-plan-form.tsx",
];

// A handler that doesn't call edited() itself hands the value to one that does.
const DELEGATED: Record<string, RegExp> = {
  "watch-grade-settings.tsx": /^onChange=\{\((e|value)\) => set\(field, (e\.target\.)?value\)\}$/,
  "forms/library-match-form.tsx": /^onChange=\{\(e\) => onChangePrefix\(e\.target\.value\)\}$/,
};

test("an edit while a save is in flight keeps Save locked, and the answer doesn't call unsent edits saved", () => {
  for (const file of SAVE_FORMS) {
    const src = read(file);
    assert.match(src, /= useSettingsSave\((4000)?\);/, file);
    // No form keeps its own copy of the save: no status state, no PATCH of its
    // own, no fade timer, no bare reset that drops a save in flight to idle.
    assert.doesNotMatch(src, /useState<SaveStatus>/, file);
    assert.doesNotMatch(src, /fetch\(withBasePath\("\/api\/settings"\)/, file);
    assert.doesNotMatch(src, /setTimeout\(/, file);
    assert.doesNotMatch(src, /set\w*Status\("idle"\)/, file);
    // Every field edit says so.
    const handlers = src.match(/on(?:Change|CheckedChange)=\{[^\n]*|onClick=\{\(\) => \{ set[^\n]*/g) ?? [];
    assert.ok(handlers.length > 0, `${file}: its edit handlers were found`);
    for (const h of handlers) {
      assert.ok(/\bedited\(\);/.test(h) || DELEGATED[file]?.test(h.trim()), `${file}: ${h.trim()} must call edited()`);
    }
  }
  // The delegates call it.
  assert.match(read("watch-grade-settings.tsx"), /function set\(field: Field, value: string\) \{\s*setValues\([^\n]*\);\s*edited\(\);\s*\}/);
  const match = read("forms/library-match-form.tsx");
  assert.match(match, /const onChangePrefix = \(key: PrefixKey\) => \(value: string\) => \{ setPrefixes\([^\n]*\);\s*edited\(\); \};/);
  assert.equal(count(match, /onChange(Movie|Tv)Prefix=\{onChangePrefix\("\w+"\)\}/), 4);
});

test("the library pickers' boxes are edits too: a box ticked during a save isn't reported as saved", () => {
  // One picker for both servers (forms/media-server-library.tsx).
  const src = read("forms/media-server-library.tsx");
  assert.match(src, /const \{ status: saveStatus, message: \w+, save, edited \} = useSettingsSave\(\);/);
  assert.match(src, /function toggle\(id: string\) \{\s*edited\(\);/);
  assert.match(src, /const result = await save\(\{ \[service === "plex" \? "plexLibraries" : "jellyfinLibraries"\]: value \}\);\s*if \(result\.ok\) \{/);
  for (const [file, service] of [["forms/plex-connect-form.tsx", "plex"], ["forms/jellyfin-sync-form.tsx", "jellyfin"]] as const) {
    assert.match(read(file), new RegExp(`<LibraryPicker\\s+service="${service}"`), file);
  }
});

test("a save is 'Saved' only when the route said ok: true", () => {
  // The shared helper's rule (tests/settings-save.test.mts); the forms that
  // still read their own answer use the same predicate.
  const dir = new URL("../src/components/settings/", import.meta.url);
  const files = [
    ...["play-history-settings.tsx", "watch-grade-settings.tsx", "features-form.tsx"],
    ...readdirSync(new URL("forms/", dir)).filter((f) => f.endsWith(".tsx")).map((f) => `forms/${f}`),
  ];
  for (const file of files) {
    const src = read(file);
    assert.doesNotMatch(src, /data\.ok !== false|body\.ok !== false|data\.ok === false/, `${file}: a 2xx without ok: true is not a save`);
  }
  // The server forms' Save & Test PATCHes through the shared helper, whose
  // `ok` is settingsPatchSucceeded.
  const media = read("forms/media-server-library.tsx");
  assert.match(media, /const saved = await patchSettings\(body\);/);
  assert.match(media, /if \(!saved\.ok\) \{/);
  for (const file of ["forms/plex-connect-form.tsx", "forms/jellyfin-sync-form.tsx", "forms/api-key-setting-form.tsx", "forms/arr-form.tsx", "forms/email-form.tsx", "forms/discord-bot-form.tsx"]) {
    assert.doesNotMatch(read(file), /fetch\(withBasePath\("\/api\/settings"\)/, file);
  }
  assert.match(read("forms/api-key-setting-form.tsx"), /const result = await patchSettings\(\{ \[settingKey\]: value \}\);\s*if \(!result\.ok\) \{/);
});

// ── switches that save on flip ────────────────────────────────────────────────

const TOGGLES = [
  "forms/request-4k-all-toggle.tsx",
  "forms/enable-user-emails-toggle.tsx",
  "forms/require-admin-mfa-toggle.tsx",
  "forms/jellyfin-restrict-sign-in-toggle.tsx",
  "forms/plex-watchlist-server-toggles.tsx",
  "forms/disable-local-login-toggle.tsx",
  "forms/enable-machine-session-toggle.tsx",
];

test("every save-on-flip switch is the one shared toggle: locked while saving, flipped back on a refusal, announced", () => {
  const shared = read("forms/setting-toggle.tsx");
  // Flip at once, flip back when the save didn't land.
  assert.match(shared, /const prev = value;\s*setValue\(next\);\s*const result = await save\(\{ \[settingKey\]: next \? "true" : "false" \}\);\s*if \(!result\.ok\) setValue\(prev\);/);
  // One save at a time.
  assert.match(shared, /disabled=\{disabled \?\? status === "saving"\}/);
  // Success and failure both go through the live region (SaveStatusMessage).
  assert.match(shared, /\{status === "ok" && <SaveStatusMessage status="ok" \/>\}/);
  assert.match(shared, /<SaveStatusMessage status="error" errorLabel=\{message \|\| t\("settings\.form\.common\.saveFailed"\)\} \/>/);
  for (const file of TOGGLES) {
    const src = read(file);
    assert.match(src, /from "\.\/setting-toggle";/, file);
    assert.doesNotMatch(src, /<CheckCircle/, `${file}: no bare success icon`);
    // No switch keeps its own PATCH, timer or status.
    assert.doesNotMatch(src, /fetch\(|setTimeout\(|useState<SaveStatus>/, file);
  }
  // The machine-session IP list saves through the shared hook too.
  const machine = read("forms/enable-machine-session-toggle.tsx");
  assert.match(machine, /const ips = useSettingsSave\(\);/);
  assert.match(machine, /onChange=\{\(e\) => \{ setAllowedIps\(e\.target\.value\); ips\.edited\(\); \}\}/);
  assert.match(machine, /<SaveStatusMessage status=\{ips\.status\}/);
  // Turning local login off still asks first, and can't start without another sign-in.
  const local = read("forms/disable-local-login-toggle.tsx");
  assert.match(local, /if \(disabled\) void save\(false\);\s*else setConfirming\(true\);/);
  assert.match(local, /disabled=\{toggle\.status === "saving" \|\| confirming \|\| \(!disabled && !externalSignInConfigured\)\}/);
  // The MFA override note stays part of the switch's description.
  assert.match(read("forms/require-admin-mfa-toggle.tsx"), /help=\{\s*<>\s*\{t\("settings\.form\.requireAdminMfa\.help"\)\}\s*\{envOverride && \(/);
});

test("the OIDC allowlist locks its controls while a save is in flight (its answer rewrites every field)", () => {
  const src = read("forms/oidc-allowlist-form.tsx");
  assert.match(src, /const saving = status === "saving";/);
  // Both text boxes, the claim input and both switches.
  assert.equal(count(src, /disabled=\{saving\}/), 5);
  assert.equal(count(src, /<(Textarea|Input|Switch)\b/), 5);
});

test("play history and watch grades announce the result through the shared live-region line", () => {
  for (const file of ["play-history-settings.tsx", "watch-grade-settings.tsx"]) {
    const src = read(file);
    assert.match(src, /<SaveStatusMessage status=\{status\} errorLabel=\{message \|\| undefined\} \/>/, file);
    assert.doesNotMatch(src, /<CheckCircle/, `${file}: no bare success icon`);
    // A failure with no reason from the route still says what happened: the
    // one shared wording (forms/shared.ts, tests/settings-save.test.mts).
    assert.match(src, /saveFailureText\(t\)/, file);
  }
  assert.match(read("forms/shared.ts"), /r\.status === 0 \? t\("settings\.common\.networkError"\) : t\("settings\.common\.saveFailedStatus", \{ status: r\.status \}\)/);
  assert.match(read("play-history-settings.tsx"), /\n {4}\}, failureText\);/);
  assert.match(read("watch-grade-settings.tsx"), /await save\(fields, saveFailureText\(t\)\);/);
});

test("the OIDC allowlist announces a save through the live region", () => {
  const src = read("forms/oidc-allowlist-form.tsx");
  assert.match(src, /\{status === "ok" && <SaveStatusMessage status="ok" \/>\}/);
  assert.doesNotMatch(src, /<CheckCircle/);
});

// ── library loads ─────────────────────────────────────────────────────────────

test("only the newest library load writes state, and an overtaken Save & Test reports the newest load", () => {
  // One loader for both servers (forms/media-server-library.tsx).
  const src = read("forms/media-server-library.tsx");
  const load = src.slice(src.indexOf("const loadLibraries = useCallback"), src.indexOf("}, [service]);", src.indexOf("const loadLibraries = useCallback")));
  assert.match(load, /const seq = \+\+loadSeq\.current;/);
  // Every state write after the await is guarded.
  assert.equal(count(load, /if \(superseded\(\)\) return \{ ok: false, count: 0, superseded: true \};/), 1);
  assert.equal(count(load, /await /), 1, "one await, checked right after");
  // A newer load aborts the older one.
  assert.match(load, /inFlight\.current\?\.abort\(\);/);
  // An overtaken Save & Test reports the newest load instead of leaving its spinner up.
  assert.match(src, /latestLoad\.current = load;\s*return load;/);
  // It follows a newer load only while there is one it has not already awaited: after an
  // unmount the newest load is itself superseded, and re-awaiting it would loop forever.
  assert.match(src, /let result = await loadLibraries\(\);[\s\S]{0,700}?while \(result\.superseded && latestLoad\.current && latestLoad\.current !== awaited\) \{\s*awaited = latestLoad\.current;\s*result = await awaited;/);
  // An answer that isn't a library list is the load error, never a render crash.
  assert.match(load, /const listed = res\.ok \? parseLibraryItems\(service, res\.data\) : null;/);
  for (const file of ["forms/plex-connect-form.tsx", "forms/jellyfin-sync-form.tsx"]) {
    assert.match(read(file), /= useLibraryLoader\("(plex|jellyfin)", /, file);
  }
});

test("Save & Test: an edit while it runs keeps it locked and its answer doesn't call the edited fields Connected", () => {
  const src = read("forms/media-server-library.tsx");
  assert.match(src, /setStatus\(\(s\) => \(s === "saving" \|\| s === "testing" \? s : "idle"\)\);/);
  assert.match(src, /if \(editSeq\.current !== sentAt\) \{[\s\S]{0,160}?setStatus\("idle"\);/);
  // The Connected line's fade is tracked, and cleared when a new one starts.
  assert.match(src, /idleTimer\.current = setTimeout\(/);
  assert.match(src, /async function saveAndTest[\s\S]*?if \(idleTimer\.current\) clearTimeout\(idleTimer\.current\);/);
  for (const file of ["forms/plex-connect-form.tsx", "forms/jellyfin-sync-form.tsx"]) {
    const form = read(file);
    assert.doesNotMatch(form, /setTimeout\(/, file);
    assert.doesNotMatch(form, /set(Server|Save)Status\(/, `${file}: field edits go through edited()`);
    assert.match(form, /server\.edited\(\);/, file);
  }
});

test("the full import runs as a background job and shows the route's reason when it fails", () => {
  const src = read("forms/media-server-library.tsx");
  assert.match(src, /runLibraryImport\(withBasePath\(`\/api\/sync\/\$\{service\}`\), signal\)/);
  assert.match(src, /\{ ifBusy: "skip" \}/);
  assert.match(src, /\{state\.error \|\| failedText\}/);
  assert.match(read("forms/plex-connect-form.tsx"), /<LibraryImportResult state=\{importer\.state\} failedText=\{t\("settings\.form\.plex\.importFailed"\)\} \/>/);
  assert.match(read("forms/jellyfin-sync-form.tsx"), /<LibraryImportResult state=\{sync\.state\} failedText=\{t\("settings\.form\.jellyfin\.syncFailed"\)\} \/>/);
});

test("Plex: Import and the picker follow the SAVED server URL, not the field (guardrail 36)", () => {
  const src = read("forms/plex-connect-form.tsx");
  assert.match(src, /const \[savedServerUrl, setSavedServerUrl\] = useState\(initialServerUrl\);/);
  assert.match(src, /if \(stored\) setSavedServerUrl\(sent\);/);
  assert.match(src, /\{savedServerUrl && \(/);
  assert.doesNotMatch(src, /\{serverUrl && \(/);
});

// ── Discord ───────────────────────────────────────────────────────────────────

test("Discord tabs: every aria-controls names the one panel that exists", () => {
  const src = read("forms/discord-bot-form.tsx");
  assert.match(src, /aria-controls="discord-panel"/);
  assert.match(src, /role="tabpanel" id="discord-panel" aria-labelledby=\{`discord-tab-\$\{tab\}`\}/);
  assert.doesNotMatch(src, /aria-controls=\{`discord-panel-/);
});

test("Discord: Register Commands and Sync Roles wait while the form holds unsaved edits", () => {
  const src = read("forms/discord-bot-form.tsx");
  assert.match(src, /const dirty = Object\.keys\(pendingChanges\(values, saved\)\)\.length > 0;/);
  assert.equal(count(src, /blocked=\{dirty\}/), 2);
  assert.match(src, /disabled=\{status === "loading" \|\| blocked\}/);
  assert.match(src, /\{dirty && \(\s*<p[^>]*>\{t\("settings\.form\.discord\.saveFirst"\)\}<\/p>/);
});

test("Discord: an action's answer is read with a JSON fallback and a non-JSON failure shows its HTTP status", () => {
  const src = read("forms/discord-bot-form.tsx");
  assert.equal(count(src, /await res\.json\(\)(?!\.catch)/), 0, "no bare res.json()");
  assert.match(src, /t\("settings\.form\.common\.requestFailedHttp", \{ status: res\.status \}\)/);
});

// ── webhook URLs ──────────────────────────────────────────────────────────────

test("webhook URLs: a row with no secret is a placeholder, never a Copy that can only fail", () => {
  const src = read("forms/webhook-urls.tsx");
  for (const service of ["Radarr", "Sonarr"]) {
    assert.match(
      src,
      new RegExp(`\\{${service.toLowerCase()}TokenSet\\s*\\? <CopyRow[^\\n]*\\n\\s*: <SecretNeededRow label=\\{label\\("${service}"\\)\\} message=\\{t\\("settings\\.form\\.webhookUrls\\.secretNeededFor", \\{ service: "${service}" \\}\\)\\} />\\}`),
      service,
    );
  }
  // A secret removed since the page rendered reads as "none", not "try again".
  assert.match(src, /: \{ kind: "none" \};/);
  assert.match(src, /\{problem === "none" && <p[^>]*>\{t\("settings\.form\.webhookUrls\.noSecret"\)\}<\/p>\}/);
});

test("webhook URLs: the copy timers are tracked and a blocked clipboard shows the whole URL until dismissed", () => {
  const src = read("forms/webhook-urls.tsx");
  assert.doesNotMatch(src, /copyUrl\?/, "the unused static copyUrl prop is gone");
  assert.match(src, /copiedTimer\.current = setTimeout\(/);
  assert.match(src, /problemTimer\.current = setTimeout\(/);
  assert.doesNotMatch(src, /setTimeout\(\(\) => setRevealed/, "the revealed URL no longer vanishes on a timer");
  assert.match(src, /<input\s+readOnly\s+autoFocus\s+value=\{revealed\}/);
  // The token is still fetched on every click, and rides the ?token= query (guardrail 2).
  assert.match(src, /result = await resolveCopyUrl\(\);/);
  assert.match(src, /url: `\$\{base\}\?token=\$\{encodeURIComponent\(tok\)\}`/);
  // Only a string token builds a URL (the answer is checked: a record of string | null),
  // and a resolver that throws is shown as a failed fetch, not an unhandled rejection.
  assert.match(src, /const WEBHOOK_TOKENS = v\.record\(v\.nullable\(v\.string\(\)\)\);/);
  assert.match(src, /typeof tok === "string" && tok \? \{ kind: "url"/);
  assert.match(src, /result = await resolveCopyUrl\(\);\s*\} catch \{[\s\S]{0,120}?result = \{ kind: "error" \};/);
});
