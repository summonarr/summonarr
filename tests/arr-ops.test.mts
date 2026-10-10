// Pure rules behind Admin → Download Queue, the Radarr/Sonarr health panel and
// one-click webhook setup, the "Open in Radarr/Sonarr" links, and the Missing
// page's Cutoff-unmet mode (src/lib/arr-queue.ts, arr-health.ts, arr-links.ts,
// arr-missing.ts). What is pinned:
//
//   QUEUE   — a Sonarr season pack (one record per episode) folds into ONE row
//             carrying every record id, with the release's size taken once, not
//             summed; attention is Radarr/Sonarr's own verdict; the removal query
//             sends every flag explicitly (the arr defaults removeFromClient to
//             TRUE, so an omitted flag is not "off").
//   HEALTH  — only non-ok checks, wiki links https only; the webhook verdict
//             demands the CURRENT token and every handled event the version
//             supports; setup keeps an existing entry's own settings, turns on
//             only Summonarr's events, and masks the token in the arr's error.
//   LINKS   — External URL wins, an invalid one falls through; slugs are encoded.
//   CUTOFF  — Radarr/Sonarr's own qualityCutoffNotMet decides, never ours; the
//             Sonarr search is only monitored episodes whose file is below cutoff.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  foldQueueRecords,
  needsAttention,
  parseTimeSpan,
  queuePhase,
  queueRemoveQuery,
  sortQueueItems,
  isQueueRemoveAction,
  importCandidates,
  manualImportFiles,
  defaultImportSelection,
  isDownloadId,
  isImportMode,
} = await import("../src/lib/arr-queue.ts");
const {
  arrValidationMessage,
  buildWebhookResource,
  buildWebhookUrl,
  evaluateWebhook,
  normalizeHealthChecks,
  normalizeWebhookBase,
  webhookTemplate,
  WEBHOOK_EVENTS,
} = await import("../src/lib/arr-health.ts");
const { arrAddUrl, arrBrowserBase, arrOpenHref, arrTitleUrl, titleSlugOf } = await import("../src/lib/arr-links.ts");
const { cutoffMovie, cutoffSeriesFromEpisodes, planCutoffSearch, qualityProfileInfo } = await import("../src/lib/arr-missing.ts");
const { arrHealthText } = await import("../src/lib/arr-health-notify.ts");

// ── queue ────────────────────────────────────────────────────────────────────

test("parseTimeSpan reads .NET TimeSpans with and without days and fractions, and nothing else", () => {
  assert.equal(parseTimeSpan("00:12:34"), 754);
  assert.equal(parseTimeSpan("1.02:03:04"), 86_400 + 7_384);
  assert.equal(parseTimeSpan("00:00:05.1234567"), 5);
  assert.equal(parseTimeSpan(undefined), null);
  assert.equal(parseTimeSpan("soon"), null);
  assert.equal(parseTimeSpan(42), null);
});

test("queuePhase: the import pipeline (tracked state) wins over the client status", () => {
  assert.equal(queuePhase("downloading", "importBlocked"), "importBlocked");
  assert.equal(queuePhase("completed", "importPending"), "importPending");
  assert.equal(queuePhase("completed", "importing"), "importing");
  assert.equal(queuePhase("failed", "failedPending"), "failed");
  assert.equal(queuePhase("downloading", "downloading"), "downloading");
  assert.equal(queuePhase("queued", undefined), "queued");
  assert.equal(queuePhase("downloadClientUnavailable", undefined), "clientUnavailable");
  // A client-flagged (stalled) download is still downloading; the flag is attention.
  assert.equal(queuePhase("warning", "downloading"), "downloading");
  assert.equal(queuePhase("something-new", undefined), "unknown");
});

test("needsAttention is Radarr/Sonarr's own verdict — warning/error status, blocked/failed import, failed or unreachable client", () => {
  assert.equal(needsAttention({ status: "downloading", trackedDownloadStatus: "ok", trackedDownloadState: "downloading" }), false);
  assert.equal(needsAttention({ status: "downloading", trackedDownloadStatus: "warning", trackedDownloadState: "downloading" }), true);
  assert.equal(needsAttention({ status: "completed", trackedDownloadStatus: "ok", trackedDownloadState: "importBlocked" }), true);
  assert.equal(needsAttention({ status: "completed", trackedDownloadStatus: "ok", trackedDownloadState: "failedPending" }), true);
  assert.equal(needsAttention({ status: "warning" }), true);
  assert.equal(needsAttention({ status: "downloadClientUnavailable" }), true);
  assert.equal(needsAttention({ status: "queued" }), false);
});

const packRecord = (id: number, episodeNumber: number, extra: Record<string, unknown> = {}) => ({
  id,
  downloadId: "SABnzbd_123",
  title: "Show.S01.1080p.WEB-DL",
  seriesId: 7,
  series: { title: "Show", year: 2026, tmdbId: 700, tvdbId: 7000 },
  episode: { seasonNumber: 1, episodeNumber },
  quality: { quality: { name: "WEBDL-1080p" } },
  size: 8e9,
  sizeleft: 2e9,
  timeleft: "00:10:00",
  status: "downloading",
  trackedDownloadStatus: "ok",
  trackedDownloadState: "downloading",
  protocol: "usenet",
  downloadClient: "SABnzbd",
  indexer: "NZBgeek",
  ...extra,
});

test("a Sonarr season pack folds into ONE row with every record id, the release's size once (never summed)", () => {
  const rows = foldQueueRecords("sonarr", "", [packRecord(11, 2), packRecord(10, 1), packRecord(12, 3)]);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.deepEqual(row.ids, [11, 10, 12]);
  assert.deepEqual(row.episodes, [
    { seasonNumber: 1, episodeNumber: 1 },
    { seasonNumber: 1, episodeNumber: 2 },
    { seasonNumber: 1, episodeNumber: 3 },
  ]);
  assert.equal(row.size, 8e9, "summing would triple an 8 GB pack to 24 GB");
  assert.equal(row.sizeLeft, 2e9);
  assert.equal(row.progress, 0.75);
  assert.equal(row.timeLeftSeconds, 600);
  assert.equal(row.mediaTitle, "Show");
  assert.equal(row.tvdbId, 7000);
  assert.equal(row.arrMediaId, 7);
});

test("one bad episode record flags the whole pack, and a record without a downloadId stands alone", () => {
  const rows = foldQueueRecords("sonarr", "anime", [
    packRecord(1, 1),
    packRecord(2, 2, { trackedDownloadStatus: "warning", statusMessages: [{ title: "x", messages: ["Episode not found in the release"] }] }),
    packRecord(3, 1, { downloadId: null }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].attention, true);
  assert.deepEqual(rows[0].messages, ["Episode not found in the release"]);
  assert.equal(rows[0].instance, "anime");
  assert.deepEqual(rows[1].ids, [3]);
});

test("Radarr records are never folded — two downloads for one movie are two rows", () => {
  const rec = (id: number) => ({ id, downloadId: "same", movieId: 5, movie: { title: "M", tmdbId: 50 }, size: 1, sizeleft: 0, status: "completed" });
  assert.equal(foldQueueRecords("radarr", "", [rec(1), rec(2)]).length, 2);
});

test("records without a positive id are dropped — nothing could act on them", () => {
  assert.deepEqual(foldQueueRecords("radarr", "", [{ id: 0 }, { id: "3" }, null, "x"]), []);
});

test("messages: errorMessage first, statusMessages flattened, deduplicated, bounded", () => {
  const [row] = foldQueueRecords("radarr", "", [{
    id: 1,
    errorMessage: "Import failed",
    statusMessages: [
      { title: "Release.mkv", messages: ["Import failed", "Not a valid movie file"] },
      { title: "Title-only line", messages: [] },
    ],
  }]);
  assert.deepEqual(row.messages, ["Import failed", "Not a valid movie file", "Title-only line"]);
});

test("sortQueueItems: attention first, then pipeline stage, then soonest to finish", () => {
  const items = [
    ...foldQueueRecords("radarr", "", [{ id: 1, movie: { title: "B" }, status: "downloading", timeleft: "01:00:00" }]),
    ...foldQueueRecords("radarr", "", [{ id: 2, movie: { title: "A" }, status: "downloading", timeleft: "00:10:00" }]),
    ...foldQueueRecords("radarr", "", [{ id: 3, movie: { title: "C" }, status: "queued" }]),
    ...foldQueueRecords("radarr", "", [{ id: 4, movie: { title: "D" }, status: "completed", trackedDownloadState: "importBlocked", trackedDownloadStatus: "warning" }]),
  ];
  assert.deepEqual(sortQueueItems(items).map((i) => i.ids[0]), [4, 2, 1, 3]);
});

test("the removal query sends EVERY flag explicitly — the arr defaults removeFromClient to true", () => {
  const q = (a: Parameters<typeof queueRemoveQuery>[0], c: boolean) => Object.fromEntries(new URLSearchParams(queueRemoveQuery(a, c)));
  assert.deepEqual(q("remove", true), { removeFromClient: "true", blocklist: "false", skipRedownload: "true", changeCategory: "false" });
  assert.deepEqual(q("remove", false), { removeFromClient: "false", blocklist: "false", skipRedownload: "true", changeCategory: "false" });
  assert.deepEqual(q("blocklist", true), { removeFromClient: "true", blocklist: "true", skipRedownload: "true", changeCategory: "false" });
  assert.deepEqual(q("blocklistSearch", true), { removeFromClient: "true", blocklist: "true", skipRedownload: "false", changeCategory: "false" });
  assert.equal(isQueueRemoveAction("blocklistSearch"), true);
  assert.equal(isQueueRemoveAction("delete"), false);
});

// ── import (Manual Import of a blocked download) ─────────────────────────────

const quality = { quality: { id: 7, name: "Bluray-1080p", source: "bluray", resolution: 1080 }, revision: { version: 1, real: 0, isRepack: false } };
const radarrRows = [
  { path: "/downloads/Movie.2024/Movie.2024.mkv", relativePath: "Movie.2024.mkv", folderName: "Movie.2024", size: 8e9, quality,
    languages: [{ id: 1, name: "English" }], releaseGroup: "GRP", indexerFlags: 4,
    movie: { id: 12, title: "Movie", year: 2024 }, rejections: [{ reason: "Not an upgrade for existing movie file", type: "permanent" }] },
  { path: "/downloads/Movie.2024/sample.mkv", relativePath: "sample.mkv", size: 5e7, quality, movie: null, rejections: [{ reason: "Sample" }] },
];
const sonarrRows = [
  { path: "/dl/Show.S01/Show.S01E02.mkv", relativePath: "Show.S01E02.mkv", folderName: "Show.S01", size: 1e9, quality, languages: [], releaseType: "seasonPack",
    series: { id: 3, title: "Show" }, episodes: [{ id: 102, seasonNumber: 1, episodeNumber: 2 }], rejections: [] },
  { path: "/dl/Show.S01/Show.S01E01.mkv", relativePath: "Show.S01E01.mkv", size: 1e9, quality,
    series: { id: 3, title: "Show" }, episodes: [{ id: 101, seasonNumber: 1, episodeNumber: 1 }], rejections: [{ reason: "Episode was unexpected" }] },
  { path: "/dl/Show.S01/Extras.mkv", relativePath: "Extras.mkv", size: 2e8, quality, series: { id: 3, title: "Show" }, episodes: [], rejections: [{ reason: "Unable to parse" }] },
];

test("importCandidates: what the dialog shows — matched target, quality, rejections; unmatched files are not importable", () => {
  const r = importCandidates("radarr", radarrRows);
  assert.deepEqual(r.map((c) => [c.name, c.target, c.quality, c.importable, c.rejections]), [
    ["Movie.2024.mkv", "Movie (2024)", "Bluray-1080p", true, ["Not an upgrade for existing movie file"]],
    ["sample.mkv", null, "Bluray-1080p", false, ["Sample"]],
  ]);
  const s = importCandidates("sonarr", sonarrRows);
  assert.deepEqual(s.map((c) => [c.name, c.importable, c.episodes.map((e) => e.episodeNumber)]), [
    ["Extras.mkv", false, []],
    ["Show.S01E01.mkv", true, [1]],
    ["Show.S01E02.mkv", true, [2]],
  ]);
  assert.deepEqual(importCandidates("radarr", "not a list"), []);
});

test("manualImportFiles: ONLY the arr's own matched rows whose path was chosen, carrying back what the arr detected", () => {
  const chosen = new Set(["/downloads/Movie.2024/Movie.2024.mkv", "/downloads/Movie.2024/sample.mkv", "/etc/passwd"]);
  assert.deepEqual(manualImportFiles("radarr", radarrRows, chosen, "SAB_1"), [{
    path: "/downloads/Movie.2024/Movie.2024.mkv",
    folderName: "Movie.2024",
    quality,
    languages: [{ id: 1, name: "English" }],
    releaseGroup: "GRP",
    indexerFlags: 4,
    downloadId: "SAB_1",
    movieId: 12,
  }], "the unmatched sample and the injected path are never sent");
  const files = manualImportFiles("sonarr", sonarrRows, new Set(sonarrRows.map((r) => r.path)), "qb_hash");
  assert.deepEqual(files.map((f) => [f.path, f.seriesId, f.episodeIds, f.releaseType ?? null]), [
    ["/dl/Show.S01/Show.S01E02.mkv", 3, [102], "seasonPack"],
    ["/dl/Show.S01/Show.S01E01.mkv", 3, [101], null],
  ]);
});

test("defaultImportSelection: the clean matched files; when every matched file was refused, all of them; never an unmatched one", () => {
  const s = importCandidates("sonarr", sonarrRows);
  assert.deepEqual([...defaultImportSelection(s)], ["/dl/Show.S01/Show.S01E02.mkv"]);
  const r = importCandidates("radarr", radarrRows);
  assert.deepEqual([...defaultImportSelection(r)], ["/downloads/Movie.2024/Movie.2024.mkv"], "the blocked import the admin came to override");
});

test("download ids and import modes", () => {
  assert.equal(isDownloadId("SABnzbd_nzo_abc123"), true);
  assert.equal(isDownloadId("A1B2C3D4E5F6"), true);
  assert.equal(isDownloadId("has space"), false);
  assert.equal(isDownloadId("x".repeat(201)), false);
  assert.equal(isDownloadId("line\nbreak"), false);
  assert.equal(isImportMode("copy"), true);
  assert.equal(isImportMode("hardlink"), false);
});

// ── health ───────────────────────────────────────────────────────────────────

test("normalizeHealthChecks: drops ok rows and blanks, errors first, wiki links https only", () => {
  const checks = normalizeHealthChecks([
    { source: "UpdateCheck", type: "notice", message: "Update available", wikiUrl: "https://wiki.servarr.com/radarr/system#update" },
    { source: "IndexerStatusCheck", type: "error", message: "All indexers are unavailable", wikiUrl: "javascript:alert(1)" },
    { source: "Ok", type: "ok", message: "fine" },
    { source: "Blank", type: "warning", message: "  " },
    { source: "DownloadClientCheck", type: "warning", message: "Unable to communicate with SABnzbd", wikiUrl: "http://plain.example/wiki" },
  ]);
  assert.deepEqual(checks.map((c) => [c.level, c.source, c.wikiUrl]), [
    ["error", "IndexerStatusCheck", null],
    ["warning", "DownloadClientCheck", null],
    ["notice", "UpdateCheck", "https://wiki.servarr.com/radarr/system#update"],
  ]);
  assert.deepEqual(normalizeHealthChecks({ not: "a list" }), []);
});

const hook = (over: Record<string, unknown> = {}, url = "http://summonarr:3000/api/webhooks/radarr?token=s3cret") => ({
  id: 9,
  name: "Summonarr",
  implementation: "Webhook",
  fields: [{ name: "url", value: url }, { name: "method", value: 1 }, { name: "password", value: "********" }],
  ...Object.fromEntries(WEBHOOK_EVENTS.radarr.map((f) => [f, true])),
  onGrab: false,
  ...over,
});

test("evaluateWebhook: missing / wrong token / missing events / ok", () => {
  assert.deepEqual(evaluateWebhook([], "radarr", "s3cret").state, "missing");
  assert.deepEqual(evaluateWebhook([{ implementation: "Discord", fields: [] }], "radarr", "s3cret").state, "missing");
  // A hook for the OTHER service's endpoint is not this one.
  assert.equal(evaluateWebhook([hook({}, "http://s:3000/api/webhooks/sonarr?token=s3cret")], "radarr", "s3cret").state, "missing");
  assert.equal(evaluateWebhook([hook()], "radarr", "rotated").state, "tokenMismatch");
  assert.equal(evaluateWebhook([hook()], "radarr", "").state, "tokenMismatch", "no secret ⇒ no hook can authenticate");
  const partial = evaluateWebhook([hook({ onManualInteractionRequired: false })], "radarr", "s3cret");
  assert.deepEqual([partial.state, partial.missingEvents], ["eventsMissing", ["onManualInteractionRequired"]]);
  const ok = evaluateWebhook([hook()], "radarr", "s3cret");
  assert.deepEqual([ok.state, ok.id], ["ok", 9]);
});

test("evaluateWebhook: an event this version does NOT support is never demanded", () => {
  const v = evaluateWebhook([hook({ onManualInteractionRequired: false, supportsOnManualInteractionRequired: false })], "radarr", "s3cret");
  assert.equal(v.state, "ok");
});

test("evaluateWebhook: an OLDER version that lacks the event flag entirely (Sonarr v3) is not stuck on 'missing events'", () => {
  const v3 = hook({}, "http://s:3000/api/webhooks/sonarr?token=s3cret") as Record<string, unknown>;
  delete v3.onHealthRestored;
  delete v3.onManualInteractionRequired;
  v3.onSeriesDelete = true;
  assert.deepEqual(evaluateWebhook([v3], "sonarr", "s3cret").state, "ok");
  // …and setup never invents the flag on that version.
  const body = buildWebhookResource(v3, "sonarr", "http://s/api/webhooks/sonarr?token=t", { isNew: false })!;
  assert.equal("onHealthRestored" in body, false);
  assert.equal("onManualInteractionRequired" in body, false);
});

test("evaluateWebhook: among several Summonarr hooks the one carrying the current token is judged", () => {
  const stale = hook({ id: 1 }, "http://old:3000/api/webhooks/radarr?token=old");
  const current = hook({ id: 2 }, "http://summonarr:3000/base/api/webhooks/radarr/?token=s3cret");
  const v = evaluateWebhook([stale, current], "radarr", "s3cret");
  assert.deepEqual([v.state, v.id], ["ok", 2]);
});

test("buildWebhookUrl keeps a base path, appends the endpoint, and puts the token in ?token= (guardrail 2)", () => {
  assert.equal(buildWebhookUrl("http://summonarr:3000", "sonarr", "a b&c"), "http://summonarr:3000/api/webhooks/sonarr?token=a+b%26c");
  assert.equal(buildWebhookUrl("https://x.example/request", "radarr", "t"), "https://x.example/request/api/webhooks/radarr?token=t");
});

test("normalizeWebhookBase: http(s) only, no credentials, query or fragment; trailing slash trimmed", () => {
  assert.equal(normalizeWebhookBase(" http://summonarr:3000/ "), "http://summonarr:3000");
  assert.equal(normalizeWebhookBase("https://x.example/sub/"), "https://x.example/sub");
  for (const bad of ["ftp://x", "http://u:p@x", "http://x/?a=1", "http://x/#f", "not a url", "", 5]) {
    assert.equal(normalizeWebhookBase(bad), null, String(bad));
  }
});

const template = {
  name: "",
  implementation: "Webhook",
  configContract: "WebhookSettings",
  fields: [{ name: "url", value: "" }, { name: "method", value: 1 }, { name: "username" }, { name: "password" }],
  onGrab: false,
  onDownload: false,
  onUpgrade: false,
  onRename: false,
  onMovieDelete: false,
  onMovieFileDelete: false,
  onHealthIssue: false,
  includeHealthWarnings: false,
  onHealthRestored: false,
  onManualInteractionRequired: false,
  supportsOnManualInteractionRequired: false,
  tags: [5],
  id: 0,
};

test("buildWebhookResource (create): Summonarr's name, the URL, ONLY the handled events the version supports", () => {
  const body = buildWebhookResource(template, "radarr", "http://s/api/webhooks/radarr?token=t", { isNew: true })!;
  assert.equal(body.name, "Summonarr");
  assert.deepEqual(body.tags, []);
  assert.equal("id" in body, false);
  assert.equal((body.fields as Array<{ name: string; value?: unknown }>).find((f) => f.name === "url")!.value, "http://s/api/webhooks/radarr?token=t");
  assert.equal((body.fields as Array<{ name: string; value?: unknown }>).find((f) => f.name === "method")!.value, 1, "the schema's own default method is kept");
  for (const f of ["onDownload", "onUpgrade", "onMovieDelete", "onMovieFileDelete", "onHealthIssue", "onHealthRestored"]) assert.equal(body[f], true, f);
  assert.equal(body.onGrab, false, "Grab is not handled, so not asked for");
  assert.equal(body.onRename, false);
  assert.equal(body.includeHealthWarnings, false);
  assert.equal(body.onManualInteractionRequired, false, "unsupported by this version ⇒ left alone");
  assert.equal(template.fields[0].value, "", "the template object is not mutated");
});

test("buildWebhookResource (update): the admin's name, tags and extra events survive; only the URL and handled events change", () => {
  const existing = hook({ name: "My hook", tags: [3], onGrab: true, onDownload: false }, "http://old/api/webhooks/radarr?token=old");
  const body = buildWebhookResource(existing, "radarr", "http://new/api/webhooks/radarr?token=t", { isNew: false })!;
  assert.equal(body.name, "My hook");
  assert.deepEqual(body.tags, [3]);
  assert.equal(body.id, 9);
  assert.equal(body.onGrab, true);
  assert.equal(body.onDownload, true);
  assert.equal((body.fields as Array<{ name: string; value?: unknown }>).find((f) => f.name === "password")!.value, "********", "masked password round-trips untouched");
});

test("buildWebhookResource refuses a template with no url field; webhookTemplate finds the Webhook entry", () => {
  assert.equal(buildWebhookResource({ fields: [{ name: "host" }] }, "sonarr", "u", { isNew: true }), null);
  assert.equal(buildWebhookResource({}, "sonarr", "u", { isNew: true }), null);
  assert.equal(webhookTemplate([{ implementation: "Discord" }, template])?.configContract, "WebhookSettings");
  assert.equal(webhookTemplate("nope"), null);
});

test("arrValidationMessage: the arr's own reason, single line, with the webhook token masked", () => {
  const body = JSON.stringify([{
    propertyName: "Url",
    errorMessage: "Unable to send test message: HTTP request failed: [401:Unauthorized] [POST] at [http://s:3000/api/webhooks/radarr?token=abc123]\nretry",
  }]);
  const msg = arrValidationMessage(body)!;
  assert.ok(!msg.includes("abc123"), msg);
  assert.ok(msg.includes("token=••••••••"));
  assert.ok(!msg.includes("\n"));
  assert.equal(arrValidationMessage("not json"), null);
  assert.equal(arrValidationMessage("[]"), null);
});

test("arrHealthText: service, the instance's display name, Radarr's level and message — control characters out", () => {
  assert.equal(arrHealthText("radarr", "4K", { level: "error", message: "Indexers\nunavailable" }), "Radarr (4K) — error: Indexers unavailable");
  assert.equal(arrHealthText("sonarr", null, { level: "bogus", message: "Disk low" }), "Sonarr: Disk low");
  assert.equal(arrHealthText("sonarr", null, { level: "warning", message: "" }), null);
  // A restored check carries the PREVIOUS level; naming it would read "error" under "restored".
  assert.equal(arrHealthText("radarr", null, { level: "error", message: "Indexers unavailable" }, "HealthRestored"), "Radarr: Indexers unavailable");
});

// ── links ────────────────────────────────────────────────────────────────────

test("arrBrowserBase: External URL first, an unusable value falls through to the connection URL", () => {
  assert.equal(arrBrowserBase("https://radarr.example.com/", "http://radarr:7878"), "https://radarr.example.com");
  assert.equal(arrBrowserBase("", "http://radarr:7878/"), "http://radarr:7878");
  assert.equal(arrBrowserBase("javascript:alert(1)", "http://radarr:7878"), "http://radarr:7878");
  assert.equal(arrBrowserBase("https://u:p@radarr.example.com", null), null);
  assert.equal(arrBrowserBase("https://x.example/radarr/", null), "https://x.example/radarr");
});

test("title, add and in-app hrefs", () => {
  assert.equal(arrTitleUrl("http://r", "radarr", "603"), "http://r/movie/603");
  assert.equal(arrTitleUrl("http://s", "sonarr", "a/b c"), "http://s/series/a%2Fb%20c");
  assert.equal(arrAddUrl("http://s", 1399), "http://s/add/new?term=tmdb%3A1399");
  assert.equal(arrOpenHref("sonarr", "4k", { tmdbId: 1 }), "/api/admin/arr/open?service=sonarr&instance=4k&tmdbId=1");
  assert.equal(arrOpenHref("radarr", "", { arrId: 7 }), "/api/admin/arr/open?service=radarr&instance=&arrId=7");
  assert.equal(titleSlugOf(603), "603");
  assert.equal(titleSlugOf(" the-office "), "the-office");
  assert.equal(titleSlugOf(""), null);
  assert.equal(titleSlugOf(-1), null);
});

// ── cutoff unmet ─────────────────────────────────────────────────────────────

const profiles = qualityProfileInfo([
  { id: 1, name: "HD-1080p", cutoff: 7, items: [{ quality: { id: 3, name: "WEBDL-1080p" } }, { quality: { id: 7, name: "Bluray-1080p" } }] },
  { id: 2, name: "Any", cutoff: 1001, items: [{ id: 1001, name: "WEB 1080p", items: [{ quality: { id: 3 } }] }] },
]);

test("qualityProfileInfo names the cutoff — a single quality or a quality GROUP", () => {
  assert.deepEqual(profiles.get(1), { name: "HD-1080p", cutoff: "Bluray-1080p" });
  assert.deepEqual(profiles.get(2), { name: "Any", cutoff: "WEB 1080p" });
  assert.equal(qualityProfileInfo("x").size, 0);
});

test("cutoffMovie: needs a file, and Radarr's own qualityCutoffNotMet=false always wins", () => {
  const base = { id: 4, tmdbId: 40, title: "Movie", year: 2020, hasFile: true, qualityProfileId: 1, movieFile: { qualityCutoffNotMet: true, quality: { quality: { name: "WEBDL-1080p" } } } };
  assert.deepEqual(cutoffMovie(base, "", profiles), {
    instance: "", arrId: 4, tmdbId: 40, title: "Movie", year: 2020, posterPath: null, quality: "WEBDL-1080p", profile: "HD-1080p", cutoff: "Bluray-1080p",
  });
  assert.equal(cutoffMovie({ ...base, hasFile: false }, "", profiles), null);
  assert.equal(cutoffMovie({ ...base, movieFile: { qualityCutoffNotMet: false } }, "", profiles), null);
});

test("cutoffSeriesFromEpisodes groups episodes per series, in order, skipping met or file-less ones", () => {
  const ep = (id: number, s: number, e: number, extra: Record<string, unknown> = {}) => ({
    id, seriesId: 9, seasonNumber: s, episodeNumber: e, title: `E${e}`, hasFile: true,
    episodeFile: { qualityCutoffNotMet: true, quality: { quality: { name: "HDTV-720p" } } },
    series: { id: 9, tmdbId: 90, tvdbId: 900, title: "Series", year: 2019, qualityProfileId: 1 },
    ...extra,
  });
  const rows = cutoffSeriesFromEpisodes([ep(3, 2, 1), ep(1, 1, 2), ep(2, 1, 1), ep(4, 1, 3, { hasFile: false }), ep(5, 1, 4, { episodeFile: { qualityCutoffNotMet: false } })], "", profiles);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].episodes.map((e) => `${e.seasonNumber}x${e.episodeNumber}`), ["1x1", "1x2", "2x1"]);
  assert.deepEqual([rows[0].title, rows[0].profile, rows[0].cutoff, rows[0].tvdbId], ["Series", "HD-1080p", "Bluray-1080p", 900]);
});

test("planCutoffSearch: monitored episodes with a file Sonarr says is below cutoff — nothing else", () => {
  const episodes = [
    { id: 1, episodeFileId: 101, hasFile: true, monitored: true },
    { id: 2, episodeFileId: 102, hasFile: true, monitored: true },   // file meets cutoff
    { id: 3, episodeFileId: 103, hasFile: true, monitored: false },  // unmonitored
    { id: 4, episodeFileId: 0, hasFile: false, monitored: true },    // missing, not an upgrade
    { id: 5, episodeFileId: 105, hasFile: true, monitored: true },
  ];
  const files = [
    { id: 101, qualityCutoffNotMet: true },
    { id: 102, qualityCutoffNotMet: false },
    { id: 103, qualityCutoffNotMet: true },
    { id: 105, qualityCutoffNotMet: true },
  ];
  assert.deepEqual(planCutoffSearch(episodes, files), [1, 5]);
  assert.deepEqual(planCutoffSearch(episodes, []), []);
});
