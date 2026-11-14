// The TRaSH admin cards' shapes (src/components/admin/trash-guides/types.ts):
// the sync switches' one table, the runtime checks of what the routes answer,
// and which Profile Library rows an Apply can take (starter-pack-select.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  APPLY_RESULT,
  SPEC_DETAIL_ANSWER,
  SPEC_STATUS_ANSWER,
  STARTER_PACK_ANSWER,
  TRASH_SYNC_TOGGLES,
  sameTrashSettings,
  trashSettingsPatch,
  type TrashSettings,
} from "../src/components/admin/trash-guides/types.ts";
import { appliableStarterItems, mergeStarterSelection } from "../src/components/admin/trash-guides/starter-pack-select.ts";
import { STARTER_PACK } from "../src/lib/trash-recommendations.ts";
import { check } from "../src/lib/validate.ts";

const read = (f: string) => readFileSync(new URL(`../src/components/admin/trash-guides/${f}`, import.meta.url), "utf8");
const all: TrashSettings = { enabled: true, syncCustomFormats: false, syncCustomFormatGroups: true, syncQualityProfiles: false, syncNaming: true, syncQualitySizes: false };

test("every sync switch saves under its own Setting, and the table covers every switch", () => {
  assert.deepEqual(trashSettingsPatch(all), {
    trashGuidesEnabled: "true",
    trashSyncCustomFormats: "false",
    trashSyncCustomFormatGroups: "true",
    trashSyncQualityProfiles: "false",
    trashSyncNaming: "true",
    trashSyncQualitySizes: "false",
  });
  assert.deepEqual(trashSettingsPatch({ syncNaming: false }), { trashSyncNaming: "false" }, "only what changed");
  assert.deepEqual(TRASH_SYNC_TOGGLES.map((r) => r.field).sort(), Object.keys(all).sort());
  // The settings page reads the same keys.
  const page = readFileSync(new URL("../src/app/(app)/admin/trash-guides/settings/page.tsx", import.meta.url), "utf8");
  for (const { settingKey } of TRASH_SYNC_TOGGLES) assert.ok(page.includes(`"${settingKey}"`), settingKey);
});

test("the Settings card follows the stored switches the page hands it after a refresh", () => {
  assert.equal(sameTrashSettings(all, { ...all }), true);
  assert.equal(sameTrashSettings(all, { ...all, syncNaming: false }), false);
  const card = read("sync-settings-card.tsx");
  assert.match(card, /if \(!sameTrashSettings\(serverSettings, initialSettings\)\) \{\s*setServerSettings\(initialSettings\);\s*setSettings\(initialSettings\);\s*\}/);
  assert.match(card, /TRASH_SYNC_TOGGLES\.map\(/, "the rows come from the table");
  assert.match(card, /saver\.save\(trashSettingsPatch\(change\)\)/, "and so does the PATCH body");
});

test("the token card is told on the server whether a token is stored, and fetches nothing to know", () => {
  const card = read("github-token-card.tsx");
  assert.match(card, /tokenConfigured: boolean;/);
  assert.doesNotMatch(card, /\bfetch(Json)?\(/);
  const page = readFileSync(new URL("../src/app/(app)/admin/trash-guides/settings/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<GithubTokenCard tokenConfigured=\{Boolean\(map\.trashGithubToken\)\} \/>/);
});

test("the starter pack's answer — curated list, derived rows, the schema-behind fallback — passes its check", () => {
  const fallback = { items: STARTER_PACK.map((item) => ({ item, spec: null, application: null })), schemaDiagnostic: "run prisma db push" };
  const readBack = check(STARTER_PACK_ANSWER, fallback);
  assert.ok(readBack.ok, readBack.ok ? "" : readBack.error);
  assert.ok(readBack.ok && !("match" in readBack.value.items![0].item), "the matcher stays server-side");
  const derived = { item: { service: "SONARR", kind: "QUALITY_SIZE", label: "TV: x", rationale: "r", labelKey: "k", labelVars: { name: "x" }, recommended: false },
    spec: { id: "s", name: "x", trashId: "t" }, application: { enabled: true, appliedAt: null, lastError: "400" } };
  assert.ok(check(STARTER_PACK_ANSWER, { items: [derived] }).ok);
  assert.equal(check(STARTER_PACK_ANSWER, { items: [{ ...derived, spec: { id: 1 } }] }).ok, false);
});

test("status, detail and apply answers pass their checks; a malformed spec is refused", () => {
  const spec = { id: "s1", service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "t", name: "x265", description: null, fetchedAt: "2026-08-01T00:00:00Z",
    application: { id: "a", enabled: false, remoteId: null, appliedAt: null, lastError: null, lastErrorAt: null, errorCount: 0 } };
  assert.ok(check(SPEC_STATUS_ANSWER, { service: "RADARR", variant: "", specs: [spec] }).ok);
  assert.ok(check(SPEC_STATUS_ANSWER, { service: "RADARR", variant: "", specs: [], schemaDiagnostic: "x" }).ok);
  assert.equal(check(SPEC_STATUS_ANSWER, { specs: [{ ...spec, kind: "MOVIE" }] }).ok, false);
  assert.ok(check(SPEC_DETAIL_ANSWER, { ...spec, upstreamPath: "p", upstreamSha: null, payload: { trash_id: "t" } }).ok);
  assert.equal(check(SPEC_DETAIL_ANSWER, { ...spec, upstreamPath: "p", upstreamSha: null, payload: ["x"] }).ok, false);
  assert.ok(check(APPLY_RESULT, { specId: "s", kind: "NAMING", trashId: "default", name: "n", ok: false, error: "x", recreated: true }).ok);
});

test("an Apply only takes rows in the catalog on a configured service", () => {
  const row = (service: "RADARR" | "SONARR", id: string | null) => ({
    item: { service, kind: "QUALITY_PROFILE" as const, label: "l", rationale: "r", recommended: true },
    spec: id ? { id, name: id, trashId: id } : null, application: null,
  });
  const items = [row("RADARR", "r1"), row("RADARR", null), row("SONARR", "s1")];
  assert.deepEqual(appliableStarterItems(items, (s) => s === "RADARR").map((i) => i.spec.id), ["r1"]);
  assert.deepEqual(appliableStarterItems(items, () => true).map((i) => i.spec.id), ["r1", "s1"]);
  const card = read("starter-pack-card.tsx");
  assert.match(card, /const appliable = useMemo\(\(\) => appliableStarterItems\(items, serviceConfigured\), \[items, serviceConfigured\]\);/);
  assert.match(card, /const interactive = !!spec && configured;/, "an unconfigured service's row can't be ticked");
  assert.match(card, /init: jsonInit\("POST", \{ specIds: toApply \}\)/, "Apply sends only appliable ticks");
});

test("the not-configured banner places its Settings link where the translation puts {settings}", () => {
  const banner = read("not-configured-banner.tsx");
  assert.match(banner, /rich\(t\("trash\.notConfigured", \{ service: [^}]*\}\), \{\s*settings: <Link /);
  assert.doesNotMatch(banner, /\\u0000|split\(/, "no placeholder splitting of its own");
});

test("starter-pack loads never land out of order: a newer load drops the one before it", () => {
  const card = read("starter-pack-card.tsx");
  assert.match(card, /const res = await action\.run\("load", \(signal\) =>/, "one key: a new load aborts the last (useAsyncAction's restart)");
  assert.match(card, /if \(!res \|\| \(!res\.ok && res\.kind === "aborted"\)\) return;/, "a dropped load writes nothing");
});

test("no non-null assertion stands in for a branch the code already took", () => {
  for (const f of ["spec-section.tsx", "starter-pack-card.tsx", "starter-pack-select.ts"]) {
    assert.doesNotMatch(read(f), /\.application!|\.spec!/, f);
  }
});

test("a changed appliable set keeps the admin's picks and ticks only a newly recommended spec", () => {
  const set = (...ids: string[]) => new Set(ids);
  // First arrival: nothing seen yet, so the recommended ones are ticked.
  assert.deepEqual([...mergeStarterSelection(set(), set(), ["a", "b"], ["a"])], ["a"]);
  // A newcomer joins; the admin's untick of "a" and tick of "b" survive.
  assert.deepEqual([...mergeStarterSelection(set("b"), set("a", "b"), ["a", "b", "c"], ["a", "c"])].sort(), ["b", "c"]);
  // A spec that left is dropped from the ticks.
  assert.deepEqual([...mergeStarterSelection(set("a", "b"), set("a", "b"), ["a"], ["a"])], ["a"]);
  const card = read("starter-pack-card.tsx");
  assert.match(card, /mergeStarterSelection\(prev, seen, resolvedIds, recommendedIds\)/);
});

test("a 200 that carries the db-push hint is a failed load on every card, never an empty catalog", () => {
  // The check keeps the hint (v.object drops undeclared keys).
  const status = check(SPEC_STATUS_ANSWER, { specs: [], schemaDiagnostic: "run prisma db push" });
  assert.ok(status.ok && status.value.schemaDiagnostic === "run prisma db push");
  // The spec tabs show it as the load error instead of "No specs pulled yet".
  assert.match(read("spec-section.tsx"), /if \(res\.ok && res\.data\.schemaDiagnostic\) \{[\s\S]*?setSpecs\(\[\]\);\s*setLoadError\(res\.data\.schemaDiagnostic\);/);
  // The Overview KPIs show "—", not zeros.
  assert.match(read("overview-kpis.tsx"), /const unreadable = !res\.ok \|\| res\.data\.schemaDiagnostic !== undefined;[\s\S]*?setFailed\(unreadable\);/);
  // The starter pack keeps its curated list and raises the banner with the hint.
  assert.match(read("starter-pack-card.tsx"), /const hint = res\.data\.schemaDiagnostic;\s*setLoadError\(hint \? \{ errors: \[\], schemaDiagnostic: hint \} : null\);/);
});

test("the pause/resume button's accessible name says what pressing it does, not only the current state", () => {
  const spec = read("spec-section.tsx");
  assert.match(spec, /aria-label=\{app\.enabled\s*\? `\$\{t\("trash\.spec\.status\.managed"\)\} — \$\{t\("trash\.spec\.pauseTitle"\)\}`\s*: `\$\{t\("trash\.spec\.status\.paused"\)\} — \$\{t\("trash\.spec\.resumeTitle"\)\}`\}/);
});
