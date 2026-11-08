// The request queue's "Why?" panel words (src/components/admin/request-arr-status-view.ts):
// the explanation line, the detail lines and each download's meta line, taken
// out of the component so they can be read without React. The panel's own
// wiring is pinned in tests/request-arr-status.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARR_STATUS_ANSWER,
  downloadMeta,
  verdictDetails,
  verdictExplanation,
  type LoadedArrStatus,
  type VerdictTextContext,
} from "../src/components/admin/request-arr-status-view.ts";
import { queueFormatters } from "../src/components/admin/queue-format.ts";
import { check } from "../src/lib/validate.ts";

const t = (key: string, vars?: Readonly<Record<string, string | number>>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const ctx: VerdictTextContext = {
  t,
  service: "Radarr (4K)",
  fmt: queueFormatters("en"),
  calendarDay: (iso) => (iso ? `day:${iso.slice(0, 10)}` : null),
};

const status = (o: Partial<LoadedArrStatus>): LoadedArrStatus => ({
  verdict: "waiting", service: "radarr", errorKind: null, monitored: true, releasedAt: null, expectedAt: null,
  episodes: null, inLibrary: false, downloads: [], downloadCount: 0, failures: { count: 0, lastAt: null, message: null }, ...o,
});
const download = (o: Partial<LoadedArrStatus["downloads"][number]>) => ({
  phase: "downloading" as const, pending: false, progress: 0.5, timeLeftSeconds: 600, estimatedCompletion: null,
  attention: false, messages: [], quality: "Bluray-1080p", episodes: 0, ...o,
});

test("the explanation names the instance the route judged, and its error kind when it couldn't be reached", () => {
  assert.equal(verdictExplanation(status({ verdict: "notInArr" }), ctx), 'adminQueue.arrStatus.why.notInArr {"service":"Radarr (4K)"}');
  assert.equal(verdictExplanation(status({ verdict: "unreachable", errorKind: "timeout" }), ctx), 'adminArr.error.timeout {"name":"Radarr (4K)"}');
  // A kind the client doesn't know reads as "other", never a raw key.
  assert.equal(verdictExplanation(status({ verdict: "unreachable", errorKind: "brandNew" }), ctx), 'adminArr.error.other {"name":"Radarr (4K)"}');
});

test("downloading reads 'held' only when every download is held", () => {
  assert.match(verdictExplanation(status({ verdict: "downloading", downloads: [download({ pending: true })] }), ctx), /why\.held/);
  assert.match(verdictExplanation(status({ verdict: "downloading", downloads: [download({ pending: true }), download({})] }), ctx), /why\.downloading/);
  assert.match(verdictExplanation(status({ verdict: "downloading", downloads: [] }), ctx), /why\.downloading/);
});

test("a movie's release date is a calendar day; a series' airing is a date-time", () => {
  assert.equal(verdictExplanation(status({ verdict: "notReleased", expectedAt: "2026-11-15T00:00:00Z" }), ctx), 'adminQueue.arrStatus.why.notReleasedMovieOn {"date":"day:2026-11-15"}');
  assert.equal(verdictExplanation(status({ verdict: "notReleased" }), ctx), "adminQueue.arrStatus.why.notReleasedMovie");
  assert.match(verdictExplanation(status({ verdict: "notReleased", service: "sonarr", expectedAt: "2026-11-15T20:00:00Z" }), ctx), /notReleasedSeriesOn \{"date":"Nov 15, 2026/);
});

test("the detail lines: each fact once, the release date only for a title nothing is downloading", () => {
  const lines = verdictDetails(status({
    verdict: "downloadFailed", releasedAt: "2026-01-02T00:00:00Z", inLibrary: true, downloadCount: 7,
    downloads: [download({})], failures: { count: 2, lastAt: "2026-08-20T10:00:00Z", message: "x" },
  }), ctx);
  assert.deepEqual(lines.map((l) => l.split(" ")[0]), [
    "adminQueue.arrStatus.releasedOn", "adminQueue.arrStatus.failureCount", "adminQueue.arrStatus.lastFailure",
    "adminQueue.arrStatus.onMediaServer", "adminQueue.arrStatus.moreDownloads",
  ]);
  assert.equal(new Set(lines).size, lines.length, "distinct: the list keys on the line");
  assert.deepEqual(verdictDetails(status({ verdict: "downloading", releasedAt: "2026-01-02T00:00:00Z" }), ctx), []);
});

test("a download's meta: time left only while fetching, the ETA only without it, nothing empty", () => {
  assert.deepEqual(downloadMeta(download({}), ctx), ["adminManage.queue.phase.downloading", "50%", 'adminQueue.arrStatus.timeLeft {"time":"10m"}', "Bluray-1080p"]);
  assert.deepEqual(downloadMeta(download({ pending: true, quality: null, episodes: 2 }), ctx), ["adminManage.queue.phase.downloading", "50%", 'adminQueue.arrStatus.episodesInDownload {"count":2}']);
  const eta = downloadMeta(download({ timeLeftSeconds: null, estimatedCompletion: "2026-09-02T10:00:00Z", quality: "" }), ctx);
  assert.equal(eta.length, 3);
  assert.match(eta[2], /^adminQueue\.arrStatus\.eta/);
});

test("the schema refuses a phase or verdict the panel has no words for, and drops what it doesn't read", () => {
  const body = { ...status({ downloads: [download({})] }), arrId: 10, hasFile: false };
  const read = check(ARR_STATUS_ANSWER, body);
  assert.ok(read.ok);
  assert.ok(read.ok && !("arrId" in read.value), "an undeclared field is dropped");
  assert.equal(check(ARR_STATUS_ANSWER, { ...body, downloads: [download({ phase: "warp" as never })] }).ok, false);
  assert.equal(check(ARR_STATUS_ANSWER, { ...body, verdict: "brandNew" }).ok, false);
  assert.equal(check(ARR_STATUS_ANSWER, { error: "Radarr is not configured" }).ok, false);
});

test("the panel keys a download's messages by position: the arr can repeat one", async () => {
  const { readFileSync } = await import("node:fs");
  const panel = readFileSync(new URL("../src/components/admin/request-arr-status.tsx", import.meta.url), "utf8");
  assert.match(panel, /d\.messages\.map\(\(m, i\) => \(\s*<p key=\{`\$\{i\}:\$\{m\}`\}/);
  assert.doesNotMatch(panel, /key=\{m\}/);
});
