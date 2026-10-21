// Audit fixes (wave A, unit "release"): the Download Queue and the release
// search dialog.
//
//   g-sonarr#1 — a removal sends ONE record id per download (`removalIds`):
//                Sonarr v3's bulk remove loops over the ids with no dedupe, so
//                a season pack's N ids blocklisted the release N times.
//   g-sonarr#2 — Sonarr v3 ignores skipRedownload, so the "Blocklist" option
//                can't promise "no new search" there (`blocklistRedownload`);
//                nor while a Sonarr instance's version is still unknown, and
//                the health report is read once per page, never per open.
//   g-sonarr#3 — a Sonarr v3 manualimport row carries ONE `language` object;
//                it is carried back as `language`, or v3 stores the file as
//                Language Unknown. v4/Radarr output is unchanged.
//   g-pollers#5 — closing the release dialog invalidates a movie's / title
//                manager's search too (the effect returns its cleanup from
//                both branches).
//   g-pollers#6 — Re-check downloads reads the per-instance errors the route
//                returns (it answers 202 even when every instance refused).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyImportOverride,
  EMPTY_IMPORT_CATALOG,
  foldQueueRecords,
  blocklistRedownload,
  importCandidates,
  ImportOverrideError,
  manualImportFiles,
  recheckOutcome,
  removalIds,
  reprocessItems,
} from "../src/lib/arr-queue.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

// ── g-sonarr#1 ───────────────────────────────────────────────────────────────

test("g-sonarr#1: a folded Sonarr pack removes with ONE record id; a pending row with its own", () => {
  const ep = (id: number, n: number) => ({
    id, downloadId: "pack-1", title: "Show.S02.1080p", seriesId: 3, series: { title: "Show" },
    episode: { seasonNumber: 2, episodeNumber: n }, size: 6e9, sizeleft: 3e9, status: "downloading",
  });
  const pending = { id: 200, title: "Show.S02E09.1080p", seriesId: 3, series: { title: "Show" }, episode: { seasonNumber: 2, episodeNumber: 9 }, size: 1e9, sizeleft: 1e9, status: "delay" };
  const rows = foldQueueRecords("sonarr", "", [ep(101, 1), ep(102, 2), ep(103, 3), pending]);
  const pack = rows.find((r) => r.downloadId === "pack-1")!;
  assert.deepEqual(pack.ids, [101, 102, 103], "the row still covers every record");
  assert.deepEqual(removalIds(pack), [101]);
  const held = rows.find((r) => r.ids.includes(200))!;
  assert.deepEqual(removalIds(held), [200]);
});

test("g-sonarr#1: the queue page's Remove sends removalIds(row), never every record id", () => {
  const page = src("components/admin/download-queue.tsx");
  const body = /fetch\(withBasePath\("\/api\/admin\/queue\/remove"\)[\s\S]*?\}\),\s*\}\);/.exec(page)?.[0] ?? "";
  assert.match(body, /ids: removalIds\(removing\)/);
  assert.doesNotMatch(body, /removing\.ids/);
});

// ── g-sonarr#2 ───────────────────────────────────────────────────────────────

test("g-sonarr#2: blocklistRedownload — Sonarr below v4 searches; v4+ and Radarr skip; an unknown Sonarr version is unknown", () => {
  assert.equal(blocklistRedownload("sonarr", "3.0.10.1567"), "searches");
  assert.equal(blocklistRedownload("sonarr", "2.0.0.5344"), "searches");
  assert.equal(blocklistRedownload("sonarr", "4.0.9.2244"), "skipped");
  assert.equal(blocklistRedownload("sonarr", "5.0.0.1"), "skipped");
  // Not known yet (loading, failed, not reported, unparseable): never the "no new search" promise.
  assert.equal(blocklistRedownload("sonarr", null), "unknown");
  assert.equal(blocklistRedownload("sonarr", undefined), "unknown");
  assert.equal(blocklistRedownload("sonarr", "garbage"), "unknown");
  assert.equal(blocklistRedownload("radarr", "3.2.2.5080"), "skipped", "Radarr is not gated");
  assert.equal(blocklistRedownload("radarr", undefined), "skipped");
});

test("g-sonarr#2: the Blocklist option's help follows the row's instance version, and the health report is read once per page", () => {
  const page = src("components/admin/download-queue.tsx");
  assert.match(page, /const redownload = removing \? blocklistRedownload\(removing\.service, arrVersions\[`\$\{removing\.service\}:\$\{removing\.instance\}`\]\) : "skipped";/);
  assert.match(page, /help: redownload === "searches"\s*\? t\("adminManage\.queue\.remove\.blocklistHelpSonarrV3"\)\s*: redownload === "unknown"\s*\? t\("adminManage\.queue\.remove\.blocklistHelpSonarrUnknown"\)\s*: t\("adminManage\.queue\.remove\.blocklistHelp"\),/);
  // The version comes from the health report, read once: the guard is set BEFORE the fetch,
  // so neither a load in flight nor a failed one is re-read by a later open.
  assert.match(page, /async function loadVersions\(\) \{\s*if \(versionsRequested\.current\) return;\s*versionsRequested\.current = true;\s*try \{\s*const res = await fetch\(withBasePath\("\/api\/admin\/arr-health"\)\);/);
  assert.equal((page.match(/versionsRequested\.current = /g) ?? []).length, 1, "never reset");
  assert.match(page, /if \(row\.service === "sonarr"\) void loadVersions\(\);/);
  // The cautious wording exists in every locale and names Sonarr v3 as the exception.
  const en = JSON.parse(src("lib/i18n/messages/en/adminManage.json")) as Record<string, string>;
  assert.match(en["adminManage.queue.remove.blocklistHelpSonarrUnknown"], /except on Sonarr v3/);
  for (const l of ["es", "fr", "de", "pt", "it", "zh"]) {
    const cat = JSON.parse(src(`lib/i18n/messages/${l}/adminManage.json`)) as Record<string, string>;
    assert.ok(cat["adminManage.queue.remove.blocklistHelpSonarrUnknown"] && cat["adminManage.queue.remove.blocklistHelpSonarrUnknown"] !== en["adminManage.queue.remove.blocklistHelpSonarrUnknown"], `${l} is translated`);
  }
});

// ── g-sonarr#3 ───────────────────────────────────────────────────────────────

const v3Row = {
  path: "/downloads/Show.S01E01.mkv", relativePath: "Show.S01E01.mkv", size: 1, downloadId: "dl",
  quality: { quality: { id: 7, name: "Bluray-1080p" }, revision: { version: 1 } },
  language: { id: 2, name: "French" },
  series: { id: 3, title: "Show" }, episodes: [{ id: 31, seasonNumber: 1, episodeNumber: 1 }],
};
const v4Row = { ...v3Row, language: undefined, languages: [{ id: 2, name: "French" }] };

test("g-sonarr#3: a v3 row's single language is carried back as `language` — never an empty `languages`", () => {
  const [file] = manualImportFiles("sonarr", [{ path: v3Row.path, row: v3Row }], "dl");
  assert.deepEqual(file.language, { id: 2, name: "French" });
  assert.equal("languages" in file, false);
  const [item] = reprocessItems("sonarr", [{ path: v3Row.path, row: v3Row }], "dl");
  assert.deepEqual(item.language, { id: 2, name: "French" });
  assert.equal("languages" in item, false);
});

test("g-sonarr#3: a v4 row keeps `languages` exactly and gains no `language`", () => {
  const [file] = manualImportFiles("sonarr", [{ path: v4Row.path, row: v4Row }], "dl");
  assert.deepEqual(file.languages, [{ id: 2, name: "French" }]);
  assert.equal("language" in file, false);
  const [item] = reprocessItems("sonarr", [{ path: v4Row.path, row: v4Row }], "dl");
  assert.deepEqual(item.languages, [{ id: 2, name: "French" }]);
  assert.equal("language" in item, false);
  const bare = { ...v3Row, language: undefined };
  const [none] = manualImportFiles("sonarr", [{ path: bare.path, row: bare }], "dl");
  assert.deepEqual(none.languages, [], "neither shape: an empty list, as before");
});

test("g-sonarr#3: the dialog shows a v3 row's language but offers no language id to correct", () => {
  const [c] = importCandidates("sonarr", [v3Row]);
  assert.deepEqual(c.languages, ["French"]);
  assert.deepEqual(c.languageIds, []);
});

test("g-sonarr#3: a language correction on a v3 row is refused (400, nothing sent) — v3 would ignore a `languages` array", () => {
  // Even with the language in the catalog: the refusal is the v3 shape, not a missing id.
  const catalog = { ...EMPTY_IMPORT_CATALOG, languages: new Map([[2, { id: 2, name: "French" }]]) };
  assert.throws(
    () => applyImportOverride("sonarr", v3Row, { languageIds: [2] }, catalog),
    (e: unknown) => e instanceof ImportOverrideError && e.field === "languages",
  );
  assert.deepEqual(applyImportOverride("sonarr", v4Row, { languageIds: [2] }, catalog).languages, [{ id: 2, name: "French" }], "a v4 row is corrected as before");
});

// ── g-pollers#5 ──────────────────────────────────────────────────────────────

test("g-pollers#5: the open-time effect returns its invalidating cleanup from the movie/target branch too", () => {
  const dialog = src("components/admin/release-search-dialog.tsx");
  const branch = /if \(!isTv\) \{([\s\S]*?)\}/.exec(dialog)?.[1] ?? "";
  assert.match(branch, /void search\(null\);\s*return invalidate;/);
  assert.doesNotMatch(dialog, /void search\(null\);\s*return;/);
  assert.match(dialog, /const invalidate = \(\) => \{\s*counter\.current\+\+;\s*\};/);
});

// ── g-pollers#6 ──────────────────────────────────────────────────────────────

test("g-pollers#6: recheckOutcome counts the refusals the 202 carries", () => {
  assert.deepEqual(recheckOutcome({ instances: 2, errors: [] }), { asked: 2, failed: [], allFailed: false });
  const partial = recheckOutcome({ instances: 3, errors: [{ service: "sonarr", instance: "", error: "x", kind: "auth" }] });
  assert.equal(partial.asked, 2);
  assert.equal(partial.allFailed, false);
  assert.deepEqual(partial.failed, [{ service: "sonarr", instance: "", kind: "auth" }]);
  assert.ok(!JSON.stringify(partial).includes('"error"'), "the raw upstream text is never carried to the page");
  const all = recheckOutcome({ instances: 2, errors: [{ service: "radarr", instance: "", kind: "timeout" }, { service: "radarr", instance: "4k", kind: "unreachable" }] });
  assert.equal(all.asked, 0);
  assert.equal(all.allFailed, true);
  assert.deepEqual(recheckOutcome(null), { asked: 0, failed: [], allFailed: false });
});

test("g-pollers#6: the page's Re-check goes through recheckOutcome and shows no success when every instance refused", () => {
  const page = src("components/admin/download-queue.tsx");
  const body = /async function recheck\(\) \{([\s\S]*?)\n  \}\n/.exec(page)?.[1] ?? "";
  assert.match(body, /const outcome = recheckOutcome\(data\);/);
  assert.match(body, /if \(!outcome\.allFailed\) setNotice\(/);
  assert.doesNotMatch(body, /data\?\.errors\?\.length/);
  assert.match(body, /setRecheckFailed\(\{ all: outcome\.allFailed, failed: outcome\.failed \}\)/);
});
