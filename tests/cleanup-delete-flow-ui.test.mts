// Pins for the shared cleanup delete flow and the Library cleanup page
// (src/components/admin/cleanup-delete.tsx, library-cleanup.tsx). The pure
// halves live in src/lib/cleanup-delete-plan.ts and are tested directly; the
// wiring inside the .tsx hooks — which the runner cannot load — is pinned by a
// structural scan of the source, the repo's pattern for client components.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arrTitleDiffers, cleanupExecuteBody, nextCleanupDraft } from "../src/lib/cleanup-delete-plan.ts";

const deleteSrc = readFileSync(new URL("../src/components/admin/cleanup-delete.tsx", import.meta.url), "utf8");
const pageSrc = readFileSync(new URL("../src/components/admin/library-cleanup.tsx", import.meta.url), "utf8");

// The body of `const <name> = useCallback(async (…) => { … }, [deps]);`.
function callbackBody(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = useCallback(`);
  assert.ok(start >= 0, `${name} callback present`);
  const end = src.indexOf("\n  }, [", start);
  assert.ok(end > start, `${name} callback ends`);
  return src.slice(start, end);
}

// ── C054: what the admin confirmed is what is sent ──────────────────────────

test("the execute body is exactly the plan's titles and count — never a skipped title, never anything else", () => {
  const plan = {
    targetCount: 3,
    reclaimableBytes: 9,
    items: [
      { tmdbId: 1, mediaType: "MOVIE" as const, title: "A", targets: [{ service: "radarr", instance: "", title: "A", sizeOnDisk: 4 }] },
      { tmdbId: 2, mediaType: "TV" as const, title: "B", targets: [{ service: "sonarr", instance: "", title: "B", sizeOnDisk: 5 }, { service: "sonarr", instance: "4k", title: "B", sizeOnDisk: 0 }] },
    ],
    skipped: [{ tmdbId: 3, mediaType: "MOVIE", title: "C", reason: "held" }],
  };
  assert.deepEqual(cleanupExecuteBody(plan, true), {
    items: [{ tmdbId: 1, mediaType: "MOVIE" }, { tmdbId: 2, mediaType: "TV" }],
    blacklist: true,
    confirmTargets: 3,
  });
  assert.equal(cleanupExecuteBody(plan, false).blacklist, false);
});

test("the hook's execute sends the plan through cleanupExecuteBody and never re-reads the live selection", () => {
  const exec = callbackBody(deleteSrc, "execute");
  assert.match(exec, /body: JSON\.stringify\(cleanupExecuteBody\(plan, blacklist\)\)/);
  assert.doesNotMatch(exec, /items\(\)/, "execute must not read the selection");
});

test("a dry-run answer is installed only while its generation is current, and every selection change bumps it", () => {
  const dry = callbackBody(deleteSrc, "dryRun");
  assert.match(dry, /const gen = \+\+planGen\.current;/);
  assert.match(dry, /if \(gen === planGen\.current\) setPlan\(next\);/);
  assert.doesNotMatch(dry, /setPlan\(\(await res\.json\(\)\)/, "the response is never installed unchecked");
  const clear = callbackBody(deleteSrc, "clearPlan");
  assert.match(clear, /planGen\.current\+\+;/);
  assert.match(deleteSrc, /return \{\n\s+plan,\n\s+clearPlan,/, "the returned clearPlan is the generation-bumping one");
  const exec = callbackBody(deleteSrc, "execute");
  assert.match(exec, /const gen = planGen\.current;/);
  assert.match(exec, /if \(fresh\?\.items && gen === planGen\.current\)/, "a 409's fresh plan for a changed selection is dropped");
});

// ── C056: a target the instance holds under another title is named ──────────

test("arrTitleDiffers ignores case, accents, punctuation and a trailing year; a different title is a difference", () => {
  assert.equal(arrTitleDiffers("Doctor Who", "Doctor Who (2005)"), false);
  assert.equal(arrTitleDiffers("Amélie", "amelie"), false);
  assert.equal(arrTitleDiffers("Marvel's Agents of S.H.I.E.L.D.", "Marvels Agents of SHIELD"), false);
  assert.equal(arrTitleDiffers("Show X", "Show Y"), true);
  assert.equal(arrTitleDiffers("Show X", ""), false, "no arr title, nothing to name");
  assert.equal(arrTitleDiffers("Show X", null), false);
  assert.equal(arrTitleDiffers("!!!", "???"), true, "all-punctuation titles fall back to a plain comparison");
});

test("the plan panel names a target's own title when it differs", () => {
  assert.match(deleteSrc, /arrTitleDiffers\(it\.title, tg\.title\)\s*\?\s*t\("adminManage\.cleanup\.plan\.targetAs", \{ instance, title: tg\.title, size \}\)/);
});

// ── C061: overlapping reloads and unsaved rule edits ────────────────────────

test("nextCleanupDraft keeps unsaved edits across a reload, follows fresh settings otherwise, and resets after a save", () => {
  const base = { days: 90, on: true };
  const edited = { days: 180, on: true };
  const fresh = { days: 90, on: false };
  assert.equal(nextCleanupDraft(edited, base, fresh, false), edited, "a dirty draft survives a protect/delete reload");
  assert.equal(nextCleanupDraft({ ...base }, base, fresh, false), fresh, "an unedited draft follows the fresh settings");
  assert.equal(nextCleanupDraft(edited, base, fresh, true), fresh, "the reload after the admin's own save resets");
  assert.equal(nextCleanupDraft(null, null, fresh, false), fresh, "the first load seeds the draft");
});

test("the page's load drops a superseded answer and merges the draft instead of overwriting it", () => {
  const load = callbackBody(pageSrc, "load");
  assert.match(load, /const seq = \+\+loadSeq\.current;/);
  assert.match(
    load,
    /const data = \(await res\.json\(\)\) as Report;\n\s+if \(seq !== loadSeq\.current\) return;\n\s+setReport\(data\);/,
    "the report is installed only after a sequence check that follows the body read",
  );
  assert.match(load, /setDraft\(\(d\) => nextCleanupDraft\(d, base, data\.settings, reset\)\);/);
  assert.doesNotMatch(load, /setDraft\(data\.settings\)/, "an unconditional draft reset discards unsaved edits");
  assert.match(pageSrc, /del\.clearPlan\(\);\n\s+await load\(\{ resetDraft: true \}\);/, "a rules save resets the draft on its reload");
});
