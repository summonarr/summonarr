// runLibraryMatchCheck end to end over an in-memory Setting store and scripted
// Jellyfin + Radarr servers: the real listers, the real judge, the stored
// report. The outcomes that matter for a check that offers fixes:
//   - a copy folded into another title's row by the sync is found and flagged;
//   - a Radarr that can't be read referees NOTHING — never a wrongMatch on an
//     item it would have agreed with — and is named in `sources`;
//   - an aborted run stores nothing (guardrail 41), the previous report stays.
process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.TRUST_PROXY = "true";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

const settings = new Map<string, string>();
type Where = { key: string | { in?: string[]; startsWith?: string } };
const matches = (key: string, w: Where["key"]) =>
  typeof w === "string" ? key === w : (w.in ? w.in.includes(key) : true) && (w.startsWith ? key.startsWith(w.startsWith) : true);
const settingDelegate = {
  findUnique: async (a: { where: { key: string } }) => (settings.has(a.where.key) ? { key: a.where.key, value: settings.get(a.where.key)! } : null),
  findMany: async (a: { where: Where }) => [...settings].filter(([k]) => matches(k, a.where.key)).map(([key, value]) => ({ key, value })),
  upsert: async (a: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
    settings.set(a.where.key, settings.has(a.where.key) ? a.update.value : a.create.value);
    return {};
  },
  update: async (a: { where: { key: string }; data: { value: string } }) => { settings.set(a.where.key, a.data.value); return {}; },
};
let locks = 0;
(globalThis as unknown as { prisma: unknown }).prisma = {
  setting: settingDelegate,
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ setting: settingDelegate, $executeRaw: async () => { locks++; return 0; } }),
};

const JF = "http://10.77.0.1:8096";
const RADARR = "http://10.77.0.2:7878";
let radarrStatus = 200;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.origin === JF && url.pathname === "/Items") {
    if (url.searchParams.get("CollapseBoxSetItems") !== "false") return json({ Items: [{ Id: "box", Type: "BoxSet" }], TotalRecordCount: 1 });
    if (url.searchParams.get("IncludeItemTypes") === "Series") return json({ Items: [], TotalRecordCount: 0 });
    return json({
      Items: [
        { Id: "a1", Type: "Movie", Name: "Ghost in the Shell", ProductionYear: 1995, Path: "/mnt/movies/Ghost in the Shell (1995)/a.mkv", ProviderIds: { Tmdb: "9323" } },
        { Id: "b2", Type: "Movie", Name: "Ghost in the Shell", ProductionYear: 1995, Path: "/mnt/movies/Ghost in the Shell (2017)/b.mkv", ProviderIds: { Tmdb: "9323" } },
      ],
      TotalRecordCount: 2,
    });
  }
  if (url.origin === RADARR && url.pathname === "/api/v3/movie") {
    if (radarrStatus !== 200) return new Response("boom", { status: radarrStatus });
    return json([
      { tmdbId: 9323, imdbId: "tt0113568", title: "Ghost in the Shell", year: 1995, path: "/data/movies/Ghost in the Shell (1995)" },
      { tmdbId: 315837, imdbId: "tt1219827", title: "Ghost in the Shell", year: 2017, path: "/data/movies/Ghost in the Shell (2017)" },
    ]);
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const { runLibraryMatchCheck, readLibraryMatchReport, LIBRARY_MATCH_REPORT_KEY } = await import("../src/lib/library-match-data.ts");

beforeEach(() => {
  settings.clear();
  settings.set("jellyfinUrl", JF);
  settings.set("jellyfinApiKey", "jf-key");
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
  radarrStatus = 200;
  locks = 0;
  warns.length = 0;
});

test("finds the copy the sync folds into the 1995 film's row, and stores the report under the report-row lock", async () => {
  const report = await runLibraryMatchCheck({ now: new Date("2026-10-13T12:00:00.000Z") });
  assert.ok(report);
  assert.deepEqual(report.sources, [
    { service: "jellyfin", instance: "", ok: true, items: 2 },
    { service: "radarr", instance: "", ok: true, items: 2 },
  ]);
  assert.deepEqual(report.flags.map((f) => [f.kind, f.itemKey, f.serverTmdbId, f.arr?.tmdbId]), [["wrongMatch", "b2", 9323, 315837]]);
  assert.deepEqual(report.counts, { checked: 2, agreed: 1, notManaged: 0, flagged: 1 });
  assert.equal(report.checkedAt, "2026-10-13T12:00:00.000Z");
  assert.equal(locks, 1);
  assert.deepEqual(await readLibraryMatchReport(), report, "what the page reads back is what was judged");
});

test("a Radarr that can't be read referees nothing: no wrongMatch, the instance named with its error kind", async () => {
  radarrStatus = 500;
  const report = await runLibraryMatchCheck();
  assert.ok(report);
  assert.deepEqual(report.sources.find((s) => s.service === "radarr"), { service: "radarr", instance: "", ok: false, kind: "server", items: 0 });
  assert.ok(report.flags.every((f) => f.kind !== "wrongMatch" && f.arr === null));
  assert.equal(report.counts.notManaged, 2);
  // The folder year still speaks — with no suggestion, so nothing is offered a fix.
  assert.deepEqual(report.flags.map((f) => [f.kind, f.itemKey]), [["yearMismatch", "b2"]]);
});

test("an aborted run stores nothing and the previous report stays", async () => {
  settings.set(LIBRARY_MATCH_REPORT_KEY, "previous");
  const controller = new AbortController();
  controller.abort();
  assert.equal(await runLibraryMatchCheck({ signal: controller.signal }), null);
  assert.equal(settings.get(LIBRARY_MATCH_REPORT_KEY), "previous");
});
