// Audit fixes (unit "release") for the release GRAB, POST /api/v3/release:
//
//   C111 — the grab POST carries RELEASE_GRAB_TIMEOUT_MS (120 s), not the 30 s
//          default: Radarr/Sonarr answer only after fetching the .torrent/.nzb
//          from the indexer (Prowlarr, FlareSolverr) and handing it to the
//          download client, so a slow indexer read as "grab failed" — handle
//          spent, nothing audited — while the arr finished the grab.
//   C011 — only a refusal of the POST ITSELF is read as the arr's grab answer
//          (404 = search cache expired → "search again", 409 = refused): a 404
//          from a lookup made before it (`/api/v3/movie?tmdbId=`, the series or
//          episode list) is an ordinary failure, never "search again".
//
// Both go through ONE helper, postReleaseGrab (src/lib/arr.ts), used by all
// three grab paths: the request "Pick release", the issue Replace, the title
// manager. Scripted Radarr/Sonarr behind a stubbed DNS lookup, in-memory
// settings.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");
console.error = () => {};
console.warn = () => {};

const { callsOf, functionBodyRange, stripComments } = await import("./audit-fix2-R8b-tests-vacuous-source.mts");

const RADARR = "http://10.0.0.5:7878";
const SONARR = "http://10.0.0.7:8989";
type Call = { method: string; url: URL; timeoutMs: number | null };
let calls: Call[] = [];
let lookupStatus = 200;
let grabStatus = 200;

// Every safeFetch call makes ONE AbortSignal.timeout(timeoutMs) just before it
// fetches; record the value so each call carries the timeout it was given.
let pendingTimeout: number | null = null;
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
(AbortSignal as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
  pendingTimeout = ms;
  return realTimeout(ms);
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  calls.push({ method, url, timeoutMs: pendingTimeout });
  pendingTimeout = null;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (method === "POST" && url.pathname === "/api/v3/release") {
    return grabStatus === 200 ? json({}) : json([{ errorMessage: "indexer said no" }], grabStatus);
  }
  if (lookupStatus !== 200) return json({ message: "nope" }, lookupStatus);
  if (url.origin === RADARR && url.pathname === "/api/v3/movie") return json([{ id: 42, tmdbId: 603 }]);
  if (url.origin === RADARR && url.pathname === "/api/v3/movie/42") return json({ id: 42, tmdbId: 603, title: "The Matrix" });
  if (url.origin === SONARR && url.pathname === "/api/v3/series") return json([{ id: 21, tvdbId: 81189 }]);
  if (url.origin === SONARR && url.pathname === "/api/v3/series/21") return json({ id: 21, tvdbId: 81189, title: "Breaking Bad" });
  if (url.origin === SONARR && url.pathname === "/api/v3/episode") return json([{ id: 501, seasonNumber: 1, episodeNumber: 2 }]);
  throw new Error(`unexpected fetch ${method} ${url}`);
}) as unknown as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const keys = args.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
});

const arr = await import("../src/lib/arr.ts");
const { grabTitleRelease } = await import("../src/lib/arr-title-data.ts");
const { grabRefusal, grabDefinitelyRefused } = await import("../src/lib/release-grab.ts");

beforeEach(() => {
  calls = [];
  lookupStatus = 200;
  grabStatus = 200;
  settings.clear();
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
  settings.set("sonarrUrl", SONARR);
  settings.set("sonarrApiKey", "sonarr-key");
});

const grabPost = () => calls.find((c) => c.method === "POST" && c.url.pathname === "/api/v3/release");

// ── C111: the grab's own timeout ─────────────────────────────────────────────

test("C111: every grab POST carries RELEASE_GRAB_TIMEOUT_MS (120 s) — the request/issue grabs and the title manager's", async () => {
  assert.equal(arr.RELEASE_GRAB_TIMEOUT_MS, 120_000);
  const grabs: Array<[string, () => Promise<void>]> = [
    ["grabMovieRelease", () => arr.grabMovieRelease(603, "guid-m", 3, "")],
    ["grabSeriesRelease", () => arr.grabSeriesRelease(81189, "guid-s", 3, 1, 2, "")],
    ["grabTitleRelease radarr", () => grabTitleRelease("radarr", "", 42, { guid: "guid-t", indexerId: 3 }, null)],
    ["grabTitleRelease sonarr", () => grabTitleRelease("sonarr", "", 21, { guid: "guid-t", indexerId: 3 }, { seasonNumber: 1 })],
  ];
  for (const [name, run] of grabs) {
    calls = [];
    await run();
    const post = grabPost();
    assert.ok(post, `${name}: posted`);
    assert.equal(post!.timeoutMs, arr.RELEASE_GRAB_TIMEOUT_MS, `${name}: the grab's timeout, not the 30 s default`);
    const lookups = calls.filter((c) => c.method === "GET");
    assert.ok(lookups.length > 0 && lookups.every((c) => c.timeoutMs === 30_000), `${name}: the lookups keep the default`);
  }
});

// ── C011: only the POST's own refusal is a grab refusal ──────────────────────

test("C011: a 404 from the GRAB POST is ArrReleaseGrabError → 'search again'; a 409 is the arr's refusal", async () => {
  grabStatus = 404;
  const expired = await arr.grabMovieRelease(603, "g", 3, "").then(() => null, (e: unknown) => e);
  assert.ok(expired instanceof arr.ArrReleaseGrabError);
  assert.ok(expired instanceof arr.ArrResponseError, "still an ArrResponseError — the routes' instanceof checks hold");
  assert.deepEqual(grabRefusal(expired), { kind: "expired" });
  assert.equal(grabDefinitelyRefused(expired), true, "a 404 refusal hands the handle back");

  grabStatus = 409;
  const refused = await arr.grabSeriesRelease(81189, "g", 3, 1, null, "").then(() => null, (e: unknown) => e);
  assert.equal(grabRefusal(refused)?.kind, "refused");
});

test("C011: a 404 from a LOOKUP before the grab is NOT 'search cache expired' — it is an ordinary failure", async () => {
  lookupStatus = 404;
  for (const run of [
    () => arr.grabMovieRelease(603, "g", 3, ""),
    () => arr.grabSeriesRelease(81189, "g", 3, 1, 2, ""),
  ]) {
    calls = [];
    const err = await run().then(() => null, (e: unknown) => e);
    assert.ok(err instanceof arr.ArrResponseError, "the lookup's 404");
    assert.ok(!(err instanceof arr.ArrReleaseGrabError));
    assert.equal(grabRefusal(err), null, "never read as the grab's own 404");
    assert.equal(grabPost(), undefined, "nothing was grabbed");
  }
});

test("C011: a grab that times out or loses its connection is not a refusal either", async () => {
  const timeout = new (await import("../src/lib/safe-fetch.ts")).SafeFetchError("timeout", RADARR, "t");
  assert.equal(grabRefusal(timeout), null);
  assert.equal(grabDefinitelyRefused(timeout), false);
});

test("C111/C011: no source POSTs /api/v3/release except postReleaseGrab", () => {
  // Every arrFetch* call is read as a whole (its balanced argument list,
  // comments stripped), whatever its config argument is called and however
  // its options are laid out; and the bare grab path — "/api/v3/release" with
  // no query, which only a grab uses — may appear nowhere else, so a path
  // constant or another client can't route around the chokepoint either.
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const arrFile = join(srcDir, "lib", "arr.ts");
  const [grabStart, grabEnd] = functionBodyRange(readFileSync(arrFile, "utf8"), "export async function postReleaseGrab(");
  const inGrab = (p: string, at: number) => p === arrFile && at >= grabStart && at < grabEnd;
  const offenders: string[] = [];
  let allowedCalls = 0;
  let allowedPaths = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "generated") walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      const src = readFileSync(p, "utf8");
      for (const c of callsOf(src, "arrFetch\\w*")) {
        if (!/["'`]\/api\/v3\/release["'`?]/.test(c.args) || !/\bmethod:\s*["'`]POST["'`]/.test(c.args)) continue;
        if (inGrab(p, c.index)) allowedCalls++;
        else offenders.push(`${p}: arrFetch(${c.args.trim().slice(0, 80)}…)`);
      }
      for (const m of stripComments(src).matchAll(/["'`]\/api\/v3\/release["'`]/g)) {
        if (inGrab(p, m.index)) allowedPaths++;
        else offenders.push(`${p}: the bare grab path at ${m.index}`);
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, [], "a grab POST outside postReleaseGrab loses the grab timeout and the typed refusal");
  assert.equal(allowedCalls, 1, "the scan found postReleaseGrab's own POST — it can't pass by matching nothing");
  assert.equal(allowedPaths, 1);
});
