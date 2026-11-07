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

// ── the exact target set, not just its size ─────────────────────────────────

test("the execute body echoes the dry run's target-set fingerprint, and the hook keeps a 409's fresh one", () => {
  const plan = {
    targetCount: 1,
    targetsFingerprint: "f".repeat(64),
    items: [{ tmdbId: 1, mediaType: "MOVIE" as const }],
  };
  assert.deepEqual(cleanupExecuteBody(plan, true), {
    items: [{ tmdbId: 1, mediaType: "MOVIE" }],
    blacklist: true,
    confirmTargets: 1,
    confirmFingerprint: "f".repeat(64),
  });
  assert.equal("confirmFingerprint" in cleanupExecuteBody({ targetCount: 1, items: plan.items }, true), false, "an older server's plan sends only the count");
  const exec = callbackBody(deleteSrc, "execute");
  assert.match(exec, /setPlan\(\{ targetCount: fresh\.targetCount, targetsFingerprint: fresh\.targetsFingerprint, /, "a 409's fresh plan is confirmed against ITS set");
});

// ── the hook's callbacks keep their identity ────────────────────────────────

test("the hook reads items/onDeleted through refs updated after commit, so its callbacks aren't rebuilt every render", () => {
  assert.match(deleteSrc, /const items = useCallback\(\(\) => itemsRef\.current\(\), \[\]\);/);
  assert.match(deleteSrc, /const onDeleted = useCallback\(\(\) => onDeletedRef\.current\(\), \[\]\);/);
  const effect = /useEffect\(\(\) => \{\n\s+itemsRef\.current = opts\.items;\n\s+onDeletedRef\.current = opts\.onDeleted;\n\s+\}\);/;
  assert.match(deleteSrc, effect, "the refs follow the latest props in an effect");
  assert.equal(deleteSrc.split("itemsRef.current = ").length - 1, 1, "never written during render");
  assert.doesNotMatch(deleteSrc, /const \{ items, onDeleted \} = opts;/, "the per-render closures are not the callbacks' deps");
});

// ── the page's error slots, the save, and a failed first load ───────────────

function functionBody(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} present`);
  return src.slice(start, src.indexOf("\n  }\n", start));
}

test("a load clears only its own error — never the one a protect, unprotect or rules save set", () => {
  const load = callbackBody(pageSrc, "load");
  assert.match(load, /setLoadError\(""\);/);
  assert.doesNotMatch(load, /setActionError|setError\(/, "a background reload never touches an action's error");
  for (const name of ["saveRules", "setProtected"]) {
    const body = functionBody(pageSrc, name);
    assert.match(body, /setActionError\(""\);/, `${name} clears the action error when the admin starts it`);
    assert.doesNotMatch(body, /setLoadError|setError\(/, `${name} writes only the action error`);
  }
  assert.match(pageSrc, /\[loadError, actionError, del\.error\]\.filter\(/, "every error is shown");
});

test("a rules save installs the saved draft as the report's settings and the draft base BEFORE its reload", () => {
  const body = functionBody(pageSrc, "saveRules");
  const base = body.indexOf("draftBase.current = draft;");
  const settings = body.indexOf("setReport((r) => (r ? { ...r, settings: draft } : r));");
  const reload = body.indexOf("await load({ resetDraft: true });");
  assert.ok(base > 0 && settings > 0 && reload > 0, "all three present");
  assert.ok(base < reload && settings < reload, "Save reads clean even when a Protect supersedes the reload");
  assert.ok(body.indexOf("if (!res.ok)") < base, "only after the server accepted the save");
  assert.doesNotMatch(pageSrc, /resetDraftNext/, "a superseded load's reset can't stay armed");
});

test("a failed first load offers a Retry that reloads", () => {
  const start = pageSrc.indexOf("if (!report || !draft) {");
  assert.ok(start > 0);
  const branch = pageSrc.slice(start, pageSrc.indexOf("\n  }\n", start));
  assert.match(branch, /<Button[^>]*onClick=\{\(\) => void load\(\)\}/);
  assert.match(branch, /t\("adminManage\.common\.retry"\)/);
});

test("the protected section counts every protection and says when the list is capped", () => {
  assert.match(pageSrc, /const protectedTotal = Math\.max\(report\.protectedTotal \?\? 0, report\.protected\.length\);/);
  assert.match(pageSrc, /t\("adminManage\.cleanup\.protectedCount", \{ count: protectedTotal \}\)/);
  assert.doesNotMatch(pageSrc, /protectedCount", \{ count: report\.protected\.length \}/, "the capped list's length is not the count");
  assert.match(pageSrc, /\{protectedTotal > report\.protected\.length && \(/);
  assert.match(pageSrc, /t\("adminManage\.cleanup\.protectedCapped", \{ cap: report\.protected\.length, total: protectedTotal \}\)/);
});
